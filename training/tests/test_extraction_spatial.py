from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image, ImageDraw

from deckino_training.extraction import (CORNER_ORDER, LegacyCardExtractor, _load_model, letterbox, unletterbox,
    prepare_extraction_dataset, read_manifest, train_extractor, evaluate_extractor, rectify_extractor, extractor_smoke)
from deckino_training.extraction_network import CardExtractor, spatial_loss
from deckino_training.extraction_augmentation import transform_photo, augment_photo
from deckino_training.extraction_groups import capture_group, assign_groups, persistent_real_splits
from deckino_training.extraction_evaluation import summarize, selection_key, calibrate
from deckino_training.extraction_training import RealFirstBatches, learning_check, _validate_resume
import test_extraction as fixtures


class SpatialExtractorTests(unittest.TestCase):
    def test_spatial_shape_gradients_and_frozen_batchnorm(self):
        model = CardExtractor().train()
        original = {name: value.clone() for name, value in model.named_buffers()}
        corners, presence, heatmaps = model.forward_with_heatmaps(torch.randn(2, 3, 256, 256))
        self.assertEqual((2, 8), tuple(corners.shape))
        self.assertEqual((2, 4, 64, 64), tuple(heatmaps.shape))
        targets = torch.tensor([[.2, .1, .8, .1, .8, .9, .2, .9]] * 2)
        loss, components = spatial_loss(corners, presence, heatmaps, targets, torch.tensor([1., 0.]))
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertGreater(model.corner_head.weight.grad.abs().sum().item(), 0)
        self.assertGreater(model.presence_head[-1].weight.grad.abs().sum().item(), 0)
        for name, value in model.named_buffers():
            self.assertTrue(torch.equal(original[name], value), name)
        self.assertEqual({"heatmap_loss", "corner_loss", "presence_loss"}, components.keys())

    def test_negative_samples_never_contribute_localization_gradients(self):
        corners = torch.full((2, 8), .5, requires_grad=True)
        logits = torch.zeros(2, requires_grad=True)
        maps = torch.zeros(2, 4, 64, 64, requires_grad=True)
        loss, parts = spatial_loss(corners, logits, maps, torch.zeros_like(corners), torch.zeros(2))
        loss.backward()
        self.assertEqual(0, corners.grad.abs().sum().item())
        self.assertEqual(0, maps.grad.abs().sum().item())
        self.assertGreater(logits.grad.abs().sum().item(), 0)
        self.assertEqual(0, parts["corner_loss"].item())

    def test_rotation_preserves_semantic_corner_order_and_matches_pixels(self):
        image = Image.new("RGB", (101, 101))
        points = [{"x": .2, "y": .3}, {"x": .8, "y": .3}, {"x": .8, "y": .7}, {"x": .2, "y": .7}]
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)]
        for point, color in zip(points, colors):
            x, y = point["x"] * 100, point["y"] * 100
            ImageDraw.Draw(image).rectangle((x-3, y-3, x+3, y+3), fill=color)
        matrix = np.array([[0., -1., 100.], [1., 0., 0.], [0., 0., 1.]])
        warped, mapped = transform_photo(image, points, matrix)
        for point, color in zip(mapped, colors):
            self.assertEqual(color, warped.getpixel((round(point["x"] * 100), round(point["y"] * 100))))
        self.assertAlmostEqual(.7, mapped[0]["x"])
        self.assertAlmostEqual(.2, mapped[0]["y"])
        with self.assertRaises(ValueError):
            transform_photo(image, points, np.array([[1, 0, 100], [0, 1, 0], [0, 0, 1.]]))

    def test_sampler_caps_synthetic_and_restores_exact_samples_and_augmentation_seeds(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = fixtures.ExtractionTests()._prepare(Path(folder), include_synthetic=False)
            records, _, _ = read_manifest(manifest)
            records += [replace(records[0], source_kind="synthetic-positive")] * 100
            generator = torch.Generator().manual_seed(7)
            before = generator.get_state()
            batches = list(RealFirstBatches(records, 16, 4, generator))
            self.assertTrue(all(sum(records[index].source_kind != "real" for index, _ in batch) <= 3 for batch in batches))
            generator.set_state(before)
            self.assertEqual(batches, list(RealFirstBatches(records, 16, 4, generator)))

    def test_perspective_then_letterbox_keeps_pixels_and_labels_aligned(self):
        image = Image.new("RGB", (201, 301))
        points = [{"x": .2, "y": .2}, {"x": .8, "y": .2}, {"x": .8, "y": .8}, {"x": .2, "y": .8}]
        original = json.dumps(points)
        for point in points:
            x, y = point["x"] * 200, point["y"] * 300
            ImageDraw.Draw(image).ellipse((x-5, y-5, x+5, y+5), fill="white")
        matrix = np.array([[.85, .03, 9.], [-.02, .9, 15.], [.0003, -.0001, 1.]])
        warped, mapped = transform_photo(image, points, matrix)
        tensor, target = letterbox(warped, mapped, mean=[0, 0, 0], std=[1, 1, 1])
        for x, y in target.reshape(4, 2).tolist():
            self.assertGreater(tensor[:, round(y * 255), round(x * 255)].mean().item(), .9)
        recovered = unletterbox(target.tolist(), image.width, image.height)
        np.testing.assert_allclose([[p["x"], p["y"]] for p in mapped], [[p["x"], p["y"]] for p in recovered], atol=1e-6)
        self.assertEqual(original, json.dumps(points))

    def test_failed_learning_gate_emits_reload_and_loss_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            with self.assertRaisesRegex(RuntimeError, "learning check failed"):
                learning_check(manifest, root / "artifacts", "learning", "cpu", 8, 0, 7, None, max_updates=0, pretrained=False)
            output = root / "artifacts/learning"
            report = json.loads((output / "learning-check.json").read_text())
            self.assertFalse(report["passed"])
            self.assertTrue(report["checkpoint_reload_parity"])
            self.assertTrue((output / "diagnostics/failures/index.json").is_file())
            self.assertTrue((output / "training-history.jsonl").is_file())
            self.assertFalse((output / "best.pt").exists())

    def test_resume_rejects_previous_architecture_and_changed_manifest(self):
        with self.assertRaisesRegex(ValueError, "architecture"):
            _validate_resume({"architecture": "mobilenetv3-small-extractor"}, {"architecture": "mobilenetv3-small-spatial-v2"})
        with self.assertRaisesRegex(ValueError, "manifest_sha256"):
            _validate_resume({"manifest_sha256": "old"}, {"manifest_sha256": "new"})

    def test_smoke_uses_requested_batch_even_with_one_real_photo(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixtures.ExtractionTests()._write_annotation(root, "one-session", 0, present=True)
            prepare_extraction_dataset(root, "small")
            report = extractor_smoke(root / "exports/small/manifest.jsonl", "cpu", 4, 2, None)
            self.assertEqual(4, report["batch_size"])
            self.assertEqual(2, report["steps"])
            self.assertGreater(report["corner_gradient"], 0)

    def test_fine_tuning_starts_after_five_frozen_backbone_epochs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            train_extractor(manifest, root / "artifacts", "schedule", 6, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=1)
            checkpoint = torch.load(root / "artifacts/schedule/last.pt", weights_only=False, map_location="cpu")
            history = checkpoint["history"]
            self.assertTrue(all(item["backbone_frozen"] and item["learning_rates"] == {"backbone": 0., "heads": .001} for item in history[:5]))
            self.assertFalse(history[5]["backbone_frozen"])
            self.assertAlmostEqual(3e-5, history[5]["learning_rates"]["backbone"])
            self.assertAlmostEqual(3e-4, history[5]["learning_rates"]["heads"])

    def test_empty_evaluation_is_unavailable_not_zero_and_selection_uses_geometry(self):
        empty = summarize([])
        self.assertIsNone(empty["mean_corner_error"])
        self.assertIsNone(empty["presence_recall"])
        self.assertEqual((.5, False), calibrate([]))
        good = {**empty, "negatives": 5, "presence_precision": .99, "presence_recall": .99,
                "correct_warp_coverage": .8, "mean_corner_error": .02}
        bad = {**good, "correct_warp_coverage": .01, "mean_corner_error": .4}
        self.assertGreater(selection_key(good), selection_key(bad))

    def test_legacy_192_checkpoint_still_rectifies_with_its_own_preprocessing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model = LegacyCardExtractor().eval()
            checkpoint = root / "old.pt"
            torch.save({"artifact_schema_version": 1, "architecture": "mobilenetv3-small-extractor",
                        "input_size": 192, "model_version": "old", "model_state": model.state_dict()}, checkpoint)
            _, loaded = _load_model(checkpoint, torch.device("cpu"))
            image = Image.new("RGB", (320, 480), "white")
            image.save(root / "photo.jpg")
            (root / "thresholds.json").write_text(json.dumps({"model_version": "old", "presence_threshold": 1.}))
            result = rectify_extractor(checkpoint, root / "thresholds.json", root / "photo.jpg", root / "preview", "cpu", None)
            self.assertFalse(result["accepted"])
            self.assertTrue((root / "preview" / "overlay.jpg").exists())
            sample, _ = letterbox(image, input_size=192)
            with torch.inference_mode():
                self.assertTrue(torch.equal(model(sample[None])[0], loaded(sample[None])[0]))

    def test_no_holdouts_never_evaluates_training_as_validation_or_test(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            helper = fixtures.ExtractionTests()
            helper._write_annotation(root, "single-session", 0, present=True)
            helper._write_annotation(root, "single-session", 1, present=False)
            prepare_extraction_dataset(root, "development")
            manifest = root / "exports" / "development" / "manifest.jsonl"
            train_extractor(manifest, root / "artifacts", "test", 1, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=1)
            report = evaluate_extractor(manifest, root / "artifacts/test/best.pt", root / "artifacts/test", "cpu", 2, 0, None)
            self.assertEqual("unavailable", report["split"])
            self.assertEqual(0, report["metrics"]["samples"])
            self.assertEqual(0, report["validation_samples"])
            self.assertFalse(report["calibrated"])
            self.assertFalse(report["qualified"])
            self.assertIsNone(report["metrics"]["presence_precision"])
            with patch("deckino_training.extraction_evaluation.predict", side_effect=AssertionError("locked test ran again")):
                cached = evaluate_extractor(manifest, root / "artifacts/test/best.pt", root / "artifacts/test", "cpu", 2, 0, None)
            self.assertEqual(report, cached)
            (root / "artifacts/test/thresholds.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "missing or changed"):
                evaluate_extractor(manifest, root / "artifacts/test/best.pt", root / "artifacts/test", "cpu", 2, 0, None)

    def test_negative_only_validation_cannot_select_an_early_corner_checkpoint(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            helper = fixtures.ExtractionTests()
            for index, (present, split) in enumerate(((True, "train"), (False, "validation"))):
                _, sidecar = helper._write_annotation(root, f"session-{index}", index, present=present)
                annotation = json.loads(sidecar.read_text())
                annotation["Split"] = split
                sidecar.write_text(json.dumps(annotation))
            prepare_extraction_dataset(root, "development")
            manifest = root / "exports/development/manifest.jsonl"
            train_extractor(manifest, root / "artifacts", "negative-validation", 2, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=1)
            checkpoint = torch.load(root / "artifacts/negative-validation/best.pt", weights_only=False, map_location="cpu")
            self.assertTrue(checkpoint["development_only"])
            self.assertEqual(2, checkpoint["epoch"])
            self.assertIsNone(checkpoint["best_selection_key"])

    def test_interrupted_training_resumes_with_the_same_samples_schedule_and_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            train_extractor(manifest, root / "artifacts", "continuous", 2, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=1)
            def stop(event, **values):
                if event == "extraction_epoch_completed":
                    raise InterruptedError("checkpoint saved")
            with patch("deckino_training.extraction_training.emit", side_effect=stop):
                with self.assertRaises(InterruptedError):
                    train_extractor(manifest, root / "artifacts", "resumed", 2, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=1)
            last = root / "artifacts/resumed/last.pt"
            train_extractor(manifest, root / "artifacts", "resumed", 2, 2, 3e-4, 0, False, last, "cpu", 7, None, max_batches=1)
            expected = torch.load(root / "artifacts/continuous/last.pt", weights_only=False, map_location="cpu")
            actual = torch.load(last, weights_only=False, map_location="cpu")
            for name, value in expected["model_state"].items():
                self.assertTrue(torch.equal(value, actual["model_state"][name]), name)
            self.assertEqual(expected["history"], actual["history"])


class CaptureGroupTests(unittest.TestCase):
    def test_import_batches_are_grouped_by_date_but_custom_groups_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            imports = Path(folder)
            batch = imports / "batch"
            batch.mkdir()
            (batch / ".deckino-import.json").write_text(json.dumps({"BatchId": "batch", "Sources": [{"SourceGroup": "batch/photos"}]}))
            image = batch / "20260108_113929.jpg"
            Image.new("RGB", (20, 30)).save(image)
            sidecar = image.with_suffix(".json")
            group, evidence = capture_group(sidecar, image, "batch/photos", imports)
            self.assertEqual("capture-day:2026-01-08", group)
            self.assertEqual("filename", evidence["method"])
            self.assertEqual("custom", capture_group(sidecar, image, "custom", imports)[0])
            exif = Image.Exif()
            exif[36867] = "2026:01:09 11:39:29"
            Image.new("RGB", (20, 30)).save(image, exif=exif)
            group, evidence = capture_group(sidecar, image, "batch/photos", imports)
            self.assertEqual("batch/photos", group)
            self.assertIn("Conflicting", evidence["warning"])

    def test_global_split_handles_small_strata_and_preserves_pins(self):
        groups = {f"group-{i}": {"card_present": i % 2 == 0, "condition": f"condition-{i}"} for i in range(8)}
        original = assign_groups(groups, 7)
        self.assertEqual({"train", "validation", "test"}, set(original.values()))
        groups["new"] = {"card_present": True, "condition": "new"}
        updated = assign_groups(groups, 7, original)
        self.assertTrue(all(updated[key] == value for key, value in original.items()))

    def test_duplicate_merges_cannot_cross_established_splits(self):
        with tempfile.TemporaryDirectory() as folder:
            registry = Path(folder) / "registry.json"
            registry.write_text(json.dumps({"schema_version": 2, "seed": 7, "groups": {"a": "train", "b": "test"}, "image_hashes": {}}))
            records = [{"source_group": "a", "capture_group": name, "image_sha256": name,
                        "card_present": True, "capture_condition": None} for name in ("a", "b")]
            with self.assertRaisesRegex(ValueError, "crosses"):
                persistent_real_splits(records, registry, 7)


if __name__ == "__main__":
    unittest.main()
