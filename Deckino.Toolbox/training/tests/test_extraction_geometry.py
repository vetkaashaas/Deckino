from __future__ import annotations

import unittest

import numpy as np
import torch

from deckino_training.extraction_network import (
    CardExtractor,
    _geometry_targets,
    decode_geometry,
    geometry_loss,
    readable_orientation_class,
)


class GeometryExtractorTests(unittest.TestCase):
    def test_targets_encode_four_peaks_offsets_mask_and_readable_orientation(self):
        corners = torch.tensor([[.173, .119, .841, .203, .777, .901, .102, .798]])
        targets = _geometry_targets(corners, torch.ones(1), 80, 80)
        self.assertEqual(4, targets["corner_heatmaps"].eq(1).sum().item())
        self.assertEqual((1, 4, 80, 80), tuple(targets["semantic_corner_heatmaps"].shape))
        self.assertTrue(all(targets["semantic_corner_heatmaps"][0, index].eq(1).sum().item() == 1
                            for index in range(4)))
        self.assertEqual((1, 4, 2), tuple(targets["offsets"].shape))
        self.assertGreater(targets["masks"].sum().item(), 0)
        self.assertEqual(readable_orientation_class(corners.reshape(4, 2).numpy()),
                         targets["orientations"][0].item())

    def test_readable_orientation_class_changes_cyclically_without_reordering_annotations(self):
        upright = np.asarray([[.2, .1], [.8, .1], [.8, .9], [.2, .9]])
        rotated = np.column_stack((1 - upright[:, 1], upright[:, 0]))
        self.assertEqual(0, readable_orientation_class(upright))
        self.assertEqual(1, readable_orientation_class(rotated))

    def test_mask_guided_decoder_ignores_stronger_interior_distractor(self):
        logits = torch.full((1, 1, 80, 80), -12.)
        for y, x in ((10, 10), (10, 70), (70, 70), (70, 10)):
            logits[0, 0, y, x] = 8
        logits[0, 0, 40, 40] = 10
        mask = torch.full((1, 1, 80, 80), -10.)
        mask[:, :, 10:71, 10:71] = 10
        outputs = {"corner_logits": logits, "offsets": torch.zeros(1, 2, 80, 80),
                   "mask_logits": mask, "orientation_logits": torch.tensor([[10., 0., 0., 0.]]),
                   "presence_logits": torch.ones(1)}
        corners, details = decode_geometry(outputs)
        expected = torch.tensor([[10/79, 10/79, 70/79, 10/79, 70/79, 70/79, 10/79, 70/79]])
        self.assertTrue(torch.allclose(expected, corners, atol=1e-6))
        self.assertTrue(details[0]["geometry_valid"])
        self.assertGreater(details[0]["mask_iou"], .9)

    def test_semantic_heatmaps_recover_a_generic_miss_and_assign_readable_order(self):
        generic = torch.full((1, 1, 80, 80), -12.)
        semantic = torch.full((1, 4, 80, 80), -12.)
        points = ((10, 10), (10, 70), (70, 70), (70, 10))
        for role, (y, x) in enumerate(points):
            semantic[0, role, y, x] = 12
            if role != 1:
                generic[0, 0, y, x] = 8
        generic[0, 0, 40, 40] = 9
        mask = torch.full((1, 1, 80, 80), -10.)
        mask[:, :, 10:71, 10:71] = 10
        outputs = {"corner_logits": generic, "semantic_corner_logits": semantic,
                   "offsets": torch.zeros(1, 2, 80, 80), "mask_logits": mask,
                   "orientation_logits": torch.zeros(1, 4), "presence_logits": torch.ones(1)}
        corners, details = decode_geometry(outputs)
        expected = torch.tensor([[10/79, 10/79, 70/79, 10/79, 70/79, 70/79, 10/79, 70/79]])
        self.assertTrue(torch.allclose(expected, corners, atol=1e-6))
        self.assertEqual(0, details[0]["orientation_class"])
        self.assertTrue(all(score > .99 for score in details[0]["semantic_corner_scores"]))
        self.assertGreater(details[0]["semantic_ambiguity_margin"], 10)

    def test_no_card_masks_offset_and_orientation_loss_but_trains_rejection_heads(self):
        model = CardExtractor()
        outputs = model.forward_geometry(torch.zeros(2, 3, 320, 320))
        loss, terms = geometry_loss(outputs, torch.zeros(2, 8), torch.zeros(2))
        loss.backward()
        self.assertEqual(0, terms["offset_loss"].item())
        self.assertEqual(0, terms["orientation_loss"].item())
        self.assertGreater(terms["corner_focal_loss"].item(), 0)
        self.assertGreater(terms["semantic_corner_focal_loss"].item(), 0)
        self.assertGreater(terms["mask_bce_loss"].item(), 0)
        self.assertGreater(terms["presence_loss"].item(), 0)


if __name__ == "__main__":
    unittest.main()
