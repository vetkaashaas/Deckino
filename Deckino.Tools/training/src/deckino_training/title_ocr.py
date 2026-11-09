"""Read a card's printed name from a camera photo, and check card identity labels against it.

The card's title strip is cut out of the frame along its corners and read by a text recognizer with
no text detector (the detector misses these small strips; the corners already say where the title
is). The phone does the same when the artwork model is unsure, then matches the text against the
artwork model's top 5 cards and, failing that, against every card name (``TitleMatcher``).

The app's TypeScript (``src/recognition/title/title-core.ts``) mirrors ``title_strip``, ``ctc_decode``,
``normalize``, ``similarity`` and ``TitleMatcher``: ``export-title-reader`` writes a fixture that
``scripts/verify-title-reader.mjs`` replays through it, so change both sides together.

``verify-identity-labels`` reads every labelled camera photo and lists those whose title clearly
names another card than the label. It never edits a sidecar: the Toolbox's Identify Card page shows
the listed photos again until a person saves them.
"""
from __future__ import annotations

import bisect
import json
import math
import re
import shutil
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from .artwork_camera_probe import _phone_frame
from .artwork_mobile import _homography, _sha256
from .events import emit

# PaddleOCR PP-OCRv5 English mobile recognizer (Apache-2.0) in RapidOCR's ONNX export; its character
# list is in the model's metadata.
MODEL_URL = ("https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/"
             "en_PP-OCRv5_rec_mobile.onnx")
MODEL_SHA256 = "c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8"
MODEL_FILE = "en_PP-OCRv5_rec_mobile.onnx"
# Bump with TITLE_READER_SCHEMA_VERSION in the app's title-reader.ts when the files or steps change.
TITLE_READER_SCHEMA_VERSION = 1

# Shared with the app through title-manifest.json.
TITLE_READER = {
    # The card in rectified pixels, as the artwork crop's card (63 x 88 mm).
    "card_size": [630, 880],
    # The title strip, as fractions of the card; it is read twice, ending at each of `rights`: the narrow
    # one leaves out the mana cost, the wide one keeps the end of a long name.
    "title_box": {"left": .03, "top": .025, "bottom": .115},
    "rights": [.72, .85],
    "input_height": 48,
    # Shorter reads (normalized) are noise.
    "min_line_length": 3,
    # Similarity (0-100) to accept one of the artwork model's top 5, and a card from all names.
    "top5_match": 80,
    "all_cards_match": 90,
    # Another card scoring this close to the best one makes the read ambiguous.
    "rival_gap": 3,
    # A top-5 card's name may also match by its start when the read is at least this long.
    "prefix_min_length": 8,
}
# Similarity for "the title is the label's name" in the label check.
LABEL_MATCH = 80
# Not game cards: their names repeat real cards' or aren't printed as a title.
SKIPPED_LAYOUTS = ("art_series", "token", "double_faced_token", "emblem", "vanguard")


def normalize(text: str) -> str:
    """Lowercase letters and digits only: OCR merges and splits words ("k9markl")."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def similarity(a: str, b: str) -> float:
    """0-100: twice the longest common subsequence over both lengths (rapidfuzz's ratio)."""
    if not a and not b:
        return 100.
    previous = [0] * (len(b) + 1)
    for char in a:
        current = [0]
        for index, other in enumerate(b):
            current.append(previous[index] + 1 if char == other else max(previous[index + 1], current[index]))
        previous = current
    return 200 * previous[-1] / (len(a) + len(b))


_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def letter_counts(text: str) -> list[int]:
    """How often each of a-z, 0-9 occurs in a normalized text."""
    return [text.count(char) for char in _ALPHABET]


def _could_reach(line: str, line_counts: list[int], name: str, name_counts: list[int], score: float) -> bool:
    """Whether `similarity` can reach `score`: a common subsequence uses each letter at most as often as the
    rarer side has it. Only skips work; never changes a result."""
    common = sum(min(a, b) for a, b in zip(line_counts, name_counts))
    return 200 * common >= score * (len(line) + len(name))


def title_strip(frame: np.ndarray, corners: list[dict[str, float]], right: float) -> np.ndarray:
    """The recognizer's input (3, input_height, width) float32 for one read of the title.

    `frame` is upright RGB uint8 (height, width, 3); `corners` are TopLeft, TopRight, BottomRight,
    BottomLeft with x = pixel / (width - 1). Each output pixel's centre maps through the card's
    homography into the frame and is sampled bilinearly, clamped to the frame's edge. BGR, as the
    model was trained (OpenCV), scaled to [-1, 1].
    """
    height, width = frame.shape[:2]
    card_width, card_height = TITLE_READER["card_size"]
    box, out_height = TITLE_READER["title_box"], TITLE_READER["input_height"]
    left, right_px = box["left"] * card_width, right * card_width
    top, bottom = box["top"] * card_height, box["bottom"] * card_height
    out_width = math.ceil(out_height * (right_px - left) / (bottom - top))
    a, b, c, d, e, f, g, h = _homography(
        [(0., 0.), (card_width - 1., 0.), (card_width - 1., card_height - 1.), (0., card_height - 1.)],
        [(point["x"] * (width - 1), point["y"] * (height - 1)) for point in corners])
    xs = left + (np.arange(out_width) + .5) / out_width * (right_px - left) - .5
    ys = top + (np.arange(out_height) + .5) / out_height * (bottom - top) - .5
    card_x, card_y = np.meshgrid(xs, ys)
    denominator = g * card_x + h * card_y + 1
    x = np.clip((a * card_x + b * card_y + c) / denominator, 0, width - 1)
    y = np.clip((d * card_x + e * card_y + f) / denominator, 0, height - 1)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    wx, wy = (x - x0)[..., None], (y - y0)[..., None]
    pixels = frame.astype(np.float64)
    top_row = pixels[y0, x0] * (1 - wx) + pixels[y0, x1] * wx
    bottom_row = pixels[y1, x0] * (1 - wx) + pixels[y1, x1] * wx
    rgb = top_row * (1 - wy) + bottom_row * wy
    return ((rgb[:, :, ::-1] / 255 - .5) / .5).transpose(2, 0, 1).astype(np.float32)


def ctc_decode(classes: list[int], characters: list[str]) -> str:
    """Greedy CTC: class 0 is the blank, 1..n the model's characters, n + 1 a space; repeats collapse."""
    text, previous = [], 0
    for index in classes:
        if index != previous and index != 0:
            text.append(characters[index - 1] if index <= len(characters) else " ")
        previous = index
    return "".join(text)


class TitleMatcher:
    """The phone's decision: one of the artwork model's top 5 by name, else one card from all names.

    `oracle_ids`/`names` are the artwork labels' (app-labels.json). A card named "X // X" (an Art
    Series card) is left out: it repeats a real card's name.
    """

    def __init__(self, oracle_ids: list[str], names: list[str]) -> None:
        self.faces: dict[str, list[str]] = {}
        self.by_name: dict[str, list[str]] = {}
        for oracle, name in zip(oracle_ids, names, strict=True):
            parts = name.split(" // ")
            if len(parts) > 1 and len(set(parts)) == 1:
                continue
            faces = list(dict.fromkeys(face for face in map(normalize, [name, *parts]) if face))
            self.faces[oracle] = faces
            for face in faces:
                self.by_name.setdefault(face, []).append(oracle)
        # Names by length, so a read only looks at names long enough and short enough to reach a score.
        self.names = sorted(self.by_name, key=len)
        self.lengths = [len(name) for name in self.names]
        self.counts = [letter_counts(name) for name in self.names]

    def _score(self, lines: list[str], oracle: str) -> float:
        """The best read against the card's names; a long enough read may also be the start of one (glare or the
        frame's edge hid the rest: "jasmineborea" for Jasmine Boreal of the Seven)."""
        prefix = TITLE_READER["prefix_min_length"]
        return max((max(similarity(line, face), similarity(line, face[:len(line)]) if len(line) >= prefix else 0.)
                    for line in lines for face in self.faces.get(oracle, [])), default=0.)

    def match(self, lines: list[str], candidates: list[str]) -> dict | None:
        constants = TITLE_READER
        if not lines:
            return None
        scored = [(self._score(lines, oracle), oracle)
                  for oracle in dict.fromkeys(candidates) if oracle in self.faces]
        if scored:
            best_score, best = max(scored, key=lambda item: item[0])  # first of equals: the artwork's order
            rivals = [oracle for score, oracle in scored
                      if oracle != best and score >= best_score - constants["rival_gap"]
                      and self.faces[oracle] != self.faces[best]]
            if best_score >= constants["top5_match"] and not rivals:
                return {"oracle_id": best, "method": "ocr-top5", "score": best_score}
        # All names: a short read only as an exact name (a near miss of a short name is too easy: "horder" is not
        # Order), a long one by similarity.
        threshold = constants["all_cards_match"] - constants["rival_gap"]
        short = [line for line in lines if len(line) < constants["prefix_min_length"]]
        long = [(line, letter_counts(line)) for line in lines if len(line) >= constants["prefix_min_length"]]
        found: list[tuple[float, str]] = [(100., line) for line in dict.fromkeys(short) if line in self.by_name]
        # similarity <= 200 * min / (sum): a name shorter than lt/(200-t) or longer than l(200-t)/t can't reach t.
        low = min((math.ceil(len(line) * threshold / (200 - threshold)) for line, _ in long), default=0)
        high = max((math.floor(len(line) * (200 - threshold) / threshold) for line, _ in long), default=-1)
        for index in range(bisect.bisect_left(self.lengths, low), bisect.bisect_right(self.lengths, high)):
            name, name_counts = self.names[index], self.counts[index]
            score = max((similarity(line, name) for line, counts in long
                         if _could_reach(line, counts, name, name_counts, threshold)), default=0.)
            if score >= threshold and name not in short:
                found.append((score, name))
        if not found:
            return None
        best_score, best_name = max(found, key=lambda item: item[0])
        oracles = self.by_name[best_name]
        rivals = [name for score, name in found
                  if name != best_name and score >= best_score - constants["rival_gap"]
                  and self.by_name[name] != oracles]
        if best_score < constants["all_cards_match"] or len(oracles) != 1 or rivals:
            return None
        return {"oracle_id": oracles[0], "method": "ocr-all", "score": best_score}


def ensure_model(training_root: Path) -> Path:
    path = training_root / "ocr" / MODEL_FILE
    if path.is_file() and _sha256(path) == MODEL_SHA256:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    emit("title_ocr_model_download", url=MODEL_URL)
    partial = path.with_suffix(".partial")
    with urllib.request.urlopen(MODEL_URL, timeout=120) as response, partial.open("wb") as file:
        while chunk := response.read(1 << 20):
            file.write(chunk)
    if _sha256(partial) != MODEL_SHA256:
        partial.unlink()
        raise ValueError(f"The downloaded title reader model does not match its checksum ({MODEL_URL}).")
    partial.replace(path)
    return path


class TitleReader:
    def __init__(self, model_path: Path) -> None:
        import onnxruntime as ort
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.characters = self.session.get_modelmeta().custom_metadata_map["character"].splitlines()
        self.input_name = self.session.get_inputs()[0].name

    def read_frame(self, frame: np.ndarray, corners: list[dict[str, float]]) -> list[str]:
        """The title read at each width, normalized, short reads and repeats dropped."""
        lines = []
        for right in TITLE_READER["rights"]:
            strip = title_strip(frame, corners, right)
            logits = self.session.run(None, {self.input_name: strip[None]})[0][0]
            lines.append(normalize(ctc_decode(logits.argmax(axis=1).tolist(), self.characters)))
        return [line for line in dict.fromkeys(lines) if len(line) >= TITLE_READER["min_line_length"]]

    def read_title(self, image: Image.Image, corners: list[dict[str, float]]) -> list[str]:
        """Reads the photo as the phone sees it: brought down to the camera's 480 px frame."""
        return self.read_frame(_phone_frame(image.convert("RGB")), corners)


class CardNames:
    """Paper game cards' names (and each face's), normalized, from the Toolbox catalogue."""

    def __init__(self, database: Path) -> None:
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        placeholders = ",".join("?" * len(SKIPPED_LAYOUTS))
        self.by_oracle: dict[str, set[str]] = {}
        self.display: dict[str, str] = {}
        for name, oracle in connection.execute(
                f"SELECT DISTINCT name, oracle_id FROM cards WHERE is_paper = 1 AND oracle_id IS NOT NULL "
                f"AND (layout IS NULL OR layout NOT IN ({placeholders}))", SKIPPED_LAYOUTS):
            oracle = oracle.lower()
            for face in (name, *name.split(" // ")):
                if normalize(face):
                    self.by_oracle.setdefault(oracle, set()).add(normalize(face))
        # Every card shows by name, skipped layouts too: a label can name one (an Art Series card).
        for name, oracle, layout in connection.execute(
                "SELECT name, oracle_id, layout FROM cards WHERE oracle_id IS NOT NULL"):
            self.display.setdefault(oracle.lower(), f"{name} (Art Series)" if layout == "art_series" else name)
        connection.close()
        self.by_name: dict[str, set[str]] = {}
        for oracle, faces in self.by_oracle.items():
            for face in faces:
                self.by_name.setdefault(face, set()).add(oracle)
        self.name_counts = {name: letter_counts(name) for name in self.by_name}

    def score(self, lines: list[str], oracle: str) -> float:
        return max((similarity(line, name) for line in lines for name in self.by_oracle.get(oracle.lower(), ())),
                   default=0.)

    def find(self, lines: list[str]) -> tuple[str, str, float] | None:
        """The one card whose name the title clearly reads as (oracle, matched name, score), or None."""
        cutoff = TITLE_READER["all_cards_match"]
        # Rivals count down to rival_gap under the cutoff, as on the phone.
        floor = cutoff - TITLE_READER["rival_gap"]
        scores: dict[str, float] = {}
        line_counts = [(line, letter_counts(line)) for line in lines]
        for name, name_counts in self.name_counts.items():
            for line, counts in line_counts:
                if _could_reach(line, counts, name, name_counts, floor):
                    score = similarity(line, name)
                    if score >= floor and score > scores.get(name, 0.):
                        scores[name] = score
        if not scores:
            return None
        best = max(scores, key=scores.__getitem__)
        if scores[best] < cutoff:
            return None
        oracles = self.by_name[best]
        # As the phone: another card's name about as close makes the read ambiguous.
        if len(oracles) != 1 or any(name != best and score >= scores[best] - TITLE_READER["rival_gap"]
                                    and self.by_name[name] != oracles for name, score in scores.items()):
            return None
        return next(iter(oracles)), best, scores[best]


def _corners(identity_path: Path, identity: dict) -> list[dict[str, float]] | None:
    """A person's saved corners first, else the phone's."""
    annotation_path = identity_path.with_name(identity_path.name.replace("._identity.json", "._annotations.json"))
    if annotation_path.is_file():
        try:
            annotation = json.loads(annotation_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            annotation = {}
        keys = ("TopLeft", "TopRight", "BottomRight", "BottomLeft")
        if annotation.get("CardPresent") and all(annotation.get(key) for key in keys):
            return [{"x": annotation[key]["X"], "y": annotation[key]["Y"]} for key in keys]
    predicted = identity.get("PredictedCorners") or []
    if len(predicted) == 4:
        return [{"x": point["X"], "y": point["Y"]} for point in predicted]
    return None


def verify_identity_labels(training_root: Path, database: Path, output: Path) -> dict:
    imports_root = training_root / "camera" / "imports"
    reader = TitleReader(ensure_model(training_root))
    names = CardNames(database)
    checked_utc = datetime.now(timezone.utc).isoformat()
    sidecars = sorted(imports_root.rglob("*._identity.json"))
    counts = {"labelled": 0, "agrees": 0, "flagged": 0, "unclear": 0, "no_corners": 0}
    flagged = []
    for index, identity_path in enumerate(sidecars, 1):
        if index % 50 == 0 or index == len(sidecars):
            emit("identity_ocr_progress", done=index, total=len(sidecars))
        try:
            identity = json.loads(identity_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        label = identity.get("OracleId")
        if identity.get("Status") not in ("confirmed", "corrected") or not label:
            continue
        counts["labelled"] += 1
        image_file = identity.get("ImageFile")
        image_path = identity_path.with_name(image_file) if image_file else None
        corners = _corners(identity_path, identity)
        if corners is None or image_path is None or not image_path.is_file():
            counts["no_corners"] += 1
            continue
        # One unreadable photo or degenerate quad must not lose the whole check.
        try:
            with Image.open(image_path) as image:
                lines = reader.read_title(image, corners)
        except Exception as error:  # noqa: BLE001
            emit("identity_ocr_skipped", image=str(image_path), message=str(error))
            counts["unclear"] += 1
            continue
        if names.score(lines, label) >= LABEL_MATCH:
            counts["agrees"] += 1
            continue
        found = names.find(lines)
        label_names = names.by_oracle.get(label.lower(), set())
        # A name the label's starts with ("Jasmine Boreal" in "Jasmine Boreal of the Seven" half covered by glare)
        # can't tell the two apart. Nor can a short name: one misread letter makes another ("herd" for Hero), which
        # is why the phone takes a short read only when it is exact.
        if (found is None or found[0] == label.lower() or len(found[1]) < TITLE_READER["prefix_min_length"]
                or any(name.startswith(found[1]) for name in label_names)):
            counts["unclear"] += 1
            continue
        counts["flagged"] += 1
        flagged.append({
            "image": image_path.relative_to(imports_root).as_posix(),
            "label_oracle_id": label,
            "label_name": names.display.get(label.lower(), label),
            "label_reviewed_utc": identity.get("ReviewedUtc"),
            "read_text": lines[0] if lines else "",
            "read_oracle_id": found[0],
            "read_name": names.display.get(found[0], found[0]),
            "read_score": round(found[2], 1),
        })
    report = {"schema_version": 1, "checked_utc": checked_utc, "model": MODEL_FILE, "counts": counts,
              "flagged": flagged}
    _write_json(output, report)
    emit("identity_ocr_check", output=str(output), **counts)
    return report


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".partial")
    partial.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    partial.replace(path)


def _fixture_frame(width: int, height: int) -> np.ndarray:
    """A deterministic test frame both sides can build: no photo in the fixture."""
    y, x = np.mgrid[0:height, 0:width]
    channels = [(x * 31 + y * 17 + channel * 71 + (x * y) % 13) % 256 for channel in range(3)]
    return np.stack(channels, axis=-1).astype(np.uint8)


def export_title_reader(training_root: Path, output_dir: Path) -> Path:
    """The app's title reader: the model, its characters, the shared constants and a parity fixture."""
    model = ensure_model(training_root)
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(model, output_dir / "title-reader.onnx")
    characters = TitleReader(model).characters
    _write_json(output_dir / "characters.json", characters)

    width, height = 120, 160
    frame = _fixture_frame(width, height)
    quads = [
        [(.2, .1), (.8, .12), (.78, .9), (.18, .88)],    # a tilted card
        [(.3, .2), (.7, .25), (.9, .95), (.05, .8)],      # strong perspective
        [(-.1, -.05), (.6, 0.), (.65, .7), (-.08, .66)],  # running off the frame: clamped samples
    ]
    strip_cases = []
    for quad in quads:
        corners = [{"x": x, "y": y} for x, y in quad]
        for right in TITLE_READER["rights"]:
            strip = title_strip(frame, corners, right)
            flat = strip.astype(np.float64).ravel()
            strip_cases.append({"corners": corners, "right": right, "shape": list(strip.shape),
                                "sum": float(flat.sum()), "sum_of_squares": float((flat ** 2).sum()),
                                "samples": [[int(index), float(flat[index])] for index in range(0, flat.size, 97)]})
    space = len(characters) + 1
    letter = {char: index + 1 for index, char in enumerate(characters)}
    decode_cases = [{"classes": classes, "text": ctc_decode(classes, characters)} for classes in [
        [0, letter["H"], letter["H"], 0, letter["e"], letter["r"], letter["o"], 0, letter["'"], letter["s"], space,
         space, letter["B"], 0, letter["l"], letter["a"], letter["d"], letter["e"], 0],
        [letter["a"], 0, letter["a"], letter["a"], 0, 0],
        [0, 0, 0],
    ]]
    names = ["Hero's Blade", "Let's Play a Game", "Let's Play a Game // Let's Play a Game", "Fire // Ice",
             "Jasmine Boreal", "Jasmine Boreal of the Seven", "Plains", "Plains // Plains", "K-9, Mark I",
             "Lightning Bolt", "Lightning Blast"]
    oracles = [f"00000000-0000-0000-0000-{index:012d}" for index in range(len(names))]
    matcher = TitleMatcher(oracles, names)
    match_inputs = [
        (["herosblade"], [oracles[9], oracles[0]]),
        (["letsplayagame"], []),
        (["k9markl", "k9markl"], [oracles[8]]),
        (["k9markl"], []),
        (["lightningbol"], [oracles[9], oracles[10]]),
        (["lightningbl"], [oracles[9], oracles[10]]),
        (["ice"], []),
        (["plains"], []),
        (["jasmineborea"], [oracles[5]]),
        (["xyzzy"], [oracles[0]]),
        ([], [oracles[0]]),
    ]
    match_cases = [{"lines": lines, "candidates": candidates, "result": matcher.match(lines, candidates)}
                   for lines, candidates in match_inputs]
    similarity_cases = [{"a": a, "b": b, "score": similarity(a, b)}
                        for a, b in [("herosblade", "herosblade"), ("k9markl", "k9marki"), ("", "abc"),
                                     ("jasmineborea", "jasmineboreal"), ("abc", "")]]
    fixture = {"frame": {"width": width, "height": height}, "tolerance": 1e-3, "strip_cases": strip_cases,
               "decode_cases": decode_cases, "names": names, "oracle_ids": oracles, "match_cases": match_cases,
               "similarity_cases": similarity_cases}
    _write_json(output_dir / "fixture.json", fixture)
    manifest = {"title_reader_schema_version": TITLE_READER_SCHEMA_VERSION, "model": "title-reader.onnx",
                "model_sha256": MODEL_SHA256, "source": MODEL_URL, "characters": "characters.json",
                "fixture": "fixture.json", "constants": TITLE_READER}
    _write_json(output_dir / "title-manifest.json", manifest)
    emit("title_reader_exported", output_dir=str(output_dir))
    return output_dir
