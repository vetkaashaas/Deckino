from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from deckino_training import commands


class CudaContractTests(unittest.TestCase):
    def test_device_contract_rejects_removed_backends(self) -> None:
        for device in ("dml", "privateuseone", "hip"):
            with self.subTest(device=device), self.assertRaisesRegex(ValueError, "auto, cuda, cpu"):
                commands._resolve_device(device)

    def test_selects_required_cuda_adapter_when_it_is_not_gpu_zero(self) -> None:
        with (
            patch.dict("os.environ", {"DECKINO_CUDA_DEVICE_NAME": "RTX 4070 Laptop GPU"}),
            patch.object(torch.cuda, "is_available", return_value=True),
            patch.object(torch.cuda, "device_count", return_value=2),
            patch.object(
                torch.cuda,
                "get_device_name",
                side_effect=["NVIDIA RTX A1000 Laptop GPU", "NVIDIA GeForce RTX 4070 Laptop GPU"],
            ),
        ):
            device = commands._resolve_device("cuda")

        self.assertEqual(str(device), "cuda:1")

    def test_doctor_reports_cuda_device_details(self) -> None:
        properties = type(
            "Properties",
            (),
            {"name": "NVIDIA GeForce RTX 4070 Laptop GPU", "total_memory": 8 * 1024**3, "major": 8, "minor": 9},
        )()
        events: list[dict[str, object]] = []
        with (
            patch.object(torch.cuda, "is_available", return_value=True),
            patch.object(torch.cuda, "device_count", return_value=1),
            patch.object(torch.cuda, "get_device_properties", return_value=properties),
            patch.object(commands, "_driver_version", return_value="560.00"),
            patch.object(commands, "emit", side_effect=lambda event, **values: events.append({"event": event, **values})),
        ):
            result = commands.doctor(True, "RTX 4070 Laptop GPU")

        self.assertEqual(result, 0)
        self.assertEqual(events[0]["status"], "ok")
        self.assertEqual(events[0]["devices"][0]["vram_mb"], 8192)
        self.assertEqual(events[0]["devices"][0]["compute_capability"], "8.9")

    def test_schema_two_checkpoint_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "legacy.pt"
            torch.save({"artifact_schema_version": 2}, checkpoint)
            with self.assertRaisesRegex(ValueError, "schema v1/v2"):
                commands._load_checkpoint(checkpoint, torch.device("cpu"))


if __name__ == "__main__":
    unittest.main()
