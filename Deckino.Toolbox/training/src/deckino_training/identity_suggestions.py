"""Guess the card in every corner-annotated camera photo that has no ``._identity.json`` yet.

Replays the phone path on each photo (VGA frame, ``recognizer.onnx`` crop + search, the app's top-K
decision; see :mod:`artwork_camera_probe`) and writes the candidates as an unreviewed
``<photo>._identity.json`` for the Toolbox's Card Identification page. These are guesses for review
only: an identity becomes a training label once a person confirms it there.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from .artwork_camera_probe import CORNER_NAMES, PERMISSIVE, _phone_frame
from .artwork_mobile import MOBILE_SCHEMA_VERSION, decide_top_k, recognition_grid_transform, resolve_artwork_version
from .events import emit


def suggest_card_identities(training_root: Path, model_version: str | None = None) -> int:
    import onnxruntime as ort
    version = resolve_artwork_version(training_root / "artifacts", model_version)
    mobile_root = training_root / "mobile" / "artwork" / version
    manifest_path = mobile_root / "mobile-manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"No mobile export for {version}: run export-artwork-mobile first ({manifest_path})")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("artwork_mobile_schema_version") != MOBILE_SCHEMA_VERSION:
        raise ValueError(f"{manifest_path} is not a schema v{MOBILE_SCHEMA_VERSION} export; re-run export-artwork-mobile")
    labels = json.loads((mobile_root / "labels.json").read_text(encoding="utf-8"))
    oracles, prototypes = labels["oracles"], labels["prototypes"]
    catalogue = manifest["recognizer"]["catalogue_size"]
    session = ort.InferenceSession(str(mobile_root / manifest["recognizer"]["onnx"]), providers=["CPUExecutionProvider"])

    sidecars = sorted((training_root / "camera" / "imports").rglob("*._annotations.json"))
    emit("card_identity_suggestions_started", model_version=version, photos=len(sidecars))
    written = 0
    for done, sidecar in enumerate(sidecars, start=1):
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        image_path = sidecar.parent / payload["ImageFile"]
        identity_path = image_path.with_name(image_path.stem + "._identity.json")
        points = [payload.get(name) for name in CORNER_NAMES]
        # An annotation with a missing corner is invalid (the Toolbox flags it); skip it, not the whole batch.
        if (payload.get("CardPresent") and all(isinstance(point, dict) for point in points)
                and image_path.is_file() and not identity_path.exists()):
            corners = [{"x": point["X"], "y": point["Y"]} for point in points]
            with Image.open(image_path) as source:
                frame = _phone_frame(source.convert("RGB"))
            height, width = frame.shape[:2]
            _, scores, found = session.run(["embedding", "top_scores", "top_prototypes"], {
                "frame": np.ascontiguousarray(frame.transpose(2, 0, 1)[None]),
                "grid_transform": recognition_grid_transform(corners, width, height).astype(np.float32)})
            decision = decide_top_k(scores[0], found[0], oracles, prototypes, PERMISSIVE, catalogue)
            identity = {
                "SchemaVersion": 1, "ImageFile": image_path.name, "Source": "toolbox", "ModelVersion": version,
                "Candidates": [{"OracleId": candidate["oracle_id"], "Score": round(candidate["score"], 4),
                                "Prototype": candidate["prototype"]} for candidate in decision["candidates"]],
                "Status": "unreviewed",
            }
            temporary = identity_path.with_name(identity_path.name + ".tmp")
            temporary.write_text(json.dumps(identity, indent=2), encoding="utf-8")
            os.replace(temporary, identity_path)
            written += 1
            emit("card_identity_suggested", path=str(identity_path))
        if done % 50 == 0:
            emit("card_identity_suggestions_progress", done=done, photos=len(sidecars), written=written)
    emit("card_identity_suggestions_completed", model_version=version, photos=len(sidecars), written=written)
    return written
