from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from deckino_training.camera_manifest import (
    CAPTURE_CONDITIONS,
    prepare_camera_manifest,
)
from deckino_training.manifest import (
    MANIFEST_SCHEMA_VERSION,
    ManifestRecord,
    REAL_CAMERA,
    read_manifest,
    write_json,
    write_manifest,
)


class CameraManifestTests(unittest.TestCase):
    def test_camera_set_requires_conditions_and_special_card_traits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            dataset_records: list[ManifestRecord] = []
            for index in range(2):
                image = dataset_root / f"source-{index}.jpg"
                Image.new("RGB", (256, 256)).save(image)
                dataset_records.append(
                    ManifestRecord(
                        dataset_version="dataset-v2",
                        image_path=image.name,
                        oracle_id=f"oracle-{index}",
                        printing_id=f"printing-{index}",
                        card_name=f"Card {index}",
                        split="train",
                    )
                )
            dataset_manifest = dataset_root / "manifest.jsonl"
            write_manifest(dataset_manifest, dataset_records)
            write_json(dataset_root / "metadata.json", {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "dataset_version": "dataset-v2",
                "image_root": ".",
            })

            capture_root = root / "captures"
            traits = (("foil", "borderless"), ("unusual_layout",))
            for index in range(2):
                card_root = capture_root / f"oracle-{index}"
                card_root.mkdir(parents=True)
                (card_root / "capture.json").write_text(
                    json.dumps({"traits": traits[index]}), encoding="utf-8"
                )
                for condition in CAPTURE_CONDITIONS:
                    Image.new("RGB", (630, 880)).save(card_root / f"{condition}.jpg")

            output_root = root / "prepared-camera"
            report = prepare_camera_manifest(
                capture_root,
                output_root,
                dataset_manifest,
                "pixel-v1",
                minimum_cards=2,
            )

            self.assertEqual(report.cards, 2)
            self.assertEqual(report.captures, 10)
            records = read_manifest(output_root / "camera-manifest.jsonl")
            self.assertTrue(all(record.validation_kind == REAL_CAMERA for record in records))
            self.assertTrue(all(record.input_kind == "auto" for record in records))


if __name__ == "__main__":
    unittest.main()
