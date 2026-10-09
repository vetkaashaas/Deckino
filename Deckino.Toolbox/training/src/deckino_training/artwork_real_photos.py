"""Real camera photos labelled on the Toolbox's Card Identification page, as artwork training data.

A photo counts when its ``._identity.json`` is ``confirmed`` or ``corrected`` with an ``OracleId`` and the exact
``PrintingId`` (so its artwork is known, never guessed among a card's reprints) and its ``._annotations.json`` has
the four card corners. The model's guesses in the identity file are never read.
Crops are cut exactly as the phone cuts them (the photo shrunk to the 480 px VGA frame, then
``phone_recognition_crop``), with the corners jittered a little the way the extractor misses.

Cards in a frozen benchmark (artwork_benchmark.py) are never trained on, so the benchmark measures recognition of
cards the model never saw photographed.
"""
from __future__ import annotations

import json
import random
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import torch
from PIL import Image
from torch import Tensor
from torch.utils.data import Dataset
from torchvision import transforms

from .artwork_camera_probe import CORNER_NAMES, _phone_frame
from .artwork_mobile import phone_recognition_crop
from .model import NORMALIZE_MEAN, NORMALIZE_STD

LABEL_STATUSES = {"confirmed", "corrected"}
# Corner jitter, as a fraction of the frame: about the extractor's typical miss.
CORNER_JITTER = 0.012


@dataclass(frozen=True)
class RealPhoto:
    image_path: Path
    corners: tuple[tuple[float, float], ...]
    oracle_id: str
    # The training class of the labelled printing, as artwork.py names it: its illustration, else the printing.
    artwork_id: str


def load_real_photos(data_root: Path) -> list[RealPhoto]:
    photos: list[RealPhoto] = []
    connection = sqlite3.connect(data_root / "deckino.db")
    try:
        illustrations = dict(connection.execute("SELECT lower(scryfall_id), illustration_id FROM cards"))
    finally:
        connection.close()
    for identity_path in sorted((data_root / "training" / "camera" / "imports").rglob("*._identity.json")):
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        if identity.get("Status") not in LABEL_STATUSES or not identity.get("OracleId"):
            continue
        printing = (identity.get("PrintingId") or "").lower()
        if printing not in illustrations:
            continue
        annotation_path = identity_path.with_name(identity_path.name.replace("._identity.json", "._annotations.json"))
        if not annotation_path.is_file():
            continue
        annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
        if not annotation.get("CardPresent") or any(not annotation.get(name) for name in CORNER_NAMES):
            continue
        image_path = identity_path.parent / identity["ImageFile"]
        if not image_path.is_file():
            continue
        photos.append(RealPhoto(image_path, tuple((annotation[name]["X"], annotation[name]["Y"]) for name in CORNER_NAMES),
                                identity["OracleId"].lower(),
                                illustrations[printing] or f"printing:{printing}"))
    return photos


class RealPhotoPairDataset(Dataset[tuple[Tensor, Tensor, int]]):
    """Two views of each photo. The photo is already a real camera frame, so only light extra damage."""

    def __init__(self, photos: list[RealPhoto]) -> None:
        self.photos = photos
        self.transform = transforms.Compose([
            transforms.RandomApply([transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.15, hue=0.02)], p=0.7),
            transforms.RandomErasing(p=0.1, scale=(0.01, 0.06), ratio=(0.2, 4.0), value="random"),
            transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD),
        ])

    def __len__(self) -> int:
        return len(self.photos)

    def __getitem__(self, index: int) -> tuple[Tensor, Tensor, int]:
        photo = self.photos[index]
        # Decode and shrink once; the two views differ only in where the jittered corners land.
        with Image.open(photo.image_path) as source:
            frame = _phone_frame(source.convert("RGB"))

        def view() -> Tensor:
            corners = [{"x": x + random.uniform(-CORNER_JITTER, CORNER_JITTER),
                        "y": y + random.uniform(-CORNER_JITTER, CORNER_JITTER)} for x, y in photo.corners]
            return self.transform(torch.from_numpy(phone_recognition_crop(frame, corners)))

        return view(), view(), index
