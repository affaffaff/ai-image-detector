#!/usr/bin/env python3
"""Score a benchmark manifest with the exported ONNX model.

This is the offline counterpart to src/offscreen/preprocess.js. It emits the
shipped Resize(440) + CenterCrop(384) signal plus native-grid alternatives in
one pass. It never downloads data or weights.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps


INPUT_NAME = "pixel_values"
OUTPUT_NAME = "fake_logit"
TILE_SIZE = 384
MAX_AXIS_SAMPLES = 3
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
MEAN_FILL = (124, 116, 104)
REQUIRED_COLUMNS = {
    "image_id",
    "path",
    "label",
    "generator",
    "split",
    "phash",
    "degradation",
}
STRATEGIES = (
    "official_center",
    "native_mean",
    "native_max",
    "native_median",
    "native_top2",
    "native_top3",
    "native_noisy_or",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def axis_origins(length: int) -> list[int]:
    if length <= 0:
        raise ValueError("decoded image has an empty edge")
    if length <= TILE_SIZE:
        return [(length - TILE_SIZE) // 2]
    last = length - TILE_SIZE
    count = min(MAX_AXIS_SAMPLES, math.ceil(length / TILE_SIZE))
    if count == 1:
        return [math.floor(last / 2 + 0.5)]
    # JavaScript Math.round() rounds positive halves upward; Python round()
    # uses banker's rounding. Keep this exactly aligned with the browser grid.
    return [math.floor(last * index / (count - 1) + 0.5) for index in range(count)]


def tile_tensor(image: Image.Image, x: int, y: int) -> np.ndarray:
    canvas = Image.new("RGB", (TILE_SIZE, TILE_SIZE), MEAN_FILL)
    sx = max(0, x)
    sy = max(0, y)
    dx = sx - x
    dy = sy - y
    copy_width = min(TILE_SIZE - dx, image.width - sx)
    copy_height = min(TILE_SIZE - dy, image.height - sy)
    if copy_width <= 0 or copy_height <= 0:
        raise ValueError("tile does not intersect decoded image")
    crop = image.crop((sx, sy, sx + copy_width, sy + copy_height))
    canvas.paste(crop, (dx, dy))
    pixels = np.asarray(canvas, dtype=np.float32) / np.float32(255.0)
    normalized = (pixels - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(normalized.transpose(2, 0, 1)[None, ...])


def sigmoid(logit: float) -> float:
    if logit >= 0:
        return 1.0 / (1.0 + math.exp(-logit))
    exponent = math.exp(logit)
    return exponent / (1.0 + exponent)


def infer_tensor(session: ort.InferenceSession, tensor: np.ndarray) -> float:
    result = session.run([OUTPUT_NAME], {INPUT_NAME: tensor})[0]
    return sigmoid(float(np.asarray(result).reshape(-1)[0]))


def official_center_tensor(image: Image.Image) -> np.ndarray:
    """Match the authors' Resize(440) + CenterCrop(384) test transform."""
    width, height = image.size
    if width <= height:
        resized_width = 440
        resized_height = max(440, int(height * 440 / width))
    else:
        resized_height = 440
        resized_width = max(440, int(width * 440 / height))
    resized = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    left = (resized_width - TILE_SIZE) // 2
    top = (resized_height - TILE_SIZE) // 2
    crop = resized.crop((left, top, left + TILE_SIZE, top + TILE_SIZE))
    pixels = np.asarray(crop, dtype=np.float32) / np.float32(255.0)
    normalized = (pixels - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(normalized.transpose(2, 0, 1)[None, ...])


def score_image(
    session: ort.InferenceSession,
    path: Path,
    *,
    include_official_center_diagnostic: bool = False,
) -> dict[str, float]:
    with Image.open(path) as decoded:
        image = ImageOps.exif_transpose(decoded).convert("RGB")
        probabilities: list[float] = []
        for y in axis_origins(image.height):
            for x in axis_origins(image.width):
                tensor = tile_tensor(image, x, y)
                probabilities.append(infer_tensor(session, tensor))
        ordered = sorted(probabilities, reverse=True)
        top2 = ordered[: min(2, len(ordered))]
        top3 = ordered[: min(3, len(ordered))]
        noisy_or = 1.0 - math.prod(1.0 - value for value in probabilities)
        scores = {
            "official_center": infer_tensor(session, official_center_tensor(image)),
            "native_mean": sum(probabilities) / len(probabilities),
            "native_max": ordered[0],
            "native_median": float(np.median(np.asarray(probabilities))),
            "native_top2": sum(top2) / len(top2),
            "native_top3": sum(top3) / len(top3),
            "native_noisy_or": noisy_or,
        }
        return scores


def read_rows(path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = list(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - set(fields)
        if missing:
            raise ValueError(f"manifest is missing columns: {', '.join(sorted(missing))}")
        rows = list(reader)
    if not rows:
        raise ValueError("manifest contains no rows")
    return fields, rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", required=True, type=Path, dest="manifest")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--strategy", choices=STRATEGIES, default="official_center")
    parser.add_argument(
        "--include-official-center-diagnostic",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--providers",
        default="CUDAExecutionProvider,CPUExecutionProvider",
        help="comma-separated ONNX Runtime providers, first available wins",
    )
    args = parser.parse_args()

    fields, rows = read_rows(args.manifest)
    requested = [item.strip() for item in args.providers.split(",") if item.strip()]
    available = ort.get_available_providers()
    providers = [item for item in requested if item in available]
    if not providers:
        raise ValueError(
            f"none of the requested ONNX providers are available: {requested}; have {available}"
        )
    print(f"onnxruntime providers: {providers} (available: {available})", flush=True)
    session_providers: list[str | tuple[str, dict[str, object]]] = []
    for item in providers:
        if item == "CUDAExecutionProvider":
            session_providers.append((
                "CUDAExecutionProvider",
                {
                    "device_id": 0,
                    "arena_extend_strategy": "kSameAsRequested",
                    "gpu_mem_limit": 2 * 1024 * 1024 * 1024,
                    "cudnn_conv_algo_search": "DEFAULT",
                },
            ))
        else:
            session_providers.append(item)
    session = ort.InferenceSession(str(args.model), providers=session_providers)
    if INPUT_NAME not in {item.name for item in session.get_inputs()}:
        raise ValueError(f"ONNX graph does not expose input '{INPUT_NAME}'")
    if OUTPUT_NAME not in {item.name for item in session.get_outputs()}:
        raise ValueError(f"ONNX graph does not expose output '{OUTPUT_NAME}'")

    model_hash = sha256_file(args.model)
    output_rows = []
    for index, row in enumerate(rows, start=1):
        image_path = Path(row["path"])
        if not image_path.is_absolute():
            image_path = args.manifest.parent / image_path
        actual_image_hash = sha256_file(image_path)
        declared_image_hash = row.get("image_sha256", "").lower()
        if declared_image_hash and declared_image_hash != actual_image_hash:
            raise ValueError(f"input image hash mismatch for {row['image_id']}")
        strategies = score_image(
            session,
            image_path,
            include_official_center_diagnostic=args.include_official_center_diagnostic,
        )
        score = strategies[args.strategy]
        output_rows.append({
            **row,
            **{f"score_{name}": f"{value:.10f}" for name, value in strategies.items()},
            "score": f"{score:.10f}",
            "model_sha256": model_hash,
            "image_sha256": actual_image_hash,
        })
        identity = row["image_id"].encode("ascii", "replace").decode("ascii")
        print(f"[{index}/{len(rows)}] {identity}: {args.strategy}={score:.6f}", flush=True)

    score_fields = [*(f"score_{name}" for name in STRATEGIES)]
    generated_fields = {"score", "model_sha256", *score_fields}
    output_fields = [field for field in fields if field not in generated_fields]
    output_fields.extend([*score_fields, "score", "model_sha256"])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=output_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(output_rows)


if __name__ == "__main__":
    main()
