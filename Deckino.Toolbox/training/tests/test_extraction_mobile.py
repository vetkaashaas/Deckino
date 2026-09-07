from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import torch

from deckino_training.cli import build_parser
from deckino_training.extraction_mobile import (NormalizedGeometryExporter, _has_semantic,
                                                _output_names, resolve_checkpoint)
from deckino_training.extraction_network import Recipe4CardExtractor, Recipe6CardExtractor


class ExtractionMobileTests(unittest.TestCase):
    def test_recipe4_export_wrapper_omits_semantic_head(self):
        model = Recipe4CardExtractor().eval()
        wrapper = NormalizedGeometryExporter(model, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5)).eval()
        self.assertFalse(_has_semantic(model))
        self.assertEqual(
            ("corner_logits", "offsets", "mask_logits", "orientation_logits", "presence_logits"),
            _output_names(model),
        )
        with torch.inference_mode():
            outputs = wrapper(torch.rand(1, 3, 320, 320))
        self.assertEqual(5, len(outputs))
        self.assertEqual((1, 1, 80, 80), tuple(outputs[0].shape))
        self.assertEqual((1, 2, 80, 80), tuple(outputs[1].shape))
        self.assertEqual((1,), tuple(outputs[4].shape))

    def test_recipe6_export_wrapper_includes_semantic_head(self):
        model = Recipe6CardExtractor().eval()
        self.assertTrue(_has_semantic(model))
        self.assertIn("semantic_corner_logits", _output_names(model))
        wrapper = NormalizedGeometryExporter(model, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5)).eval()
        with torch.inference_mode():
            outputs = wrapper(torch.rand(1, 3, 320, 320))
        self.assertEqual(6, len(outputs))
        self.assertEqual((1, 4, 80, 80), tuple(outputs[5].shape))

    def test_resolve_checkpoint_prefers_current_pointer(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            artifacts = root / "artifacts"
            version = "extractor-run-20260829T155011729Z"
            folder = artifacts / version
            folder.mkdir(parents=True)
            (folder / "extractor.pt").write_bytes(b"weights")
            (root / "current-extraction.json").write_text(json.dumps({
                "model_version": version,
                "files": {"checkpoint": "extractor.pt"},
            }), encoding="utf-8")
            path, resolved = resolve_checkpoint(artifacts, None, None)
            self.assertEqual(version, resolved)
            self.assertEqual(folder / "extractor.pt", path)

    def test_cli_exposes_export_extraction_mobile(self):
        parser = build_parser()
        arguments = parser.parse_args([
            "export-extraction-mobile",
            "--artifacts-root", "data/training/artifacts",
            "--output", "data/training/mobile/extractor/test",
            "--model-version", "extractor-run-20260829T155011729Z",
        ])
        self.assertEqual("export-extraction-mobile", arguments.command)
        self.assertEqual("cpu", arguments.device)
