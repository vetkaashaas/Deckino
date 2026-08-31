from __future__ import annotations

from pathlib import Path

import torch
from PIL import Image

from deckino_training.extraction_suggestion import _suggest


class _LegacySuggestionModel:
    def __init__(self, corners: list[float], presence_logit: float) -> None:
        self.corners = corners
        self.presence_logit = presence_logit

    def __call__(self, images: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return (torch.tensor([self.corners], dtype=torch.float32),
                torch.tensor([self.presence_logit], dtype=torch.float32))


def test_valid_low_confidence_guess_keeps_corners_for_human_review(tmp_path: Path) -> None:
    image_path = tmp_path / "card.png"
    Image.new("RGB", (320, 320), "white").save(image_path)
    model = _LegacySuggestionModel([.2, .1, .8, .1, .8, .9, .2, .9], -1.)

    result = _suggest(image_path, model, {"input_size": 320},
                      {"presence_threshold": .5}, torch.device("cpu"))

    assert result["geometry_valid"] is True
    assert result["would_be_accepted"] is False
    assert result["rejection_reason"] == "presence_below_threshold"
    assert result["corners"] is not None


def test_invalid_guess_is_not_returned_to_annotator(tmp_path: Path) -> None:
    image_path = tmp_path / "card.png"
    Image.new("RGB", (320, 320), "white").save(image_path)
    model = _LegacySuggestionModel([.2, .1, .2, .1, .8, .9, .2, .9], 5.)

    result = _suggest(image_path, model, {"input_size": 320},
                      {"presence_threshold": .5}, torch.device("cpu"))

    assert result["geometry_valid"] is False
    assert result["corners"] is None
