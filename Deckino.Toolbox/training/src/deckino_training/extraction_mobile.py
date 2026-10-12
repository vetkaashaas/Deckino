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
                                 corner_anchor_policy_for_config, decode_geometry,
                                 offset_range_for_config)

OUTPUT_NAMES = (
    "corner_logits",
    "offsets",
    "mask_logits",
    "orientation_logits",
    "presence_logits",
)
SEMANTIC_OUTPUT = "semantic_corner_logits"
# The Dynamo exporter only builds opset 18; asking for 17 makes it attempt a down-conversion that fails noisily.
ONNX_OPSET = 18
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


class NormalizedRefinerExporter(nn.Module):
    """ImageNet-normalize [0, 1] RGB canonical corner crops, then predict crop-pixel corners."""

    def __init__(self, model: nn.Module, mean: tuple[float, float, float],
                 std: tuple[float, float, float]) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(std, dtype=torch.float32).view(1, 3, 1, 1))

    def forward(self, crops: Tensor) -> tuple[Tensor, Tensor]:
        outputs = self.model((crops - self.mean) / self.std)
        return outputs["points"], outputs["log_scale"]


# The phone's recognition frame (portrait VGA): the refiner runs on it, and its fixture cards are drawn on one.
REFINER_FIXTURE_FRAME = (480, 640)
# Fixture cards: true corners in frame pixels (TopLeft, TopRight, BottomRight, BottomLeft of the card) and the
# coarse-guess offset per corner, about the extractor's 1.5% mean error. Upright, tilted, upside down, and one
# corner running past the frame edge so the crop fill is exercised.
REFINER_FIXTURE_CARDS = (
    (((132, 168), (348, 176), (340, 474), (122, 466)), ((4, -3), (-5, 2), (3, 5), (-2, -4))),
    (((180, 130), (390, 175), (330, 455), (118, 410)), ((-6, 4), (3, 3), (-4, -2), (5, -5))),
    (((350, 480), (140, 470), (150, 186), (360, 196)), ((3, 3), (-4, 2), (2, -5), (-3, -2))),
    (((-6, 210), (232, 196), (246, 528), (8, 542)), ((5, 2), (-3, -4), (4, 3), (-2, 5))),
)
# Phone (in-graph bicubic) vs Toolbox (PIL bicubic) refined corners on the fixture cards, as a fraction of the card
# diagonal. A gross-error guard only: the drawn cards have sharp corners the refiner never trained on, so a small
# sampling difference can move an unsure corner by ~0.5%. On 60 real phone photos the two agreed to 0.013% mean,
# 0.23% worst (2026-10-12). The crop check (mean under one grey level) is the precise one.
REFINER_FRAME_CORNER_TOLERANCE = 1e-2
REFINER_FIXTURE_TOLERANCE = 1e-5


def _export_refiner(refiner_path: Path, output_root: Path, device: torch.device) -> dict[str, Any]:
    """Export the corner refiner for the phone and verify it.

    refiner.onnx takes the upright camera frame and four crop transforms, cuts the corner crops itself (as the
    recognizer cuts its crop) and returns crop-pixel corners. The network is checked against PyTorch, the in-graph
    crops against the Toolbox's PIL crops, and the phone's whole refinement against refine_corners; the recorded
    passes become refiner-fixture.json for the app's TypeScript check.
    """
    from .extraction_refiner import (CROP_HALF_EXTENT, CROP_SIZE, DEFAULT_PASSES, FILL_RGB,
                                     MAXIMUM_CORNER_UNCERTAINTY, OUTPUT_STRIDE, load_refiner)
    config, refiner = load_refiner(refiner_path, device)
    wrapper = NormalizedRefinerExporter(refiner, tuple(config["normalization_mean"]),
                                        tuple(config["normalization_std"])).to(device).eval()
    crops_path = output_root / "refiner-crops.onnx"
    dummy = torch.zeros(4, 3, CROP_SIZE, CROP_SIZE, dtype=torch.float32, device=device)
    options = dict(input_names=["crops"], output_names=["points", "log_scale"], opset_version=ONNX_OPSET)
    try:
        # The refiner graph is static (fixed 4x128x128 crops), so the TorchScript exporter suffices.
        torch.onnx.export(wrapper, dummy, str(crops_path), dynamo=False, do_constant_folding=True, **options)
    except Exception:
        torch.onnx.export(wrapper, dummy, str(crops_path), dynamo=True, verbose=False, **options)
    import onnx as onnx_module
    data_path = crops_path.with_name(crops_path.name + ".data")
    if data_path.is_file():
        onnx_module.save_model(onnx_module.load(str(crops_path)), str(crops_path), save_as_external_data=False)
        data_path.unlink()
    onnx_module.checker.check_model(onnx_module.load(str(crops_path)))
    sample = torch.rand(4, 3, CROP_SIZE, CROP_SIZE, dtype=torch.float32, device=device)
    with torch.inference_mode():
        expected = tuple(value.cpu() for value in wrapper(sample))
    converted = _onnx_outputs(crops_path, sample.cpu(), ("points", "log_scale"), "crops")
    point_error = _max_abs(expected[0], converted["points"])
    scale_error = _max_abs(expected[1], converted["log_scale"])
    # Points are in crop pixels, so allow slightly more absolute error than logits.
    if not (point_error <= 1e-2 and scale_error <= LOGIT_ATOL * 10):
        raise ValueError(f"ONNX refiner diverged from PyTorch: points {point_error}, log_scale {scale_error}")

    onnx_path = output_root / "refiner.onnx"
    _wrap_refiner_with_frame(crops_path, onnx_path)
    crops_path.unlink()
    frame = _refiner_fixture_frame()
    crop_error = _refiner_crop_parity(frame)
    fixture, corner_error, decision_mismatches = _refiner_frame_parity(onnx_path, frame, refiner, device)
    passed = crop_error["mean"] <= 1 / 255 and corner_error <= REFINER_FRAME_CORNER_TOLERANCE
    if not passed:
        raise ValueError(f"Phone refinement diverged from the Toolbox's: crops {crop_error}, corners {corner_error}")
    _write_json(output_root / "refiner-fixture.json", fixture)
    return {"onnx": onnx_path.name, "architecture": config["architecture"], "checkpoint_sha256": _sha256(refiner_path),
            "inputs": {"frame": "the upright camera frame the corners refer to, uint8 RGB planar [1, 3, H, W]",
                       "crop_affine": "[4, 2, 3] float32: crop pixel (x, y, 1) -> GridSample normalized frame "
                                      "coordinates (align_corners=1), one per corner in TopLeft..BottomLeft order"},
            "crop_shape": [4, 3, CROP_SIZE, CROP_SIZE],
            "crop": "in-graph GridSample, bicubic, out-of-frame pixels filled with crop_fill_rgb, rounded to 8 bits",
            "normalization": "imagenet-inside-graph",
            "outputs": {"points": "[4, 2] crop pixels (x, y), pixel centres at integers",
                        "log_scale": "[4] Laplace log-scale in crop pixels"},
            "crop_size": CROP_SIZE, "crop_half_extent": CROP_HALF_EXTENT, "output_stride": OUTPUT_STRIDE,
            "crop_frame": config["crop_frame"], "crop_fill_rgb": list(FILL_RGB), "passes": DEFAULT_PASSES,
            "corner_convention": config.get("corner_convention"),
            "maximum_corner_uncertainty": MAXIMUM_CORNER_UNCERTAINTY,
            "uncertainty": "exp(log_scale) * step / card_diagonal; keep the coarse corner above maximum_corner_uncertainty",
            "working_image": "none: the phone refines only when step < 2 (any card in a 640px frame)",
            "crop_mapping": "image = corner + [unit(next - corner), unit(previous - corner)] * step @ (q - (crop_size - 1) / 2), "
                            "step = 2 * crop_half_extent * card_diagonal / crop_size",
            "fixture": "refiner-fixture.json",
            "parity": {"points_max_abs_error": point_error, "log_scale_max_abs_error": scale_error,
                       "crop_mean_abs_error": crop_error["mean"], "crop_max_abs_error": crop_error["max"],
                       "frame_corner_max_error": corner_error, "frame_decision_mismatches": decision_mismatches,
                       "frame_corner_tolerance": REFINER_FRAME_CORNER_TOLERANCE, "passed": passed}}


def _refiner_crop_parts() -> tuple[list[Any], list[Any], list[Any]]:
    """Nodes, initializers and inputs that cut the four corner crops (``crops``) from the frame inside the graph.

    The four 128x128 sampling grids sit side by side in one [1, 128, 512, 2] grid, so the frame is sampled once
    without copying it per corner; the result is split back into [4, 3, 128, 128].
    """
    import numpy as np
    from onnx import TensorProto, helper, numpy_helper

    from .extraction_refiner import CROP_SIZE, FILL_RGB
    side = CROP_SIZE
    ys, xs = np.mgrid[0:side, 0:side]
    points = np.stack([xs.ravel(), ys.ravel(), np.ones(side * side)], axis=1).astype(np.float32)
    initializers = [
        numpy_helper.from_array(points, "refiner_canonical_points"),
        numpy_helper.from_array(np.array([4, side, side, 2], dtype=np.int64), "refiner_grid_shape"),
        numpy_helper.from_array(np.array([1, side, 4 * side, 2], dtype=np.int64), "refiner_grid_row_shape"),
        numpy_helper.from_array(np.array([3, side, 4, side], dtype=np.int64), "refiner_crop_split_shape"),
        numpy_helper.from_array(np.array(FILL_RGB, dtype=np.float32).reshape(1, 3, 1, 1), "refiner_fill"),
        numpy_helper.from_array(np.array(0, dtype=np.float32), "refiner_zero"),
        numpy_helper.from_array(np.array(255, dtype=np.float32), "refiner_255"),
        numpy_helper.from_array(np.array(1 / 255, dtype=np.float32), "refiner_inverse_255"),
    ]
    nodes = [
        helper.make_node("Transpose", ["crop_affine"], ["refiner_affine_t"], perm=[0, 2, 1]),
        helper.make_node("MatMul", ["refiner_canonical_points", "refiner_affine_t"], ["refiner_grid_points"]),
        helper.make_node("Reshape", ["refiner_grid_points", "refiner_grid_shape"], ["refiner_grids"]),
        helper.make_node("Transpose", ["refiner_grids"], ["refiner_grids_by_row"], perm=[1, 0, 2, 3]),
        helper.make_node("Reshape", ["refiner_grids_by_row", "refiner_grid_row_shape"], ["refiner_grid"]),
        helper.make_node("Cast", ["frame"], ["refiner_frame_f32"], to=TensorProto.FLOAT),
        # Zero padding around the fill-shifted frame is the PIL fill colour once the fill is added back.
        helper.make_node("Sub", ["refiner_frame_f32", "refiner_fill"], ["refiner_frame_shifted"]),
        helper.make_node("GridSample", ["refiner_frame_shifted", "refiner_grid"], ["refiner_sampled"],
                         mode="bicubic", padding_mode="zeros", align_corners=1),
        helper.make_node("Add", ["refiner_sampled", "refiner_fill"], ["refiner_filled"]),
        # PIL hands the network 8-bit crops.
        helper.make_node("Clip", ["refiner_filled", "refiner_zero", "refiner_255"], ["refiner_clipped"]),
        helper.make_node("Round", ["refiner_clipped"], ["refiner_rounded"]),
        helper.make_node("Mul", ["refiner_rounded", "refiner_inverse_255"], ["refiner_row"]),
        helper.make_node("Reshape", ["refiner_row", "refiner_crop_split_shape"], ["refiner_split"]),
        helper.make_node("Transpose", ["refiner_split"], ["crops"], perm=[2, 0, 1, 3]),
    ]
    inputs = [helper.make_tensor_value_info("frame", TensorProto.UINT8, [1, 3, "height", "width"]),
              helper.make_tensor_value_info("crop_affine", TensorProto.FLOAT, [4, 2, 3])]
    return nodes, initializers, inputs


def _wrap_refiner_with_frame(crops_path: Path, path: Path) -> None:
    import onnx
    model = onnx.load(str(crops_path))
    graph = model.graph
    nodes, initializers, inputs = _refiner_crop_parts()
    kept_inputs = [value for value in graph.input if value.name != "crops"]
    del graph.input[:]
    graph.input.extend(inputs + kept_inputs)
    existing = list(graph.node)
    del graph.node[:]
    graph.node.extend(nodes + existing)
    graph.initializer.extend(initializers)
    graph.name = "deckino_corner_refiner"
    onnx.checker.check_model(model)
    onnx.save_model(model, str(path), save_as_external_data=False)


def _refiner_crop_model() -> Any:
    """The in-graph crop alone, for checking it against the Toolbox's PIL crop."""
    import onnx
    from onnx import TensorProto, helper

    from .extraction_refiner import CROP_SIZE
    nodes, initializers, inputs = _refiner_crop_parts()
    graph = helper.make_graph(nodes, "deckino_refiner_crop", inputs,
                              [helper.make_tensor_value_info("crops", TensorProto.FLOAT,
                                                             [4, 3, CROP_SIZE, CROP_SIZE])], initializers)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", ONNX_OPSET)])
    onnx.checker.check_model(model)
    return model


def _refiner_fixture_frame() -> Any:
    """A textured upright frame with the fixture cards drawn on it: dark border, light face, a darker art box."""
    import numpy as np
    from PIL import Image, ImageDraw
    width, height = REFINER_FIXTURE_FRAME
    rng = np.random.default_rng(29)
    y, x = np.mgrid[0:height, 0:width]
    background = np.stack([120 + 60 * np.sin(x / 23.), 110 + 50 * np.cos(y / 31.), (x + 2 * y) % 89 + 80], axis=-1)
    background = background + rng.normal(0, 6, background.shape)
    image = Image.fromarray(np.clip(background, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    for corners, _ in REFINER_FIXTURE_CARDS:
        quad = np.array(corners, dtype=np.float64)
        centre = quad.mean(axis=0)
        draw.polygon([tuple(point) for point in quad], fill=(24, 22, 26))
        draw.polygon([tuple(centre + (point - centre) * .92) for point in quad], fill=(214, 200, 172))
        draw.polygon([tuple(centre + (point - centre) * np.array([.78, .45]) - (0, 30)) for point in quad],
                     fill=(150, 70, 60))
    return np.asarray(image)


def _refiner_fixture_corners() -> list[list[dict[str, float]]]:
    width, height = REFINER_FIXTURE_FRAME
    return [[{"x": (x + dx) / (width - 1), "y": (y + dy) / (height - 1)}
             for (x, y), (dx, dy) in zip(corners, offsets)] for corners, offsets in REFINER_FIXTURE_CARDS]


def _grid_affine(origin: Any, matrix: Any, width: int, height: int) -> Any:
    """Crop pixel (x, y, 1) -> GridSample normalized frame coordinates (align_corners=1: -1 is pixel 0)."""
    import numpy as np
    scale = np.array([2 / (width - 1), 2 / (height - 1)])
    return np.column_stack((matrix * scale[:, None], origin * scale - 1))


def refine_on_frame(session: Any, frame: Any, corners: list[dict[str, float]],
                    record: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The phone's refinement with refiner.onnx; Deckino.App's src/extraction/corner-refiner.ts mirrors it.

    Same passes, crop frames and corner choice as refine_corners, which samples with PIL instead. ``frame`` is
    HxWx3 uint8 RGB; ``record`` collects each pass's inputs and outputs for the app fixture.
    """
    import math

    import numpy as np

    from .extraction_refiner import (CROP_HALF_EXTENT, CROP_SIZE, DEFAULT_PASSES, _diagonal, _pixels,
                                     crop_frame, serve_refinement)
    height, width = frame.shape[:2]
    coarse = _pixels(corners, width, height)
    diagonal = _diagonal(coarse)
    step = 2 * CROP_HALF_EXTENT * diagonal / CROP_SIZE
    if step >= 2:
        # refine_corners would box-reduce the frame first; no card in a 640px frame is that big.
        return serve_refinement(coarse, coarse, diagonal, [math.inf] * 4, corners, width, height)
    planar = np.ascontiguousarray(frame.transpose(2, 0, 1)[None])
    points = coarse.copy()
    uncertainty: list[float | None] = [None] * 4
    for _ in range(DEFAULT_PASSES):
        frames = [crop_frame(points, index, diagonal) for index in range(4)]
        affine = np.stack([_grid_affine(origin, matrix, width, height) for origin, matrix in frames]).astype(np.float32)
        predicted, log_scale = session.run(["points", "log_scale"], {"frame": planar, "crop_affine": affine})
        if record is not None:
            record.append({"crop_affine": affine.ravel().tolist(), "points": predicted.ravel().tolist(),
                           "log_scale": log_scale.ravel().tolist()})
        points = np.array([origin + matrix @ point
                           for (origin, matrix), point in zip(frames, predicted.astype(np.float64))])
        uncertainty = [float(value) for value in np.exp(log_scale.astype(np.float64)) * step / diagonal]
    return serve_refinement(points, coarse, diagonal, uncertainty, corners, width, height)


def _refiner_crop_parity(frame: Any) -> dict[str, float]:
    """In-graph crops vs the Toolbox's PIL crops for the first pass of every fixture card, in [0, 1] units."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    from .extraction_refiner import _crop, _diagonal, _pixels, crop_frame
    session = ort.InferenceSession(_refiner_crop_model().SerializeToString(), providers=["CPUExecutionProvider"])
    height, width = frame.shape[:2]
    image = Image.fromarray(frame)
    planar = np.ascontiguousarray(frame.transpose(2, 0, 1)[None])
    errors = []
    for corners in _refiner_fixture_corners():
        points = _pixels(corners, width, height)
        frames = [crop_frame(points, index, _diagonal(points)) for index in range(4)]
        affine = np.stack([_grid_affine(origin, matrix, width, height) for origin, matrix in frames]).astype(np.float32)
        (graph,) = session.run(["crops"], {"frame": planar, "crop_affine": affine})
        reference = np.stack([np.asarray(_crop(image, origin, matrix), dtype=np.float32).transpose(2, 0, 1) / 255
                              for origin, matrix in frames])
        errors.append(np.abs(graph - reference))
    stacked = np.stack(errors)
    return {"mean": float(stacked.mean()), "max": float(stacked.max())}


def _refiner_frame_parity(onnx_path: Path, frame: Any, refiner: nn.Module,
                          device: torch.device) -> tuple[dict[str, Any], float, int]:
    """The phone's refinement vs refine_corners on the fixture cards.

    Returns the app fixture, the worst gap between corners both refined, and how many corners one side refined
    and the other kept.
    """
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    from .extraction_refiner import _diagonal, _pixels, refine_corners
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    height, width = frame.shape[:2]
    image = Image.fromarray(frame)
    cases, worst, mismatches = [], 0., 0
    for corners in _refiner_fixture_corners():
        passes: list[dict[str, Any]] = []
        phone = refine_on_frame(session, frame, corners, passes)
        toolbox = refine_corners(refiner, image, corners, device)
        gap = np.linalg.norm(_pixels(phone["corners"], width, height) - _pixels(toolbox["corners"], width, height),
                             axis=1) / _diagonal(_pixels(corners, width, height))
        both = [a and b for a, b in zip(phone["corner_refined"], toolbox["corner_refined"])]
        mismatches += sum(a != b for a, b in zip(phone["corner_refined"], toolbox["corner_refined"]))
        worst = max([worst, *(float(value) for value, refined in zip(gap, both) if refined)])
        cases.append({"corners": corners, "passes": passes,
                      "expected": {"corners": phone["corners"], "corner_refined": phone["corner_refined"],
                                   "corner_uncertainty": phone["corner_uncertainty"]}})
    return ({"width": width, "height": height, "tolerance": REFINER_FIXTURE_TOLERANCE, "cases": cases},
            worst, mismatches)


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
    base_options = dict(
        input_names=["image"], output_names=list(names),
        opset_version=ONNX_OPSET,
    )
    failures = []
    try:
        # The Dynamo exporter traces dynamic-shape graphs (upsample sizes read
        # from backbone maps, 2x2 orientation grids) that the legacy
        # TorchScript exporter cannot follow on modern torch.
        torch.onnx.export(wrapper, dummy, str(onnx_path), dynamo=True, verbose=False, **base_options)
    except Exception as error:
        failures.append(f"dynamo exporter: {error}")
        legacy_options = dict(base_options, do_constant_folding=True)
        try:
            torch.onnx.export(wrapper, dummy, str(onnx_path), dynamo=False, **legacy_options)
        except TypeError:
            torch.onnx.export(wrapper, dummy, str(onnx_path), **legacy_options)
        except Exception as legacy_error:
            failures.append(f"torchscript exporter: {legacy_error}")
            raise ValueError("ONNX export failed: " + " | ".join(failures)) from legacy_error
    import onnx as onnx_module
    data_path = onnx_path.with_name(onnx_path.name + ".data")
    onnx_model = onnx_module.load(str(onnx_path))
    if data_path.is_file():
        # The Dynamo exporter stores weights beside the graph, but the phone
        # bundles a single asset (Metro only serves extractor.onnx), so inline
        # the weights and remove the sidecar.
        onnx_module.save_model(onnx_model, str(onnx_path), save_as_external_data=False)
        data_path.unlink()
    onnx_module.checker.check_model(onnx_module.load(str(onnx_path)))


def _onnx_outputs(onnx_path: Path, images: Tensor, names: tuple[str, ...],
                  input_name: str = "image") -> dict[str, Tensor]:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ValueError("ONNX parity requires the onnxruntime package") from error
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    result = session.run(list(names), {input_name: images.detach().cpu().numpy()})
    return {name: torch.from_numpy(value) for name, value in zip(names, result)}


def _max_abs(left: Tensor, right: Tensor) -> float:
    return float((left.float() - right.float()).abs().max().item())


def _parity_report(pytorch: dict[str, Tensor], converted: dict[str, Tensor],
                   policy: str, offset_range: float) -> dict[str, Any]:
    logit_errors = {name: _max_abs(pytorch[name], converted[name]) for name in pytorch}
    torch_corners, _ = decode_geometry(pytorch, policy, offset_range)
    converted_corners, _ = decode_geometry(converted, policy, offset_range)
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
    offset_range = offset_range_for_config(loaded)
    parity = _parity_report(pytorch, onnx_values, policy, offset_range)
    if not parity["passed"]:
        raise ValueError(f"ONNX extractor diverged from PyTorch: {parity}")

    tflite_name = _try_tflite(onnx_path, output_root / "extractor.tflite")
    artifact_root = checkpoint_path.parent
    refiner_path = artifact_root / "refiner.pt"
    refiner = _export_refiner(refiner_path, output_root, device) if refiner_path.is_file() else None
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
        "offset_range": offset_range,
        "heatmap_size": HEATMAP_SIZE,
        "output_names": list(names),
        "output_shapes": shapes,
        "has_semantic_corners": SEMANTIC_OUTPUT in names,
        "onnx": "extractor.onnx",
        "tflite": tflite_name,
        "onnx_parity": parity,
        # Second-stage full-resolution corner refinement; null for pre-recipe-9 extractors.
        "refiner": refiner,
    }
    _write_json(output_root / "mobile-manifest.json", manifest)
    emit("extraction_mobile_exported", **{key: manifest[key] for key in
         ("model_version", "architecture", "onnx", "tflite") if key in manifest},
         parity_passed=parity["passed"])
    return manifest
