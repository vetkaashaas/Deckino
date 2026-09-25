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
* ``recognizer.onnx`` - what the app ships: the embedding network with the
  float16 index baked in as a constant and a TopK over prototype scores, so the
  phone searches every prototype natively instead of in JavaScript.
* ``app-labels.json`` - the compact label table the app bundles: oracle ids and
  names, each prototype's oracle(s), and which prototypes are ambiguous.
* ``fixture-crop-source.u8`` + ``fixture-crops.f32`` - a synthetic upright frame
  and the expected phone recognition crops, so the app's TypeScript warp can be
  proven identical to :func:`phone_recognition_crop`.

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

MOBILE_SCHEMA_VERSION = 2
APP_LABELS_SCHEMA_VERSION = 1
ONNX_OPSET = 17
EMBEDDING_ATOL = 1e-4
INDEX_DTYPES = ("float16", "int8", "float32")
TOP_K = 5
# Maximum allowed index-quantization error before the export is refused.
QUANTIZATION_LIMITS = {"float32": 0., "float16": .002, "int8": .01}
MINIMUM_TOP1_AGREEMENT = .999
PARITY_QUERIES = 2000
FIXTURE_INPUTS = 2
# Prototypes the recognizer graph returns; the app collapses them to oracles.
# Enough to see a runner-up oracle past every printing of a heavily reprinted card.
RECOGNIZER_TOP_K = 128
# The calibrated thresholds come from synthetic Scryfall views, where nearly every
# query is a card. Real camera crops need a floor: on 962 annotated photos a 0.5
# score kept ~91% of cards and ~1.6% of card-shaped no-card crops. Provisional
# until probe-artwork-camera is re-run on a new model.
APP_SCORE_THRESHOLD = .5
APP_MARGIN_THRESHOLD = 0.
# Upright frame the fixture crop cases are cut from: the phone's VGA frame in portrait.
FIXTURE_FRAME = (480, 640)
FIXTURE_CORNERS = [
    # A card held upright, slightly rotated and in perspective.
    [{"x": .2, "y": .18}, {"x": .83, "y": .22}, {"x": .79, "y": .83}, {"x": .16, "y": .8}],
    # Upside down and partly outside the frame, so edge clamping is exercised.
    [{"x": .95, "y": .9}, {"x": .12, "y": .97}, {"x": .05, "y": .15}, {"x": .88, "y": .05}],
]
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


def decide_top_k(top_scores: np.ndarray, top_prototypes: np.ndarray, oracles: list[dict[str, str]],
                 prototypes: list[dict[str, Any]], thresholds: dict[str, Any], catalogue_size: int) -> dict[str, Any]:
    """:func:`decide` from the recognizer's top-K prototypes - the rule the app runs.

    The best oracle's best prototype is always the global best, so the candidate,
    its score and its ambiguity match :func:`decide`. When every returned
    prototype belongs to that oracle the runner-up is not visible; the margin is
    then the lower bound ``score - last returned score``.
    """
    best: dict[int, tuple[float, int]] = {}
    for score, prototype_index in zip(np.asarray(top_scores, dtype=np.float64).tolist(),
                                      np.asarray(top_prototypes).astype(int).tolist()):
        for oracle_index in prototypes[prototype_index]["oracles"]:
            previous = best.get(oracle_index)
            if previous is None or score > previous[0]:
                best[oracle_index] = (score, prototype_index)
    ranked = sorted(best.items(), key=lambda item: (-item[1][0], item[0]))[:TOP_K]
    oracle_index, (score, prototype_index) = ranked[0]
    margin_bounded = len(ranked) == 1 and len(top_scores) < catalogue_size
    if len(ranked) > 1:
        margin = score - ranked[1][1][0]
    else:
        margin = score - float(top_scores[-1]) if margin_bounded else math.inf
    ambiguous = prototypes[prototype_index]["ambiguous"]
    rejected = ambiguous or score < thresholds["score_threshold"] or margin < thresholds["margin_threshold"]
    return {"rejected": bool(rejected),
            "rejection_reason": "ambiguous_artwork" if ambiguous else "below_confidence_threshold" if rejected else None,
            "oracle_id": None if rejected else oracles[oracle_index]["oracle_id"],
            "candidate_oracle_id": oracles[oracle_index]["oracle_id"],
            "candidate_prototype": prototype_index, "score": float(score),
            "margin": None if math.isinf(margin) else float(margin), "margin_is_lower_bound": margin_bounded,
            "candidates": [{"oracle_id": oracles[index]["oracle_id"], "score": float(value), "prototype": prototype}
                           for index, (value, prototype) in ranked]}


def _homography(destination: list[tuple[float, float]], source: list[tuple[float, float]]) -> list[float]:
    """Coefficients mapping a destination point to its source point (PIL perspective convention)."""
    matrix, target = [], []
    for (x, y), (u, v) in zip(destination, source, strict=True):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        target.append(u)
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        target.append(v)
    return np.linalg.solve(np.asarray(matrix, dtype=np.float64), np.asarray(target, dtype=np.float64)).tolist()


def phone_recognition_crop(frame: np.ndarray, corners: list[dict[str, float]]) -> np.ndarray:
    """The app's recognition crop: one homography warp from the upright frame, bilinear, edges clamped.

    ``frame`` is HxWx3 uint8 RGB; ``corners`` are the extractor's normalized
    TopLeft, TopRight, BottomRight, BottomLeft points, where x = pixel / (width - 1).
    Returns the [3, 224, 224] float32 [0, 1] tensor recognizer.onnx takes:
    recognition_crop_v1 of the 315x440 rectified card stretched to 224x224, with
    rectify and resize composed into one sampling step. Mirrored exactly by
    ``Deckino.App/src/recognition/artwork/recognition-crop.ts``.
    """
    height, width = frame.shape[:2]
    rectified_width, rectified_height = RECOGNITION_CROP["rectified_size"]
    box = RECOGNITION_CROP["canonical_pixels"]
    destination = [(0., 0.), (rectified_width - 1., 0.), (rectified_width - 1., rectified_height - 1.),
                   (0., rectified_height - 1.)]
    source = [(point["x"] * (width - 1), point["y"] * (height - 1)) for point in corners]
    a, b, c, d, e, f, g, h = _homography(destination, source)
    steps = (np.arange(IMAGE_SIZE, dtype=np.float64) + .5) / IMAGE_SIZE
    canonical_x = box["left"] + steps * (box["right"] - box["left"]) - .5
    canonical_y = box["top"] + steps * (box["bottom"] - box["top"]) - .5
    grid_x, grid_y = np.meshgrid(canonical_x, canonical_y)
    denominator = g * grid_x + h * grid_y + 1
    sample_x = np.clip((a * grid_x + b * grid_y + c) / denominator, 0, width - 1)
    sample_y = np.clip((d * grid_x + e * grid_y + f) / denominator, 0, height - 1)
    left, top = np.floor(sample_x).astype(int), np.floor(sample_y).astype(int)
    right, bottom = np.minimum(left + 1, width - 1), np.minimum(top + 1, height - 1)
    weight_x, weight_y = (sample_x - left)[..., None], (sample_y - top)[..., None]
    pixels = frame.astype(np.float64)
    upper = pixels[top, left] * (1 - weight_x) + pixels[top, right] * weight_x
    lower = pixels[bottom, left] * (1 - weight_x) + pixels[bottom, right] * weight_x
    return ((upper * (1 - weight_y) + lower * weight_y) / 255).transpose(2, 0, 1).astype(np.float32)


def _fixture_frame(seed: int) -> np.ndarray:
    """A deterministic textured upright frame for crop parity: gradients plus random blocks."""
    width, height = FIXTURE_FRAME
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    frame = np.stack([x / width * 255, y / height * 255, (x + y) % 97 / 96 * 255], axis=-1)
    for _ in range(60):
        left, top = int(rng.integers(0, width - 40)), int(rng.integers(0, height - 40))
        frame[top:top + int(rng.integers(8, 40)), left:left + int(rng.integers(8, 40))] = rng.integers(0, 256, 3)
    return np.clip(frame, 0, 255).astype(np.uint8)


def _app_labels(version: str, oracles: list[dict[str, str]], prototypes: list[dict[str, Any]]) -> dict[str, Any]:
    return {"app_labels_schema_version": APP_LABELS_SCHEMA_VERSION, "model_version": version,
            "oracle_ids": [oracle["oracle_id"] for oracle in oracles],
            "names": [oracle["name"] for oracle in oracles],
            # One oracle index per prototype, or a list when an artwork is shared by several cards.
            "prototype_oracles": [item["oracles"][0] if len(item["oracles"]) == 1 else item["oracles"]
                                  for item in prototypes],
            "ambiguous_prototypes": [index for index, item in enumerate(prototypes) if item["ambiguous"]]}


def _export_recognizer(embedding_path: Path, vectors: np.ndarray, top_k: int, path: Path) -> None:
    """Append the prototype search to the embedding graph: scores = embedding @ index^T, then TopK."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    model = onnx.load(str(embedding_path))
    graph = model.graph
    graph.initializer.extend([
        numpy_helper.from_array(np.ascontiguousarray(vectors.astype(np.float16).T), "prototype_vectors_t"),
        numpy_helper.from_array(np.array([top_k], dtype=np.int64), "top_k"),
    ])
    graph.node.extend([
        # Stored as float16 to halve the asset; ONNX Runtime folds the cast once at session load.
        helper.make_node("Cast", ["prototype_vectors_t"], ["prototype_vectors_t_f32"], to=TensorProto.FLOAT),
        helper.make_node("MatMul", ["embedding", "prototype_vectors_t_f32"], ["scores"]),
        helper.make_node("TopK", ["scores", "top_k"], ["top_scores", "top_prototypes"], axis=-1, largest=1, sorted=1),
    ])
    graph.output.extend([helper.make_tensor_value_info("top_scores", TensorProto.FLOAT, [1, top_k]),
                         helper.make_tensor_value_info("top_prototypes", TensorProto.INT64, [1, top_k])])
    graph.name = "deckino_artwork_recognizer"
    onnx.checker.check_model(model)
    onnx.save_model(model, str(path), save_as_external_data=False)


def _recognizer_parity(path: Path, images: np.ndarray, expected: np.ndarray, vectors: np.ndarray,
                       baked: np.ndarray, oracles: list[dict[str, str]], prototypes: list[dict[str, Any]],
                       thresholds: dict[str, Any], top_k: int, seed: int) -> dict[str, Any]:
    """The shipped graph plus the app's top-K rule must reproduce the full-index decision.

    ``baked`` is the float16 index the graph holds, widened to float32 as ONNX
    Runtime does; its own retrieval parity against the float32 index is checked too.
    """
    searched = baked
    import onnxruntime as ort
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    score_error, disagreements = 0., []
    for index, image in enumerate(images):
        _, top_scores, top_prototypes = session.run(["embedding", "top_scores", "top_prototypes"],
                                                    {"image": image[None]})
        reference = decide(expected[index], searched, oracles, prototypes, thresholds)
        reference_scores = searched @ expected[index]
        score_error = max(score_error, float(np.abs(top_scores[0] - reference_scores[top_prototypes[0]]).max()))
        got = decide_top_k(top_scores[0], top_prototypes[0], oracles, prototypes, thresholds, len(searched))
        if got["candidate_oracle_id"] != reference["candidate_oracle_id"] or got["rejected"] != reference["rejected"]:
            disagreements.append({"input": index, "expected": reference["candidate_oracle_id"],
                                  "got": got["candidate_oracle_id"]})
    # The top-K collapse over many realistic queries (index rows plus noise), without the network.
    rng = np.random.default_rng(seed + 1)
    rows = rng.choice(len(vectors), size=min(PARITY_QUERIES, len(vectors)), replace=False)
    queries = vectors[rows] + rng.normal(0, .03, size=(len(rows), vectors.shape[1])).astype(np.float32)
    queries /= np.linalg.norm(queries, axis=1, keepdims=True)
    collapse_mismatches = 0
    for query in queries:
        scores = searched @ query
        order = np.argsort(-scores, kind="stable")[:top_k]
        full = decide(query, searched, oracles, prototypes, thresholds)
        short = decide_top_k(scores[order], order, oracles, prototypes, thresholds, len(searched))
        margin_matches = short["margin_is_lower_bound"] or full["margin"] == short["margin"] or (
            full["margin"] is not None and short["margin"] is not None
            and abs(full["margin"] - short["margin"]) < 1e-6)
        if (full["candidate_oracle_id"], full["rejected"]) != (short["candidate_oracle_id"], short["rejected"]) \
                or not margin_matches:
            collapse_mismatches += 1
    index_quantization = _quantization_parity(vectors, baked, "float16", seed)
    passed = score_error <= 1e-4 and not disagreements and collapse_mismatches == 0 and index_quantization["passed"]
    return {"top_k": top_k, "index_quantization": index_quantization, "top_score_max_abs_error": score_error, "network_disagreements": disagreements,
            "collapse_queries": int(len(queries)), "collapse_mismatches": collapse_mismatches, "passed": passed}


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
                          index_dtype: str = "float16", seed: int = 20260925,
                          app_score_threshold: float = APP_SCORE_THRESHOLD,
                          app_margin_threshold: float = APP_MARGIN_THRESHOLD) -> dict[str, Any]:
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
    top_k = min(RECOGNIZER_TOP_K, len(labels))
    recognizer_path = output_root / "recognizer.onnx"
    _export_recognizer(onnx_path, vectors, top_k, recognizer_path)
    baked = vectors.astype(np.float16).astype(np.float32)
    recognizer_parity = _recognizer_parity(recognizer_path, images.numpy(), expected, vectors, baked, oracles,
                                           prototypes, thresholds, top_k, seed)
    if not recognizer_parity["passed"]:
        raise ValueError(f"recognizer.onnx does not reproduce the full-index decision: {recognizer_parity}")
    app_thresholds = {"score_threshold": float(app_score_threshold), "margin_threshold": float(app_margin_threshold)}
    # Replay cases for the app's TypeScript: top-K prototypes in, decision out; and the phone crop.
    fixture["top_k_cases"] = []
    for query in [case["embedding"] for case in fixture["embedding_cases"]] + \
            [case["query"] for case in fixture["search_cases"]]:
        scores = baked @ np.asarray(query, dtype=np.float32)
        order = np.argsort(-scores, kind="stable")[:top_k]
        fixture["top_k_cases"].append({
            "top_scores": scores[order].tolist(), "top_prototypes": order.tolist(),
            "decision": decide_top_k(scores[order], order, oracles, prototypes, app_thresholds, len(baked))})
    frame = _fixture_frame(seed)
    frame.tofile(output_root / "fixture-crop-source.u8")
    crops = np.stack([phone_recognition_crop(frame, corners) for corners in FIXTURE_CORNERS])
    crops.astype("<f4").tofile(output_root / "fixture-crops.f32")
    fixture["crop_cases"] = {"source": {"file": "fixture-crop-source.u8", "width": FIXTURE_FRAME[0],
                                        "height": FIXTURE_FRAME[1], "layout": "HWC", "color": "RGB", "dtype": "uint8"},
                             "crops": {"file": "fixture-crops.f32", "shape": list(crops.shape), "dtype": "float32",
                                       "layout": "NCHW"},
                             "corners": FIXTURE_CORNERS, "tolerance": 1e-4}
    fixture["app_thresholds"] = app_thresholds
    _write_json(output_root / "fixture.json", fixture)
    (output_root / "app-labels.json").write_text(
        json.dumps(_app_labels(version, oracles, prototypes), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    files = ["embedding.onnx", index_path.name, "labels.json", "fixture.json", "fixture-inputs.f32",
             "recognizer.onnx", "app-labels.json", "fixture-crop-source.u8", "fixture-crops.f32"]
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
        "recognizer": {"onnx": "recognizer.onnx", "input_name": "image", "input_shape": [1, 3, IMAGE_SIZE, IMAGE_SIZE],
                       "outputs": {"embedding": "embedding", "scores": "top_scores", "prototypes": "top_prototypes"},
                       "top_k": top_k, "catalogue_size": int(vectors.shape[0]),
                       "index": "float16 constant inside the graph, cast to float32 at load",
                       "labels": "app-labels.json"},
        "phone_crop": {"algorithm": "single homography warp from the upright frame, bilinear, edges clamped",
                       "corners": "normalized; pixel = x * (width - 1)",
                       "reference": "deckino_training.artwork_mobile.phone_recognition_crop"},
        "app_decision": {**app_thresholds, "rule": "decide_top_k over the recognizer's top prototypes",
                         "source": "provisional camera floor; re-check with probe-artwork-camera",
                         "calibrated_score_threshold": thresholds["score_threshold"],
                         "calibrated_margin_threshold": thresholds["margin_threshold"]},
        "app_files": ["recognizer.onnx", "app-labels.json", "mobile-manifest.json"],
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
                   "index_quantization": quantization, "recognizer": recognizer_parity},
        "fixture": "fixture.json",
        "files": {name: {"sha256": _sha256(output_root / name), "bytes": (output_root / name).stat().st_size}
                  for name in files},
    }
    _write_json(output_root / "mobile-manifest.json", manifest)
    emit("artwork_mobile_exported", model_version=version, output=str(output_root), index_dtype=index_dtype,
         prototypes=int(vectors.shape[0]), index_bytes=manifest["files"][index_path.name]["bytes"],
         embedding_max_abs_error=embedding_error, top1_agreement=quantization["top1_agreement"],
         recognizer_bytes=manifest["files"]["recognizer.onnx"]["bytes"],
         app_labels_bytes=manifest["files"]["app-labels.json"]["bytes"])
    return manifest
