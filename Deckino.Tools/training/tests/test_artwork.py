from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from deckino_training.artwork import (
    ARTWORK_MANIFEST_SCHEMA_VERSION,
    _metrics,
    _thresholds,
    prepare_artwork_dataset,
    read_artwork_manifest,
    build_index,
    evaluate_index,
    recognize_index,
    train_artwork,
)
from deckino_training.model import EmbeddingNetwork


def _database(data_root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(data_root / "deckino.db")
    connection.executescript(
        """
        CREATE TABLE cards (
            scryfall_id TEXT PRIMARY KEY,
            oracle_id TEXT,
            illustration_id TEXT,
            name TEXT NOT NULL,
            art_crop_uri TEXT,
            is_paper INTEGER NOT NULL
        );
        CREATE TABLE oracle_cards (oracle_id TEXT PRIMARY KEY, type_line TEXT);
        CREATE TABLE art_downloads (
            scryfall_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            file_path TEXT
        );
        """
    )
    return connection


def test_prepare_artwork_manifest_deduplicates_printings_without_copying_images(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.mkdir()
    first = cards / "first.jpg"
    second = cards / "second.jpg"
    Image.new("RGB", (32, 32), "red").save(first)
    Image.new("RGB", (32, 32), "blue").save(second)
    connection = _database(tmp_path)
    connection.executemany(
        "INSERT INTO oracle_cards VALUES (?, ?)",
        (("oracle-a", "Creature"), ("oracle-b", "Basic Land")),
    )
    connection.executemany(
        "INSERT INTO cards VALUES (?, ?, ?, ?, ?, 1)",
        (
            ("printing-a1", "oracle-a", "art-a", "Alpha", "https://example/a",),
            ("printing-a2", "oracle-a", "art-a", "Alpha", "https://example/a",),
            ("printing-b", "oracle-b", "art-b", "Plains", "https://example/b",),
        ),
    )
    connection.executemany(
        "INSERT INTO art_downloads VALUES (?, 'downloaded', ?)",
        (("printing-a1", str(first)), ("printing-a2", str(first)), ("printing-b", str(second))),
    )
    connection.commit()
    connection.close()

    report = prepare_artwork_dataset(tmp_path, "paper-art-v4")
    manifest = tmp_path / "exports" / "paper-art-v4" / "manifest.jsonl"
    records, root = read_artwork_manifest(manifest)

    assert report["schema_version"] == ARTWORK_MANIFEST_SCHEMA_VERSION
    assert report["artworks"] == 2
    assert report["records"] == 10
    assert root == tmp_path
    assert {item.artwork_id for item in records} == {"art-a", "art-b"}
    assert first.is_file() and second.is_file()
    assert not (manifest.parent / "cards").exists()


def test_prepare_artwork_manifest_marks_cross_oracle_illustration_as_ambiguous(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.mkdir()
    image = cards / "shared.jpg"
    unique_image = cards / "unique.jpg"
    Image.new("RGB", (32, 32), "green").save(image)
    Image.new("RGB", (32, 32), "purple").save(unique_image)
    connection = _database(tmp_path)
    connection.executemany(
        "INSERT INTO oracle_cards VALUES (?, 'Creature')", (("oracle-a",), ("oracle-b",), ("oracle-c",)),
    )
    connection.executemany(
        "INSERT INTO cards VALUES (?, ?, 'shared-art', ?, 'https://example', 1)",
            (("printing-a", "oracle-a", "Alpha"), ("printing-b", "oracle-b", "Beta")),
    )
    connection.execute(
        "INSERT INTO cards VALUES ('printing-c', 'oracle-c', 'unique-art', 'Gamma', 'https://example', 1)"
    )
    connection.executemany(
        "INSERT INTO art_downloads VALUES (?, 'downloaded', ?)",
        (("printing-a", str(image)), ("printing-b", str(image))),
    )
    connection.execute(
        "INSERT INTO art_downloads VALUES ('printing-c', 'downloaded', ?)", (str(unique_image),)
    )
    connection.commit()
    connection.close()

    report = prepare_artwork_dataset(tmp_path, "paper-art-v4")
    records, _ = read_artwork_manifest(
        tmp_path / "exports" / "paper-art-v4" / "manifest.jsonl"
    )

    assert report["ambiguous_illustrations"] == 1
    shared = [item for item in records if item.artwork_id == "shared-art"]
    assert len(shared) == 1
    assert shared[0].role == "prototype"
    assert shared[0].oracle_ids == ["oracle-a", "oracle-b"]

    checkpoint_path = tmp_path / "best.pt"
    network = EmbeddingNetwork(32, pretrained=False)
    torch.save(
        {
            "artifact_schema_version": 3,
            "dataset_version": "paper-v3",
            "model_version": "existing-v3",
            "config": {"embedding_dim": 32},
            "model_state": network.state_dict(),
        },
        checkpoint_path,
    )
    manifest = tmp_path / "exports" / "paper-art-v4" / "manifest.jsonl"
    index_root = tmp_path / "artifacts" / "index"
    report_path = tmp_path / "artifacts" / "retrieval-report.json"
    build_index(manifest, checkpoint_path, index_root, "cpu", 2, None)
    evaluate_index(manifest, checkpoint_path, index_root, report_path, "cpu", 2, None)
    recognition = recognize_index(
        checkpoint_path,
        index_root,
        image,
        report_path.with_name("artwork-thresholds.json"),
        "cpu",
        None,
    )
    assert recognition["rejected"] is True
    assert recognition["rejection_reason"] == "ambiguous_artwork"
    assert recognition["candidate_oracle_ids"] == ["oracle-a", "oracle-b"]


def test_strict_calibration_and_oracle_metrics() -> None:
    scores = np.asarray([0.90] * 100)
    margins = np.asarray([0.20] * 100)
    correct = np.asarray([True] * 100)
    thresholds = _thresholds(scores, margins, correct)
    predictions = [
        {
            "actual_oracle_id": "oracle-a",
            "predicted_oracle_id": "oracle-a",
            "score": 0.90,
            "margin": 0.20,
            "top5_correct": True,
        }
        for _ in range(100)
    ]

    assert thresholds["qualified"] is True
    assert _metrics(predictions, thresholds)["top1"] == 1.0
    assert _metrics(predictions, thresholds)["accepted_precision"] == 1.0


def test_old_artwork_schema_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "exports" / "old"
    root.mkdir(parents=True)
    (root / "metadata.json").write_text(json.dumps({"schema_version": 3}), encoding="utf-8")
    (root / "manifest.jsonl").write_text("{}\n", encoding="utf-8")

    try:
        read_artwork_manifest(root / "manifest.jsonl")
    except ValueError as error:
        assert "schema v4" in str(error)
    else:
        raise AssertionError("Old manifests must be rejected")


def test_cpu_index_evaluate_and_recognize_round_trip(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.mkdir()
    first = cards / "first.jpg"
    second = cards / "second.jpg"
    Image.new("RGB", (64, 64), "red").save(first)
    Image.new("RGB", (64, 64), "blue").save(second)
    connection = _database(tmp_path)
    connection.executemany(
        "INSERT INTO oracle_cards VALUES (?, 'Creature')", (("oracle-a",), ("oracle-b",)),
    )
    connection.executemany(
        "INSERT INTO cards VALUES (?, ?, ?, ?, 'https://example', 1)",
        (("printing-a", "oracle-a", "art-a", "Alpha"), ("printing-b", "oracle-b", "art-b", "Beta")),
    )
    connection.executemany(
        "INSERT INTO art_downloads VALUES (?, 'downloaded', ?)",
        (("printing-a", str(first)), ("printing-b", str(second))),
    )
    connection.commit()
    connection.close()
    prepare_artwork_dataset(tmp_path, "paper-art-v4")
    checkpoint_path = tmp_path / "best.pt"
    network = EmbeddingNetwork(32, pretrained=False)
    torch.save(
        {
            "artifact_schema_version": 3,
            "dataset_version": "paper-v3",
            "model_version": "existing-v3",
            "config": {"embedding_dim": 32},
            "model_state": network.state_dict(),
        },
        checkpoint_path,
    )
    manifest = tmp_path / "exports" / "paper-art-v4" / "manifest.jsonl"
    index_root = tmp_path / "artifacts" / "index"
    report_path = tmp_path / "artifacts" / "retrieval-report.json"

    build_index(manifest, checkpoint_path, index_root, "cpu", 2, None)
    report = evaluate_index(manifest, checkpoint_path, index_root, report_path, "cpu", 2, None)
    recognition = recognize_index(
        checkpoint_path,
        index_root,
        first,
        report_path.with_name("artwork-thresholds.json"),
        "cpu",
        None,
    )

    assert report["test"]["samples"] == 4
    assert recognition["candidate_oracle_id"] == "oracle-a"
    assert len(recognition["candidates"]) == 2


def test_paired_artwork_training_writes_and_resumes_schema_four_checkpoint(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.mkdir()
    colors = ("red", "green", "blue", "yellow")
    connection = _database(tmp_path)
    for index, color in enumerate(colors):
        image = cards / f"{index}.jpg"
        Image.new("RGB", (96, 96), color).save(image)
        oracle_id = f"oracle-{index}"
        connection.execute("INSERT INTO oracle_cards VALUES (?, 'Creature')", (oracle_id,))
        connection.execute(
            "INSERT INTO cards VALUES (?, ?, ?, ?, 'https://example', 1)",
            (f"printing-{index}", oracle_id, f"art-{index}", f"Card {index}"),
        )
        connection.execute(
            "INSERT INTO art_downloads VALUES (?, 'downloaded', ?)",
            (f"printing-{index}", str(image)),
        )
    connection.commit()
    connection.close()
    prepare_artwork_dataset(tmp_path, "paper-art-v4")
    manifest = tmp_path / "exports" / "paper-art-v4" / "manifest.jsonl"
    artifacts = tmp_path / "artifacts"
    model_version = "artwork-cpu-v4"

    train_artwork(
        manifest, artifacts, model_version, 1, 4, 3e-4, 0, 32,
        False, None, "cpu", 1234, None,
    )
    checkpoint_path = artifacts / model_version / "last.pt"
    first = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    assert first["artifact_schema_version"] == 4
    assert first["identity_key"] == "artwork_id"
    assert first["completed_epoch"] == 1
    assert first["optimizer_state"]["state"]

    train_artwork(
        manifest, artifacts, model_version, 2, 4, 3e-4, 0, 32,
        False, checkpoint_path, "cpu", 1234, None,
    )
    resumed = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    assert resumed["completed_epoch"] == 2
