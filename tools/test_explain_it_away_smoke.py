#!/usr/bin/env python3
"""Smoke tests for the explain-it-away null suite. No GPU, no real corpus."""

from __future__ import annotations

import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from explain_it_away import (  # noqa: E402
    DECISION_THRESHOLD,
    apply_stress,
    run_null_shootout,
    stress_destination,
)
from null_features import b4_spectral_ratio, extract_features, luma_plane  # noqa: E402


def write_png(path: Path, size: tuple[int, int], seed: int) -> None:
    rng = np.random.default_rng(seed)
    height, width = size[1], size[0]
    yy, xx = np.mgrid[0:height, 0:width]
    base = np.zeros((height, width, 3), dtype=np.uint8)
    base[..., 0] = ((np.sin(xx / (6 + seed % 7)) + 1) * 110).astype(np.uint8)
    base[..., 1] = ((np.cos(yy / (5 + seed % 5)) + 1) * 90).astype(np.uint8)
    base[..., 2] = rng.integers(40, 180, size=(height, width), dtype=np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base).save(path, format="PNG")


def write_jpeg(path: Path, size: tuple[int, int], seed: int, quality: int) -> None:
    rng = np.random.default_rng(seed)
    height, width = size[1], size[0]
    yy, xx = np.mgrid[0:height, 0:width]
    base = np.zeros((height, width, 3), dtype=np.uint8)
    base[..., 0] = ((np.sin(xx / 18.0) + 1) * 70).astype(np.uint8)
    base[..., 1] = ((np.cos(yy / 14.0) + 1) * 70).astype(np.uint8)
    base[..., 2] = rng.integers(20, 90, size=(height, width), dtype=np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base).save(path, format="JPEG", quality=quality, subsampling=2)


def main() -> int:
    failures: list[str] = []

    luma = np.zeros((128, 128), dtype=np.float64)
    luma[:64] = 200
    if b4_spectral_ratio(luma) is None:
        failures.append("B4 should be defined on 128px luma")

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        rows = []
        for split, split_seed in (("fit", 1), ("eval", 2)):
            for index in range(8):
                ai_path = root / split / f"ai-{index:02d}.png"
                real_path = root / split / f"real-{index:02d}.jpg"
                write_png(ai_path, (256, 256), seed=split_seed * 100 + index)
                write_jpeg(real_path, (64, 48), seed=split_seed * 200 + index, quality=40)
                ai_features = extract_features(ai_path)
                real_features = extract_features(real_path)
                ai_row = {
                    "image_id": f"{split}-ai-{index:02d}",
                    "path": str(ai_path),
                    "label": 1,
                    "generator": "toy-gen" if split == "eval" else "fit-gen",
                    "split": split,
                    "source_key": "toy-gen" if split == "eval" else "fit-gen",
                    "cluster_id": f"{split}-ai-{index:02d}",
                    "degradation": "native",
                    "score_native_max": 0.92 + index * 0.001,
                    "score_official_calibrated": 0.92 + index * 0.001,
                    **{k: v for k, v in ai_features.items() if not k.startswith("_")},
                    "_pixels32": ai_features["_pixels32"],
                }
                real_row = {
                    "image_id": f"{split}-real-{index:02d}",
                    "path": str(real_path),
                    "label": 0,
                    "generator": "real",
                    "split": split,
                    "source_key": f"camera-{index % 3}",
                    "cluster_id": f"{split}-real-{index:02d}",
                    "degradation": "native",
                    "score_native_max": 0.11 + index * 0.001,
                    "score_official_calibrated": 0.11 + index * 0.001,
                    **{k: v for k, v in real_features.items() if not k.startswith("_")},
                    "_pixels32": real_features["_pixels32"],
                }
                for band_index, value in enumerate(ai_features["_fft_bands"] or []):
                    ai_row[f"fft_band_{band_index}"] = value
                for band_index, value in enumerate(real_features["_fft_bands"] or []):
                    real_row[f"fft_band_{band_index}"] = value
                if ai_features["_dct_bands"]:
                    for band_index, value in enumerate(ai_features["_dct_bands"][:-1]):
                        ai_row[f"dct_band_{band_index}"] = value
                    ai_row["dct_high_low"] = ai_features["_dct_bands"][-1]
                if real_features["_dct_bands"]:
                    for band_index, value in enumerate(real_features["_dct_bands"][:-1]):
                        real_row[f"dct_band_{band_index}"] = value
                    real_row["dct_high_low"] = real_features["_dct_bands"][-1]
                rows.extend([ai_row, real_row])

        shootout = run_null_shootout(rows, samples=200, seed=20260813)
        detector_ba = shootout["detector"]["balancedAccuracy"]["value"]
        if not math.isclose(detector_ba, 1.0):
            failures.append(f"toy detector BA should be 1.0, got {detector_ba}")
        geom = shootout["univariate"]["b1_log_pixels"]
        if geom.get("skipped") or geom["oracleBA"] < 0.95:
            failures.append(f"pixel-count null should leak on toy data, got {geom}")
        shuffled = shootout["multivariate"]["shuffled_label_all_nuisance"]
        if shuffled.get("skipped"):
            failures.append("shuffled-label control skipped")
        elif shuffled["fairBA"] > 0.85:
            failures.append(f"shuffled-label fair BA too high: {shuffled['fairBA']}")
        if shootout["corpusGate"]["status"] != "fail":
            failures.append(f"toy corpus should FAIL the oracle gate, got {shootout['corpusGate']}")
        gate = shootout["corpusGate"]
        gate_probes = {entry["id"]: entry for entry in gate.get("probes", [])}
        if gate.get("permutationSamples") != 10000 or len(gate_probes) != 5:
            failures.append(f"frozen B1-B5 permutation family missing: {gate}")
        pixel_gate = gate_probes.get("b1_log_pixels", {})
        if pixel_gate.get("status") != "fail" or pixel_gate.get("correctedPValue", 1.0) >= 0.01:
            failures.append(f"obvious cluster-level pixel leak should fail permutation gate: {pixel_gate}")
        if ">= 0.70" in gate.get("rule", "") or ">= 0.60" in gate.get("rule", ""):
            failures.append(f"superseded fixed-BA corpus rule survived: {gate['rule']}")

        source = root / "fit" / "ai-00.png"
        dest_root = root / "stress-out"
        record = {"path": "fit/ai-00.png"}
        jpeg_dest = stress_destination(dest_root, "jpeg_only", record, source)
        apply_stress("jpeg_only", source, jpeg_dest)
        if jpeg_dest.suffix.lower() not in {".jpg", ".jpeg"} or not jpeg_dest.is_file():
            failures.append("jpeg_only did not write a jpeg")
        native_dest = stress_destination(dest_root, "native", record, source)
        if native_dest.resolve() != source.resolve():
            failures.append("native cell must point at the original bytes")
        apply_stress("jpeg_only", source, jpeg_dest)
        first = jpeg_dest.read_bytes()
        jpeg_dest.unlink()
        apply_stress("jpeg_only", source, jpeg_dest)
        if jpeg_dest.read_bytes() != first:
            failures.append("jpeg_only is not deterministic")

        report_keys = json.loads(json.dumps(shootout, default=str))
        if "predictions" in json.dumps(report_keys):
            failures.append("serialized shootout leaked raw predictions")
        if abs(DECISION_THRESHOLD - 0.65) > 1e-12:
            failures.append("threshold moved")

    if failures:
        print("FAIL")
        for item in failures:
            print(f"  {item}")
        return 1
    print("explain-it-away smoke: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
