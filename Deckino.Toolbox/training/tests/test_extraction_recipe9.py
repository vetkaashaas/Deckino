from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import torch

from deckino_training.extraction import _load_model
from deckino_training.extraction_network import (ARCHITECTURE, CORNER_ANCHOR_POLICY, LEGACY_OFFSET_RANGE,
                                                  OFFSET_RANGE, RECIPE8_ARCHITECTURE, CardExtractor,
                                                  Recipe8CardExtractor, _geometry_targets, corner_anchor_policy_for_config,
                                                  decode_geometry, geometry_loss, offset_range_for_config)

CORNERS = torch.tensor([[.2013, .1987, .8021, .2114, .7932, .8006, .1978, .7891]])


def _planted_outputs(targets, index: int = 0) -> dict[str, torch.Tensor]:
    heatmap = targets["corner_heatmaps"][index:index + 1]
    offsets = torch.zeros(1, 2, 80, 80)
    for corner in range(4):
        for cell, offset in zip(targets["neighborhood_cells"][index, corner],
                                targets["neighborhood_offsets"][index, corner]):
            offsets[0, :, cell[1], cell[0]] = offset
    return {"corner_logits": torch.logit(heatmap.clamp(1e-4, 1 - 1e-4)), "offsets": offsets,
            "mask_logits": torch.full((1, 1, 80, 80), 5.), "orientation_logits": torch.zeros(1, 4)}


class Recipe9Tests(unittest.TestCase):
    def test_heatmap_is_centred_on_exact_position_with_one_focal_peak_per_corner(self):
        targets = _geometry_targets(CORNERS, torch.ones(1), 80, 80)
        self.assertEqual(4, int(targets["corner_heatmaps"].eq(1).sum()))
        legacy = _geometry_targets(CORNERS, torch.ones(1), 80, 80, subpixel=False)
        # The sub-cell target differs from the rounded-cell target around each peak.
        self.assertFalse(torch.allclose(targets["corner_heatmaps"], legacy["corner_heatmaps"]))
        exact = CORNERS.reshape(4, 2) * 79
        for corner in range(4):
            cells = targets["neighborhood_cells"][0, corner].float()
            self.assertTrue(torch.allclose(cells + targets["neighborhood_offsets"][0, corner], exact[corner].expand(9, 2)))
            self.assertLessEqual(float(targets["neighborhood_offsets"][0, corner].abs().max()), OFFSET_RANGE)

    def test_decoder_recovers_exact_corners_when_peak_is_one_cell_away(self):
        targets = _geometry_targets(CORNERS, torch.ones(1), 80, 80)
        outputs = _planted_outputs(targets)
        # Move the top-left peak one cell right: the neighbourhood-trained offset still lands exactly.
        x, y = targets["cells"][0, 0].tolist()
        outputs["corner_logits"][0, 0, y, x] = torch.logit(torch.tensor(.9))
        outputs["corner_logits"][0, 0, y, x + 1] = 10.
        corners, _ = decode_geometry(outputs, CORNER_ANCHOR_POLICY, OFFSET_RANGE)
        self.assertTrue(torch.allclose(corners, CORNERS, atol=1e-5))
        legacy, _ = decode_geometry(outputs, CORNER_ANCHOR_POLICY, LEGACY_OFFSET_RANGE)
        self.assertFalse(torch.allclose(legacy, CORNERS, atol=1e-3))

    def test_offset_loss_supervises_the_full_neighbourhood(self):
        model = CardExtractor()
        outputs = model.forward_geometry(torch.zeros(1, 3, 320, 320))
        with torch.no_grad():
            outputs["offsets"].zero_()
        _, parts = geometry_loss(outputs, CORNERS, torch.ones(1))
        _, legacy = geometry_loss(outputs, CORNERS, torch.ones(1), subpixel=False)
        # Zero offsets are far from the +-1 cell neighbour targets but close to the centre-cell target.
        self.assertGreater(parts["offset_loss"].item(), legacy["offset_loss"].item())

    def test_recipe8_checkpoints_keep_their_decoder_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / "recipe8.pt"
            torch.save({"artifact_schema_version": 2, "architecture": RECIPE8_ARCHITECTURE, "input_size": 320,
                        "model_state": Recipe8CardExtractor().state_dict()}, checkpoint)
            config, model = _load_model(checkpoint, torch.device("cpu"))
        self.assertIsInstance(model, Recipe8CardExtractor)
        self.assertNotIsInstance(model, CardExtractor)
        self.assertEqual(LEGACY_OFFSET_RANGE, offset_range_for_config(config))
        self.assertEqual(CORNER_ANCHOR_POLICY, corner_anchor_policy_for_config(config))
        self.assertEqual(OFFSET_RANGE, offset_range_for_config({"architecture": ARCHITECTURE}))


if __name__ == "__main__":
    unittest.main()
