"""Full-resolution second-stage corner refinement.

The 320px extractor places each corner to within roughly one 4px heatmap cell,
which is 15-25px on an imported 2048px photograph. The refiner re-examines every
coarse corner in a crop taken from the photograph itself. Each crop is warped
into a canonical frame: the coarse corner sits at the crop centre, the edge
towards the next corner points right and the edge towards the previous corner
points down, so every corner of every card looks like the top-left corner of an
upright card. A small MobileNetV3 network then predicts the exact corner with a
sub-pixel soft-argmax, plus a Laplace uncertainty. A corner whose predicted
uncertainty exceeds MAXIMUM_CORNER_UNCERTAINTY keeps its coarse position.

Classical edge-line fitting was evaluated first and rejected: on black-bordered
cards over dark surfaces the printed frame is the strongest straight line near
the prediction, so it made corners worse. A learned refiner uses the same cues
as the annotator, including card context when the physical edge is faint.
"""
from __future__ import annotations

import math
import random
import zlib
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import torch
from PIL import Image
from torch import Tensor, nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
from torchvision.transforms import functional as TF

from .events import emit
from .extraction import (NORMALIZE_MEAN, NORMALIZE_STD, ExtractionRecord, _atomic_torch_save, _device,
                         _sha256, _validate_quad, _write_json, read_manifest)
from .extraction_augmentation import _apply_camera_artifacts
from .extraction_network import SpatialRefinement

REFINER_ARCHITECTURE = "mobilenetv3-small-corner-refiner-v1"
REFINER_SCHEMA_VERSION = 1
CROP_SIZE = 128
# Half the crop side as a fraction of the card diagonal. Coarse p95 error is
# about 3.3% of the diagonal, so 7.5% keeps the true corner well inside.
CROP_HALF_EXTENT = .075
OUTPUT_STRIDE = 2
REFINER_CHANNELS = 32
HEATMAP_SIGMA_CELLS = 1.
FILL_RGB = (114, 114, 114)
DEFAULT_PASSES = 2
# Per-corner fallback: the Laplace scale estimates the expected |dx|+|dy| error.
# Above 1.5% of the card diagonal the refiner is no better than the coarse stage
# (recipe-8 mean error was ~1.6%), so the coarse corner is kept. Provisional:
# tune it against the refined-vs-coarse evaluation of a real training run.
MAXIMUM_CORNER_UNCERTAINTY = .015
# Simulated coarse error, as fractions of the card diagonal. The recipe-8 model
# measured 1.6% mean, 3.3% p95 on held-out photos; training slightly wider keeps
# the refiner robust to a worse coarse stage.
NOISE_CORNER_SIGMA = .014
NOISE_CORNER_LIMIT = .055
NOISE_SHIFT_SIGMA = .008
NOISE_SCALE_SIGMA = .012
NOISE_ROTATION_DEGREES = 1.2


class CornerRefiner(nn.Module):
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__()
        network = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
        # Strides 2/4/8/16 are enough context for a 128px corner crop.
        self.features = network.features[:9]
        self.taps = (0, 1, 3, 8)
        self.lateral = nn.ModuleList(nn.Conv2d(channels, REFINER_CHANNELS, 1) for channels in (16, 16, 24, 48))
        self.refine = nn.ModuleList(SpatialRefinement(REFINER_CHANNELS) for _ in range(3))
        self.heatmap_head = nn.Conv2d(REFINER_CHANNELS, 1, 1)
        self.uncertainty_head = nn.Sequential(nn.Linear(48 + REFINER_CHANNELS, 64), nn.Hardswish(), nn.Linear(64, 1))
        self.train(self.training)

    def train(self, mode: bool = True) -> CornerRefiner:
        super().train(mode)
        # Pretrained BatchNorm statistics stay frozen, as in the coarse extractor.
        for layer in self.features.modules():
            if isinstance(layer, nn.BatchNorm2d):
                layer.eval()
        return self

    def forward(self, crops: Tensor) -> dict[str, Tensor]:
        maps, values = [], crops
        for index, layer in enumerate(self.features):
            values = layer(values)
            if index in self.taps:
                maps.append(values)
        spatial = self.lateral[3](maps[3])
        for block, index in zip(self.refine, (2, 1, 0)):
            spatial = block(F.interpolate(spatial, size=maps[index].shape[-2:], mode="bilinear", align_corners=False)
                            + self.lateral[index](maps[index]))
        logits = self.heatmap_head(spatial).float()[:, 0]
        height, width = logits.shape[-2:]
        distribution = logits.flatten(1).softmax(-1).reshape_as(logits)
        # A stride-2 cell j is centred on crop pixel 2j.
        xs = torch.arange(width, device=logits.device, dtype=torch.float32) * OUTPUT_STRIDE
        ys = torch.arange(height, device=logits.device, dtype=torch.float32) * OUTPUT_STRIDE
        points = torch.stack(((distribution.sum(1) * xs).sum(-1), (distribution.sum(2) * ys).sum(-1)), dim=-1)
        pooled = torch.cat((F.adaptive_avg_pool2d(maps[3], 1).flatten(1), F.adaptive_avg_pool2d(spatial, 1).flatten(1)), 1)
        log_scale = self.uncertainty_head(pooled).float()[:, 0].clamp(-4., 4.)
        return {"points": points, "logits": logits, "log_scale": log_scale}


def refiner_loss(outputs: dict[str, Tensor], targets: Tensor, valid: Tensor) -> tuple[Tensor, dict[str, Tensor]]:
    """L1 on the soft-argmax point, heatmap KL, and a detached Laplace NLL for the uncertainty head."""
    weight = valid.float()
    count = weight.sum().clamp_min(1)
    error = (outputs["points"] - targets).abs().sum(-1)
    l1 = (error * weight).sum() / count
    logits = outputs["logits"]
    height, width = logits.shape[-2:]
    ys, xs = torch.meshgrid(torch.arange(height, device=logits.device), torch.arange(width, device=logits.device),
                            indexing="ij")
    cells = targets / OUTPUT_STRIDE
    gaussian = torch.exp(-((xs[None] - cells[:, 0, None, None]) ** 2 + (ys[None] - cells[:, 1, None, None]) ** 2)
                         / (2 * HEATMAP_SIGMA_CELLS ** 2))
    gaussian = gaussian / gaussian.flatten(1).sum(-1).clamp_min(1e-8)[:, None, None]
    heatmap = (-(gaussian * logits.flatten(1).log_softmax(-1).reshape_as(logits)).sum((1, 2)) * weight).sum() / count
    # The uncertainty head learns to predict its own error without changing localization.
    nll = ((error.detach() / outputs["log_scale"].exp() + 2 * outputs["log_scale"]) * weight).sum() / count
    total = l1 + heatmap + .5 * nll
    return total, {"point_l1": l1, "heatmap_kl": heatmap, "uncertainty_nll": nll}


def _pixels(corners: Sequence[dict[str, float]], width: int, height: int) -> np.ndarray:
    return np.array([[float(point["x"]) * (width - 1), float(point["y"]) * (height - 1)] for point in corners],
                    dtype=np.float64)


def _normalized(points: np.ndarray, width: int, height: int) -> list[dict[str, float]]:
    return [{"x": float(x / max(1, width - 1)), "y": float(y / max(1, height - 1))} for x, y in points]


def _diagonal(points: np.ndarray) -> float:
    return max(float(np.linalg.norm(points[0] - points[2])), float(np.linalg.norm(points[1] - points[3])))


class WorkingImage:
    """Photograph box-reduced so a crop pixel spans at most ~2 source pixels (no aliasing)."""

    def __init__(self, image: Image.Image, diagonal: float) -> None:
        image = image.convert("RGB")
        step = 2 * CROP_HALF_EXTENT * diagonal / CROP_SIZE
        self.factor = max(1, int(step))
        self.source_size = image.size
        self.image = image.reduce(self.factor) if self.factor > 1 else image
        # Working pixel i averages source pixels [i*factor, (i+1)*factor). reduce()
        # rounds the output size up, so the reduced/original size ratio is not the
        # pixel mapping for odd sizes and would bias corners near the far edge.
        self.scale = np.full(2, 1 / self.factor)

    def to_working(self, points: np.ndarray) -> np.ndarray:
        return (points + .5) * self.scale - .5

    def to_source(self, points: np.ndarray) -> np.ndarray:
        return (points + .5) / self.scale - .5


def crop_frame(points: np.ndarray, index: int, diagonal: float) -> tuple[np.ndarray, np.ndarray]:
    """Affine frame mapping canonical crop pixels q to image pixels p = origin + matrix @ q."""
    corner = points[index]
    following = points[(index + 1) % 4] - corner
    previous = points[(index - 1) % 4] - corner
    step = 2 * CROP_HALF_EXTENT * diagonal / CROP_SIZE
    matrix = np.column_stack((following / np.linalg.norm(following), previous / np.linalg.norm(previous))) * step
    center = np.full(2, (CROP_SIZE - 1) / 2)
    return corner - matrix @ center, matrix


def _crop(image: Image.Image, origin: np.ndarray, matrix: np.ndarray) -> Image.Image:
    # PIL samples output pixel centres at (q + .5) and input pixel centres sit
    # at (p + .5), so shift both sides of the pixel-centre affine map.
    offset = origin + .5 - matrix @ np.full(2, .5)
    data = (matrix[0, 0], matrix[0, 1], offset[0], matrix[1, 0], matrix[1, 1], offset[1])
    return image.transform((CROP_SIZE, CROP_SIZE), Image.Transform.AFFINE, data, Image.Resampling.BICUBIC,
                           fillcolor=FILL_RGB)


def corner_crops(image: WorkingImage, coarse: np.ndarray, diagonal: float
                 ) -> tuple[list[Image.Image], list[tuple[np.ndarray, np.ndarray]]]:
    """Canonical crops for all four corners; frames map crop pixels to *working* image pixels."""
    working = image.to_working(coarse)
    working_diagonal = diagonal * float(np.mean(image.scale))
    crops, frames = [], []
    for index in range(4):
        origin, matrix = crop_frame(working, index, working_diagonal)
        crops.append(_crop(image.image, origin, matrix))
        frames.append((origin, matrix))
    return crops, frames


def _to_tensor(crop: Image.Image) -> Tensor:
    return TF.normalize(TF.to_tensor(crop), NORMALIZE_MEAN, NORMALIZE_STD)


def simulate_coarse(points: np.ndarray, rng: random.Random) -> np.ndarray:
    """Perturb ground-truth corners with a coarse-stage-like error: a shared similarity jitter plus per-corner noise."""
    diagonal = _diagonal(points)
    center = points.mean(0)
    angle = math.radians(rng.gauss(0, NOISE_ROTATION_DEGREES))
    scale = 1 + rng.gauss(0, NOISE_SCALE_SIGMA)
    rotation = scale * np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    shift = np.array([rng.gauss(0, NOISE_SHIFT_SIGMA), rng.gauss(0, NOISE_SHIFT_SIGMA)]) * diagonal
    moved = (points - center) @ rotation.T + center + shift
    for index in range(4):
        noise = np.array([rng.gauss(0, NOISE_CORNER_SIGMA), rng.gauss(0, NOISE_CORNER_SIGMA)])
        magnitude = float(np.linalg.norm(noise))
        if magnitude > NOISE_CORNER_LIMIT:
            noise *= NOISE_CORNER_LIMIT / magnitude
        moved[index] += noise * diagonal
    # Keep the total displacement inside the crop.
    displacement = moved - points
    limit = .9 * CROP_HALF_EXTENT * diagonal
    lengths = np.linalg.norm(displacement, axis=1, keepdims=True)
    return points + displacement * np.minimum(1, limit / np.maximum(lengths, 1e-9))


class RefinerDataset(Dataset[tuple[Tensor, Tensor, Tensor, Tensor]]):
    """Four canonical corner crops per annotated positive photograph."""

    def __init__(self, image_root: Path, records: Sequence[ExtractionRecord], training: bool, seed: int,
                 repeats: int = 1) -> None:
        self.image_root = image_root
        self.records = [record for record in records if record.card_present and record.corners]
        self.training, self.seed, self.repeats = training, seed, repeats
        self.epoch = 0

    def __len__(self) -> int:
        return len(self.records) * self.repeats

    def __getitem__(self, index: int) -> tuple[Tensor, Tensor, Tensor, Tensor]:
        record = self.records[index % len(self.records)]
        # Validation noise is fixed per photograph; training noise changes every epoch.
        key = f"{self.seed}:{index}:{self.epoch}" if self.training else f"{self.seed}:{record.sample_id}"
        rng = random.Random(zlib.crc32(key.encode()))
        with Image.open(self.image_root / record.image_path) as source:
            image = source.convert("RGB")
        truth = _pixels(record.corners, image.width, image.height)
        coarse = simulate_coarse(truth, rng)
        diagonal = _diagonal(coarse)
        if self.training:
            diagonal *= 1 + rng.uniform(-.15, .15)  # crop-scale jitter
        working = WorkingImage(image, diagonal)
        crops, frames = corner_crops(working, coarse, diagonal)
        tensors, targets, valid = [], [], []
        truth_working = working.to_working(truth)
        for crop, (origin, matrix), target_point in zip(crops, frames, truth_working):
            target = np.linalg.solve(matrix, target_point - origin)
            inside = bool(np.all(target >= 2) and np.all(target <= CROP_SIZE - 3))
            if self.training:
                crop = _apply_camera_artifacts(crop, rng)
                if rng.random() < .5:
                    # Swapping the two edge axes is a mirrored corner: still a valid card corner.
                    crop = crop.transpose(Image.Transpose.TRANSPOSE)
                    target = target[::-1].copy()
            tensors.append(_to_tensor(crop))
            targets.append(torch.tensor(target, dtype=torch.float32))
            valid.append(inside)
        # Converts a crop-pixel error to a fraction of the true card diagonal.
        step = float(np.linalg.norm(frames[0][1][:, 0]))
        fraction = step / (float(np.mean(working.scale)) * _diagonal(truth))
        return torch.stack(tensors), torch.stack(targets), torch.tensor(valid), torch.full((4,), fraction)


def _collate(batch):
    crops, targets, valid, scale = zip(*batch)
    return torch.cat(crops), torch.cat(targets), torch.cat(valid), torch.cat(scale)


def _configuration(records: Sequence[ExtractionRecord], manifest: Path, model_version: str, seed: int,
                   pretrained: bool, epochs: int, batch_size: int) -> dict[str, Any]:
    return {"refiner_schema_version": REFINER_SCHEMA_VERSION, "architecture": REFINER_ARCHITECTURE,
            "model_version": model_version, "dataset_version": records[0].dataset_version,
            "manifest_sha256": _sha256(manifest), "crop_size": CROP_SIZE, "crop_half_extent": CROP_HALF_EXTENT,
            "output_stride": OUTPUT_STRIDE, "crop_frame": "corner-centre-next-edge-right-previous-edge-down",
            "crop_fill_rgb": list(FILL_RGB), "working_image": "box-reduce-to-at-most-2-source-pixels-per-crop-pixel-exact-mapping-v2",
            "maximum_corner_uncertainty": MAXIMUM_CORNER_UNCERTAINTY,
            "normalization_mean": NORMALIZE_MEAN, "normalization_std": NORMALIZE_STD,
            "passes": DEFAULT_PASSES, "seed": seed, "pretrained": pretrained, "epochs": epochs,
            "batch_images": batch_size, "corner_convention": "edge-intersection-v1",
            "noise": {"corner_sigma": NOISE_CORNER_SIGMA, "corner_limit": NOISE_CORNER_LIMIT,
                      "shift_sigma": NOISE_SHIFT_SIGMA, "scale_sigma": NOISE_SCALE_SIGMA,
                      "rotation_degrees": NOISE_ROTATION_DEGREES},
            "objective": "soft-argmax-l1-plus-heatmap-kl-plus-0.5x-detached-laplace-nll",
            "training_image_hashes": sorted({item.image_sha256 for item in records if item.split == "train"})}


@torch.inference_mode()
def _validate(model: CornerRefiner, loader: DataLoader, device: torch.device) -> dict[str, float | None]:
    model.eval()
    before, after = [], []
    for crops, targets, valid, scale in loader:
        outputs = model(crops.to(device))
        center = torch.full_like(targets, (CROP_SIZE - 1) / 2)
        keep = valid.bool()
        after.extend(((outputs["points"].cpu() - targets).norm(dim=-1) * scale)[keep].tolist())
        before.extend(((center - targets).norm(dim=-1) * scale)[keep].tolist())
    if not after:
        return {"mean_corner_error": None, "p95_corner_error": None, "input_mean_corner_error": None}
    return {"mean_corner_error": float(np.mean(after)), "p95_corner_error": float(np.percentile(after, 95)),
            "within_1_percent": float(np.mean(np.array(after) <= .01)),
            "input_mean_corner_error": float(np.mean(before)), "corners": len(after)}


def train_refiner(manifest: Path, artifacts_root: Path, model_version: str, epochs: int, batch_size: int,
                  learning_rate: float, workers: int, pretrained: bool, resume: Path | None, device_name: str,
                  seed: int, cuda_index: int | None, max_batches: int | None = None) -> dict[str, Any]:
    if epochs < 1 or batch_size < 1:
        raise ValueError("Epochs and batch size must be positive")
    torch.manual_seed(seed)
    records, root, _ = read_manifest(manifest)
    training = [item for item in records if item.split == "train" and item.card_present]
    validation = [item for item in records if item.split == "validation" and item.source_kind == "real"
                  and item.card_present]
    if not training:
        raise ValueError("Refiner training requires annotated positive photographs")
    device = _device(device_name, cuda_index)
    output = artifacts_root.resolve() / model_version
    output.mkdir(parents=True, exist_ok=True)
    config = _configuration(records, manifest, model_version, seed, pretrained, epochs, batch_size)
    config.update(learning_rate=learning_rate)
    checkpoint = torch.load(resume, map_location="cpu", weights_only=False) if resume else None
    if checkpoint:
        for key in ("architecture", "manifest_sha256", "crop_size", "crop_half_extent", "seed", "epochs",
                    "batch_images", "learning_rate", "noise"):
            if checkpoint.get(key) != config.get(key):
                raise ValueError(f"Resume refiner checkpoint {key} does not match this run; start a fresh run")
    model = CornerRefiner(pretrained=pretrained and checkpoint is None).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=1e-4)
    total_steps = epochs
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda index: min(1., (index + 1) / 3)
                                                  * (.02 + .98 * (1 + math.cos(math.pi * index / total_steps)) / 2))
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    start, best, history = 1, None, []
    if checkpoint:
        model.load_state_dict(checkpoint["model_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        scheduler.load_state_dict(checkpoint["scheduler_state"])
        scaler.load_state_dict(checkpoint["scaler_state"])
        start, best, history = checkpoint["epoch"] + 1, checkpoint["best_mean_corner_error"], checkpoint["history"]
    # Real photos are few; several noisy views per photo per epoch give the refiner many corner examples.
    dataset = RefinerDataset(root, training, True, seed, repeats=4)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=workers, collate_fn=_collate,
                        pin_memory=device.type == "cuda", persistent_workers=False, drop_last=len(dataset) > batch_size,
                        generator=torch.Generator().manual_seed(seed))
    validation_loader = DataLoader(RefinerDataset(root, validation, False, seed), batch_size=batch_size,
                                   num_workers=workers, collate_fn=_collate) if validation else None
    _write_json(output / "refiner-config.json", config)
    for epoch in range(start, epochs + 1):
        dataset.epoch = epoch
        model.train()
        totals: dict[str, float] = {}
        steps = len(loader) if max_batches is None else min(len(loader), max_batches)
        for batch, (crops, targets, valid, _) in enumerate(loader, 1):
            if batch > steps:
                break
            crops, targets, valid = crops.to(device), targets.to(device), valid.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                outputs = model(crops)
            loss, parts = refiner_loss(outputs, targets, valid)
            if not torch.isfinite(loss):
                raise RuntimeError(f"Refiner training produced a non-finite loss at epoch {epoch}, batch {batch}")
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.)
            scaler.step(optimizer)
            scaler.update()
            for key, value in {"loss": loss, **parts}.items():
                totals[key] = totals.get(key, 0.) + float(value.detach())
            if batch == 1 or batch == steps or batch % 10 == 0:
                emit("extraction_refiner_progress", epoch=epoch, epochs=epochs, batch=batch, total_batches=steps,
                     **{key: value / batch for key, value in totals.items()})
        scheduler.step()
        metrics = _validate(model, validation_loader, device) if validation_loader else {"mean_corner_error": None}
        score = metrics["mean_corner_error"]
        improved = best is None or (score is not None and score < best)
        if improved:
            best = score
        row = {"epoch": epoch, **{key: value / max(1, steps) for key, value in totals.items()},
               "validation": metrics, "selected": improved}
        history.append(row)
        saved = {**config, "epoch": epoch, "model_state": model.state_dict(), "history": history,
                 "best_mean_corner_error": best, "validation_metrics": metrics}
        _atomic_torch_save({**saved, "optimizer_state": optimizer.state_dict(),
                            "scheduler_state": scheduler.state_dict(), "scaler_state": scaler.state_dict()},
                           output / "refiner-last.pt")
        if improved:
            _atomic_torch_save(saved, output / "refiner.pt")
        emit("extraction_refiner_epoch_completed", **row)
    _write_json(output / "refiner-history.json", history)
    result = {"model_version": model_version, "completed_epoch": epochs, "best_mean_corner_error": best}
    emit("extraction_refiner_completed", **result)
    return result


def load_refiner(path: Path, device: torch.device) -> tuple[dict[str, Any], CornerRefiner]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    if checkpoint.get("architecture") != REFINER_ARCHITECTURE or checkpoint.get("crop_size") != CROP_SIZE:
        raise ValueError("Unsupported corner refiner architecture or crop size")
    model = CornerRefiner().to(device)
    model.load_state_dict(checkpoint["model_state"])
    model.eval()
    return checkpoint, model


@torch.inference_mode()
def refine_corners(model: CornerRefiner, image: Image.Image, corners: Sequence[dict[str, float]],
                   device: torch.device, passes: int = DEFAULT_PASSES,
                   maximum_uncertainty: float = MAXIMUM_CORNER_UNCERTAINTY) -> dict[str, Any]:
    """Refine normalized [TopLeft, TopRight, BottomRight, BottomLeft] corners on the full photograph.

    `refined` is true when at least one corner was moved; `corner_refined` says which.
    """
    image = image.convert("RGB")
    coarse = _pixels(corners, image.width, image.height)
    diagonal = _diagonal(coarse)
    points = coarse.copy()
    uncertainty = [None] * 4
    working = WorkingImage(image, diagonal)
    for _ in range(max(1, passes)):
        crops, frames = corner_crops(working, points, diagonal)
        outputs = model(torch.stack([_to_tensor(crop) for crop in crops]).to(device))
        predicted = outputs["points"].cpu().double().numpy()
        scales = outputs["log_scale"].exp().cpu().double().numpy()
        refined = []
        for index, ((origin, matrix), point) in enumerate(zip(frames, predicted)):
            refined.append(origin + matrix @ point)
            # Laplace scale in crop pixels -> fraction of the card diagonal.
            uncertainty[index] = float(scales[index] * np.linalg.norm(matrix @ np.array([1., 0.]))
                                       / (float(np.mean(working.scale)) * diagonal))
        points = working.to_source(np.array(refined))
    shifts = np.linalg.norm(points - coarse, axis=1) / diagonal
    # Keep the coarse corner wherever the refiner is unsure or left its crop.
    corner_refined = [bool(shift <= CROP_HALF_EXTENT and value <= maximum_uncertainty)
                      for shift, value in zip(shifts, uncertainty)]
    # Unrefined corners are returned exactly as given, without a pixel round trip.
    result = [refined_point if refined else {"x": float(point["x"]), "y": float(point["y"])}
              for refined_point, refined, point in zip(_normalized(points, image.width, image.height),
                                                        corner_refined, corners)]
    try:
        _validate_quad(result)
    except ValueError:
        corner_refined = [False] * 4
        result = [dict(point) for point in corners]
    served_shifts = [float(shift) if refined else 0. for shift, refined in zip(shifts, corner_refined)]
    return {"corners": result, "refined": any(corner_refined), "corner_refined": corner_refined,
            "corner_uncertainty": uncertainty, "corner_shift": served_shifts,
            "coarse_corners": [dict(point) for point in corners]}
