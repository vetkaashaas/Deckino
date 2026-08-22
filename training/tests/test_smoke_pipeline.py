from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from deckino_training.commands import evaluate, recognize, train
from deckino_training.manifest import ManifestRecord, write_manifest


class SmokePipelineTests(unittest.TestCase):
    def test_twenty_class_cpu_training_evaluation_and_recognition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            records: list[ManifestRecord] = []
            for class_index in range(20):
                oracle_id = f"oracle-{class_index:02d}"
                for image_index, split in enumerate(("train", "validation")):
                    relative = Path("images") / f"{class_index:02d}-{image_index}.jpg"
                    destination = root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    Image.new(
                        "RGB",
                        (256, 256),
                        (
                            (class_index * 31 + image_index) % 255,
                            (class_index * 67 + image_index) % 255,
                            (class_index * 109 + image_index) % 255,
                        ),
                    ).save(destination)
                    records.append(
                        ManifestRecord(
                            dataset_version="smoke-dataset-v1",
                            image_path=relative.as_posix(),
                            oracle_id=oracle_id,
                            printing_id=f"printing-{class_index:02d}-{image_index}",
                            card_name=f"Card {class_index:02d}",
                            split=split,
                        )
                    )
            manifest = root / "manifest.jsonl"
            write_manifest(manifest, records)
            artifacts = root / "artifacts"

            result = train(
                manifest_path=manifest,
                artifacts_root=artifacts,
                model_version="smoke-model-v1",
                epochs=1,
                batch_size=20,
                learning_rate=3e-4,
                workers=0,
                embedding_dim=32,
                pretrained=False,
                resume_path=None,
                device_name="cpu",
                max_batches=1,
            )
            checkpoint = artifacts / "smoke-model-v1" / "best.pt"
            self.assertEqual(result, 0)
            self.assertTrue(checkpoint.is_file())

            self.assertEqual(
                train(
                    manifest_path=manifest,
                    artifacts_root=artifacts,
                    model_version="smoke-model-v1",
                    epochs=2,
                    batch_size=20,
                    learning_rate=3e-4,
                    workers=0,
                    embedding_dim=32,
                    pretrained=False,
                    resume_path=artifacts / "smoke-model-v1" / "last.pt",
                    device_name="cpu",
                    max_batches=1,
                ),
                0,
            )
            self.assertEqual(evaluate(manifest, checkpoint, "cpu", 20, 0), 0)
            self.assertEqual(
                recognize(
                    checkpoint,
                    root / records[0].image_path,
                    "cpu",
                    score_threshold=-1.0,
                    margin_threshold=-1.0,
                ),
                0,
            )


if __name__ == "__main__":
    unittest.main()
