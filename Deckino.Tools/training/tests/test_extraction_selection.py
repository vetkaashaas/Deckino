from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image

from deckino_training.extraction_diagnostics import heatmap_statistics, write_corner_heatmaps
from deckino_training.extraction import CORNER_ORDER, read_manifest
from deckino_training.extraction_evaluation import calibration_report, evaluate, selection_key, summarize
from deckino_training.extraction_training import _validate_resume
import test_extraction as fixtures
from test_extraction_recipe3 import prediction


class CalibratedSelectionTests(unittest.TestCase):
    def test_geometry_coverage_beats_threshold_calibration_noise(self):
        negatives = [prediction(False, .1)] * 4 + [prediction(False, .99, False)]
        earlier = ([prediction()] * 27 + [prediction(warp=.1)] * 26
                   + [prediction(confidence=.4, warp=.1)] * 3 + negatives)
        later = ([prediction()] * 22 + [prediction(warp=.1)] * 32
                 + [prediction(confidence=.4, warp=.1)] * 2 + negatives)
        self.assertGreater(selection_key(earlier), selection_key(later))

    def test_feasible_negative_rejection_beats_higher_unsafe_coverage(self):
        safe = calibration_report([prediction(warp=.1), prediction(), prediction(False, .1)])
        unsafe = calibration_report([prediction(), prediction(), prediction(False, .8)])
        self.assertTrue(safe["constraints_met"])
        self.assertFalse(unsafe["constraints_met"])
        self.assertGreater(selection_key([prediction(), prediction(), prediction(False, .1)]),
                           selection_key([prediction(), prediction(), prediction(False, .8)]))
        empty = calibration_report([prediction(valid=False), prediction(False, .99, False)])
        self.assertFalse(empty["constraints_met"])

    def test_missing_classes_and_error_tiebreak_remain_explicit(self):
        positive_only = calibration_report([prediction()])
        self.assertEqual(.5, positive_only["presence_threshold"])
        self.assertTrue(selection_key([prediction()])[0])
        self.assertGreater(selection_key([prediction(error=.01), prediction(False, .1)]),
                           selection_key([prediction(error=.03), prediction(False, .1)]))

    def test_old_selection_cannot_resume_even_when_recipe_matches(self):
        with self.assertRaisesRegex(ValueError, "checkpoint_selection_policy"):
            _validate_resume({"training_recipe_version": 4},
                             {"training_recipe_version": 4, "checkpoint_selection_policy": "geometry-guarded-v3"})


class HeatmapDiagnosticTests(unittest.TestCase):
    def test_two_peaks_show_disagreement_with_global_expectation(self):
        logits = torch.full((4, 64, 64), -30.)
        logits[:, 10, 10] = 10
        logits[:, 50, 50] = 10
        probabilities, statistics = heatmap_statistics(logits)
        self.assertTrue(np.allclose(probabilities.sum(axis=(1, 2)), 1))
        self.assertAlmostEqual(30 / 63, statistics[0]["expected_tensor_xy"][0], places=6)
        self.assertAlmostEqual(1., statistics[0]["second_peak_outside_4_cells_ratio"])
        self.assertEqual([10 / 63, 10 / 63], statistics[0]["peak_tensor_xy"])

    def test_render_is_bounded_relative_and_keeps_model_outputs(self):
        class FixedSpatial(torch.nn.Module):
            def forward_with_heatmaps(self, images):
                return (torch.tensor([[.2, .2, .8, .2, .8, .8, .2, .8]]), torch.zeros(1),
                        torch.zeros(1, 4, 64, 64))
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            model = FixedSpatial().eval()
            result = write_corner_heatmaps(Image.new("RGB", (320, 640)), model,
                {"input_size": 256, "model_version": "example", "epoch": 78}, torch.device("cpu"), output, "preview")
            report = json.loads((output / result["report"]).read_text())
            self.assertTrue(report["inspection_only"])
            self.assertAlmostEqual(.2, report["corners"][0]["output_tensor_xy"][0])
            self.assertAlmostEqual(.5, report["corners"][0]["expected_tensor_xy"][0])
            self.assertNotIn(str(output), json.dumps(report))
            with Image.open(output / result["preview"]) as preview:
                self.assertEqual((512, 608), preview.size)
            with (output / result["preview"]).open("ab") as stream:
                stream.write(b"")  # No retained file handles from the renderer.

    def test_legacy_model_and_nonfinite_heatmaps_are_explicit(self):
        result = write_corner_heatmaps(Image.new("RGB", (10, 10)), torch.nn.Identity(), {},
                                      torch.device("cpu"), Path("unused"), "unused")
        self.assertEqual("unavailable", result["status"])
        with self.assertRaisesRegex(ValueError, "Non-finite"):
            heatmap_statistics(torch.full((4, 64, 64), float("nan")))


class BaselineComparisonTests(unittest.TestCase):
    def test_comparison_uses_same_validation_and_is_exported_without_rerunning_locked_test(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            records, _, _ = read_manifest(manifest)
            validation_ids = [item.sample_id for item in records if item.split == "validation"]
            candidate_path, baseline_path = root / "candidate.pt", root / "baseline.pt"
            candidate_path.write_bytes(b"candidate")
            baseline_path.write_bytes(b"baseline")
            config = {"dataset_version": records[0].dataset_version, "artifact_schema_version": 2,
                      "architecture": "mobilenetv3-small-spatial-v2", "input_size": 256,
                      "corner_order": list(CORNER_ORDER), "training_image_hashes": []}
            models = [torch.nn.Linear(1, 1), torch.nn.Linear(1, 1), torch.nn.Linear(1, 1)]
            configs = [{**config, "model_version": name} for name in ("candidate", "baseline", "candidate")]
            def predictions(model, subset, *args, **kwargs):
                return [{**prediction(item.card_present, .9 if item.card_present else .1),
                         "sample_id": item.sample_id, "source_group": item.source_group,
                         "source_kind": "real", "capture_condition": "desk", "condition_tags": [],
                         "image_sha256": item.image_sha256, "corners": item.corners}
                        for item in subset]
            output = root / "evaluation"
            with patch("deckino_training.extraction_evaluation._load_model", side_effect=list(zip(configs, models))), \
                 patch("deckino_training.extraction_evaluation.predict", side_effect=predictions) as predict_mock, \
                 patch("deckino_training.extraction_evaluation.write_failures",
                       side_effect=lambda destination, *args, **kwargs: (destination.mkdir(parents=True, exist_ok=True),
                                                                       (destination / "failures.jsonl").write_text(""))):
                report = evaluate(manifest, candidate_path, output, "cpu", 2, 0, None, baseline_path)
            comparison = json.loads((output / "baseline-comparison.json").read_text())
            self.assertEqual("compared", comparison["status"])
            self.assertEqual(report["baseline_comparison"], comparison)
            self.assertEqual(validation_ids, [item["sample_id"] for item in comparison["samples"]])
            self.assertEqual([item.sample_id for item in predict_mock.call_args_list[0].args[1]],
                             [item.sample_id for item in predict_mock.call_args_list[1].args[1]])
            self.assertIn("baseline-comparison.json", report["artifact_checksums"])
            with patch("deckino_training.extraction_evaluation._load_model", return_value=(configs[0], models[0])), \
                 patch("deckino_training.extraction_evaluation.predict", side_effect=AssertionError("evaluation reran")):
                self.assertEqual(report, evaluate(manifest, candidate_path, output, "cpu", 2, 0, None, baseline_path))


if __name__ == "__main__":
    unittest.main()
