"""Export the card extractor for on-device inference (ONNX, optional TFLite)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import torch
from torch import Tensor, nn

from .events import emit
from .extraction import (LEGACY_COORDINATE_TRANSFORM, NORMALIZE_MEAN, NORMALIZE_STD,
                         _load_model, _sha256, _write_json)
from .extraction_network import (HEATMAP_SIZE, INPUT_SIZE,
                                 corner_anchor_policy_for_config, decode_geometry)

OUTPUT_NAMES = (
    "corner_logits",
    "offsets",
    "mask_logits",
    "orientation_logits",
    "presence_logits",
)
SEMANTIC_OUTPUT = "semantic_corner_logits"
ONNX_OPSET = 17
LOGIT_ATOL = 2e-4
CORNER_ATOL = 1.5e-3


class NormalizedGeometryExporter(nn.Module):
    """ImageNet-normalize [0, 1] RGB NCHW frames, then run geometry heads."""

    def __init__(self, model: nn.Module, mean: tuple[float, float, float],
                 std: tuple[float, float, float]) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(std, dtype=torch.float32).view(1, 3, 1, 1))

    def forward(self, images: Tensor) -> tuple[Tensor, ...]:
        outputs = self.model.forward_geometry((images - self.mean) / self.std)
        packed = (outputs["corner_logits"], outputs["offsets"], outputs["mask_logits"],
                  outputs["orientation_logits"], outputs["presence_logits"])
        if "semantic_corner_logits" in outputs:
            packed = packed + (outputs["semantic_corner_logits"],)
        return packed


def _has_semantic(model: nn.Module) -> bool:
    return hasattr(model, "semantic_corner_head")


def _output_names(model: nn.Module) -> tuple[str, ...]:
    names = list(OUTPUT_NAMES)
    if _has_semantic(model):
        names.append(SEMANTIC_OUTPUT)
    return tuple(names)


def _pack_outputs(values: tuple[Tensor, ...], names: tuple[str, ...]) -> dict[str, Tensor]:
    return {name: value for name, value in zip(names, values)}


def resolve_checkpoint(artifacts_root: Path, model_version: str | None,
                       checkpoint: Path | None) -> tuple[Path, str]:
    if checkpoint is not None:
        path = checkpoint.resolve()
        if not path.is_file():
            raise ValueError(f"Extractor checkpoint was not found: {path}")
        version = model_version or path.parent.name
        return path, version
    if not artifacts_root.is_dir():
        raise ValueError(f"Artifacts root was not found: {artifacts_root}")
    if model_version:
        path = artifacts_root / model_version / "extractor.pt"
        if not path.is_file():
            raise ValueError(f"No extractor.pt in {path.parent}")
        return path, model_version
    pointer = artifacts_root.parent / "current-extraction.json"
    if pointer.is_file():
        payload = json.loads(pointer.read_text(encoding="utf-8"))
        version = str(payload["model_version"])
        relative = payload.get("files", {}).get("checkpoint", "extractor.pt")
        path = artifacts_root / version / relative
        if path.is_file():
            return path, version
    runs = sorted(
        (path for path in artifacts_root.glob("extractor-run-*")
         if (path / "extractor.pt").is_file()),
        key=lambda path: path.name,
        reverse=True,
    )
    if not runs:
        raise ValueError(f"No extractor-run-* checkpoint was found under {artifacts_root}")
    return runs[0] / "extractor.pt", runs[0].name


def _copy_sidecar(artifact_root: Path, name: str, output_root: Path) -> None:
    source = artifact_root / name
    if source.is_file():
        shutil.copy2(source, output_root / name)


def _export_onnx(wrapper: NormalizedGeometryExporter, names: tuple[str, ...],
                 onnx_path: Path) -> None:
    try:
        import onnx  # noqa: F401
    except ImportError as error:
        raise ValueError("export-extraction-mobile requires the onnx package") from error
    dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE, dtype=torch.float32)
    wrapper.eval()
    export_options = dict(
        input_names=["image"], output_names=list(names),
        opset_version=ONNX_OPSET, do_constant_folding=True,
    )
    try:
        torch.onnx.export(wrapper, dummy, str(onnx_path), dynamo=False, **export_options)
    except TypeError:
        torch.onnx.export(wrapper, dummy, str(onnx_path), **export_options)
    import onnx as onnx_module
    onnx_module.checker.check_model(onnx_module.load(str(onnx_path)))


def _onnx_outputs(onnx_path: Path, images: Tensor, names: tuple[str, ...]) -> dict[str, Tensor]:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ValueError("ONNX parity requires the onnxruntime package") from error
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    result = session.run(list(names), {"image": images.detach().cpu().numpy()})
    return {name: torch.from_numpy(value) for name, value in zip(names, result)}


def _max_abs(left: Tensor, right: Tensor) -> float:
    return float((left.float() - right.float()).abs().max().item())


def _parity_report(pytorch: dict[str, Tensor], converted: dict[str, Tensor],
                   policy: str) -> dict[str, Any]:
    logit_errors = {name: _max_abs(pytorch[name], converted[name]) for name in pytorch}
    torch_corners, _ = decode_geometry(pytorch, policy)
    converted_corners, _ = decode_geometry(converted, policy)
    corner_error = _max_abs(torch_corners, converted_corners)
    failed = [name for name, error in logit_errors.items() if error > LOGIT_ATOL]
    if corner_error > CORNER_ATOL:
        failed.append("decoded_corners")
    return {
        "logit_max_abs_error": logit_errors,
        "decoded_corner_max_abs_error": corner_error,
        "logit_atol": LOGIT_ATOL,
        "corner_atol": CORNER_ATOL,
        "passed": not failed,
        "failed": failed,
    }


def _tflite_spatial_outputs_ok(tflite_path: Path) -> bool:
    try:
        from ai_edge_litert.interpreter import Interpreter
    except ImportError:
        try:
            from tensorflow.lite import Interpreter  # type: ignore
        except ImportError:
            return False
    try:
        interpreter = Interpreter(model_path=str(tflite_path))
        interpreter.allocate_tensors()
    except Exception:
        return False
    spatial = {"corner_logits": HEATMAP_SIZE * HEATMAP_SIZE,
               "offsets": 2 * HEATMAP_SIZE * HEATMAP_SIZE,
               "mask_logits": HEATMAP_SIZE * HEATMAP_SIZE}
    details = {item["name"]: item for item in interpreter.get_output_details()}
    for name, minimum in spatial.items():
        if name not in details:
            return False
        size = 1
        for dimension in details[name]["shape"]:
            size *= int(dimension)
        if size < minimum:
            return False
    return True


def _try_tflite(onnx_path: Path, tflite_path: Path) -> str | None:
    try:
        from onnx2tf import convert
    except ImportError:
        return None
    convert(
        input_onnx_file_path=str(onnx_path),
        output_folder_path=str(tflite_path.parent / "onnx2tf"),
        copy_onnx_input_output_names_to_tflite=True,
        batch_size=1,
        non_verbose=True,
    )
    produced = tflite_path.parent / "onnx2tf" / "extractor_float32.tflite"
    if not produced.is_file():
        candidates = sorted((tflite_path.parent / "onnx2tf").glob("*float32*.tflite"))
        produced = candidates[0] if candidates else None
    if produced is None or not produced.is_file() or not _tflite_spatial_outputs_ok(produced):
        return None
    shutil.copy2(produced, tflite_path)
    return str(tflite_path.name)


def export_extraction_mobile(
    artifacts_root: Path,
    output_root: Path,
    model_version: str | None = None,
    checkpoint: Path | None = None,
    device_name: str = "cpu",
) -> dict[str, Any]:
    checkpoint_path, version = resolve_checkpoint(artifacts_root, model_version, checkpoint)
    device = torch.device("cpu" if device_name == "auto" else device_name)
    if device.type == "cuda" and not torch.cuda.is_available():
        device = torch.device("cpu")
    loaded, model = _load_model(checkpoint_path, device)
    model.eval()
    mean = tuple(float(value) for value in loaded.get("normalization_mean", NORMALIZE_MEAN))
    std = tuple(float(value) for value in loaded.get("normalization_std", NORMALIZE_STD))
    input_size = int(loaded.get("input_size", INPUT_SIZE))
    if input_size != INPUT_SIZE:
        raise ValueError(f"Mobile export currently supports {INPUT_SIZE}px extractors, not {input_size}px")
    policy = corner_anchor_policy_for_config(loaded)
    names = _output_names(model)
    wrapper = NormalizedGeometryExporter(model, mean, std).to(device).eval()
    output_root.mkdir(parents=True, exist_ok=True)
    onnx_path = output_root / "extractor.onnx"
    emit("extraction_mobile_export_started", model_version=version, checkpoint=str(checkpoint_path))
    _export_onnx(wrapper, names, onnx_path)

    sample = torch.rand(1, 3, INPUT_SIZE, INPUT_SIZE, dtype=torch.float32, device=device)
    with torch.inference_mode():
        pytorch_tuple = wrapper(sample)
    pytorch = _pack_outputs(tuple(value.cpu() for value in pytorch_tuple), names)
    onnx_values = _onnx_outputs(onnx_path, sample.cpu(), names)
    parity = _parity_report(pytorch, onnx_values, policy)
    if not parity["passed"]:
        raise ValueError(f"ONNX extractor diverged from PyTorch: {parity}")

    tflite_name = _try_tflite(onnx_path, output_root / "extractor.tflite")
    artifact_root = checkpoint_path.parent
    _copy_sidecar(artifact_root, "preprocessing.json", output_root)
    _copy_sidecar(artifact_root, "thresholds.json", output_root)
    _copy_sidecar(artifact_root, "config.json", output_root)
    shapes = {name: list(pytorch[name].shape) for name in names}
    manifest = {
        "mobile_export_schema_version": 1,
        "model_version": version,
        "architecture": loaded.get("architecture"),
        "checkpoint_sha256": _sha256(checkpoint_path),
        "input_name": "image",
        "input_shape": [1, 3, INPUT_SIZE, INPUT_SIZE],
        "input_layout": "NCHW",
        "input_range": [0.0, 1.0],
        "input_color": "RGB",
        "normalization": "imagenet-inside-graph",
        "normalization_mean": list(mean),
        "normalization_std": list(std),
        "letterbox": "centered-contain-black",
        "coordinate_transform": loaded.get("coordinate_transform", LEGACY_COORDINATE_TRANSFORM),
        "corner_order": ["TopLeft", "TopRight", "BottomRight", "BottomLeft"],
        "corner_anchor_policy": policy,
        "heatmap_size": HEATMAP_SIZE,
        "output_names": list(names),
        "output_shapes": shapes,
        "has_semantic_corners": SEMANTIC_OUTPUT in names,
        "onnx": "extractor.onnx",
        "tflite": tflite_name,
        "onnx_parity": parity,
    }
    _write_json(output_root / "mobile-manifest.json", manifest)
    emit("extraction_mobile_exported", **{key: manifest[key] for key in
         ("model_version", "architecture", "onnx", "tflite") if key in manifest},
         parity_passed=parity["passed"])
    return manifest
