from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import torch
from PIL import Image, ImageDraw

from deckino_training.cli import build_parser
from deckino_training.extraction import (
    CORNER_ORDER,
    CardExtractor,
    evaluate_extractor,
    letterbox,
    prepare_extraction_dataset,
    read_manifest,
    train_extractor,
    unletterbox,
)
from deckino_training.extraction_network import spatial_loss


class ExtractionTests(unittest.TestCase):
    def _write_annotation(
        self,
        data_root: Path,
        group: str,
        index: int,
        *,
        present: bool,
        duplicate_source: Path | None = None,
    ) -> tuple[Path, Path]:
        folder = data_root / "training" / "camera" / "imports" / group
        folder.mkdir(parents=True, exist_ok=True)
        image_path = folder / f"capture-{index}.jpg"
        if duplicate_source is None:
            image = Image.new("RGB", (320, 480), (30 + index * 17, 55 + index * 11, 80 + index * 7))
            draw = ImageDraw.Draw(image)
            draw.line((0, index * 19 % 480, 319, (index * 53 + 120) % 480), fill="white", width=7)
            draw.rectangle((70, 70, 250, 400), outline=(10 + index * 13, 220, 50), width=8)
            image.save(image_path, quality=96, subsampling=0)
        else:
            image_path.write_bytes(duplicate_source.read_bytes())
        corners = {
            "TopLeft": {"X": 0.22, "Y": 0.15},
            "TopRight": {"X": 0.79, "Y": 0.17},
            "BottomRight": {"X": 0.82, "Y": 0.84},
            "BottomLeft": {"X": 0.19, "Y": 0.82},
        }
        payload = {
            "SchemaVersion": 1,
            "DatasetVersion": "corners-v1",
            "ImageFile": image_path.name,
            "CardPresent": present,
            "CornerOrder": list(CORNER_ORDER),
            "ImageWidth": 320,
            "ImageHeight": 480,
            "SourceGroup": group,
            "CaptureCondition": "desk-light" if present else "no-card",
            "Split": None,
            **(corners if present else {name: None for name in CORNER_ORDER}),
        }
        sidecar = folder / f"{image_path.stem}._annotations.json"
        sidecar.write_text(json.dumps(payload), encoding="utf-8")
        return image_path, sidecar

    def _prepare(self, root: Path, *, include_synthetic: bool = True) -> Path:
        first, _ = self._write_annotation(root, "session-0", 0, present=True)
        for index in range(1, 7):
            self._write_annotation(root, f"session-{index}", index, present=True)
        self._write_annotation(root, "duplicate-session", 20, present=True, duplicate_source=first)
        for index in range(3):
            self._write_annotation(root, f"negative-session-{index}", 30 + index, present=False)
        full_cards = root / "training" / "extraction" / "full-cards"
        full_cards.mkdir(parents=True)
        Image.new("RGB", (315, 440), (70, 90, 160)).save(full_cards / "card.jpg")
        prepare_extraction_dataset(root, "corners-v1", synthetic_per_card=4, include_synthetic=include_synthetic)
        return root / "exports" / "corners-v1" / "manifest.jsonl"

    def test_preparation_is_grouped_deterministic_and_writes_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest = self._prepare(root)
            first_bytes = manifest.read_bytes()
            records, _, metadata = read_manifest(manifest)

            prepare_extraction_dataset(root, "corners-v1", synthetic_per_card=4, include_synthetic=True)

            self.assertEqual(first_bytes, manifest.read_bytes())
            duplicate_records = [record for record in records if record.image_path.endswith("capture-0.jpg") or record.image_path.endswith("capture-20.jpg")]
            self.assertEqual(1, len({record.source_group for record in duplicate_records}))
            self.assertEqual(1, len({record.split for record in duplicate_records}))
            synthetic = [record for record in records if record.parent_card_id is not None]
            self.assertEqual(1, len({record.split for record in synthetic}))
            self.assertTrue(all(record.generation_recipe for record in synthetic))
            self.assertTrue(any(record.source_kind == "synthetic-negative" for record in records))
            self.assertEqual(list(CORNER_ORDER), metadata["corner_order"])
            self.assertEqual("round-half-to-even", metadata["input"]["resize_rounding"])

            sidecar = next((root / "training" / "camera" / "imports").rglob("*._annotations.json"))
            changed = json.loads(sidecar.read_text(encoding="utf-8"))
            changed["CaptureCondition"] = "changed-after-versioning"
            sidecar.write_text(json.dumps(changed), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "immutable"):
                prepare_extraction_dataset(root, "corners-v1", synthetic_per_card=4, include_synthetic=True)

    def test_cli_synthetic_scenes_require_explicit_opt_in(self) -> None:
        arguments = ["prepare-extraction", "--data-root", "example", "--dataset-version", "corners-v1"]
        self.assertFalse(build_parser().parse_args(arguments).include_synthetic)
        self.assertTrue(build_parser().parse_args([*arguments, "--include-synthetic"]).include_synthetic)

    def test_default_preparation_uses_only_annotations_even_with_cached_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self._write_annotation(root, "positive-session", 0, present=True)
            self._write_annotation(root, "negative-session", 1, present=False)
            for folder in ("full-cards", "backgrounds"):
                asset_root = root / "training" / "extraction" / folder
                asset_root.mkdir(parents=True)
                # Disabled assets must not be decoded, hashed, or included.
                (asset_root / "unused.jpg").write_bytes(b"not an image")

            report = prepare_extraction_dataset(root, "corners-current")
            records, _, metadata = read_manifest(root / "exports" / "corners-current" / "manifest.jsonl")

            self.assertEqual(2, report["records"])
            self.assertEqual(0, report["synthetic_records"])
            self.assertEqual(1, report["negative_records"])
            self.assertFalse(report["include_synthetic"])
            self.assertFalse(metadata["include_synthetic"])
            self.assertTrue(all(record.source_kind == "real" for record in records))
            self.assertTrue(all(record.corners is None for record in records if not record.card_present))
            self.assertFalse((root / "training" / "extraction" / "synthetic").exists())
            inventory = json.loads((root / "exports" / "corners-current" / "source-inventory.json").read_text())
            self.assertEqual([], inventory["full_card_assets"])
            self.assertEqual([], inventory["background_assets"])

    def test_opt_in_preserves_real_splits_and_cannot_mutate_existing_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            real_manifest = self._prepare(root, include_synthetic=False)
            real_records, _, _ = read_manifest(real_manifest)
            report = prepare_extraction_dataset(root, "corners-with-synthetic", include_synthetic=True)
            mixed_records, _, _ = read_manifest(root / "exports" / "corners-with-synthetic" / "manifest.jsonl")

            self.assertTrue(report["include_synthetic"])
            self.assertGreater(report["synthetic_records"], 0)
            self.assertEqual(
                {record.image_path: record.split for record in real_records},
                {record.image_path: record.split for record in mixed_records if record.source_kind == "real"},
            )
            self.assertTrue(any(record.source_kind == "hard-negative" for record in mixed_records))
            self.assertTrue(any(record.source_kind == "synthetic-negative" for record in mixed_records))
            with self.assertRaisesRegex(ValueError, "immutable"):
                prepare_extraction_dataset(root, "corners-v1", include_synthetic=True)

    def test_current_working_snapshot_accepts_annotator_corners_v1_sidecars(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self._write_annotation(root, "session", 0, present=True)

            report = prepare_extraction_dataset(
                root, "corners-current", synthetic_per_card=0,
            )
            records, _, metadata = read_manifest(
                root / "exports" / "corners-current" / "manifest.jsonl",
            )

            self.assertEqual(1, report["real_records"])
            self.assertEqual(0, report["synthetic_records"])
            self.assertEqual("corners-current", metadata["dataset_version"])
            self.assertTrue(any(record.card_present for record in records))

    def test_letterbox_round_trip_and_negative_corner_mask(self) -> None:
        corners = [{"x": 0.1, "y": 0.2}, {"x": 0.9, "y": 0.2},
                   {"x": 0.9, "y": 0.8}, {"x": 0.1, "y": 0.8}]
        _, tensor_corners = letterbox(Image.new("RGB", (640, 853)), corners)
        self.assertIsNotNone(tensor_corners)
        recovered = unletterbox(tensor_corners.tolist(), 640, 853)
        for actual, expected in zip(recovered, corners, strict=True):
            self.assertAlmostEqual(expected["x"], actual["x"], places=5)
            self.assertAlmostEqual(expected["y"], actual["y"], places=5)

        predicted = torch.full((2, 8), 0.5, requires_grad=True)
        actual = torch.stack((torch.zeros(8), torch.full((8,), 0.5)))
        presence = torch.tensor([0.0, 1.0])
        total, components = spatial_loss(predicted, torch.zeros(2), torch.zeros(2, 4, 64, 64), actual, presence)
        self.assertEqual(0.0, components["corner_loss"].item())
        self.assertGreater(components["presence_loss"].item(), 0)
        total.backward()

    def test_model_shape_checkpoint_resume_evaluation_and_compact_artifact(self) -> None:
        model = CardExtractor()
        corners, presence = model(torch.zeros(2, 3, 256, 256))
        self.assertEqual((2, 8), tuple(corners.shape))
        self.assertEqual((2,), tuple(presence.shape))

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest = self._prepare(root, include_synthetic=False)
            artifacts = root / "training" / "artifacts"
            def interrupt_after_first_epoch(event, **values):
                if event == "extraction_epoch_completed":
                    raise InterruptedError("test interruption after durable checkpoint")
            with patch("deckino_training.extraction_training.emit", side_effect=interrupt_after_first_epoch):
                with self.assertRaises(InterruptedError):
                    train_extractor(manifest, artifacts, "extractor-test", 2, 16, 3e-4, 0, False,
                                    None, "cpu", 20260824, None, max_batches=1)
            last = artifacts / "extractor-test" / "last.pt"
            self.assertFalse(torch.load(last, map_location="cpu", weights_only=False)["include_synthetic"])
            result = train_extractor(manifest, artifacts, "extractor-test", 2, 16, 3e-4, 0, False,
                                     last, "cpu", 20260824, None, max_batches=1)
            self.assertEqual(22, result["completed_epoch"])
            report = evaluate_extractor(manifest, artifacts / "extractor-test" / "best.pt",
                                        artifacts / "extractor-test", "cpu", 16, 0, None)
            self.assertFalse(report["qualified"])
            self.assertTrue((artifacts / "extractor-test" / "extractor.pt").is_file())
            self.assertTrue((artifacts / "extractor-test" / "thresholds.json").is_file())
            self.assertTrue((artifacts / "extractor-test" / "preprocessing.json").is_file())


if __name__ == "__main__":
    unittest.main()
