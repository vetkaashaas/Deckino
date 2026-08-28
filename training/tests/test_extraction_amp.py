from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from deckino_training.extraction_network import CardExtractor
from deckino_training.extraction_training import _optimizer_update, learning_check, train
import test_extraction as fixtures


class TinyExtractor(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.ones(8))

    def forward_with_heatmaps(self, images):
        corners = self.weight[None] * images[:, 0, 0, 0, None]
        presence = self.weight.mean().expand(len(images))
        heatmaps = self.weight[:4][None, :, None, None].expand(len(images), 4, 4, 4)
        return corners, presence, heatmaps


class ExtractionAmpTests(unittest.TestCase):
    def setUp(self):
        self.images = torch.ones(2, 3, 8, 8)
        self.corners = torch.tensor([[.2, .2, .8, .2, .8, .8, .2, .8]] * 2)
        self.presence = torch.tensor([1., 0.])

    def update(self, model, optimizer, scaler, retries=16):
        return _optimizer_update(model, optimizer, scaler, self.images, self.corners,
                                 self.presence, torch.device("cpu"), "Test learning", 7, retries)

    def test_overflow_skips_mutation_reduces_scale_then_completes_exactly_one_update(self):
        reference = TinyExtractor()
        optimizer = torch.optim.AdamW(reference.parameters(), lr=.01)
        self.update(reference, optimizer, torch.amp.GradScaler("cpu"))

        model = TinyExtractor()
        optimizer = torch.optim.AdamW(model.parameters(), lr=.01)
        scaler = torch.amp.GradScaler("cpu")
        before = model.weight.detach().clone()
        attempts = []
        def overflow_once(gradient):
            attempts.append(model.weight.detach().clone())
            return torch.full_like(gradient, float("inf")) if len(attempts) == 1 else gradient
        model.weight.register_hook(overflow_once)
        with patch("deckino_training.extraction_training.emit") as emitted:
            loss, _, retries = self.update(model, optimizer, scaler)
        self.assertEqual(1, retries)
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(all(torch.equal(before, value) for value in attempts))
        self.assertTrue(torch.equal(reference.weight, model.weight))
        self.assertEqual(1, optimizer.state[model.weight]["step"].item())
        self.assertEqual(32768., scaler.get_scale())
        emitted.assert_called_once()
        self.assertEqual(7, emitted.call_args.kwargs["optimizer_updates"])
        self.assertTrue(emitted.call_args.kwargs["retrying"])
        restored = torch.amp.GradScaler("cpu")
        restored.load_state_dict(scaler.state_dict())
        self.assertEqual(scaler.state_dict(), restored.state_dict())

    def test_persistent_overflow_stops_without_corrupting_weights_or_optimizer(self):
        model = TinyExtractor()
        original = model.weight.detach().clone()
        model.weight.register_hook(lambda gradient: torch.full_like(gradient, float("inf")))
        optimizer = torch.optim.AdamW(model.parameters())
        scaler = torch.amp.GradScaler("cpu")
        with patch("deckino_training.extraction_training.emit") as emitted:
            with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                self.update(model, optimizer, scaler, retries=2)
        self.assertEqual(3, emitted.call_count)
        self.assertFalse(emitted.call_args.kwargs["retrying"])
        self.assertTrue(torch.equal(original, model.weight))
        self.assertEqual({}, optimizer.state)
        self.assertIsNone(model.weight.grad)
        self.assertEqual(8192., scaler.get_scale())

    def test_full_precision_nonfinite_gradients_remain_fatal(self):
        model = TinyExtractor()
        model.weight.register_hook(lambda gradient: torch.full_like(gradient, float("nan")))
        optimizer = torch.optim.AdamW(model.parameters())
        with self.assertRaisesRegex(RuntimeError, "without AMP"):
            self.update(model, optimizer, torch.amp.GradScaler("cpu", enabled=False))
        self.assertTrue(torch.isfinite(model.weight).all())
        self.assertEqual({}, optimizer.state)

    def test_nonfinite_forward_loss_is_not_retried(self):
        model = TinyExtractor()
        optimizer = torch.optim.AdamW(model.parameters())
        self.images.fill_(float("nan"))
        with patch("deckino_training.extraction_training.emit") as emitted:
            with self.assertRaisesRegex(RuntimeError, "non-finite forward loss"):
                self.update(model, optimizer, torch.amp.GradScaler("cpu"))
        emitted.assert_not_called()
        self.assertEqual({}, optimizer.state)

    def test_finite_elements_with_overflowing_norm_do_not_reach_optimizer(self):
        model = TinyExtractor()
        model.weight.register_hook(lambda gradient: torch.full_like(gradient, 1e30))
        optimizer = torch.optim.AdamW(model.parameters())
        with self.assertRaisesRegex(RuntimeError, "total norm"):
            self.update(model, optimizer, torch.amp.GradScaler("cpu", init_scale=1.))
        self.assertTrue(torch.isfinite(model.weight).all())
        self.assertEqual({}, optimizer.state)

    def test_learning_and_full_training_count_only_successful_updates_and_save_recovery(self):
        scaler_class = torch.amp.GradScaler
        def model_with_initial_overflow(pretrained=False):
            model = CardExtractor(pretrained=pretrained)
            calls = 0
            def overflow_once(gradient):
                nonlocal calls
                calls += 1
                return torch.full_like(gradient, float("inf")) if calls == 1 else gradient
            model.corner_head.weight.register_hook(overflow_once)
            return model

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = fixtures.ExtractionTests()._prepare(root, include_synthetic=False)
            with patch("deckino_training.extraction_training.CardExtractor", side_effect=model_with_initial_overflow), \
                 patch("torch.amp.GradScaler", side_effect=lambda *args, **kwargs: scaler_class("cpu")):
                train(manifest, root / "artifacts", "full", 1, 2, 3e-4, 0, False, None, "cpu", 7, None, max_batches=2)
                # Reproduce the user's pre-fix checkpoint saved at update zero.
                with self.assertRaisesRegex(RuntimeError, "learning check failed"):
                    learning_check(manifest, root / "artifacts", "learning", "cpu", 8, 0, 7, None, max_updates=0, pretrained=False)
                last = root / "artifacts/learning/last.pt"
                original = torch.load(last, map_location="cpu", weights_only=False)
                original.pop("amp_overflow_retries")
                original.pop("amp_overflow_retry_limit")
                torch.save(original, last)
                with self.assertRaisesRegex(RuntimeError, "learning check failed"):
                    learning_check(manifest, root / "artifacts", "learning", "cpu", 8, 0, 7, None, max_updates=1, pretrained=False)
            for name, updates in (("full", 2), ("learning", 1)):
                checkpoint = torch.load(root / f"artifacts/{name}/last.pt", map_location="cpu", weights_only=False)
                self.assertEqual(updates, checkpoint["optimizer_updates"])
                self.assertEqual(1, checkpoint["amp_overflow_retries"])
                self.assertEqual(32768., checkpoint["scaler_state"]["scale"])
                self.assertTrue(all(state["step"].item() == updates for state in checkpoint["optimizer_state"]["state"].values()))
            report = json.loads((root / "artifacts/learning/learning-check.json").read_text())
            self.assertEqual(1, report["amp_overflow_retries"])
            self.assertEqual(1, report["optimizer_updates"])


if __name__ == "__main__":
    unittest.main()
