from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import torch
from PIL import Image

from deckino_training.artwork import (
    ARTWORK_ARTIFACT_SCHEMA_VERSION,
    ARTWORK_MANIFEST_SCHEMA_VERSION,
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
            is_paper INTEGER NOT NULL,
            -- Generated, so the positional INSERTs below still give five values; no fixture is an Art Series card.
            layout TEXT GENERATED ALWAYS AS (NULL) VIRTUAL
        );
        CREATE TABLE oracle_cards (oracle_id TEXT PRIMARY KEY, type_line TEXT);
        CREATE TABLE card_images (
            image_id TEXT PRIMARY KEY,
            scryfall_id TEXT NOT NULL,
            face_index INTEGER NOT NULL,
            illustration_id TEXT,
            status TEXT NOT NULL,
            file_path TEXT
        );
        """
    )
    return connection


def _image(connection: sqlite3.Connection, data_root: Path, printing: str, image: Path, face: int = 0,
           illustration: str | None = None) -> None:
    """A downloaded face of a printing; its illustration defaults to the printing's."""
    connection.execute(
        """
        INSERT INTO card_images
        SELECT ? || ':' || ?, scryfall_id, ?, COALESCE(?, illustration_id), 'downloaded', ?
        FROM cards WHERE scryfall_id = ?
        """,
        (printing, face, face, illustration, image.relative_to(data_root).as_posix(), printing),
    )


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
        "INSERT INTO cards VALUES (?, ?, ?, ?, 1)",
        (
            ("printing-a1", "oracle-a", "art-a", "Alpha"),
            ("printing-a2", "oracle-a", "art-a", "Alpha"),
            ("printing-b", "oracle-b", "art-b", "Plains"),
        ),
    )
    for printing, image in (("printing-a1", first), ("printing-a2", first), ("printing-b", second)):
        _image(connection, tmp_path, printing, image)
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
        "INSERT INTO cards VALUES (?, ?, 'shared-art', ?, 1)",
            (("printing-a", "oracle-a", "Alpha"), ("printing-b", "oracle-b", "Beta")),
    )
    connection.execute(
        "INSERT INTO cards VALUES ('printing-c', 'oracle-c', 'unique-art', 'Gamma', 1)"
    )
    for printing, path in (("printing-a", image), ("printing-b", image), ("printing-c", unique_image)):
        _image(connection, tmp_path, printing, path)
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


def test_old_artwork_schema_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "exports" / "old"
    root.mkdir(parents=True)
    (root / "metadata.json").write_text(json.dumps({"schema_version": 3}), encoding="utf-8")
    (root / "manifest.jsonl").write_text("{}\n", encoding="utf-8")

    try:
        read_artwork_manifest(root / "manifest.jsonl")
    except ValueError as error:
        assert f"schema v{ARTWORK_MANIFEST_SCHEMA_VERSION}" in str(error)
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
        "INSERT INTO cards VALUES (?, ?, ?, ?, 1)",
        (("printing-a", "oracle-a", "art-a", "Alpha"), ("printing-b", "oracle-b", "art-b", "Beta")),
    )
    _image(connection, tmp_path, "printing-a", first)
    _image(connection, tmp_path, "printing-b", second)
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


def test_paired_artwork_training_writes_and_resumes_current_schema_checkpoint(tmp_path: Path) -> None:
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
            "INSERT INTO cards VALUES (?, ?, ?, ?, 1)",
            (f"printing-{index}", oracle_id, f"art-{index}", f"Card {index}"),
        )
        _image(connection, tmp_path, f"printing-{index}", image)
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
    assert first["artifact_schema_version"] == ARTWORK_ARTIFACT_SCHEMA_VERSION
    assert first["identity_key"] == "artwork_id"
    assert first["completed_epoch"] == 1
    assert first["optimizer_state"]["state"]

    train_artwork(
        manifest, artifacts, model_version, 2, 4, 3e-4, 0, 32,
        False, checkpoint_path, "cpu", 1234, None,
    )
    resumed = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    assert resumed["completed_epoch"] == 2


def test_every_face_of_a_double_faced_card_is_a_reference(tmp_path: Path) -> None:
    images = tmp_path / "card-images"
    images.mkdir()
    front, back, other = images / "front.jpg", images / "back.jpg", images / "other.jpg"
    for path, color in ((front, "red"), (back, "blue"), (other, "green")):
        Image.new("RGB", (63, 88), color).save(path)
    connection = _database(tmp_path)
    connection.executemany("INSERT INTO oracle_cards VALUES (?, 'Creature')", (("oracle-a",), ("oracle-b",)))
    connection.executemany("INSERT INTO cards VALUES (?, ?, ?, ?, 1)",
                           (("printing-a", "oracle-a", "front-art", "Day // Night"),
                            ("printing-b", "oracle-b", "other-art", "Other")))
    _image(connection, tmp_path, "printing-a", front)
    _image(connection, tmp_path, "printing-a", back, face=1, illustration="back-art")
    _image(connection, tmp_path, "printing-b", other)
    connection.commit()
    connection.close()

    prepare_artwork_dataset(tmp_path, "faces")
    records, _ = read_artwork_manifest(tmp_path / "exports" / "faces" / "manifest.jsonl")
    labels = json.loads((tmp_path / "exports" / "faces" / "labels.json").read_text(encoding="utf-8"))["labels"]

    prototypes = {item.artwork_id: item for item in records if item.role == "prototype"}
    assert set(prototypes) == {"front-art", "back-art", "other-art"}
    assert prototypes["back-art"].face_index == 1
    assert prototypes["back-art"].image_path == "card-images/back.jpg"
    assert all(item.input_kind == "card" for item in records)
    assert {item["artwork_id"]: item["face_index"] for item in labels}["back-art"] == 1
