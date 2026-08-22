from __future__ import annotations

import unittest

import torch
from PIL import Image

from deckino_training.model import ArcMarginProduct, EmbeddingNetwork, crop_card_art


class ModelTests(unittest.TestCase):
    def test_embedding_and_arcface_shapes(self) -> None:
        model = EmbeddingNetwork(embedding_dim=64, pretrained=False)
        head = ArcMarginProduct(embedding_dim=64, class_count=20)
        images = torch.rand(2, 3, 224, 224)
        embeddings = model(images)
        logits = head(embeddings, torch.tensor([0, 1]))

        self.assertEqual(tuple(embeddings.shape), (2, 64))
        self.assertEqual(tuple(logits.shape), (2, 20))
        torch.testing.assert_close(embeddings.norm(dim=1), torch.ones(2), atol=1e-5, rtol=1e-5)

    def test_full_card_art_crop_can_be_forced_or_detected(self) -> None:
        full_card = Image.new("RGB", (630, 880))
        art = Image.new("RGB", (672, 936))

        self.assertEqual(crop_card_art(full_card, "auto").size, (530, 334))
        self.assertEqual(crop_card_art(full_card, "card").size, (530, 334))
        self.assertEqual(crop_card_art(art, "art").size, art.size)


if __name__ == "__main__":
    unittest.main()
