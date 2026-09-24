from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from deckino_training.artwork import ARTWORK_ARTIFACT_SCHEMA_VERSION, INDEX_SCHEMA_VERSION
from deckino_training.artwork_mobile import decide, export_artwork_mobile, resolve_artwork_version
from deckino_training.cli import build_parser
from deckino_training.model import EmbeddingNetwork

DIMENSION = 32


def write_artwork_artifact(artifacts: Path, version: str = "mobilenetv3s-512-art-v4", count: int = 40) -> Path:
    """A complete, checksum-valid artwork artifact as the identity workflow leaves it."""
    root = artifacts / version
    index_root = root / "index"
    index_root.mkdir(parents=True)
    torch.manual_seed(7)
    model = EmbeddingNetwork(DIMENSION).eval()
    torch.save({"artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION, "identity_key": "artwork_prototype",
                "dataset_version": "paper-art-v4", "model_version": version, "source_checkpoint": "best.pt",
                "config": {"embedding_dim": DIMENSION}, "model_state": model.state_dict()}, root / "embedding.pt")
    rng = np.random.default_rng(3)
    vectors = rng.normal(size=(count, DIMENSION)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors.tofile(index_root / "index.f32")
    labels = []
    for index in range(count):
        # Two prototypes per oracle (alternate art); the last prototype is an artwork shared by two cards.
        oracle = f"oracle-{index // 2:03d}"
        oracle_ids = [oracle, "oracle-shared"] if index == count - 1 else [oracle]
        labels.append({"index": index, "artwork_id": f"art-{index:03d}", "oracle_id": oracle, "oracle_ids": oracle_ids,
                       "oracle_names": {value: f"Card {value}" for value in oracle_ids},
                       "ambiguous": len(oracle_ids) > 1, "printing_id": f"print-{index:03d}",
                       "card_name": f"Card {oracle}", "category": "normal"})
    metadata = {"index_schema_version": INDEX_SCHEMA_VERSION, "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION,
                "dataset_version": "paper-art-v4", "checkpoint_model_version": version, "checkpoint_file": "best.pt",
                "count": count, "embedding_dimension": DIMENSION, "dtype": "float32", "normalization": "l2",
                "vectors_sha256": hashlib.sha256((index_root / "index.f32").read_bytes()).hexdigest(),
                "labels_sha256": hashlib.sha256(json.dumps(labels, ensure_ascii=False, sort_keys=True,
                                                           separators=(",", ":")).encode("utf-8")).hexdigest()}
    (index_root / "index-metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (index_root / "index-labels.json").write_text(json.dumps({**metadata, "labels": labels}), encoding="utf-8")
    (root / "artwork-thresholds.json").write_text(json.dumps({
        "artifact_schema_version": ARTWORK_ARTIFACT_SCHEMA_VERSION, "dataset_version": "paper-art-v4",
        "checkpoint_model_version": version, "score_threshold": .5, "margin_threshold": .05,
        "calibration_precision": .999, "calibration_coverage": .96, "qualified": True}), encoding="utf-8")
    return root


class ArtworkMobileExportTests(unittest.TestCase):
    def test_float16_export_is_complete_checksummed_and_reproducible(self):
        with tempfile.TemporaryDirectory() as folder:
            artifacts = Path(folder) / "training" / "artifacts"
            write_artwork_artifact(artifacts)
            manifest = export_artwork_mobile(artifacts)
            output = Path(folder) / "training" / "mobile" / "artwork" / "mobilenetv3s-512-art-v4"
            for name, entry in manifest["files"].items():
                self.assertEqual(entry["sha256"], hashlib.sha256((output / name).read_bytes()).hexdigest(), name)
            self.assertEqual(40 * DIMENSION * 2, manifest["files"]["index.float16.bin"]["bytes"])
            self.assertTrue(manifest["parity"]["index_quantization"]["passed"])
            self.assertLessEqual(manifest["parity"]["embedding_max_abs_error"], 1e-4)
            self.assertEqual(.5, manifest["decision"]["score_threshold"])

            labels = json.loads((output / "labels.json").read_text(encoding="utf-8"))
            self.assertEqual(40, len(labels["prototypes"]))
            self.assertTrue(labels["prototypes"][-1]["ambiguous"])

            # Replaying the fixture from the packed files must give the recorded decisions.
            vectors = np.fromfile(output / "index.float16.bin", dtype="<f2").astype(np.float32).reshape(40, DIMENSION)
            fixture = json.loads((output / "fixture.json").read_text(encoding="utf-8"))
            thresholds = manifest["decision"]
            for case in fixture["search_cases"]:
                decision = decide(np.asarray(case["query"], dtype=np.float32), vectors, labels["oracles"],
                                  labels["prototypes"], thresholds)
                self.assertEqual(case["decision"], decision)
            by_row = {case["query_prototype"]: case["decision"] for case in fixture["search_cases"]}
            self.assertEqual("ambiguous_artwork", by_row[39]["rejection_reason"])
            self.assertEqual("oracle-000", by_row[0]["oracle_id"])
            inputs = np.fromfile(output / "fixture-inputs.f32", dtype="<f4").reshape(fixture["inputs"]["shape"])
            self.assertTrue(((inputs >= 0) & (inputs <= 1)).all())

    def test_int8_export_writes_row_scales_that_reconstruct_the_index(self):
        with tempfile.TemporaryDirectory() as folder:
            artifacts = Path(folder) / "artifacts"
            root = write_artwork_artifact(artifacts)
            output = Path(folder) / "mobile"
            manifest = export_artwork_mobile(artifacts, output, index_dtype="int8")
            self.assertEqual("index.scales.f32", manifest["index"]["scales"])
            quantized = np.fromfile(output / "index.int8.bin", dtype=np.int8).reshape(40, DIMENSION)
            scales = np.fromfile(output / "index.scales.f32", dtype="<f4")
            original = np.fromfile(root / "index" / "index.f32", dtype=np.float32).reshape(40, DIMENSION)
            self.assertLess(float(np.abs(quantized * scales[:, None] - original).max()), .01)

    def test_mismatched_thresholds_and_tampered_index_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            artifacts = Path(folder) / "artifacts"
            root = write_artwork_artifact(artifacts)
            thresholds = json.loads((root / "artwork-thresholds.json").read_text(encoding="utf-8"))
            (root / "artwork-thresholds.json").write_text(json.dumps({**thresholds, "checkpoint_model_version": "other"}),
                                                           encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "thresholds checkpoint"):
                export_artwork_mobile(artifacts, Path(folder) / "out")
            (root / "artwork-thresholds.json").write_text(json.dumps(thresholds), encoding="utf-8")
            with (root / "index" / "index.f32").open("r+b") as stream:
                stream.write(b"\x00\x00\x00\x00")
            with self.assertRaisesRegex(ValueError, "checksum"):
                export_artwork_mobile(artifacts, Path(folder) / "out")

    def test_version_resolution_prefers_the_imported_pointer(self):
        with tempfile.TemporaryDirectory() as folder:
            artifacts = Path(folder) / "training" / "artifacts"
            write_artwork_artifact(artifacts, "art-a")
            write_artwork_artifact(artifacts, "art-b")
            (artifacts.parent / "current-artwork.json").write_text(json.dumps({"model_version": "art-a"}),
                                                                   encoding="utf-8")
            self.assertEqual("art-a", resolve_artwork_version(artifacts, None))
            self.assertEqual("art-b", resolve_artwork_version(artifacts, "art-b"))

    def test_single_oracle_catalogue_has_unbounded_margin(self):
        vectors = np.eye(2, dtype=np.float32)
        decision = decide(np.array([1., 0.], dtype=np.float32), vectors, [{"oracle_id": "only", "name": "Only"}],
                          [{"oracles": [0], "ambiguous": False}, {"oracles": [0], "ambiguous": False}],
                          {"score_threshold": .5, "margin_threshold": .1})
        self.assertIsNone(decision["margin"])
        self.assertEqual("only", decision["oracle_id"])

    def test_cli_exposes_export_artwork_mobile(self):
        arguments = build_parser().parse_args(["export-artwork-mobile", "--artifacts-root", "data/training/artifacts"])
        self.assertEqual("float16", arguments.index_dtype)
        self.assertIsNone(arguments.model_version)


if __name__ == "__main__":
    unittest.main()
