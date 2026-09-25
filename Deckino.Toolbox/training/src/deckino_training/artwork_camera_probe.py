"""End-to-end check of the exported artwork recognizer on real annotated camera photos.

Replays what the phone does for every photo in ``training/camera/imports``: shrink
the photo to the phone's VGA frame, cut the recognition crop with the labelled
corners using :func:`phone_recognition_crop`, run the shipped ``recognizer.onnx``
and apply the app's top-K decision. No Card photos contribute a card-shaped crop
from the frame centre - what the phone would read if the extractor misfired.

A full-resolution bicubic crop of the same photo is scored as the reference, so
the report also shows what the phone's lower resolution costs. Output:
``summary.json`` (score percentiles and a score/margin threshold grid),
``rows.json`` (one row per photo) and ``camera-probe.html`` (a contact sheet).
"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .artwork_mobile import (FIXTURE_FRAME, RECOGNITION_CROP, decide_top_k, phone_recognition_crop,
                             resolve_artwork_version)
from .events import emit
from .model import IMAGE_SIZE

CORNER_NAMES = ("TopLeft", "TopRight", "BottomRight", "BottomLeft")
NO_CARD_QUAD = [{"x": .3, "y": .25}, {"x": .7, "y": .25}, {"x": .7, "y": .75}, {"x": .3, "y": .75}]
PERMISSIVE = {"score_threshold": -1., "margin_threshold": -1.}
SCORE_GRID = (.3, .4, .45, .5, .55, .6, .65, .7, .75, .8)
MARGIN_GRID = (0., .02, .05, .1)


def _phone_frame(image: Image.Image) -> np.ndarray:
    """Shrink a photo so its short side matches the phone's 480 px VGA frame (never enlarge)."""
    short = min(image.size)
    scale = min(1., min(FIXTURE_FRAME) / short)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return np.asarray(image.resize(size, Image.Resampling.BILINEAR) if scale < 1 else image, dtype=np.uint8)


def _reference_crop(image: Image.Image, corners: list[dict[str, float]]) -> np.ndarray:
    """The training-side crop: bicubic rectify at full resolution, crop, bicubic resize."""
    from .artwork_mobile import _homography
    width, height = RECOGNITION_CROP["rectified_size"]
    box = RECOGNITION_CROP["canonical_pixels"]
    destination = [(0., 0.), (width - 1., 0.), (width - 1., height - 1.), (0., height - 1.)]
    source = [(point["x"] * (image.width - 1), point["y"] * (image.height - 1)) for point in corners]
    rectified = image.transform((width, height), Image.Transform.PERSPECTIVE, _homography(destination, source),
                                Image.Resampling.BICUBIC)
    crop = rectified.crop((box["left"], box["top"], box["right"], box["bottom"]))
    crop = crop.resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BICUBIC)
    return (np.asarray(crop, dtype=np.float32) / 255).transpose(2, 0, 1)


def _thumbnail(crop: np.ndarray) -> str:
    buffer = io.BytesIO()
    Image.fromarray((crop.transpose(1, 2, 0) * 255).round().astype(np.uint8)).save(buffer, "JPEG", quality=80)
    return base64.b64encode(buffer.getvalue()).decode()


def _percentiles(values: list[float]) -> dict[str, float] | None:
    return {f"p{q}": round(float(np.percentile(values, q)), 3) for q in (1, 5, 25, 50, 75, 95, 99)} if values else None


def probe_artwork_camera(training_root: Path, model_version: str | None = None, output_root: Path | None = None,
                         limit: int | None = None) -> dict[str, Any]:
    import onnxruntime as ort
    artifacts_root = training_root / "artifacts"
    version = resolve_artwork_version(artifacts_root, model_version)
    mobile_root = training_root / "mobile" / "artwork" / version
    manifest_path = mobile_root / "mobile-manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"No mobile export for {version}: run export-artwork-mobile first ({manifest_path})")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if "recognizer" not in manifest:
        raise ValueError(f"{manifest_path} predates recognizer.onnx; re-run export-artwork-mobile")
    labels = json.loads((mobile_root / "labels.json").read_text(encoding="utf-8"))
    oracles, prototypes = labels["oracles"], labels["prototypes"]
    names = {oracle["oracle_id"]: oracle["name"] for oracle in oracles}
    catalogue = manifest["recognizer"]["catalogue_size"]
    app_thresholds = {key: manifest["app_decision"][key] for key in ("score_threshold", "margin_threshold")}
    session = ort.InferenceSession(str(mobile_root / manifest["recognizer"]["onnx"]),
                                   providers=["CPUExecutionProvider"])
    output_root = output_root or artifacts_root / version / "camera-probe"
    output_root.mkdir(parents=True, exist_ok=True)

    def recognize(crop: np.ndarray, thresholds: dict[str, float]) -> dict[str, Any]:
        _, scores, found = session.run(["embedding", "top_scores", "top_prototypes"], {"image": crop[None]})
        return decide_top_k(scores[0], found[0], oracles, prototypes, thresholds, catalogue)

    sidecars = sorted((training_root / "camera" / "imports").rglob("*._annotations.json"))
    emit("artwork_camera_probe_started", model_version=version, photos=len(sidecars))
    rows: list[dict[str, Any]] = []
    for sidecar in sidecars:
        if limit is not None and len(rows) >= limit:
            break
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        image_path = sidecar.parent / payload["ImageFile"]
        if not image_path.is_file():
            continue
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        card = bool(payload["CardPresent"])
        corners = ([{"x": payload[name]["X"], "y": payload[name]["Y"]} for name in CORNER_NAMES] if card
                   else NO_CARD_QUAD)
        phone_crop = phone_recognition_crop(_phone_frame(image), corners)
        phone = recognize(phone_crop, PERMISSIVE)
        reference = recognize(_reference_crop(image, corners), PERMISSIVE)
        app = recognize(phone_crop, app_thresholds)
        candidates = phone["candidates"]
        rows.append({"image": str(image_path.relative_to(training_root.parent)), "group": payload.get("SourceGroup"),
                     "kind": "card" if card else "no-card", "score": phone["score"],
                     "margin": phone["margin"] if phone["margin"] is not None else 1.,
                     "ambiguous": phone["rejection_reason"] == "ambiguous_artwork",
                     "top1": names[candidates[0]["oracle_id"]],
                     "top2": names[candidates[1]["oracle_id"]] if len(candidates) > 1 else None,
                     "app_accepted": not app["rejected"],
                     "reference_top1": names[reference["candidate_oracle_id"]], "reference_score": reference["score"],
                     "thumb": _thumbnail(phone_crop)})
        if len(rows) % 100 == 0:
            emit("artwork_camera_probe_progress", photos=len(rows))

    cards = [row for row in rows if row["kind"] == "card"]
    negatives = [row for row in rows if row["kind"] == "no-card"]

    def kept(group: list[dict[str, Any]], score: float, margin: float) -> float:
        return round(sum(row["score"] >= score and row["margin"] >= margin and not row["ambiguous"]
                         for row in group) / max(1, len(group)), 3)

    summary = {
        "model_version": version, "cards": len(cards), "no_card": len(negatives),
        "phone_frame": {"short_side": min(FIXTURE_FRAME), "crop": "phone_recognition_crop"},
        "app_thresholds": app_thresholds,
        "app_cards_accepted": kept(cards, app_thresholds["score_threshold"], app_thresholds["margin_threshold"]),
        "app_no_card_accepted": kept(negatives, app_thresholds["score_threshold"], app_thresholds["margin_threshold"]),
        "card_score": _percentiles([row["score"] for row in cards]),
        "no_card_score": _percentiles([row["score"] for row in negatives]),
        "card_margin": _percentiles([row["margin"] for row in cards]),
        "phone_matches_full_resolution_top1": round(
            sum(row["top1"] == row["reference_top1"] for row in cards) / max(1, len(cards)), 3),
        "full_resolution_card_score": _percentiles([row["reference_score"] for row in cards]),
        "distinct_top1_cards": len({row["top1"] for row in cards}),
        "ambiguous_top1_cards": sum(row["ambiguous"] for row in cards),
        "threshold_grid": [{"score": score, "margin": margin, "cards_kept": kept(cards, score, margin),
                            "no_card_kept": kept(negatives, score, margin)}
                           for score in SCORE_GRID for margin in MARGIN_GRID],
    }
    _write(output_root / "summary.json", json.dumps(summary, indent=2))
    _write(output_root / "rows.json",
           json.dumps([{key: value for key, value in row.items() if key != "thumb"} for row in rows], indent=1))
    _write(output_root / "camera-probe.html", _html(summary, rows))
    emit("artwork_camera_probe_finished", model_version=version, output=str(output_root),
         cards=len(cards), no_card=len(negatives), app_cards_accepted=summary["app_cards_accepted"],
         app_no_card_accepted=summary["app_no_card_accepted"])
    return summary


def _write(path: Path, text: str) -> None:
    path.write_text(text + "\n", encoding="utf-8")


def _html(summary: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    from html import escape
    cells = "".join(
        f'<figure class="{row["kind"]}{"" if row["app_accepted"] else " rejected"}">'
        f'<img src="data:image/jpeg;base64,{row["thumb"]}" alt=""><figcaption><b>{escape(row["top1"])}</b><br>'
        f'score {row["score"]:.3f} · margin {row["margin"]:.3f}{" · ambiguous" if row["ambiguous"] else ""}'
        f'{"" if row["app_accepted"] else " · app rejects"}<br>'
        f'<small>2nd: {escape(row["top2"] or "-")}</small>'
        f'{"" if row["top1"] == row["reference_top1"] else "<br><small>full-res: " + escape(row["reference_top1"]) + "</small>"}'
        f'</figcaption></figure>'
        for row in sorted(rows, key=lambda row: (row["kind"] != "card", row["score"])))
    headline = {key: value for key, value in summary.items() if key != "threshold_grid"}
    grid = "".join(f'<tr><td>{item["score"]}</td><td>{item["margin"]}</td><td>{item["cards_kept"]:.1%}</td>'
                   f'<td>{item["no_card_kept"]:.1%}</td></tr>' for item in summary["threshold_grid"]
                   if item["margin"] == 0.)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Artwork camera probe</title><style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#666;--card:#f3f4f6;--neg:#fde8e8;--off:#fff4d6}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111;--fg:#eee;--muted:#aaa;--card:#1e1f22;--neg:#3a1d1d;--off:#3a321d}}}}
body{{background:var(--bg);color:var(--fg);font:14px system-ui;margin:16px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}}
figure{{margin:0;padding:6px;background:var(--card);border-radius:6px}} figure.rejected{{background:var(--off)}}
figure.no-card{{background:var(--neg)}} img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px}}
figcaption{{font-size:12px;margin-top:4px;overflow-wrap:anywhere}} small{{color:var(--muted)}}
pre{{white-space:pre-wrap;font-size:12px}} table{{border-collapse:collapse;margin:8px 0}}
td,th{{border:1px solid var(--muted);padding:2px 8px;text-align:right}}</style></head><body>
<h1>Artwork camera probe</h1>
<p>{escape(summary["model_version"])} · the phone's path: photo shrunk to a 480 px short side, recognition crop from the
labelled corners, recognizer.onnx, top-K decision. Lowest score first. Yellow = the app's threshold rejects it;
red = No Card photos (centre crop).</p>
<table><tr><th>score ≥</th><th>margin ≥</th><th>cards kept</th><th>no-card kept</th></tr>{grid}</table>
<pre>{escape(json.dumps(headline, indent=1))}</pre><div class="grid">{cells}</div></body></html>"""
