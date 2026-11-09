"""Keep the current artwork model loaded and guess the card in one camera photo per request.

Replays the phone path on each photo (VGA frame, ``recognizer.onnx`` crop + search, the app's top-K
decision; see :mod:`artwork_camera_probe`) for the Toolbox's Card Identification page. The Toolbox
starts this worker while that page is open and writes the guesses next to the phone's own when a
person saves the photo. They are guesses for review only: never train on them.

Requests and replies are JSON lines: ``{"request_id", "image_path", "corners": [{"x", "y"} x4]}``
in, ``card_identity_suggestion`` (or ``card_identity_suggestion_error``) out.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from .artwork_camera_probe import PERMISSIVE, _phone_frame
from .artwork_mobile import MOBILE_SCHEMA_VERSION, decide_top_k, recognition_grid_transform, resolve_artwork_version
from .events import emit


def run_identity_worker(training_root: Path, model_version: str | None = None) -> int:
    import onnxruntime as ort
    try:
        version = resolve_artwork_version(training_root / "artifacts", model_version)
        mobile_root = training_root / "mobile" / "artwork" / version
        manifest_path = mobile_root / "mobile-manifest.json"
        if not manifest_path.is_file():
            raise ValueError(f"{version} has no phone files yet: use Build phone files on the Runner page first.")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("artwork_mobile_schema_version") != MOBILE_SCHEMA_VERSION:
            raise ValueError(f"The phone files for {version} are outdated: use Build phone files on the Runner page again.")
    except ValueError as error:
        emit("card_identity_worker_error", message=str(error))
        return 1
    labels = json.loads((mobile_root / "labels.json").read_text(encoding="utf-8"))
    oracles, prototypes = labels["oracles"], labels["prototypes"]
    catalogue = manifest["recognizer"]["catalogue_size"]
    session = ort.InferenceSession(str(mobile_root / manifest["recognizer"]["onnx"]), providers=["CPUExecutionProvider"])
    emit("card_identity_worker_ready", model_version=version)

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = str(request["request_id"])
            with Image.open(request["image_path"]) as source:
                frame = _phone_frame(source.convert("RGB"))
            height, width = frame.shape[:2]
            _, scores, found = session.run(["embedding", "top_scores", "top_prototypes"], {
                "frame": np.ascontiguousarray(frame.transpose(2, 0, 1)[None]),
                "grid_transform": recognition_grid_transform(request["corners"], width, height).astype(np.float32)})
            decision = decide_top_k(scores[0], found[0], oracles, prototypes, PERMISSIVE, catalogue)
            emit("card_identity_suggestion", request_id=request_id, model_version=version, candidates=[
                {"OracleId": candidate["oracle_id"], "Score": round(candidate["score"], 4),
                 "Prototype": candidate["prototype"]} for candidate in decision["candidates"]])
        except Exception as error:  # A bad photo must not stop the warm worker.
            emit("card_identity_suggestion_error", request_id=request_id, message=str(error))
    return 0
