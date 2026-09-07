from __future__ import annotations

import json
import tempfile
import unittest
from collections import Counter
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import torch
import numpy as np

import test_extraction as fixtures
from deckino_training.extraction import _load_model, read_manifest
from deckino_training.extraction_evaluation import (calibration_report, comparison_result, failure_details,
                                                     selection_key, selection_operating_point,
                                                     semantic_orientation_shift, summarize, write_failures)
from deckino_training.extraction_groups import assign_groups
from deckino_training.extraction_network import (CORNER_ANCHOR_POLICY, LEGACY_CORNER_ANCHOR_POLICY,
                                                  RECIPE6_ARCHITECTURE, RECIPE7_ARCHITECTURE,
                                                  CardExtractor, Recipe6CardExtractor, Recipe7CardExtractor,
                                                  _decode_one, corner_anchor_policy_for_config,
                                                  geometry_loss, readable_orientation_class)
from deckino_training.extraction_training import RealFirstBatches, _validate_resume


def prediction(present=True, confidence=.8, valid=True, error=.01, warp=.01, ambiguity=1.):
    return {"actual_present": present, "presence_probability": confidence, "quad_valid": valid,
            "ambiguity_margin": ambiguity, "corner_errors": [error] * 4 if present else [],
            "warp_error": warp if present else None}


class Recipe8Tests(unittest.TestCase):
    def test_geometry_objective_masks_offsets_and_orientation_for_negatives(self):
        model = CardExtractor()
        outputs = model.forward_geometry(torch.zeros(2, 3, 320, 320))
        corners = torch.tensor([[.1, .1, .9, .1, .9, .9, .1, .9], [0.] * 8])
        loss, terms = geometry_loss(outputs, corners, torch.tensor([1., 0.]))
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertGreater(terms["corner_focal_loss"].item(), 0)
        self.assertGreater(terms["semantic_role_loss"].item(), 0)
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
        self.assertAlmostEqual(.305, counts["small"] / (counts["small"] + counts["large"]), delta=.03)
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

    def test_checkpoint_selection_calibrates_scarce_negative_scores(self):
        candidate = [prediction(confidence=.96, warp=.01), prediction(confidence=.95, warp=.01),
                     prediction(False, confidence=.90, valid=True)]
        operating = selection_operating_point(candidate)
        self.assertTrue(operating["constraints_met"])
        self.assertGreater(operating["presence_threshold"], .90)
        self.assertEqual(0, operating["metrics"]["negative_acceptance_rate"])

        weak_geometry = [prediction(confidence=.96, warp=.08, error=.08),
                         prediction(confidence=.95, warp=.08, error=.08),
                         prediction(False, confidence=.1, valid=True)]
        self.assertGreater(selection_key(candidate), selection_key(weak_geometry))

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

    def test_correct_negative_is_not_reported_as_invalid_geometry_failure(self):
        negative = prediction(False, .1, False, ambiguity=-1e9)
        details = failure_details(negative, .5, .1)
        self.assertEqual([], details["failure_reasons"])

        metrics = summarize([prediction(ambiguity=.75), negative])
        self.assertEqual(.75, metrics["mean_ambiguity_margin"])
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            write_failures(output, [prediction(), negative], [], output, .5, .1)
            self.assertEqual("", (output / "failures.jsonl").read_text())
            self.assertEqual({"failures": []}, json.loads(
                (output / "diagnostics/failures/index.json").read_text()))

    def test_decoder_clamps_subcell_offsets_at_tensor_border(self):
        corner_logits = torch.full((1, 80, 80), -20.)
        offsets = torch.zeros((2, 80, 80))
        for y, x in ((0, 0), (0, 79), (79, 79), (79, 0)):
            corner_logits[0, y, x] = 20.
            offsets[:, y, x] = torch.tensor([-.5 if x == 0 else .5,
                                              -.5 if y == 0 else .5])
        values, details = _decode_one(corner_logits, offsets, torch.full((1, 80, 80), 20.),
                                      torch.zeros(4))
        self.assertTrue(details["geometry_valid"])
        self.assertEqual(1, details["candidate_count"])
        self.assertTrue(all(0. <= value <= 1. for value in values))

    def test_orientation_head_preserves_spatial_layout_and_older_recipes_still_load(self):
        model = CardExtractor()
        outputs = model.forward_geometry(torch.zeros(2, 3, 320, 320))
        self.assertEqual((2, 4), tuple(outputs["orientation_logits"].shape))
        self.assertEqual((128, 2496), tuple(model.orientation_head[0].weight.shape))

        old_model = Recipe6CardExtractor()
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / "recipe6.pt"
            torch.save({"artifact_schema_version": 2, "architecture": RECIPE6_ARCHITECTURE,
                        "input_size": 320, "model_state": old_model.state_dict()}, checkpoint)
            _, loaded = _load_model(checkpoint, torch.device("cpu"))
        self.assertIsInstance(loaded, Recipe6CardExtractor)

        recipe7 = Recipe7CardExtractor()
        model.load_state_dict(recipe7.state_dict())
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / "recipe7.pt"
            torch.save({"artifact_schema_version": 2, "architecture": RECIPE7_ARCHITECTURE,
                        "input_size": 320, "model_state": recipe7.state_dict()}, checkpoint)
            config, loaded = _load_model(checkpoint, torch.device("cpu"))
        self.assertIsInstance(loaded, Recipe7CardExtractor)
        self.assertNotIsInstance(loaded, CardExtractor)
        self.assertEqual(LEGACY_CORNER_ANCHOR_POLICY, corner_anchor_policy_for_config(config))

    def test_recipe8_anchor_is_stable_across_small_top_edge_tilts(self):
        top_right_higher = np.asarray([[.2, .101], [.8, .099], [.8, .9], [.2, .9]])
        top_left_higher = np.asarray([[.2, .099], [.8, .101], [.8, .9], [.2, .9]])
        self.assertEqual(0, readable_orientation_class(top_right_higher, CORNER_ANCHOR_POLICY))
        self.assertEqual(0, readable_orientation_class(top_left_higher, CORNER_ANCHOR_POLICY))
        self.assertEqual(3, readable_orientation_class(top_right_higher, LEGACY_CORNER_ANCHOR_POLICY))
        self.assertEqual(0, readable_orientation_class(top_left_higher, LEGACY_CORNER_ANCHOR_POLICY))

    def test_recipe8_anchor_retains_four_phone_rotations(self):
        pose = np.asarray([[.2, .1], [.8, .1], [.8, .9], [.2, .9]])
        orientations = []
        for _ in range(4):
            orientations.append(readable_orientation_class(pose))
            pose = np.column_stack((1 - pose[:, 1], pose[:, 0]))
        self.assertEqual([0, 1, 2, 3], orientations)

    def test_orientation_metric_scores_final_semantic_corner_order(self):
        actual = [(20., 10.), (80., 11.), (79., 90.), (21., 89.)]
        predicted = [(20.2, 10.4), (79.8, 10.8), (79.1, 89.7), (20.8, 89.2)]
        self.assertEqual(0, semantic_orientation_shift(predicted, actual))
        self.assertEqual(2, semantic_orientation_shift(predicted[2:] + predicted[:2], actual))

    def test_group_assignment_balances_independent_sessions(self):
        groups = {f"session-{index}": {"counts": Counter(samples=1000 if index == 0 else 10,
                                                            positive=10), "requested": None}
                  for index in range(12)}
        assignments = assign_groups(groups, 17)
        counts = Counter(assignments.values())
        self.assertTrue(all(counts[split] >= 1 for split in ("train", "validation", "test")))

    def test_recipe_configuration_must_match_on_resume(self):
        for key in ("training_recipe_version", "corner_anchor_policy", "sampling_policy", "objective", "decoder_policy",
                    "ema_policy", "batch_size", "checkpoint_selection_policy", "coordinate_transform",
                    "amp_initial_loss_scale"):
            with self.assertRaisesRegex(ValueError, key):
                _validate_resume({key: 3}, {key: 4})


if __name__ == "__main__":
    unittest.main()
