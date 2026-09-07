from __future__ import annotations

import tempfile
import unittest
from collections import Counter
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import torch
import numpy as np

import test_extraction as fixtures
from deckino_training.extraction import read_manifest
from deckino_training.extraction_evaluation import calibration_report, comparison_result, failure_details, summarize
from deckino_training.extraction_network import CardExtractor, geometry_loss, readable_orientation_class
from deckino_training.extraction_training import RealFirstBatches, _validate_resume


def prediction(present=True, confidence=.8, valid=True, error=.01, warp=.01, ambiguity=1.):
    return {"actual_present": present, "presence_probability": confidence, "quad_valid": valid,
            "ambiguity_margin": ambiguity, "corner_errors": [error] * 4 if present else [],
            "warp_error": warp if present else None}


class Recipe5Tests(unittest.TestCase):
    def test_geometry_objective_masks_offsets_and_orientation_for_negatives(self):
        model = CardExtractor()
        outputs = model.forward_geometry(torch.zeros(2, 3, 320, 320))
        corners = torch.tensor([[.1, .1, .9, .1, .9, .9, .1, .9], [0.] * 8])
        loss, terms = geometry_loss(outputs, corners, torch.tensor([1., 0.]))
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertGreater(terms["corner_focal_loss"].item(), 0)
        self.assertGreater(terms["mask_bce_loss"].item(), 0)
        self.assertGreaterEqual(terms["offset_loss"].item(), 0)
        self.assertGreaterEqual(terms["orientation_loss"].item(), 0)

    def test_sampling_balances_classes_and_mixes_natural_and_group_sampling(self):
        with tempfile.TemporaryDirectory() as folder:
            first = read_manifest(fixtures.ExtractionTests()._prepare(Path(folder), include_synthetic=False))[0][0]
        records = [replace(first, source_group="large", card_present=True) for _ in range(99)]
        records += [replace(first, source_group="small", card_present=True),
                    replace(first, source_group="negative", card_present=False)]
        counts = Counter()
        generator = torch.Generator().manual_seed(17)
        initial = generator.get_state()
        batches = list(RealFirstBatches(records, 16, 400, generator))
        for batch in batches:
            self.assertEqual(4, sum(not records[index].card_present for index, _ in batch))
            counts.update(records[index].source_group for index, _ in batch if records[index].card_present)
        self.assertAlmostEqual(.255, counts["small"] / (counts["small"] + counts["large"]), delta=.03)
        generator.set_state(initial)
        self.assertEqual(batches, list(RealFirstBatches(records, 16, 400, generator)))

    def test_small_batch_and_missing_class_sampling(self):
        with tempfile.TemporaryDirectory() as folder:
            first = read_manifest(fixtures.ExtractionTests()._prepare(Path(folder), include_synthetic=False))[0][0]
        records = [replace(first, card_present=True), replace(first, card_present=False)]
        batches = list(RealFirstBatches(records, 1, 1000, torch.Generator().manual_seed(7)))
        self.assertAlmostEqual(.25, sum(not records[batch[0][0]].card_present for batch in batches) / 1000, delta=.05)
        with patch("deckino_training.extraction_training.emit") as emitted:
            list(RealFirstBatches(records[:1], 4, 1, torch.Generator()))
        self.assertEqual(["negative"], emitted.call_args.kwargs["missing_classes"])

    def test_positive_sampling_keeps_rare_readable_orientations_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            first = next(item for item in read_manifest(fixtures.ExtractionTests()._prepare(
                Path(folder), include_synthetic=False))[0] if item.card_present)
        upright = np.asarray([[.2, .1], [.8, .1], [.8, .9], [.2, .9]])
        poses = [upright]
        for _ in range(3):
            poses.append(np.column_stack((1 - poses[-1][:, 1], poses[-1][:, 0])))
        records = []
        orientations = []
        for pose_index, (pose, count) in enumerate(zip(poses, (97, 1, 1, 1))):
            corners = [{"x": float(x), "y": float(y)} for x, y in pose]
            records.extend(replace(first, corners=corners, source_group="one-capture") for _ in range(count))
            orientations.extend([readable_orientation_class(pose)] * count)
        sampled = Counter()
        for batch in RealFirstBatches(records, 8, 200, torch.Generator().manual_seed(19)):
            sampled.update(orientations[index] for index, _ in batch)
        self.assertTrue(all(sampled[orientation] > 100 for orientation in range(1, 4)), sampled)

    def test_calibration_uses_presence_and_ambiguity_and_is_provisional(self):
        rows = [prediction(confidence=.82, ambiguity=.5),
                prediction(False, .99, True, ambiguity=.01)]
        report = calibration_report(rows)
        self.assertTrue(report["calibrated"])
        self.assertTrue(report["provisional"])
        self.assertGreaterEqual(report["ambiguity_margin_threshold"], .01)
        self.assertEqual(1, report["selected_metrics"]["accepted_extraction_precision"])

    def test_zero_acceptance_never_satisfies_calibration(self):
        report = calibration_report([prediction(valid=False), prediction(False, .9, False)])
        self.assertFalse(report["constraints_met"])
        self.assertEqual("constraints_unmet_legacy_fallback", report["status"])

    def test_diagnostics_keep_geometry_rejections_distinct(self):
        rejected = failure_details(prediction(ambiguity=.01), .5, .1)
        self.assertEqual(["ambiguous_geometry"], rejected["failure_reasons"])
        baseline = summarize([prediction(warp=.05), prediction(False, .1)])
        candidate = summarize([prediction(), prediction(False, .1)])
        self.assertTrue(comparison_result(candidate, baseline)["accuracy_improved"])

    def test_recipe_configuration_must_match_on_resume(self):
        for key in ("training_recipe_version", "sampling_policy", "objective", "decoder_policy",
                    "ema_policy", "batch_size", "checkpoint_selection_policy"):
            with self.assertRaisesRegex(ValueError, key):
                _validate_resume({key: 3}, {key: 4})


if __name__ == "__main__":
    unittest.main()
