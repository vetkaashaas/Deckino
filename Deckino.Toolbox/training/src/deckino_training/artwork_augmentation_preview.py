"""Do the artwork training views look like what the phone actually sees?

Writes ``augmentation-preview.html`` - each sampled Scryfall art crop, clean and
as several training views of the chosen recipe, next to real recognition crops
cut from the annotated camera photos exactly as the phone cuts them - and
``summary.json``: brightness, contrast, sharpness, noise and saturation
percentiles for clean scans, legacy views, camera-v1 views and real crops, plus
how fast each recipe produces a view. The numbers say whether the synthetic
views cover the real range; the sheet lets you judge by eye. Re-running with the
same seed reproduces both.
"""
from __future__ import annotations

import base64
import io
import json
import random
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

from .artwork_camera_probe import CORNER_NAMES, _phone_frame
from .artwork_mobile import phone_recognition_crop
from .camera_augmentation import AUGMENTATION_RECIPES
from .events import emit
from .model import IMAGE_SIZE, build_train_transform

STATISTIC_VIEWS = 400
REAL_CROPS = 200
LUMA = np.array([0.299, 0.587, 0.114])


def _statistics(image: np.ndarray) -> dict[str, float]:
    """Image statistics on a [3, H, W] float array in [0, 1]."""
    luma = np.tensordot(LUMA, image, axes=1)
    laplacian = (luma[:-2, 1:-1] + luma[2:, 1:-1] + luma[1:-1, :-2] + luma[1:-1, 2:] - 4 * luma[1:-1, 1:-1])
    # Immerkaer's noise estimate: a Laplacian-difference mask that cancels smooth image content.
    mask = (luma[:-2, :-2] - 2 * luma[:-2, 1:-1] + luma[:-2, 2:] - 2 * luma[1:-1, :-2] + 4 * luma[1:-1, 1:-1]
            - 2 * luma[1:-1, 2:] + luma[2:, :-2] - 2 * luma[2:, 1:-1] + luma[2:, 2:])
    return {"brightness": float(luma.mean()), "contrast": float(luma.std()),
            "sharpness": float(laplacian.var() * 1e3),
            "noise": float(np.sqrt(np.pi / 2) * np.abs(mask).mean() / 6),
            "saturation": float((image.max(0) - image.min(0)).mean())}


def _percentiles(rows: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    return {key: {f"p{q}": round(float(np.percentile([row[key] for row in rows], q)), 4) for q in (10, 50, 90)}
            for key in rows[0]} if rows else {}


def _clean(image: Image.Image) -> np.ndarray:
    resized = image.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BICUBIC)
    return np.asarray(resized, dtype=np.float32).transpose(2, 0, 1) / 255


def _thumbnail(image: np.ndarray) -> str:
    buffer = io.BytesIO()
    Image.fromarray((image.transpose(1, 2, 0).clip(0, 1) * 255).round().astype(np.uint8)).save(
        buffer, "JPEG", quality=82)
    return base64.b64encode(buffer.getvalue()).decode()


def _real_crops(data_root: Path, count: int, seed: int) -> list[np.ndarray]:
    """Recognition crops from annotated card photos, cut the way the phone cuts them."""
    sidecars = sorted((data_root / "training" / "camera" / "imports").rglob("*._annotations.json"))
    random.Random(seed).shuffle(sidecars)
    crops: list[np.ndarray] = []
    for sidecar in sidecars:
        if len(crops) >= count:
            break
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        image_path = sidecar.parent / payload["ImageFile"]
        if not payload.get("CardPresent") or not image_path.is_file():
            continue
        with Image.open(image_path) as source:
            frame = _phone_frame(source.convert("RGB"))
        corners = [{"x": payload[name]["X"], "y": payload[name]["Y"]} for name in CORNER_NAMES]
        crops.append(phone_recognition_crop(frame, corners))
    return crops


def preview_artwork_augmentation(data_root: Path, output_root: Path, recipe: str = "camera-v1",
                                 artworks: int = 24, views: int = 6, seed: int = 20260929) -> dict[str, Any]:
    if recipe not in AUGMENTATION_RECIPES:
        raise ValueError(f"Recipe must be one of {AUGMENTATION_RECIPES}")
    images = sorted((data_root / "cards").rglob("*.jpg"))
    if len(images) < artworks:
        raise ValueError(f"Found {len(images)} art crops under {data_root / 'cards'}; need at least {artworks}")
    rng = random.Random(seed)
    shown = rng.sample(images, artworks)
    statistic_sources = rng.sample(images, min(len(images), STATISTIC_VIEWS))
    output_root.mkdir(parents=True, exist_ok=True)
    emit("artwork_augmentation_preview_started", recipe=recipe, artworks=artworks, views=views)

    groups: dict[str, list[dict[str, float]]] = {"clean_scryfall": []}
    timing: dict[str, float] = {}
    for name in AUGMENTATION_RECIPES:
        transform = build_train_transform(name, normalize=False)
        torch.manual_seed(seed)
        rows, started = [], time.perf_counter()
        for path in statistic_sources:
            with Image.open(path) as source:
                rows.append(_statistics(transform(source.convert("RGB")).numpy()))
        timing[name] = round((time.perf_counter() - started) / len(statistic_sources) * 1000, 2)
        groups[f"{name}_views"] = rows
    for path in statistic_sources:
        with Image.open(path) as source:
            groups["clean_scryfall"].append(_statistics(_clean(source)))
    real = _real_crops(data_root, REAL_CROPS, seed)
    groups["real_phone_crops"] = [_statistics(crop) for crop in real]

    transform = build_train_transform(recipe, normalize=False)
    torch.manual_seed(seed)
    sheet_rows = []
    for path in shown:
        with Image.open(path) as source:
            image = source.convert("RGB")
            sheet_rows.append({"name": path.relative_to(data_root / "cards").as_posix(),
                               "clean": _thumbnail(_clean(image)),
                               "views": [_thumbnail(transform(image).numpy()) for _ in range(views)]})

    summary = {"recipe": recipe, "seed": seed, "statistic_views_per_group": len(statistic_sources),
               "real_crops": len(real), "milliseconds_per_view": timing,
               "statistics": {name: _percentiles(rows) for name, rows in groups.items()}}
    (output_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (output_root / "augmentation-preview.html").write_text(
        _html(summary, sheet_rows, [_thumbnail(crop) for crop in real[:artworks * 2]]), encoding="utf-8")
    emit("artwork_augmentation_preview_finished", output=str(output_root), recipe=recipe,
         milliseconds_per_view=timing, real_crops=len(real))
    return summary


def _html(summary: dict[str, Any], rows: list[dict[str, Any]], real: list[str]) -> str:
    from html import escape
    statistics = summary["statistics"]
    groups = list(statistics)
    table = "".join(
        f"<tr><th>{escape(metric)}</th>" + "".join(
            f"<td>{statistics[group][metric]['p10']:.3f} · <b>{statistics[group][metric]['p50']:.3f}</b> · "
            f"{statistics[group][metric]['p90']:.3f}</td>" for group in groups) + "</tr>"
        for metric in statistics["real_phone_crops"])
    header = "".join(f"<th>{escape(group.replace('_', ' '))}</th>" for group in groups)
    sheet = "".join(
        f'<div class="row"><figure class="clean"><img src="data:image/jpeg;base64,{row["clean"]}" alt="">'
        f'<figcaption>{escape(row["name"])}</figcaption></figure>'
        + "".join(f'<figure><img src="data:image/jpeg;base64,{view}" alt=""></figure>' for view in row["views"])
        + "</div>" for row in rows)
    real_cells = "".join(f'<figure><img src="data:image/jpeg;base64,{crop}" alt=""></figure>' for crop in real)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Augmentation preview</title><style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#666;--card:#f3f4f6;--accent:#dfe9f7}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111;--fg:#eee;--muted:#aaa;--card:#1e1f22;--accent:#1d2a3a}}}}
body{{background:var(--bg);color:var(--fg);font:14px system-ui;margin:16px}}
.row,.real{{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;margin-bottom:10px}}
figure{{margin:0;padding:4px;background:var(--card);border-radius:6px}} figure.clean{{background:var(--accent)}}
img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px;display:block}}
figcaption{{font-size:11px;color:var(--muted);overflow-wrap:anywhere}}
.scroll{{overflow-x:auto}} table{{border-collapse:collapse;font-size:12px}}
td,th{{border:1px solid var(--muted);padding:3px 8px;text-align:right;white-space:nowrap}}</style></head><body>
<h1>Artwork augmentation preview</h1>
<p>Recipe <b>{escape(summary["recipe"])}</b>, seed {summary["seed"]}. Each row: the clean Scryfall art crop
(blue) and training views. Below: real recognition crops cut from annotated camera photos the way the phone cuts
them. Table: p10 · <b>median</b> · p90 per group; the training views should cover the real crops' range.
View cost (ms): {escape(json.dumps(summary["milliseconds_per_view"]))}.</p>
<div class="scroll"><table><tr><th></th>{header}</tr>{table}</table></div>
<h2>Training views</h2>{sheet}
<h2>Real phone crops</h2><div class="real">{real_cells}</div></body></html>"""
