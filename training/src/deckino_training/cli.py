from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from . import commands
from .events import fail


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deckino-training")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("doctor", help="Report WSL and PyTorch accelerator readiness")

    prepare_parser = subparsers.add_parser("prepare", help="Validate and copy a versioned dataset")
    prepare_parser.add_argument("--data-root", type=Path, required=True)
    prepare_parser.add_argument("--output-root", type=Path, required=True)
    prepare_parser.add_argument("--dataset-version", required=True)
    prepare_parser.add_argument("--max-classes", type=int)

    train_parser = subparsers.add_parser("train", help="Train a MobileNetV3 ArcFace model")
    train_parser.add_argument("--manifest", type=Path, required=True)
    train_parser.add_argument("--artifacts-root", type=Path, required=True)
    train_parser.add_argument("--model-version", required=True)
    train_parser.add_argument("--epochs", type=int, default=20)
    train_parser.add_argument("--batch-size", type=int, default=128)
    train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    train_parser.add_argument("--workers", type=int, default=4)
    train_parser.add_argument("--embedding-dim", type=int, default=512)
    train_parser.add_argument("--pretrained", action="store_true")
    train_parser.add_argument("--resume", type=Path)
    train_parser.add_argument("--device", default="auto")
    train_parser.add_argument("--max-batches", type=int, help=argparse.SUPPRESS)

    evaluate_parser = subparsers.add_parser("evaluate", help="Evaluate a held-out simulated-camera split")
    evaluate_parser.add_argument("--manifest", type=Path, required=True)
    evaluate_parser.add_argument("--checkpoint", type=Path, required=True)
    evaluate_parser.add_argument("--device", default="auto")
    evaluate_parser.add_argument("--batch-size", type=int, default=128)
    evaluate_parser.add_argument("--workers", type=int, default=4)

    recognize_parser = subparsers.add_parser("recognize", help="Recognize one saved card-art image")
    recognize_parser.add_argument("--checkpoint", type=Path, required=True)
    recognize_parser.add_argument("--image", type=Path, required=True)
    recognize_parser.add_argument("--device", default="auto")
    recognize_parser.add_argument("--score-threshold", type=float, default=0.45)
    recognize_parser.add_argument("--margin-threshold", type=float, default=0.05)
    recognize_parser.add_argument(
        "--input-kind",
        choices=("auto", "card", "art"),
        default="auto",
        help="Treat the image as a full aligned card, an art crop, or infer from aspect ratio",
    )
    return parser


def run(arguments: argparse.Namespace) -> int:
    if arguments.command == "doctor":
        return commands.doctor()
    if arguments.command == "prepare":
        return commands.prepare(
            arguments.data_root,
            arguments.output_root,
            arguments.dataset_version,
            arguments.max_classes,
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
        )
    if arguments.command == "evaluate":
        return commands.evaluate(
            arguments.manifest,
            arguments.checkpoint,
            arguments.device,
            arguments.batch_size,
            arguments.workers,
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
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        return fail(str(error), command=arguments.command)


if __name__ == "__main__":
    raise SystemExit(main())
