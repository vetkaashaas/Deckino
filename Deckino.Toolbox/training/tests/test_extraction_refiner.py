from __future__ import annotations

import random
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

import test_extraction as fixtures
from deckino_training.extraction import evaluate_extractor, read_manifest, rectify_extractor, train_extractor
from deckino_training.extraction_audit import audit_labels
from deckino_training.extraction_evaluation import paired_bootstrap, robust_geometry_error, selection_key
from deckino_training.extraction_refiner import (CROP_SIZE, MAXIMUM_CORNER_UNCERTAINTY, CornerRefiner, WorkingImage,
                                                 corner_crops, crop_frame, load_refiner, refine_corners,
                                                 refiner_loss, simulate_coarse, train_refiner)
from deckino_training.extraction_suggestion import _refine_request
from test_extraction_recipe3 import prediction


class RefinerGeometryTests(unittest.TestCase):
    def test_canonical_crop_puts_every_corner_top_left_with_interior_bottom_right(self):
        # A red card on a black background with a green dot on each true corner.
        image = Image.new("RGB", (900, 700))
        quad = np.array([[250., 120.], [690., 180.], [640., 600.], [200., 560.]])
        draw = ImageDraw.Draw(image)
        draw.polygon([tuple(point) for point in quad], fill=(200, 30, 30))
        for x, y in quad:
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(0, 255, 0))
        diagonal = float(np.linalg.norm(quad[0] - quad[2]))
        working = WorkingImage(image, diagonal)
        coarse = quad + np.array([[6., -4.], [-5., 7.], [3., 5.], [-7., -3.]])
        crops, frames = corner_crops(working, coarse, diagonal)
        for crop, (origin, matrix), truth in zip(crops, frames, working.to_working(quad)):
            target = np.linalg.solve(matrix, truth - origin)
            x, y = np.round(target).astype(int)
            red, green, _ = crop.getpixel((x, y))
            self.assertGreater(green, 150)  # the crop target lands on the true corner's green dot
            self.assertLess(red, 150)
            # Card interior (red) lies down-right of the corner, background up-left.
            self.assertGreater(crop.getpixel((min(CROP_SIZE - 1, x + 12), min(CROP_SIZE - 1, y + 12)))[0], 150)
            self.assertLess(crop.getpixel((max(0, x - 12), max(0, y - 12)))[0], 40)

    def test_crop_frame_round_trips_between_crop_and_image_pixels(self):
        points = np.array([[10., 20.], [110., 25.], [105., 160.], [5., 150.]])
        origin, matrix = crop_frame(points, 2, 200.)
        center = np.full(2, (CROP_SIZE - 1) / 2)
        self.assertTrue(np.allclose(origin + matrix @ center, points[2]))

    def test_simulated_coarse_error_stays_inside_the_crop(self):
        points = np.array([[100., 100.], [400., 110.], [390., 520.], [95., 510.]])
        diagonal = float(np.linalg.norm(points[0] - points[2]))
        rng = random.Random(3)
        for _ in range(200):
            moved = simulate_coarse(points, rng)
            self.assertLessEqual(float(np.linalg.norm(moved - points, axis=1).max()), .075 * diagonal)

    def test_loss_ignores_targets_outside_the_crop(self):
        model = CornerRefiner()
        outputs = model(torch.zeros(2, 3, CROP_SIZE, CROP_SIZE))
        targets = torch.tensor([[60., 70.], [5000., 5000.]])
        loss, parts = refiner_loss(outputs, targets, torch.tensor([True, False]))
        self.assertTrue(torch.isfinite(loss))
        alone, _ = refiner_loss({key: value[:1] for key, value in outputs.items()}, targets[:1], torch.tensor([True]))
        self.assertAlmostEqual(float(loss), float(alone), places=4)


class _FixedRefiner(torch.nn.Module):
    """Predicts a fixed crop offset from the centre with a chosen per-corner uncertainty."""

    def __init__(self, shift: float, log_scales: list[float]) -> None:
        super().__init__()
        self.shift, self.log_scales = shift, torch.tensor(log_scales)

    def forward(self, crops):
        centre = (CROP_SIZE - 1) / 2 + self.shift
        return {"points": torch.full((crops.shape[0], 2), centre), "log_scale": self.log_scales[:crops.shape[0]]}


class RefinerServingTests(unittest.TestCase):
    CORNERS = [{"x": .2, "y": .15}, {"x": .8, "y": .16}, {"x": .82, "y": .85}, {"x": .18, "y": .84}]

    def test_box_reduction_uses_the_exact_pixel_mapping_for_odd_sizes(self):
        # 1365px reduces to 683px (rounded up); the mapping must still be exactly 1/factor.
        working = WorkingImage(Image.new("RGB", (1365, 1023)), 2000.)
        self.assertEqual(2, working.factor)
        self.assertEqual((683, 512), working.image.size)
        far = np.array([[1364., 1022.]])
        self.assertTrue(np.allclose(working.to_working(far), (far + .5) / 2 - .5))
        self.assertTrue(np.allclose(working.to_source(working.to_working(far)), far))

    def test_unsure_corners_keep_their_coarse_position(self):
        image = Image.new("RGB", (400, 600), (90, 90, 90))
        # Corners 0 and 2 are confident; 1 and 3 exceed the uncertainty limit.
        confident, unsure = -3., 3.
        model = _FixedRefiner(2., [confident, unsure, confident, unsure])
        result = refine_corners(model, image, self.CORNERS, torch.device("cpu"), passes=1)
        self.assertEqual([True, False, True, False], result["corner_refined"])
        self.assertTrue(result["refined"])
        self.assertEqual(self.CORNERS[1], result["corners"][1])
        self.assertNotEqual(self.CORNERS[0], result["corners"][0])
        self.assertEqual(0., result["corner_shift"][1])
        self.assertGreater(result["corner_uncertainty"][1], MAXIMUM_CORNER_UNCERTAINTY)

    def test_all_unsure_reports_not_refined(self):
        image = Image.new("RGB", (400, 600), (90, 90, 90))
        result = refine_corners(_FixedRefiner(2., [3.] * 4), image, self.CORNERS, torch.device("cpu"), passes=1)
        self.assertFalse(result["refined"])
        self.assertEqual(self.CORNERS, result["corners"])


class RobustSelectionTests(unittest.TestCase):
    def test_continuous_geometry_ranks_ahead_of_coverage_counts(self):
        precise = [prediction(error=.005), prediction(error=.005, warp=.1), prediction(False, .1)]
        sloppy = [prediction(error=.025), prediction(error=.025), prediction(False, .1)]
        self.assertLess(robust_geometry_error(precise), robust_geometry_error(sloppy))
        self.assertGreater(selection_key(precise), selection_key(sloppy))

    def test_paired_bootstrap_reports_intervals_on_shared_photos(self):
        baseline = [dict(prediction(error=.02), sample_id=f"s{index}") for index in range(12)]
        candidate = [dict(prediction(error=.01), sample_id=f"s{index}") for index in range(12)]
        report = paired_bootstrap(candidate, baseline)
        mean = report["metrics"]["mean_corner_error"]
        self.assertEqual(12, report["shared_positives"])
        self.assertTrue(mean["significant_improvement"])
        self.assertLess(mean["ci95"][1], 0)
        self.assertEqual("insufficient_shared_positives", paired_bootstrap(candidate[:2], baseline[:2])["status"])


class RefinerPipelineTests(unittest.TestCase):
    def test_refiner_trains_evaluates_audits_rectifies_and_exports(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            helper = fixtures.ExtractionTests("test_letterbox_round_trip_and_negative_corner_mask")
            manifest = helper._prepare(root, include_synthetic=False)
            artifacts = root / "training" / "artifacts"
            train_extractor(manifest, artifacts, "run", 1, 8, 3e-4, 0, False, None, "cpu", 20260824, None,
                            max_batches=1)
            train_refiner(manifest, artifacts, "run", 1, 2, 1e-3, 0, False, None, "cpu", 20260824, None,
                          max_batches=1)
            output = artifacts / "run"
            for name in ("refiner.pt", "refiner-last.pt", "refiner-config.json", "refiner-history.json"):
                self.assertTrue((output / name).is_file(), name)
            config, refiner = load_refiner(output / "refiner.pt", torch.device("cpu"))
            self.assertEqual("edge-intersection-v1", config["corner_convention"])

            records, image_root, _ = read_manifest(manifest)
            record = next(item for item in records if item.card_present)
            with Image.open(image_root / record.image_path) as source:
                result = refine_corners(refiner, source.convert("RGB"), record.corners, torch.device("cpu"))
            self.assertEqual(4, len(result["corners"]))
            self.assertEqual(4, len(result["corner_uncertainty"]))

            report = evaluate_extractor(manifest, output / "best.pt", output, "cpu", 8, 0, None,
                                        refiner_checkpoint=output / "refiner.pt")
            self.assertIn("refiner_sha256", report["evaluation_identity"])
            self.assertIn("coarse_only_validation_at_0_5", report["refiner"])
            self.assertIn("robust_geometry_error", report["validation_metrics"])

            audit = audit_labels(manifest, output / "best.pt", output / "refiner.pt", output / "audit", "cpu", None)
            self.assertEqual(sum(item.card_present for item in records), audit["positives"])
            self.assertTrue((output / "audit" / "label-audit.json").is_file())

            thresholds = output / "thresholds.json"
            diagnostic = rectify_extractor(output / "best.pt", thresholds, image_root / record.image_path,
                                           output / "manual", "cpu", None, output / "refiner.pt")
            self.assertIn("coarse_corners", diagnostic)

            refined = _refine_request(image_root / record.image_path, record.corners, refiner, torch.device("cpu"))
            self.assertTrue(refined["refiner_available"])
            self.assertFalse(_refine_request(image_root / record.image_path, record.corners, None,
                                             torch.device("cpu"))["refiner_available"])

            # The extractor's own ONNX export needs a newer torch than this CPU test runtime;
            # the refiner graph is static and exports here, so verify its contract directly.
            from deckino_training.extraction_mobile import _export_refiner
            mobile_root = root / "mobile"
            mobile_root.mkdir()
            exported = _export_refiner(output / "refiner.pt", mobile_root, torch.device("cpu"))
            self.assertTrue(exported["parity"]["passed"])
            self.assertTrue((mobile_root / "refiner.onnx").is_file())
            self.assertEqual([4, 3, CROP_SIZE, CROP_SIZE], exported["input_shape"])


if __name__ == "__main__":
    unittest.main()
