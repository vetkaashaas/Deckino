from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

import torch

from . import artwork, commands
from .events import fail


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deckino-training")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor_parser = subparsers.add_parser(
        "doctor", help="Report native Windows CUDA readiness"
    )
    doctor_parser.add_argument("--require-cuda", action="store_true")
    doctor_parser.add_argument("--expected-device")
    doctor_parser.add_argument("--minimum-vram-mb", type=int, default=6000)

    subparsers.add_parser("cache-backbone", help="Cache pretrained MobileNetV3 weights")

    smoke_parser = subparsers.add_parser(
        "accelerator-smoke", help="Run the production network CUDA gate"
    )
    smoke_parser.add_argument("--manifest", type=Path, required=True)
    smoke_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cuda")
    smoke_parser.add_argument("--batch-size", type=int, default=64)
    smoke_parser.add_argument("--embedding-dim", type=int, default=512)
    smoke_parser.add_argument("--steps", type=int, default=2)
    smoke_parser.add_argument("--cuda-device-index", type=int)

    prepare_parser = subparsers.add_parser("prepare", help="Validate and index a versioned dataset")
    prepare_parser.add_argument("--data-root", type=Path, required=True)
    prepare_parser.add_argument("--dataset-version", required=True)
    prepare_parser.add_argument("--max-classes", type=int)

    artwork_prepare_parser = subparsers.add_parser(
        "prepare-artwork", help="Build the schema-v4 artwork identity manifest"
    )
    artwork_prepare_parser.add_argument("--data-root", type=Path, required=True)
    artwork_prepare_parser.add_argument("--dataset-version", required=True)

    index_parser = subparsers.add_parser(
        "build-index", help="Embed the artwork catalog into a prototype index"
    )
    index_parser.add_argument("--manifest", type=Path, required=True)
    index_parser.add_argument("--checkpoint", type=Path, required=True)
    index_parser.add_argument("--output-root", type=Path, required=True)
    index_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    index_parser.add_argument("--batch-size", type=int, default=32)
    index_parser.add_argument("--cuda-device-index", type=int)

    index_evaluate_parser = subparsers.add_parser(
        "evaluate-index", help="Evaluate and calibrate oracle-collapsed artwork retrieval"
    )
    index_evaluate_parser.add_argument("--manifest", type=Path, required=True)
    index_evaluate_parser.add_argument("--checkpoint", type=Path, required=True)
    index_evaluate_parser.add_argument("--index-root", type=Path, required=True)
    index_evaluate_parser.add_argument("--output", type=Path, required=True)
    index_evaluate_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    index_evaluate_parser.add_argument("--batch-size", type=int, default=64)
    index_evaluate_parser.add_argument("--cuda-device-index", type=int)

    index_recognize_parser = subparsers.add_parser(
        "recognize-index", help="Recognize one artwork with the prototype index"
    )
    index_recognize_parser.add_argument("--checkpoint", type=Path, required=True)
    index_recognize_parser.add_argument("--index-root", type=Path, required=True)
    index_recognize_parser.add_argument("--image", type=Path, required=True)
    index_recognize_parser.add_argument("--thresholds", type=Path, required=True)
    index_recognize_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    index_recognize_parser.add_argument("--cuda-device-index", type=int)

    artwork_train_parser = subparsers.add_parser(
        "train-artwork", help="Train the schema-v4 paired-view artwork embedding fallback"
    )
    artwork_train_parser.add_argument("--manifest", type=Path, required=True)
    artwork_train_parser.add_argument("--artifacts-root", type=Path, required=True)
    artwork_train_parser.add_argument("--model-version", required=True)
    artwork_train_parser.add_argument("--epochs", type=int, default=30)
    artwork_train_parser.add_argument("--batch-size", type=int, default=64)
    artwork_train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    artwork_train_parser.add_argument("--workers", type=int, default=4)
    artwork_train_parser.add_argument("--embedding-dim", type=int, default=512)
    artwork_train_parser.add_argument("--pretrained", action="store_true")
    artwork_train_parser.add_argument("--resume", type=Path)
    artwork_train_parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    artwork_train_parser.add_argument("--seed", type=int, default=20260823)
    artwork_train_parser.add_argument("--cuda-device-index", type=int)

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
    train_parser.add_argument("--cuda-device-index", type=int)

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
    evaluate_parser.add_argument("--comparison-checkpoint", type=Path)
    evaluate_parser.add_argument("--cuda-device-index", type=int)

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
    recognize_parser.add_argument("--cuda-device-index", type=int)
    return parser


def run(arguments: argparse.Namespace) -> int:
    if arguments.command == "doctor":
        return commands.doctor(
            arguments.require_cuda,
            arguments.expected_device,
            arguments.minimum_vram_mb,
        )
    if arguments.command == "cache-backbone":
        return commands.cache_backbone()
    if arguments.command == "accelerator-smoke":
        return commands.accelerator_smoke(
            arguments.manifest,
            arguments.device,
            arguments.batch_size,
            arguments.embedding_dim,
            arguments.steps,
            arguments.cuda_device_index,
        )
    if arguments.command == "prepare":
        return commands.prepare(
            arguments.data_root,
            arguments.dataset_version,
            arguments.max_classes,
        )
    if arguments.command == "prepare-artwork":
        artwork.prepare_artwork_dataset(arguments.data_root, arguments.dataset_version)
        return 0
    if arguments.command == "build-index":
        artwork.build_index(
            arguments.manifest,
            arguments.checkpoint,
            arguments.output_root,
            arguments.device,
            arguments.batch_size,
            arguments.cuda_device_index,
        )
        return 0
    if arguments.command == "evaluate-index":
        artwork.evaluate_index(
            arguments.manifest,
            arguments.checkpoint,
            arguments.index_root,
            arguments.output,
            arguments.device,
            arguments.batch_size,
            arguments.cuda_device_index,
        )
        return 0
    if arguments.command == "recognize-index":
        artwork.recognize_index(
            arguments.checkpoint,
            arguments.index_root,
            arguments.image,
            arguments.thresholds,
            arguments.device,
            arguments.cuda_device_index,
        )
        return 0
    if arguments.command == "train-artwork":
        artwork.train_artwork(
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
            arguments.seed,
            arguments.cuda_device_index,
        )
        return 0
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
            arguments.cuda_device_index,
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
            arguments.comparison_checkpoint,
            arguments.cuda_device_index,
        )
    if arguments.command == "recognize":
        return commands.recognize(
            arguments.checkpoint,
            arguments.image,
            arguments.device,
            arguments.score_threshold,
            arguments.margin_threshold,
            arguments.input_kind,
            arguments.cuda_device_index,
        )
    raise AssertionError(f"Unknown command: {arguments.command}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        return run(arguments)
    except torch.cuda.OutOfMemoryError as error:
        batch_size = getattr(arguments, "batch_size", 32)
        recommended_batch_size = max(16, batch_size // 2)
        return fail(
            f"CUDA out of memory: {error}. Retry with --batch-size {recommended_batch_size}.",
            command=arguments.command,
            error_code="cuda_out_of_memory",
            recommended_batch_size=recommended_batch_size,
        )
    except RuntimeError as error:
        if "cuda" in str(error).casefold() and "out of memory" in str(error).casefold():
            batch_size = getattr(arguments, "batch_size", 32)
            recommended_batch_size = max(16, batch_size // 2)
            return fail(
                f"CUDA out of memory: {error}. Retry with --batch-size {recommended_batch_size}.",
                command=arguments.command,
                error_code="cuda_out_of_memory",
                recommended_batch_size=recommended_batch_size,
            )
        return fail(str(error), command=arguments.command)
    except (FileNotFoundError, OSError, ValueError) as error:
        return fail(str(error), command=arguments.command)


if __name__ == "__main__":
    raise SystemExit(main())
