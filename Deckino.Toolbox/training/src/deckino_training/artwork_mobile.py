"""Export the artwork identity model and prototype index for on-device recognition.

The phone recognizes a card by embedding the rectified artwork crop and finding
the nearest artwork prototype. This export packages everything that needs:

* ``embedding.onnx`` - the MobileNetV3 embedding network with ImageNet
  normalization inside the graph; input [1, 3, 224, 224] RGB in [0, 1], output an
  L2-normalized embedding.
* ``index.<dtype>.bin`` - prototype vectors, float16 by default (half the size of
  the float32 training index) or int8 with one float32 scale per row.
* ``labels.json`` - a compact oracle table and one entry per prototype.
* ``mobile-manifest.json`` - the preprocessing and decision contract, checksums,
  and the measured ONNX and index-quantization parity.
* ``fixture.json`` + ``fixture-inputs.f32`` - reference inputs with expected
  embeddings and decisions, so the app can prove it reproduces this pipeline.

The decision rule matches ``recognize-index``: collapse prototype scores to the
best score per oracle, reject ambiguous artworks (one illustration shared by
several cards), and require both the calibrated score and top-2 margin.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import Tensor, nn

from .artwork import ARTWORK_ARTIFACT_SCHEMA_VERSION, _load_embedding, _load_index, _write_json
from .events import emit
from .model import IMAGE_SIZE, NORMALIZE_MEAN, NORMALIZE_STD

MOBILE_SCHEMA_VERSION = 1
ONNX_OPSET = 17
EMBEDDING_ATOL = 1e-4
INDEX_DTYPES = ("float16", "int8", "float32")
TOP_K = 5
# Maximum allowed index-quantization error before the export is refused.
QUANTIZATION_LIMITS = {"float32": 0., "float16": .002, "int8": .01}
MINIMUM_TOP1_AGREEMENT = .999
PARITY_QUERIES = 2000
FIXTURE_INPUTS = 2
# Must match the extraction recognition_crop_v1 contract used by rectify-extraction.
RECOGNITION_CROP = {"rectified_size": [315, 440], "left": .08, "top": .11, "right": .92, "bottom": .49,
                    "canonical_pixels": {"left": 25, "top": 48, "right": 290, "bottom": 216}}


class NormalizedEmbeddingExporter(nn.Module):
    """ImageNet-normalize [0, 1] RGB NCHW crops, then embed them."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor(NORMALIZE_MEAN, dtype=torch.float32).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(NORMALIZE_STD, dtype=torch.float32).view(1, 3, 1, 1))

    def forward(self, images: Tensor) -> Tensor:
        return self.model((images - self.mean) / self.std)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_artwork_version(artifacts_root: Path, model_version: str | None) -> str:
    """Explicit version, else the imported current-artwork pointer, else the newest complete artwork artifact."""
    if model_version:
        return model_version
    pointer = artifacts_root.parent / "current-artwork.json"
    if pointer.is_file():
        version = json.loads(pointer.read_text(encoding="utf-8")).get("model_version")
        if version:
            return str(version)
    # Skip import staging folders and the dated backups an import keeps of a replaced model.
    candidates = sorted((path for path in artifacts_root.iterdir() if path.is_dir()
                         and not path.name.startswith(".") and ".replaced-" not in path.name
                         and (path / "embedding.pt").is_file() and (path / "index" / "index.f32").is_file()),
                        key=lambda path: path.stat().st_mtime, reverse=True) if artifacts_root.is_dir() else []
    if not candidates:
        raise ValueError(f"No artwork artifact with embedding.pt and index/ was found under {artifacts_root}")
    return candidates[0].name


def _oracle_table(labels: list[dict[str, Any]]) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    names: dict[str, str] = {}
    for label in labels:
        for oracle_id in label.get("oracle_ids", [label["oracle_id"]]):
            names.setdefault(oracle_id, label.get("oracle_names", {}).get(oracle_id, label["card_name"]))
    oracle_ids = sorted(names)
    position = {oracle_id: index for index, oracle_id in enumerate(oracle_ids)}
    prototypes = [{"artwork_id": label["artwork_id"], "printing_id": label.get("printing_id"),
                   "oracles": [position[value] for value in label.get("oracle_ids", [label["oracle_id"]])],
                   "ambiguous": bool(label.get("ambiguous", False))} for label in labels]
    return [{"oracle_id": oracle_id, "name": names[oracle_id]} for oracle_id in oracle_ids], prototypes


def _pack_index(vectors: np.ndarray, dtype: str) -> tuple[bytes, np.ndarray, np.ndarray | None]:
    """Return the packed bytes, the dequantized float32 matrix the app will search, and int8 row scales."""
    if dtype == "float32":
        packed = vectors.astype("<f4")
        return packed.tobytes(), packed.astype(np.float32), None
    if dtype == "float16":
        packed = vectors.astype("<f2")
        return packed.tobytes(), packed.astype(np.float32), None
    scales = np.maximum(np.abs(vectors).max(axis=1), 1e-12).astype("<f4") / 127
    quantized = np.clip(np.round(vectors / scales[:, None]), -127, 127).astype(np.int8)
    return quantized.tobytes(), quantized.astype(np.float32) * scales[:, None], scales


def decide(query: np.ndarray, vectors: np.ndarray, oracles: list[dict[str, str]], prototypes: list[dict[str, Any]],
           thresholds: dict[str, Any]) -> dict[str, Any]:
    """The on-device decision rule, identical in meaning to recognize-index."""
    scores = vectors @ query.astype(np.float32)
    best: dict[int, tuple[float, int]] = {}
    for prototype_index, score in enumerate(scores.tolist()):
        for oracle_index in prototypes[prototype_index]["oracles"]:
            previous = best.get(oracle_index)
            if previous is None or score > previous[0]:
                best[oracle_index] = (score, prototype_index)
    ranked = sorted(best.items(), key=lambda item: (-item[1][0], item[0]))[:TOP_K]
    oracle_index, (score, prototype_index) = ranked[0]
    # A catalogue with a single oracle has no runner-up; treat the margin as unbounded.
    margin = score - ranked[1][1][0] if len(ranked) > 1 else math.inf
    ambiguous = prototypes[prototype_index]["ambiguous"]
    rejected = ambiguous or score < thresholds["score_threshold"] or margin < thresholds["margin_threshold"]
    return {"rejected": bool(rejected),
            "rejection_reason": "ambiguous_artwork" if ambiguous else "below_confidence_threshold" if rejected else None,
            "oracle_id": None if rejected else oracles[oracle_index]["oracle_id"],
            "candidate_oracle_id": oracles[oracle_index]["oracle_id"],
            "candidate_prototype": prototype_index, "score": float(score),
            "margin": None if math.isinf(margin) else float(margin),
            "candidates": [{"oracle_id": oracles[index]["oracle_id"], "score": float(value), "prototype": prototype}
                           for index, (value, prototype) in ranked]}


def _export_onnx(wrapper: nn.Module, path: Path) -> None:
    dummy = torch.zeros(1, 3, IMAGE_SIZE, IMAGE_SIZE, dtype=torch.float32)
    options = dict(input_names=["image"], output_names=["embedding"], opset_version=ONNX_OPSET)
    try:
        # MobileNetV3 with a fixed input is a static graph; the TorchScript exporter suffices.
        torch.onnx.export(wrapper, dummy, str(path), dynamo=False, do_constant_folding=True, **options)
    except Exception:
        torch.onnx.export(wrapper, dummy, str(path), dynamo=True, verbose=False, **options)
    import onnx
    data_path = path.with_name(path.name + ".data")
    if data_path.is_file():
        # Keep a single asset file for the app bundle.
        onnx.save_model(onnx.load(str(path)), str(path), save_as_external_data=False)
        data_path.unlink()
    onnx.checker.check_model(onnx.load(str(path)))


def _onnx_embeddings(path: Path, images: np.ndarray) -> np.ndarray:
    import onnxruntime as ort
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return np.concatenate([session.run(["embedding"], {"image": image[None]})[0] for image in images])


def _quantization_parity(vectors: np.ndarray, searched: np.ndarray, dtype: str, seed: int) -> dict[str, Any]:
    """Compare float32 and packed-index retrieval on near-duplicate queries drawn from the index."""
    rng = np.random.default_rng(seed)
    rows = rng.choice(len(vectors), size=min(PARITY_QUERIES, len(vectors)), replace=False)
    queries = vectors[rows] + rng.normal(0, .02, size=(len(rows), vectors.shape[1])).astype(np.float32)
    queries /= np.linalg.norm(queries, axis=1, keepdims=True)
    exact, packed = queries @ vectors.T, queries @ searched.T
    agreement = float(np.mean(exact.argmax(1) == packed.argmax(1)))
    error = float(np.abs(exact - packed).max())
    passed = agreement >= MINIMUM_TOP1_AGREEMENT and error <= QUANTIZATION_LIMITS[dtype] + 1e-7
    return {"queries": int(len(rows)), "top1_agreement": agreement, "max_score_error": error,
            "score_error_limit": QUANTIZATION_LIMITS[dtype], "minimum_top1_agreement": MINIMUM_TOP1_AGREEMENT,
            "passed": passed}


def export_artwork_mobile(artifacts_root: Path, output_root: Path | None = None, model_version: str | None = None,
                          index_dtype: str = "float16", seed: int = 20260925) -> dict[str, Any]:
    if index_dtype not in INDEX_DTYPES:
        raise ValueError(f"Index dtype must be one of {INDEX_DTYPES}")
    try:
        import onnx  # noqa: F401
        import onnxruntime  # noqa: F401
    except ImportError as error:
        raise ValueError("export-artwork-mobile needs onnx and onnxruntime: install the training package's "
                         "[mobile] extra (pip install onnx==1.17.0 onnxruntime==1.19.2)") from error
    version = resolve_artwork_version(artifacts_root, model_version)
    artifact = artifacts_root / version
    thresholds_path = artifact / "artwork-thresholds.json"
    for required in (artifact / "embedding.pt", artifact / "index" / "index.f32", thresholds_path):
        if not required.is_file():
            raise ValueError(f"Artwork artifact is missing {required.relative_to(artifacts_root)}")
    output_root = output_root or artifacts_root.parent / "mobile" / "artwork" / version
    device = torch.device("cpu")
    checkpoint, model = _load_embedding(artifact / "embedding.pt", device)
    metadata, labels, vectors = _load_index(artifact / "index")
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    # The same consistency checks recognize-index applies before trusting a result.
    if metadata["checkpoint_model_version"] != checkpoint["model_version"]:
        raise ValueError("Index checkpoint model version does not match embedding.pt")
    if thresholds.get("artifact_schema_version") != ARTWORK_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("Artwork thresholds require artifact schema v4")
    if thresholds.get("dataset_version") != metadata["dataset_version"]:
        raise ValueError("Artwork thresholds dataset version does not match the index")
    if thresholds.get("checkpoint_model_version") != checkpoint["model_version"]:
        raise ValueError("Artwork thresholds checkpoint does not match embedding.pt")
    output_root.mkdir(parents=True, exist_ok=True)
    emit("artwork_mobile_export_started", model_version=version, prototypes=len(labels), index_dtype=index_dtype)

    wrapper = NormalizedEmbeddingExporter(model).eval()
    onnx_path = output_root / "embedding.onnx"
    _export_onnx(wrapper, onnx_path)
    inputs = torch.Generator().manual_seed(seed)
    images = torch.rand(FIXTURE_INPUTS, 3, IMAGE_SIZE, IMAGE_SIZE, generator=inputs)
    with torch.inference_mode():
        expected = wrapper(images).numpy()
    converted = _onnx_embeddings(onnx_path, images.numpy())
    embedding_error = float(np.abs(expected - converted).max())
    if embedding_error > EMBEDDING_ATOL:
        raise ValueError(f"ONNX artwork embedding diverged from PyTorch by {embedding_error}")

    packed, searched, scales = _pack_index(vectors, index_dtype)
    index_path = output_root / f"index.{index_dtype}.bin"
    index_path.write_bytes(packed)
    scales_path = output_root / "index.scales.f32"
    if scales is not None:
        scales_path.write_bytes(scales.tobytes())
    elif scales_path.exists():
        scales_path.unlink()
    quantization = _quantization_parity(vectors, searched, index_dtype, seed)
    if not quantization["passed"]:
        raise ValueError(f"Packed {index_dtype} index changes retrieval beyond tolerance: {quantization}")

    oracles, prototypes = _oracle_table(labels)
    _write_json(output_root / "labels.json", {"labels_schema_version": 1, "model_version": version,
                                             "dataset_version": metadata["dataset_version"],
                                             "oracles": oracles, "prototypes": prototypes})
    # Reference cases the app must reproduce: two embeddings end to end, and
    # three index-row queries that exercise search, oracle collapse and rejection.
    images.numpy().astype("<f4").tofile(output_root / "fixture-inputs.f32")
    search_rows = sorted({0, len(labels) // 2, len(labels) - 1}
                         | ({next(index for index, item in enumerate(prototypes) if item["ambiguous"])}
                            if any(item["ambiguous"] for item in prototypes) else set()))
    fixture = {"fixture_schema_version": 1, "tolerance": {"embedding": EMBEDDING_ATOL, "score": 1e-4},
               "inputs": {"file": "fixture-inputs.f32", "shape": [FIXTURE_INPUTS, 3, IMAGE_SIZE, IMAGE_SIZE],
                          "dtype": "float32", "layout": "NCHW", "range": [0, 1]},
               "embedding_cases": [{"input": index, "embedding": expected[index].tolist(),
                                    "decision": decide(expected[index], searched, oracles, prototypes, thresholds)}
                                   for index in range(FIXTURE_INPUTS)],
               "search_cases": [{"query_prototype": row, "query": vectors[row].tolist(),
                                 "decision": decide(vectors[row], searched, oracles, prototypes, thresholds)}
                                for row in search_rows]}
    _write_json(output_root / "fixture.json", fixture)

    files = ["embedding.onnx", index_path.name, "labels.json", "fixture.json", "fixture-inputs.f32"]
    if scales is not None:
        files.append(scales_path.name)
    manifest = {
        "artwork_mobile_schema_version": MOBILE_SCHEMA_VERSION,
        "model_version": version, "dataset_version": metadata["dataset_version"],
        "checkpoint_model_version": checkpoint["model_version"],
        "embedding": {"onnx": "embedding.onnx", "input_name": "image", "input_shape": [1, 3, IMAGE_SIZE, IMAGE_SIZE],
                      "input_layout": "NCHW", "input_range": [0.0, 1.0], "input_color": "RGB",
                      "normalization": "imagenet-inside-graph", "output_name": "embedding",
                      "embedding_dimension": int(vectors.shape[1]), "output_normalization": "l2"},
        "query_preprocessing": {
            "recognition_crop": RECOGNITION_CROP,
            "resize": f"stretch the crop to {IMAGE_SIZE}x{IMAGE_SIZE} (no aspect preservation), bicubic",
            "note": "Training and indexing resize Scryfall art crops the same way; do not letterbox."},
        "index": {"file": index_path.name, "dtype": index_dtype, "byte_order": "little-endian",
                  "count": int(vectors.shape[0]), "dimension": int(vectors.shape[1]), "layout": "row-major",
                  "scales": scales_path.name if scales is not None else None,
                  "dequantize": "row * scales[row]" if scales is not None else None,
                  "normalization": "l2 before packing", "source_vectors_sha256": metadata["vectors_sha256"]},
        "labels": "labels.json",
        "decision": {"score": "dot product of the embedding with each prototype",
                     "collapse": "best score per oracle over its prototypes (an ambiguous prototype counts for each of its oracles)",
                     "margin": "best oracle score minus second-best oracle score",
                     "reject_ambiguous_artwork": True, "top_k": TOP_K,
                     "score_threshold": thresholds["score_threshold"],
                     "margin_threshold": thresholds["margin_threshold"],
                     "calibration_precision": thresholds.get("calibration_precision"),
                     "calibration_coverage": thresholds.get("calibration_coverage"),
                     "calibrated_qualified": thresholds.get("qualified")},
        "parity": {"embedding_max_abs_error": embedding_error, "embedding_atol": EMBEDDING_ATOL,
                   "index_quantization": quantization},
        "fixture": "fixture.json",
        "files": {name: {"sha256": _sha256(output_root / name), "bytes": (output_root / name).stat().st_size}
                  for name in files},
    }
    _write_json(output_root / "mobile-manifest.json", manifest)
    emit("artwork_mobile_exported", model_version=version, output=str(output_root), index_dtype=index_dtype,
         prototypes=int(vectors.shape[0]), index_bytes=manifest["files"][index_path.name]["bytes"],
         embedding_max_abs_error=embedding_error, top1_agreement=quantization["top1_agreement"])
    return manifest
