from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

import torch

from . import commands
from .events import fail


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deckino-training")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor_parser = subparsers.add_parser(
        "doctor", help="Report native Windows CUDA readiness"
    )
    doctor_parser.add_argument("--require-cuda", action="store_true")
    doctor_parser.add_argument("--expected-device")

    subparsers.add_parser("cache-backbone", help="Cache pretrained MobileNetV3 weights")

    smoke_parser = subparsers.add_parser(
        "accelerator-smoke", help="Run the production network CUDA gate"
    )
    smoke_parser.add_argument("--manifest", type=Path, required=True)
    smoke_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cuda")
    smoke_parser.add_argument("--batch-size", type=int, default=64)
    smoke_parser.add_argument("--embedding-dim", type=int, default=512)
    smoke_parser.add_argument("--steps", type=int, default=2)

    prepare_parser = subparsers.add_parser("prepare", help="Validate and index a versioned dataset")
    prepare_parser.add_argument("--data-root", type=Path, required=True)
    prepare_parser.add_argument("--dataset-version", required=True)
    prepare_parser.add_argument("--max-classes", type=int)

    subset_parser = subparsers.add_parser(
        "subset", help="Derive a deterministic no-copy subset from a prepared manifest"
    )
    subset_parser.add_argument("--source-manifest", type=Path, required=True)
    subset_parser.add_argument("--dataset-version", required=True)
    subset_parser.add_argument("--max-classes", type=int, default=20)
    subset_parser.add_argument("--min-images-per-class", type=int, default=3)

    camera_parser = subparsers.add_parser(
        "prepare-camera", help="Validate and copy the labeled Android camera set"
    )
    camera_parser.add_argument("--input-root", type=Path, required=True)
    camera_parser.add_argument("--output-root", type=Path, required=True)
    camera_parser.add_argument("--dataset-manifest", type=Path, required=True)
    camera_parser.add_argument("--camera-version", required=True)

    train_parser = subparsers.add_parser("train", help="Train a MobileNetV3 ArcFace model")
    train_parser.add_argument("--manifest", type=Path, required=True)
    train_parser.add_argument("--artifacts-root", type=Path, required=True)
    train_parser.add_argument("--model-version", required=True)
    train_parser.add_argument("--epochs", type=int, default=20)
    train_parser.add_argument("--batch-size", type=int, default=64)
    train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    train_parser.add_argument("--workers", type=int, default=4)
    train_parser.add_argument("--embedding-dim", type=int, default=512)
    train_parser.add_argument("--pretrained", action="store_true")
    train_parser.add_argument("--resume", type=Path)
    train_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    train_parser.add_argument("--max-batches", type=int, help=argparse.SUPPRESS)
    train_parser.add_argument("--seed", type=int, default=0)

    checkpoint_parser = subparsers.add_parser(
        "checkpoint-info", help="Report version and resume state from a checkpoint"
    )
    checkpoint_parser.add_argument("--checkpoint", type=Path, required=True)

    evaluate_parser = subparsers.add_parser("evaluate", help="Evaluate a held-out simulated-camera split")
    evaluate_parser.add_argument("--manifest", type=Path, required=True)
    evaluate_parser.add_argument("--checkpoint", type=Path, required=True)
    evaluate_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    evaluate_parser.add_argument("--batch-size", type=int, default=64)
    evaluate_parser.add_argument("--workers", type=int, default=4)
    evaluate_parser.add_argument("--camera-manifest", type=Path)

    recognize_parser = subparsers.add_parser("recognize", help="Recognize one saved card-art image")
    recognize_parser.add_argument("--checkpoint", type=Path, required=True)
    recognize_parser.add_argument("--image", type=Path, required=True)
    recognize_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    recognize_parser.add_argument("--score-threshold", type=float)
    recognize_parser.add_argument("--margin-threshold", type=float)
    recognize_parser.add_argument(
        "--input-kind",
        choices=("auto", "card", "art"),
        default="auto",
        help="Treat the image as a full aligned card, an art crop, or infer from aspect ratio",
    )
    return parser


def run(arguments: argparse.Namespace) -> int:
    if arguments.command == "doctor":
        return commands.doctor(arguments.require_cuda, arguments.expected_device)
    if arguments.command == "cache-backbone":
        return commands.cache_backbone()
    if arguments.command == "accelerator-smoke":
        return commands.accelerator_smoke(
            arguments.manifest,
            arguments.device,
            arguments.batch_size,
            arguments.embedding_dim,
            arguments.steps,
        )
    if arguments.command == "prepare":
        return commands.prepare(
            arguments.data_root,
            arguments.dataset_version,
            arguments.max_classes,
        )
    if arguments.command == "subset":
        return commands.subset(
            arguments.source_manifest,
            arguments.dataset_version,
            arguments.max_classes,
            arguments.min_images_per_class,
        )
    if arguments.command == "prepare-camera":
        return commands.prepare_camera(
            arguments.input_root,
            arguments.output_root,
            arguments.dataset_manifest,
            arguments.camera_version,
        )
    if arguments.command == "train":
        return commands.train(
            arguments.manifest,
            arguments.artifacts_root,
            arguments.model_version,
            arguments.epochs,
            arguments.batch_size,
            arguments.learning_rate,
            arguments.workers,
            arguments.embedding_dim,
            arguments.pretrained,
            arguments.resume,
            arguments.device,
            arguments.max_batches,
            arguments.seed,
        )
    if arguments.command == "checkpoint-info":
        return commands.checkpoint_info(arguments.checkpoint)
    if arguments.command == "evaluate":
        return commands.evaluate(
            arguments.manifest,
            arguments.checkpoint,
            arguments.device,
            arguments.batch_size,
            arguments.workers,
            arguments.camera_manifest,
        )
    if arguments.command == "recognize":
        return commands.recognize(
            arguments.checkpoint,
            arguments.image,
            arguments.device,
            arguments.score_threshold,
            arguments.margin_threshold,
            arguments.input_kind,
        )
    raise AssertionError(f"Unknown command: {arguments.command}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        return run(arguments)
    except torch.cuda.OutOfMemoryError as error:
        return fail(
            f"CUDA out of memory: {error}. Retry with --batch-size 32.",
            command=arguments.command,
            error_code="cuda_out_of_memory",
            recommended_batch_size=32,
        )
    except RuntimeError as error:
        if "cuda" in str(error).casefold() and "out of memory" in str(error).casefold():
            return fail(
                f"CUDA out of memory: {error}. Retry with --batch-size 32.",
                command=arguments.command,
                error_code="cuda_out_of_memory",
                recommended_batch_size=32,
            )
        return fail(str(error), command=arguments.command)
    except (FileNotFoundError, OSError, ValueError) as error:
        return fail(str(error), command=arguments.command)


if __name__ == "__main__":
    raise SystemExit(main())
