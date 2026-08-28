from __future__ import annotations

import json
import tempfile
import unittest
from collections import Counter
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import torch

import test_extraction as fixtures
from deckino_training.extraction import read_manifest
from deckino_training.extraction_network import spatial_loss
from deckino_training.extraction_training import RealFirstBatches, train, _validate_resume
from deckino_training.extraction_evaluation import calibration_report, summarize, failure_details, comparison_result


def prediction(present=True, confidence=.8, valid=True, error=.01, warp=.01):
    return {"actual_present": present, "presence_probability": confidence, "quad_valid": valid,
            "corner_errors": [error] * 4 if present else [], "warp_error": warp if present else None}


class Recipe3Tests(unittest.TestCase):
    def test_coordinate_objective_weights_worst_corner_per_positive_photo(self):
        targets = torch.tensor([[.1, .1, .9, .1, .9, .9, .1, .9]] * 2)
        predicted = targets.clone()
        predicted[0, 0] += .1
        predicted[1] += 10  # Negative labels cannot change localization.
        _, terms = spatial_loss(predicted, torch.zeros(2), torch.zeros(2, 4, 64, 64), targets, torch.tensor([1., 0.]))
        self.assertAlmostEqual(4 * terms["mean_corner_loss"].item(), terms["worst_corner_loss"].item())
        self.assertAlmostEqual(terms["corner_loss"].item(),
            .5 * (terms["mean_corner_loss"] + terms["worst_corner_loss"]).item())

    def test_sampling_balances_classes_and_mixes_natural_and_group_sampling(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = fixtures.ExtractionTests()._prepare(Path(folder), include_synthetic=False)
            first = read_manifest(manifest)[0][0]
        records = [replace(first, source_group="large", card_present=True) for _ in range(99)]
        records += [replace(first, source_group="small", card_present=True),
                    replace(first, source_group="negative", card_present=False)]
        counts = Counter()
        generator = torch.Generator().manual_seed(17)
        initial = generator.get_state()
        batches = list(RealFirstBatches(records, 16, 400, generator))
        for batch in batches:
            self.assertEqual(4, sum(not records[i].card_present for i, _ in batch))
            counts.update(records[i].source_group for i, _ in batch if records[i].card_present)
        self.assertAlmostEqual(.255, counts["small"] / (counts["small"] + counts["large"]), delta=.03)
        generator.set_state(initial)
        self.assertEqual(batches, list(RealFirstBatches(records, 16, 400, generator)))

    def test_small_batch_and_missing_class_sampling(self):
        with tempfile.TemporaryDirectory() as folder:
            first = read_manifest(fixtures.ExtractionTests()._prepare(Path(folder), include_synthetic=False))[0][0]
        records = [replace(first, card_present=True), replace(first, card_present=False)]
        batches = list(RealFirstBatches(records, 1, 1000, torch.Generator().manual_seed(7)))
        self.assertAlmostEqual(.25, sum(not records[b[0][0]].card_present for b in batches) / 1000, delta=.05)
        with patch("deckino_training.extraction_training.emit") as emit:
            list(RealFirstBatches(records[:1], 4, 1, torch.Generator()))
        self.assertEqual(["negative"], emit.call_args.kwargs["missing_classes"])

    def test_calibration_uses_geometry_and_reports_provisional_evidence(self):
        rows = [prediction(confidence=.82), prediction(False, .99, False)]
        report = calibration_report(rows)
        self.assertTrue(report["calibrated"])
        self.assertTrue(report["provisional"])
        self.assertEqual(.82, report["presence_threshold"])
        self.assertTrue(any(.82 < row["threshold"] < .99 for row in report["candidates"]))
        metrics = report["selected_metrics"]
        self.assertEqual(1, metrics["negative_false_positive_rate"])
        self.assertEqual(0, metrics["negative_acceptance_rate"])
        self.assertEqual(1, metrics["accepted_extraction_precision"])

    def test_calibration_missing_classes_ties_infeasible_and_empty_acceptance(self):
        self.assertEqual("missing_presence_class", calibration_report([])["status"])
        self.assertEqual(.5, calibration_report([prediction()])["presence_threshold"])
        for rows in ([prediction(confidence=.8), prediction(False, .8)],
                     [prediction(valid=False), prediction(False, .9, False)]):
            report = calibration_report(rows)
            self.assertFalse(report["constraints_met"])
            self.assertFalse(report["calibrated"])
            self.assertEqual("constraints_unmet_legacy_fallback", report["status"])
        rows = [prediction(), *[prediction(False, .1)] * 200]
        self.assertFalse(calibration_report(rows)["provisional"])

    def test_diagnostics_and_improvement_gate_keep_rejections_distinct(self):
        rejected = failure_details(prediction(confidence=.8), .97)
        self.assertEqual(["confidence_rejection"], rejected["failure_reasons"])
        negative = failure_details(prediction(False, .99, False), .97)
        self.assertFalse(negative["accepted"])
        self.assertIn("presence_false_positive", negative["failure_reasons"])
        baseline = summarize([prediction(warp=.05), prediction(False, .1)])
        candidate = summarize([prediction(), prediction(False, .1)])
        self.assertTrue(comparison_result(candidate, baseline)["accuracy_improved"])
        candidate["p95_corner_error"] = .2
        self.assertFalse(comparison_result(candidate, baseline)["accuracy_improved"])

    def test_recipe_and_sampler_configuration_must_match_on_resume(self):
        for key in ("training_recipe_version", "sampling_policy", "objective", "finishing_policy", "batch_size"):
            with self.assertRaisesRegex(ValueError, key):
                _validate_resume({key: 2}, {key: 3})

    def test_finishing_transition_and_epoch_resume_preserve_best_main_weights(self):
        with tempfile.TemporaryDirectory() as folder, patch("deckino_training.extraction_training.FINISHING_EPOCHS", 2):
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            # Inject deterministic validation scores; actual training and checkpoints remain real.
            def metrics_for_phase(model, *args, **kwargs):
                return [prediction(), prediction(False, .1)]
            def run(name, resume=None):
                return train(manifest, root / "artifacts", name, 1, 2, 3e-4, 0, False, resume, "cpu", 7, None, max_batches=1)
            with patch("deckino_training.extraction_training.predict", side_effect=metrics_for_phase):
                run("continuous")
                for event_to_stop in ("extraction_finishing_started", "extraction_epoch_completed"):
                    name = event_to_stop
                    def stop(event, **values):
                        if event == event_to_stop and (event == "extraction_finishing_started" or values.get("phase") == "finishing"):
                            raise InterruptedError("durable finishing checkpoint")
                    with patch("deckino_training.extraction_training.emit", side_effect=stop), self.assertRaises(InterruptedError):
                        run(name)
                    last = root / "artifacts" / name / "last.pt"
                    run(name, last)
                    actual = torch.load(last, weights_only=False, map_location="cpu")
                    expected = torch.load(root / "artifacts/continuous/last.pt", weights_only=False, map_location="cpu")
                    self.assertEqual(expected["history"], actual["history"])
                    for key, value in expected["model_state"].items():
                        self.assertTrue(torch.equal(value, actual["model_state"][key]), key)
                    best = torch.load(last.with_name("best.pt"), weights_only=False, map_location="cpu")
                    self.assertEqual(1, best["epoch"])
                    self.assertEqual("main", best["training_phase"])
                    self.assertEqual(2, actual["phase_epoch"])
                    self.assertTrue(all(row["sampled_synthetic"] == 0 for row in actual["history"] if row["phase"] == "finishing"))
                    self.assertEqual({"backbone": 3e-6, "heads": 3e-5}, actual["history"][-1]["learning_rates"])
                    # A completed resume is a no-op, not another 20 finishing epochs.
                    with patch("deckino_training.extraction_training._optimizer_update", side_effect=AssertionError("updated completed run")):
                        run(name, last)


if __name__ == "__main__":
    unittest.main()
