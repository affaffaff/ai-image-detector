#!/usr/bin/env python3
"""Explain-it-away sprint: freeze official-center@0.65, null shootout, stress grid.

No model changes. No threshold sweeps. Retargeted to the shipped
score_official_browser signal on the source-matched corpus.
Nulls train on FIT only and are evaluated on the held-out eval.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np
from PIL import Image, ImageOps
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from eval_common import canonical_sha256, sha256_file
from null_features import DCT_BAND_EDGES, FFT_BAND_EDGES, MEAN_FILL, extract_features, load_rgb, pixels32

DECISION_THRESHOLD = 0.65
PROTOCOL_SEED = 20260813
BOOTSTRAP_SAMPLES = 10000
PERMUTATION_SAMPLES = 10000
POWER_FLOOR = 100
SCORE_COLUMN = "score_official_calibrated"  # shipped operating point: fused-curve-calibrated official-center scores at 0.65 (raw score_official_browser is pre-calibration and must NOT be thresholded at 0.65)
RAW_SCORE_COLUMN = "score_official_browser"
EXPLORATORY_COLUMN = "score_native_max"
CANDIDATE = "official_center"
EXPECTED_MODEL_SHA256 = "df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035"

# The frozen corpus-contamination battery in docs/eval-protocol.md is B1-B5.
# Richer univariate and fitted multivariate nulls remain useful for the paired
# detector-margin challenge, but they were not predeclared as permutation-gate
# probes and must not silently expand the multiple-testing family.
PERMUTATION_GATE_PROBES = (
    "b1_log_pixels",
    "b2_log_bytes",
    "b3_log_density",
    "b4_spectral",
    "b5_blockiness",
)

UNIVARIATE = (
    "width", "height", "aspect",
    "b1_log_pixels", "b2_log_bytes", "b3_log_density",
    "is_jpeg", "is_png", "is_webp",
    "jpeg_qmean", "jpeg_quality_proxy", "chroma_h", "chroma_v",
    "has_exif", "has_icc", "has_software", "has_comment", "has_xmp",
    "mean_r", "mean_g", "mean_b", "std_r", "std_g", "std_b",
    "luma_mean", "luma_std", "contrast_range", "noise_lapvar",
    "edge_energy", "saturation_mean", "clipped_fraction", "luma_entropy",
    "b4_spectral", "b5_blockiness", "dct_high_low",
)

GEOMETRY = ("width", "height", "aspect", "b1_log_pixels", "b2_log_bytes", "b3_log_density")
CODEC = (
    "is_jpeg", "is_png", "is_webp", "jpeg_qmean", "jpeg_quality_proxy",
    "chroma_h", "chroma_v", "has_exif", "has_icc", "has_software", "has_comment", "has_xmp",
)
APPEARANCE = (
    "mean_r", "mean_g", "mean_b", "std_r", "std_g", "std_b",
    "luma_mean", "luma_std", "contrast_range", "noise_lapvar",
    "edge_energy", "saturation_mean", "clipped_fraction", "luma_entropy",
)
ALL_NUISANCE = GEOMETRY + CODEC + APPEARANCE + ("b4_spectral", "b5_blockiness")

STRESS_CELLS = (
    "native",
    "jpeg_only",
    "resize_ar",
    "square_pad_crop",
    "resize_jpeg",
    "random_codec",
)

REPO_FREEZE = (
    "models/manifest.json",
    "models/weights/community-forensics-384-int8.onnx",
    "models/calibration/detector.json",
    "models/calibration/fused.json",
    "src/offscreen/preprocess.js",
    "src/offscreen/ort-engine.js",
    "docs/eval-protocol.md",
)

PACK_FREEZE = (
    "scores.csv",
    "splits.json",
    "index.json",
    "labels.json",
    "assignment.txt",
    "score-manifest.csv",
    "degradation-manifest.json",
    "eval-native-max.json",
    "fit-native-max.json",
    "strategy-fit.json",
    "eval-official-center.json",
    "diagnostic-report.md",
)

WIN_CONDITION = {
    "candidate": CANDIDATE,
    "threshold": DECISION_THRESHOLD,
    "evaluation": "blind native-format pack, scored once",
    "rules": [
        "overall BA lower 95% CI bound above 0.75",
        "no catastrophic generator-family slice",
        "cluster-label permutation corpus gate passes for frozen probes B1-B5",
        "paired advantage over the strongest FIT-trained null (CI on BA_model - BA_null excludes 0)",
    ],
    "publish": [
        "confusion counts",
        "per-family BA",
        "real-source slices",
        "confidence intervals",
        "model-minus-null deltas",
    ],
    "excludedFromPrimary": ["native_max", "threshold sweeps", "architecture changes"],
}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


_RUN_LOCK = None


def acquire_run_lock(path: Path) -> None:
    """Keep a process-lifetime exclusive lock so a duplicate interpreter cannot race."""
    global _RUN_LOCK
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    handle.seek(0)
    if handle.read(1) == b"":
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    if sys.platform == "win32":
        import msvcrt

        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            handle.close()
            raise SystemExit(f"another explain_it_away already holds {path}")
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n".encode("ascii"))
    handle.flush()
    _RUN_LOCK = handle


def ensure_cuda_dlls(root: Path) -> list[str]:
    """Put cuBLAS/cuDNN from a local torch install on PATH before ORT session create."""
    added: list[str] = []
    candidates = (
        root / ".venv-generate" / "Lib" / "site-packages" / "torch" / "lib",
        root / ".venv-export" / "Lib" / "site-packages" / "torch" / "lib",
    )
    for folder in candidates:
        if not folder.is_dir():
            continue
        path = str(folder)
        current = os.environ.get("PATH", "")
        if path not in current.split(os.pathsep):
            os.environ["PATH"] = path + os.pathsep + current
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(path)
        added.append(path)
        break
    return added


def git_meta(root: Path) -> dict[str, Any]:
    def run(args: list[str]) -> str:
        result = subprocess.run(args, cwd=root, capture_output=True, text=True, check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    return {
        "codeCommit": run(["git", "rev-parse", "HEAD"]),
        "worktreeDirty": bool(run(["git", "status", "--porcelain"])),
    }


def cluster_of(row: dict[str, Any]) -> str:
    if row.get("cluster_id"):
        return str(row["cluster_id"])
    image_id = str(row["image_id"])
    return image_id.split("--", 1)[0]


def balanced_accuracy(labels: np.ndarray, scores: np.ndarray, threshold: float) -> tuple[float, float, float]:
    positives = labels == 1
    negatives = labels == 0
    if not positives.any() or not negatives.any():
        raise ValueError("need both classes")
    tpr = float(np.mean(scores[positives] >= threshold))
    tnr = float(np.mean(scores[negatives] < threshold))
    return tpr, tnr, 0.5 * (tpr + tnr)


def confusion(labels: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, int]:
    predicted = scores >= threshold
    positives = labels == 1
    return {
        "tp": int(np.sum(predicted & positives)),
        "fn": int(np.sum(~predicted & positives)),
        "tn": int(np.sum(~predicted & ~positives)),
        "fp": int(np.sum(predicted & ~positives)),
    }


def roc_auc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    positives = scores[labels == 1]
    negatives = scores[labels == 0]
    if positives.size == 0 or negatives.size == 0:
        return None
    # Mann–Whitney; ties count as 0.5. Ranking only — no threshold.
    gt = np.sum(positives[:, None] > negatives[None, :])
    eq = np.sum(positives[:, None] == negatives[None, :])
    return float((gt + 0.5 * eq) / (positives.size * negatives.size))


def best_threshold(labels: np.ndarray, scores: np.ndarray) -> tuple[float, float]:
    finite = np.isfinite(scores)
    labels = labels[finite]
    scores = scores[finite]
    if labels.size == 0 or len(set(labels.tolist())) < 2:
        return 0.0, 0.5
    candidates = np.unique(scores)
    if candidates.size > 1:
        candidates = np.concatenate([candidates, (candidates[:-1] + candidates[1:]) / 2.0])
    best_t, best_ba = float(candidates[0]), -1.0
    for value in candidates:
        _, _, ba = balanced_accuracy(labels, scores, float(value))
        if ba > best_ba:
            best_t, best_ba = float(value), ba
    return best_t, best_ba


def two_sided_stump(fit_labels: np.ndarray, fit_scores: np.ndarray) -> dict[str, Any]:
    pos_t, pos_ba = best_threshold(fit_labels, fit_scores)
    neg_t, neg_ba = best_threshold(fit_labels, -fit_scores)
    if neg_ba > pos_ba:
        return {"polarity": -1, "threshold": neg_t, "fitBA": neg_ba}
    return {"polarity": 1, "threshold": pos_t, "fitBA": pos_ba}


def apply_stump(scores: np.ndarray, spec: dict[str, Any]) -> np.ndarray:
    oriented = spec["polarity"] * scores
    return (oriented >= spec["threshold"]).astype(np.float64)


def clustered_bootstrap(
    clusters_by_class: dict[int, list[str]],
    members: dict[str, list[int]],
    statistic: Callable[[np.ndarray], float],
    *,
    samples: int,
    seed: int,
) -> tuple[float, float, int]:
    rng = np.random.Generator(np.random.PCG64(seed))
    discarded = 0
    consecutive = 0
    values = np.empty(samples, dtype=np.float64)
    index = 0
    while index < samples:
        chosen: list[int] = []
        empty = False
        for label in (0, 1):
            names = clusters_by_class[label]
            if not names:
                empty = True
                break
            draws = rng.choice(np.asarray(names, dtype=object), size=len(names), replace=True)
            for name in draws:
                chosen.extend(members[str(name)])
        if empty or not chosen:
            discarded += 1
            consecutive += 1
            if consecutive > 100:
                raise RuntimeError("bootstrap aborted: too many empty-class redraws")
            continue
        consecutive = 0
        values[index] = statistic(np.asarray(chosen, dtype=np.int64))
        index += 1
    return float(np.quantile(values, 0.025)), float(np.quantile(values, 0.975)), discarded


def cluster_maps(rows: Sequence[dict[str, Any]]) -> tuple[dict[int, list[str]], dict[str, list[int]]]:
    labels: dict[str, set[int]] = defaultdict(set)
    members: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        name = cluster_of(row)
        labels[name].add(int(row["label"]))
        members[name].append(index)
    conflicts = [name for name, values in labels.items() if len(values) != 1]
    if conflicts:
        raise ValueError(f"cluster label conflict: {conflicts[:5]}")
    by_class = {
        0: sorted(name for name, values in labels.items() if next(iter(values)) == 0),
        1: sorted(name for name, values in labels.items() if next(iter(values)) == 1),
    }
    return by_class, members


def finite_column(rows: Sequence[dict[str, Any]], key: str) -> tuple[np.ndarray, np.ndarray, list[int]]:
    labels: list[int] = []
    values: list[float] = []
    keep: list[int] = []
    for index, row in enumerate(rows):
        value = row.get(key)
        if value is None:
            continue
        number = float(value)
        if not math.isfinite(number):
            continue
        labels.append(int(row["label"]))
        values.append(number)
        keep.append(index)
    return np.asarray(labels, dtype=np.int8), np.asarray(values, dtype=np.float64), keep


def as_float(value: Any) -> float:
    if value is None:
        return float("nan")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return number if math.isfinite(number) else float("nan")


def matrix_impute(
    rows: Sequence[dict[str, Any]],
    keys: Sequence[str],
    medians: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, list[int], np.ndarray]:
    raw = np.asarray(
        [[as_float(row.get(key)) for key in keys] for row in rows],
        dtype=np.float64,
    )
    labels = np.asarray([int(row["label"]) for row in rows], dtype=np.int8)
    if medians is None:
        with np.errstate(all="ignore"):
            medians = np.nanmedian(raw, axis=0)
        medians = np.where(np.isfinite(medians), medians, 0.0)
    filled = np.where(np.isfinite(raw), raw, medians)
    return filled, labels, list(range(len(rows))), medians


def fit_logistic(x: np.ndarray, y: np.ndarray) -> Any | None:
    if x.shape[0] < 8 or len(set(y.tolist())) < 2:
        return None
    if np.nanstd(x, axis=0).sum() == 0:
        return None
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            max_iter=4000,
            C=1.0,
            class_weight="balanced",
            random_state=PROTOCOL_SEED,
        ),
    )
    try:
        model.fit(x, y)
    except ValueError:
        return None
    return model


def logistic_scores(model: Any, x: np.ndarray) -> np.ndarray:
    return model.predict_proba(x)[:, 1]


def fit_pixels32(train: Sequence[dict[str, Any]], test: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    x_train = np.stack([ensure_pixels32(row) for row in train])
    y_train = np.asarray([int(row["label"]) for row in train], dtype=np.int8)
    model = fit_logistic(x_train, y_train)
    if model is None:
        return None
    train_scores = logistic_scores(model, x_train)
    stump = two_sided_stump(y_train, train_scores)
    # Probability already oriented toward AI; force polarity +1 on the probability.
    stump = {"polarity": 1, "threshold": best_threshold(y_train, train_scores)[0], "fitBA": best_threshold(y_train, train_scores)[1]}
    x_test = np.stack([ensure_pixels32(row) for row in test])
    test_scores = logistic_scores(model, x_test)
    return {"stump": stump, "train_scores": train_scores, "test_scores": test_scores}


def fit_tiny_cnn(train: Sequence[dict[str, Any]], test: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    if len(train) < 32 or len(test) < 8:
        return None
    try:
        import torch
        import torch.nn as nn
    except ImportError:
        return None

    class TinyCNN(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.net = nn.Sequential(
                nn.Conv2d(3, 8, 3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),
                nn.Conv2d(8, 16, 3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),
                nn.Flatten(),
                nn.Linear(16 * 8 * 8, 1),
            )

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return self.net(x).squeeze(1)

    torch.manual_seed(PROTOCOL_SEED)
    np.random.seed(PROTOCOL_SEED)
    device = torch.device("cpu")
    net = TinyCNN().to(device)
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-3)
    loss_fn = nn.BCEWithLogitsLoss()
    x = np.stack([ensure_pixels32(row).reshape(32, 32, 3).transpose(2, 0, 1) for row in train])
    y = np.asarray([int(row["label"]) for row in train], dtype=np.float32)
    tensor_x = torch.from_numpy(x).to(device)
    tensor_y = torch.from_numpy(y).to(device)
    net.train()
    for _ in range(25):
        optimizer.zero_grad()
        logits = net(tensor_x)
        loss = loss_fn(logits, tensor_y)
        loss.backward()
        optimizer.step()
    net.eval()
    with torch.no_grad():
        train_scores = torch.sigmoid(net(tensor_x)).cpu().numpy().astype(np.float64)
        x_test = np.stack([ensure_pixels32(row).reshape(32, 32, 3).transpose(2, 0, 1) for row in test])
        test_scores = torch.sigmoid(net(torch.from_numpy(x_test).to(device))).cpu().numpy().astype(np.float64)
    y_train = np.asarray([int(row["label"]) for row in train], dtype=np.int8)
    threshold, fit_ba = best_threshold(y_train, train_scores)
    return {
        "stump": {"polarity": 1, "threshold": threshold, "fitBA": fit_ba},
        "train_scores": train_scores,
        "test_scores": test_scores,
    }


def load_score_rows(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    if not rows:
        raise ValueError(f"{path} has no rows")
    for row in rows:
        row["label"] = int(row["label"])
        row["cluster_id"] = cluster_of(row)
        row[SCORE_COLUMN] = float(row[SCORE_COLUMN])
        if EXPLORATORY_COLUMN in row and row[EXPLORATORY_COLUMN] != "":
            row[EXPLORATORY_COLUMN] = float(row[EXPLORATORY_COLUMN])
    return rows


def _load_feature_cache(cache_path: Path) -> dict[str, dict[str, Any]]:
    cache: dict[str, dict[str, Any]] = {}
    jsonl = cache_path.with_suffix(".jsonl")
    if jsonl.is_file():
        with jsonl.open("r", encoding="utf-8") as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                cache[record["path"]] = record["features"]
    if cache_path.is_file():
        cache.update(json.loads(cache_path.read_text(encoding="utf-8")))
    return cache


def _append_feature_cache(cache_path: Path, key: str, features: dict[str, Any]) -> None:
    jsonl = cache_path.with_suffix(".jsonl")
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    with jsonl.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps({"path": key, "features": features}, separators=(",", ":")) + "\n")


def _apply_cached_features(row: dict[str, Any], cached: dict[str, Any], image_path: Path) -> None:
    row.update({k: v for k, v in cached.items() if not k.startswith("_")})
    fft_bands = cached.get("_fft_bands")
    dct_bands = cached.get("_dct_bands")
    if fft_bands:
        for band_index, value in enumerate(fft_bands):
            row[f"fft_band_{band_index}"] = value
    if dct_bands:
        for band_index, value in enumerate(dct_bands[:-1]):
            row[f"dct_band_{band_index}"] = value
        row["dct_high_low"] = dct_bands[-1]
    row["_pixels32"] = None
    row["_image_path"] = str(image_path)


def ensure_pixels32(row: dict[str, Any]) -> np.ndarray:
    existing = row.get("_pixels32")
    if existing is not None:
        return np.asarray(existing, dtype=np.float32)
    pixels = pixels32(load_rgb(Path(row["_image_path"]))[0])
    row["_pixels32"] = pixels
    return pixels


def attach_features(rows: list[dict[str, Any]], root: Path, cache_path: Path) -> list[dict[str, Any]]:
    cache = _load_feature_cache(cache_path)
    for index, row in enumerate(rows, start=1):
        image_path = Path(row["path"])
        if not image_path.is_absolute():
            image_path = root / image_path
        key = str(image_path.as_posix())
        cached = cache.get(key)
        if cached is None:
            if index == 1 or index % 25 == 0 or index == len(rows):
                print(f"features [{index}/{len(rows)}] {row['image_id']}", flush=True)
            extracted = extract_features(image_path)
            stored = {
                k: (v.tolist() if isinstance(v, np.ndarray) else v)
                for k, v in extracted.items()
                if k != "_pixels32"
            }
            cache[key] = stored
            cached = stored
            _append_feature_cache(cache_path, key, stored)
        _apply_cached_features(row, cached, image_path)
    return rows


def summarize_detector(rows: Sequence[dict[str, Any]], column: str, samples: int, seed: int) -> dict[str, Any]:
    labels = np.asarray([int(row["label"]) for row in rows], dtype=np.int8)
    scores = np.asarray([float(row[column]) for row in rows], dtype=np.float64)
    tpr, tnr, ba = balanced_accuracy(labels, scores, DECISION_THRESHOLD)
    by_class, members = cluster_maps(rows)

    def stat(indices: np.ndarray, which: str) -> float:
        tpr_i, tnr_i, ba_i = balanced_accuracy(labels[indices], scores[indices], DECISION_THRESHOLD)
        return {"tpr": tpr_i, "tnr": tnr_i, "ba": ba_i}[which]

    ba_lo, ba_hi, discarded = clustered_bootstrap(
        by_class, members, lambda idx: stat(idx, "ba"), samples=samples, seed=seed
    )
    tpr_lo, tpr_hi, _ = clustered_bootstrap(
        by_class, members, lambda idx: stat(idx, "tpr"), samples=samples, seed=seed + 1
    )
    tnr_lo, tnr_hi, _ = clustered_bootstrap(
        by_class, members, lambda idx: stat(idx, "tnr"), samples=samples, seed=seed + 2
    )
    n_ai = len(by_class[1])
    n_real = len(by_class[0])
    return {
        "images": len(rows),
        "aiImages": int(np.sum(labels == 1)),
        "realImages": int(np.sum(labels == 0)),
        "aiClusters": n_ai,
        "realClusters": n_real,
        "threshold": DECISION_THRESHOLD,
        "truePositiveRate": {"value": tpr, "ci": [tpr_lo, tpr_hi]},
        "trueNegativeRate": {"value": tnr, "ci": [tnr_lo, tnr_hi]},
        "balancedAccuracy": {"value": ba, "ci": [ba_lo, ba_hi]},
        "rocAuc": roc_auc(labels, scores),
        "confusion": confusion(labels, scores, DECISION_THRESHOLD),
        "underpowered": n_ai < POWER_FLOOR or n_real < POWER_FLOOR,
        "discardedReplicates": discarded,
        "bootstrapSamples": samples,
        "seed": seed,
    }


def evaluate_stump(
    eval_rows: Sequence[dict[str, Any]],
    eval_scores: np.ndarray,
    eval_labels: np.ndarray,
    stump: dict[str, Any],
    keep: list[int],
    samples: int,
    seed: int,
) -> dict[str, Any]:
    decisions = apply_stump(eval_scores, stump)
    tpr, tnr, ba = balanced_accuracy(eval_labels, decisions, 0.5)
    subset = [eval_rows[i] for i in keep]
    by_class, members = cluster_maps(subset)
    labels = eval_labels
    scores = decisions

    def ba_of(indices: np.ndarray) -> float:
        return balanced_accuracy(labels[indices], scores[indices], 0.5)[2]

    lo, hi, discarded = clustered_bootstrap(by_class, members, ba_of, samples=samples, seed=seed)
    oriented = stump["polarity"] * eval_scores
    return {
        "n": int(eval_labels.size),
        "nUndefined": len(eval_rows) - int(eval_labels.size),
        "polarity": stump["polarity"],
        "threshold": stump["threshold"],
        "fitBA": stump["fitBA"],
        "fairBA": ba,
        "tpr": tpr,
        "tnr": tnr,
        "rocAuc": roc_auc(eval_labels, oriented),
        "ci": [lo, hi],
        "discardedReplicates": discarded,
        "predictions": decisions,
        "keep": keep,
    }


def oracle_ba(labels: np.ndarray, scores: np.ndarray) -> dict[str, Any]:
    pos_t, pos_ba = best_threshold(labels, scores)
    neg_t, neg_ba = best_threshold(labels, -scores)
    if neg_ba > pos_ba:
        return {"oracleBA": neg_ba, "oraclePolarity": -1, "oracleThreshold": neg_t}
    return {"oracleBA": pos_ba, "oraclePolarity": 1, "oracleThreshold": pos_t}


def _oracle_ba_from_sorted_labels(
    labels: np.ndarray,
    order: np.ndarray,
    group_ends: np.ndarray,
) -> float:
    """Two-sided max-threshold BA with score ordering precomputed.

    For a high-score-positive stump, BA = 0.5 * (1 + TNR - FNR).
    Evaluating the cumulative class fractions at every distinct-score boundary
    gives the exact same maximum as ``best_threshold``. Taking the absolute
    difference also evaluates the opposite polarity. This form makes 10,000
    cluster permutations practical without re-sorting or scanning thresholds
    in Python for every draw.
    """
    ordered = labels[order]
    positives = int(np.sum(ordered == 1))
    negatives = int(ordered.size - positives)
    if positives == 0 or negatives == 0:
        return 0.5
    cumulative_positives = np.cumsum(ordered == 1)[group_ends]
    cumulative_negatives = np.cumsum(ordered == 0)[group_ends]
    separation = cumulative_negatives / negatives - cumulative_positives / positives
    return float(0.5 * (1.0 + np.max(np.abs(separation))))


def permutation_probe_gate(
    eval_rows: Sequence[dict[str, Any]],
    values: np.ndarray,
    keep: list[int],
    observed_oracle_ba: float,
    *,
    samples: int,
    rng: np.random.Generator,
) -> dict[str, Any]:
    """Frozen cluster-label permutation test from docs/eval-protocol.md."""
    subset = [eval_rows[index] for index in keep]
    if len(subset) != values.size:
        raise ValueError("permutation probe rows/values length mismatch")

    labels_by_cluster: dict[str, set[int]] = defaultdict(set)
    for row in subset:
        labels_by_cluster[cluster_of(row)].add(int(row["label"]))
    conflicts = [name for name, labels in labels_by_cluster.items() if len(labels) != 1]
    if conflicts:
        raise ValueError(f"cluster label conflict in permutation probe: {conflicts[:5]}")

    cluster_names = sorted(labels_by_cluster)
    cluster_index = {name: index for index, name in enumerate(cluster_names)}
    cluster_labels = np.asarray(
        [next(iter(labels_by_cluster[name])) for name in cluster_names],
        dtype=np.int8,
    )
    row_clusters = np.asarray(
        [cluster_index[cluster_of(row)] for row in subset],
        dtype=np.int64,
    )
    if len(set(cluster_labels.tolist())) < 2:
        raise ValueError("permutation probe needs clusters from both classes")

    order = np.argsort(values, kind="mergesort")
    ordered_values = values[order]
    group_ends = np.concatenate(
        [np.flatnonzero(ordered_values[1:] != ordered_values[:-1]), [values.size - 1]]
    ).astype(np.int64)
    null_values = np.empty(samples, dtype=np.float64)
    for index in range(samples):
        permuted_cluster_labels = rng.permutation(cluster_labels)
        permuted_row_labels = permuted_cluster_labels[row_clusters]
        null_values[index] = _oracle_ba_from_sorted_labels(permuted_row_labels, order, group_ends)

    null_median = float(np.median(null_values))
    p_value = float((1 + np.sum(null_values >= observed_oracle_ba - 1e-12)) / (1 + samples))
    return {
        "permutations": samples,
        "clusters": len(cluster_names),
        "nullMedian": null_median,
        "pValue": p_value,
        "excess": float(observed_oracle_ba - null_median),
    }


def paired_delta(
    eval_rows: Sequence[dict[str, Any]],
    model_scores: np.ndarray,
    null_decisions: np.ndarray,
    keep: list[int],
    samples: int,
    seed: int,
) -> dict[str, Any]:
    subset = [eval_rows[i] for i in keep]
    labels = np.asarray([int(row["label"]) for row in subset], dtype=np.int8)
    model = model_scores[np.asarray(keep)]
    tpr_m, tnr_m, ba_m = balanced_accuracy(labels, model, DECISION_THRESHOLD)
    tpr_n, tnr_n, ba_n = balanced_accuracy(labels, null_decisions, 0.5)
    model_pred = model >= DECISION_THRESHOLD
    null_pred = null_decisions >= 0.5
    truth = labels == 1
    model_ok = model_pred == truth
    null_ok = null_pred == truth
    by_class, members = cluster_maps(subset)

    def delta(indices: np.ndarray) -> float:
        ba_model = balanced_accuracy(labels[indices], model[indices], DECISION_THRESHOLD)[2]
        ba_null = balanced_accuracy(labels[indices], null_decisions[indices], 0.5)[2]
        return ba_model - ba_null

    lo, hi, discarded = clustered_bootstrap(by_class, members, delta, samples=samples, seed=seed)
    return {
        "modelBA": ba_m,
        "nullBA": ba_n,
        "delta": ba_m - ba_n,
        "ci": [lo, hi],
        "excludesZero": not (lo <= 0.0 <= hi),
        "paired": {
            "bothCorrect": int(np.sum(model_ok & null_ok)),
            "modelOnly": int(np.sum(model_ok & ~null_ok)),
            "nullOnly": int(np.sum(~model_ok & null_ok)),
            "bothWrong": int(np.sum(~model_ok & ~null_ok)),
        },
        "model": {"tpr" : tpr_m, "tnr": tnr_m},
        "null": {"tpr": tpr_n, "tnr": tnr_n},
        "discardedReplicates": discarded,
    }


def freeze_candidate(root: Path, pack: Path, out_dir: Path) -> dict[str, Any]:
    artifacts: dict[str, dict[str, Any]] = {}
    for relative in REPO_FREEZE:
        path = root / relative
        artifacts[relative] = {
            "sha256": sha256_file(path) if path.is_file() else None,
            "bytes": path.stat().st_size if path.is_file() else None,
            "missing": not path.is_file(),
        }
    for relative in PACK_FREEZE:
        path = pack / relative
        artifacts[f"pack/{relative}"] = {
            "sha256": sha256_file(path) if path.is_file() else None,
            "bytes": path.stat().st_size if path.is_file() else None,
            "missing": not path.is_file(),
        }
    model_hash = artifacts["models/weights/community-forensics-384-int8.onnx"]["sha256"]
    freeze = {
        "formatVersion": 1,
        "type": "explain-it-away-freeze",
        "protocolVersion": "explain-it-away-v1",
        "seed": PROTOCOL_SEED,
        "candidate": {
            "aggregation": CANDIDATE,
            "scoreColumn": SCORE_COLUMN,
            "threshold": DECISION_THRESHOLD,
            "checkpoint": "community-forensics-384-int8.onnx",
            "expectedModelSha256": EXPECTED_MODEL_SHA256,
            "observedModelSha256": model_hash,
            "hashMatch": model_hash == EXPECTED_MODEL_SHA256,
        },
        "exploratoryOnly": {
            "aggregation": "native_max",
            "scoreColumn": EXPLORATORY_COLUMN,
            "reason": "non-shipping aggregation; excluded from the primary scorecard",
        },
        "winCondition": WIN_CONDITION,
        "primaryClaimCell": "native",
        "doNotSelectWinningTransform": True,
        **git_meta(root),
        "artifacts": artifacts,
    }
    freeze["freezeSha256"] = canonical_sha256({k: v for k, v in freeze.items() if k != "freezeSha256"})
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "frozen-candidate.json"
    path.write_text(json.dumps(freeze, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "WIN_CONDITION.json").write_text(
        json.dumps(WIN_CONDITION, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return freeze


CANDIDATE_CRITICAL = {
    "models/weights/community-forensics-384-int8.onnx",
    "src/offscreen/preprocess.js",
    "pack/scores.csv",
    "pack/splits.json",
    "pack/assignment.txt",
    "pack/score-manifest.csv",
    "pack/degradation-manifest.json",
    "pack/eval-official-center.json",
    "pack/index.json",
    "pack/labels.json",
}


def verify_freeze(freeze: dict[str, Any], root: Path, pack: Path) -> list[dict[str, str]]:
    drift: list[dict[str, str]] = []
    for relative, meta in freeze["artifacts"].items():
        if meta.get("missing") or not meta.get("sha256"):
            continue
        path = pack / relative.removeprefix("pack/") if relative.startswith("pack/") else root / relative
        actual = sha256_file(path)
        if actual == meta["sha256"]:
            continue
        item = {"path": relative, "frozen": meta["sha256"], "now": actual}
        if relative in CANDIDATE_CRITICAL:
            raise ValueError(f"frozen candidate artifact mutated: {relative}")
        drift.append(item)
    if drift:
        out = pack / "explain-it-away" / "freeze-drift.json"
        out.write_text(json.dumps({"ignoredForNativeMaxSprint": drift}, indent=2) + "\n", encoding="utf-8")
        print("freeze drift (non-candidate): " + ", ".join(item["path"] for item in drift), flush=True)
    return drift


def slice_tables(rows: Sequence[dict[str, Any]], column: str) -> dict[str, Any]:
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_real: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if int(row["label"]) == 1:
            by_family[str(row.get("generator") or row.get("source_key") or "unknown")].append(row)
        else:
            by_real[str(row.get("source_key") or "unknown")].append(row)
    reals = [row for row in rows if int(row["label"]) == 0]
    ais = [row for row in rows if int(row["label"]) == 1]

    def ba_against(positives: Sequence[dict[str, Any]], negatives: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
        if not positives or not negatives:
            return None
        labels = np.asarray([1] * len(positives) + [0] * len(negatives), dtype=np.int8)
        scores = np.asarray(
            [float(row[column]) for row in positives] + [float(row[column]) for row in negatives],
            dtype=np.float64,
        )
        tpr, tnr, ba = balanced_accuracy(labels, scores, DECISION_THRESHOLD)
        return {
            "images": int(labels.size),
            "aiImages": len(positives),
            "realImages": len(negatives),
            "tpr": tpr,
            "tnr": tnr,
            "balancedAccuracy": ba,
            "confusion": confusion(labels, scores, DECISION_THRESHOLD),
        }

    families = {
        name: ba_against(group, reals)
        for name, group in sorted(by_family.items())
    }
    real_slices = {
        name: ba_against(ais, group)
        for name, group in sorted(by_real.items())
        if len(group) >= 1
    }
    return {"perFamily": families, "realSourceSlices": real_slices}


def run_null_shootout(
    rows: list[dict[str, Any]],
    *,
    samples: int,
    seed: int,
    permutation_samples: int = PERMUTATION_SAMPLES,
) -> dict[str, Any]:
    fit_rows = [row for row in rows if row["split"] == "fit"]
    eval_rows = [row for row in rows if row["split"] == "eval"]
    if not fit_rows or not eval_rows:
        raise ValueError("need FIT and eval rows")
    eval_generators = sorted({row.get("generator") for row in eval_rows if int(row["label"]) == 1})
    fit_generators = sorted({row.get("generator") for row in fit_rows if int(row["label"]) == 1})
    if set(eval_generators) & set(fit_generators):
        raise ValueError(f"eval generators leaked into FIT: {set(eval_generators) & set(fit_generators)}")

    detector = summarize_detector(eval_rows, SCORE_COLUMN, samples, seed)
    exploratory = None
    if EXPLORATORY_COLUMN in eval_rows[0]:
        exploratory = summarize_detector(eval_rows, EXPLORATORY_COLUMN, samples, seed + 17)
        exploratory["primary"] = False
        exploratory["note"] = "exploratory-only; excluded from the primary scorecard"

    probes: dict[str, Any] = {}
    permutation_inputs: dict[str, tuple[np.ndarray, list[int]]] = {}
    for name in UNIVARIATE:
        fit_y, fit_x, _ = finite_column(fit_rows, name)
        eval_y, eval_x, keep = finite_column(eval_rows, name)
        if fit_y.size < 8 or eval_y.size < 8 or len(set(fit_y.tolist())) < 2:
            probes[name] = {"skipped": True, "reason": "insufficient finite values"}
            continue
        stump = two_sided_stump(fit_y, fit_x)
        result = evaluate_stump(eval_rows, eval_x, eval_y, stump, keep, samples, seed)
        result.update(oracle_ba(eval_y, eval_x))
        result.pop("predictions")
        probes[name] = result
        if name in PERMUTATION_GATE_PROBES:
            permutation_inputs[name] = (eval_x, keep)

    def pack_logistic(keys: Sequence[str], pack_name: str) -> dict[str, Any]:
        x_fit, y_fit, _, medians = matrix_impute(fit_rows, keys)
        x_eval, y_eval, keep, _ = matrix_impute(eval_rows, keys, medians)
        model = fit_logistic(x_fit, y_fit)
        if model is None:
            return {"id": pack_name, "skipped": True}
        train_scores = logistic_scores(model, x_fit)
        test_scores = logistic_scores(model, x_eval)
        threshold, fit_ba = best_threshold(y_fit, train_scores)
        stump = {"polarity": 1, "threshold": threshold, "fitBA": fit_ba}
        result = evaluate_stump(eval_rows, test_scores, y_eval, stump, keep, samples, seed)
        result.update(oracle_ba(y_eval, test_scores))
        result["id"] = pack_name
        result["keys"] = list(keys)
        result["_eval_scores"] = test_scores
        result["_keep"] = keep
        return result

    fft_keys = [f"fft_band_{i}" for i in range(len(FFT_BAND_EDGES) - 1)]
    dct_keys = [f"dct_band_{i}" for i in range(len(DCT_BAND_EDGES) - 1)] + ["dct_high_low"]
    multivariate = {
        "geometry": pack_logistic(GEOMETRY, "geometry"),
        "codec": pack_logistic(CODEC, "codec"),
        "appearance": pack_logistic(APPEARANCE, "appearance"),
        "fft_bands": pack_logistic(fft_keys, "fft_bands"),
        "dct_bands": pack_logistic(dct_keys, "dct_bands"),
        "all_nuisance": pack_logistic(ALL_NUISANCE + tuple(fft_keys) + tuple(dct_keys), "all_nuisance"),
    }

    pixels = fit_pixels32(fit_rows, eval_rows)
    if pixels is not None:
        keep = list(range(len(eval_rows)))
        y_eval = np.asarray([int(row["label"]) for row in eval_rows], dtype=np.int8)
        result = evaluate_stump(eval_rows, pixels["test_scores"], y_eval, pixels["stump"], keep, samples, seed)
        result.update(oracle_ba(y_eval, pixels["test_scores"]))
        result["id"] = "pixels32_linear"
        result["_eval_scores"] = pixels["test_scores"]
        result["_keep"] = keep
        multivariate["pixels32_linear"] = result
    else:
        multivariate["pixels32_linear"] = {"id": "pixels32_linear", "skipped": True}

    cnn = fit_tiny_cnn(fit_rows, eval_rows)
    if cnn is not None:
        keep = list(range(len(eval_rows)))
        y_eval = np.asarray([int(row["label"]) for row in eval_rows], dtype=np.int8)
        result = evaluate_stump(eval_rows, cnn["test_scores"], y_eval, cnn["stump"], keep, samples, seed)
        result.update(oracle_ba(y_eval, cnn["test_scores"]))
        result["id"] = "tiny_cnn_32"
        result["_eval_scores"] = cnn["test_scores"]
        result["_keep"] = keep
        multivariate["tiny_cnn_32"] = result
    else:
        multivariate["tiny_cnn_32"] = {"id": "tiny_cnn_32", "skipped": True, "reason": "torch unavailable"}

    rng = np.random.Generator(np.random.PCG64(seed))
    shuffled = [dict(row) for row in fit_rows]
    by_cluster: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in shuffled:
        by_cluster[cluster_of(row)].append(row)
    cluster_names = list(by_cluster)
    cluster_labels = np.asarray([int(by_cluster[name][0]["label"]) for name in cluster_names])
    rng.shuffle(cluster_labels)
    for name, label in zip(cluster_names, cluster_labels, strict=True):
        for row in by_cluster[name]:
            row["label"] = int(label)
    x_fit, y_fit, _, medians = matrix_impute(shuffled, ALL_NUISANCE + tuple(fft_keys) + tuple(dct_keys))
    x_eval, y_eval, keep, _ = matrix_impute(eval_rows, ALL_NUISANCE + tuple(fft_keys) + tuple(dct_keys), medians)
    shuffled_model = fit_logistic(x_fit, y_fit)
    if shuffled_model is not None:
        test_scores = logistic_scores(shuffled_model, x_eval)
        train_scores = logistic_scores(shuffled_model, x_fit)
        threshold, fit_ba = best_threshold(y_fit, train_scores)
        stump = {"polarity": 1, "threshold": threshold, "fitBA": fit_ba}
        result = evaluate_stump(eval_rows, test_scores, y_eval, stump, keep, samples, seed)
        result["id"] = "shuffled_label_all_nuisance"
        result["_eval_scores"] = test_scores
        result["_keep"] = keep
        result.pop("predictions", None)
        multivariate["shuffled_label_all_nuisance"] = result
    else:
        multivariate["shuffled_label_all_nuisance"] = {"id": "shuffled_label_all_nuisance", "skipped": True}

    def fair_ba(entry: dict[str, Any]) -> float:
        if entry.get("skipped"):
            return -1.0
        return float(entry.get("fairBA", -1.0))

    scored_nulls = [(name, entry) for name, entry in {**probes, **multivariate}.items() if not entry.get("skipped")]
    best_name, best_entry = max(scored_nulls, key=lambda item: fair_ba(item[1]))
    model_scores = np.asarray([float(row[SCORE_COLUMN]) for row in eval_rows], dtype=np.float64)
    if "_eval_scores" in best_entry:
        delta = paired_delta(
            eval_rows,
            model_scores,
            apply_stump(best_entry["_eval_scores"], {"polarity": 1, "threshold": best_entry["threshold"]}),
            best_entry["_keep"],
            samples,
            seed + 9,
        )
    else:
        labels, values, keep = finite_column(eval_rows, best_name)
        delta = paired_delta(
            eval_rows,
            model_scores,
            apply_stump(values, {"polarity": best_entry["polarity"], "threshold": best_entry["threshold"]}),
            keep,
            samples,
            seed + 9,
        )

    oracle_values = [float(entry["oracleBA"]) for _, entry in scored_nulls if "oracleBA" in entry]
    max_oracle = max(oracle_values) if oracle_values else 0.5
    permutation_rng = np.random.Generator(np.random.PCG64(seed))
    multiplicity = len(PERMUTATION_GATE_PROBES)
    gate_probes: list[dict[str, Any]] = []
    for name in PERMUTATION_GATE_PROBES:
        entry = probes.get(name, {"skipped": True, "reason": "probe absent"})
        if entry.get("skipped") or name not in permutation_inputs:
            gate_probes.append({
                "id": name,
                "status": "invalid",
                "reason": entry.get("reason", "probe skipped"),
            })
            continue
        values, keep = permutation_inputs[name]
        gate = permutation_probe_gate(
            eval_rows,
            values,
            keep,
            float(entry["oracleBA"]),
            samples=permutation_samples,
            rng=permutation_rng,
        )
        corrected = min(1.0, gate["pValue"] * multiplicity)
        if corrected < 0.01 and gate["excess"] >= 0.10:
            status = "fail"
        elif corrected < 0.05:
            status = "warn"
        else:
            status = "pass"
        gate.update({
            "id": name,
            "observedOracleBA": float(entry["oracleBA"]),
            "correctedPValue": corrected,
            "status": status,
        })
        entry["permutationGate"] = dict(gate)
        gate_probes.append(gate)

    statuses = {entry["status"] for entry in gate_probes}
    if "fail" in statuses or "invalid" in statuses:
        corpus_gate = "fail"
    elif "warn" in statuses:
        corpus_gate = "warn"
    else:
        corpus_gate = "pass"

    def public(entry: dict[str, Any]) -> dict[str, Any]:
        skip = {"predictions", "keep"}
        return {k: v for k, v in entry.items() if not k.startswith("_") and k not in skip}

    return {
        "fitGenerators": fit_generators,
        "evalGenerators": eval_generators,
        "fitImages": len(fit_rows),
        "evalImages": len(eval_rows),
        "detector": detector,
        "exploratoryOfficialCenter": exploratory,
        "univariate": {name: public(entry) for name, entry in probes.items()},
        "multivariate": {name: public(entry) for name, entry in multivariate.items()},
        "bestNull": {"id": best_name, **public(best_entry)},
        "detectorMinusBestNull": delta,
        "corpusGate": {
            "status": corpus_gate,
            "maxOracleBA": max_oracle,
            "permutationSamples": permutation_samples,
            "multiplicity": {"method": "Bonferroni", "probes": multiplicity},
            "rule": (
                "FAIL if any Bonferroni-corrected p < 0.01 and oracleBA-nullMedian >= 0.10; "
                "WARN if any corrected p < 0.05; otherwise pass"
            ),
            "probes": gate_probes,
        },
        "slices": slice_tables(eval_rows, SCORE_COLUMN),
        "noPassBecause": [item for item in [
            "underpowered" if detector["underpowered"] else None,
            "detector BA lower CI <= 0.75"
            if detector["balancedAccuracy"]["ci"][0] <= 0.75 else None,
            "corpusGate=" + corpus_gate if corpus_gate != "pass" else None,
            "detector-minus-best-null CI includes zero"
            if not delta["excludesZero"] else None,
            "not native-format" if any(row.get("degradation") != "native" for row in eval_rows) else None,
        ] if item],
    }


def decode_rgb(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
            rgba = image.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, MEAN_FILL)
            canvas.paste(rgba, mask=rgba.split()[-1])
            return canvas
        return image.convert("RGB")


def encode_jpeg(image: Image.Image, quality: int, subsampling: int = 2) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality, subsampling=subsampling)
    return buffer.getvalue()


def encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def encode_webp(image: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="WEBP", quality=quality)
    return buffer.getvalue()


def resize_long_edge(image: Image.Image, target: int) -> Image.Image:
    width, height = image.size
    if max(width, height) <= target:
        return image
    scale = target / max(width, height)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def cover_square(image: Image.Image, size: int) -> Image.Image:
    scale = max(size / image.width, size / image.height)
    resized = image.resize(
        (max(1, math.ceil(image.width * scale)), max(1, math.ceil(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - size) // 2)
    top = max(0, (resized.height - size) // 2)
    return resized.crop((left, top, left + size, top + size))


def random_codec_choice(source: Path) -> tuple[str, int]:
    digest = hashlib.sha256(f"{source.as_posix()}|random_codec|{PROTOCOL_SEED}".encode("utf-8")).digest()
    quality = 70 + digest[1] % 26
    codec = "jpeg" if digest[0] < 128 else "webp"
    return codec, quality


def stress_destination(out_dir: Path, cell: str, record: dict[str, Any], source: Path) -> Path:
    relative = Path(record["path"])
    if cell == "native":
        return source
    if cell in {"jpeg_only", "resize_jpeg"}:
        return out_dir / "stress" / cell / relative.with_suffix(".jpg")
    if cell in {"resize_ar", "square_pad_crop"}:
        return out_dir / "stress" / cell / relative.with_suffix(".png")
    if cell == "random_codec":
        codec, _ = random_codec_choice(source)
        suffix = ".jpg" if codec == "jpeg" else ".webp"
        return out_dir / "stress" / cell / relative.with_suffix(suffix)
    raise ValueError(cell)


def apply_stress(cell: str, source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file():
        return
    if cell == "native":
        dest.write_bytes(source.read_bytes())
        return
    image = decode_rgb(source)
    if cell == "jpeg_only":
        dest.write_bytes(encode_jpeg(image, 85, 2))
        return
    if cell == "resize_ar":
        dest.write_bytes(encode_png(resize_long_edge(image, 768)))
        return
    if cell == "square_pad_crop":
        dest.write_bytes(encode_png(cover_square(image, 1024)))
        return
    if cell == "resize_jpeg":
        dest.write_bytes(encode_jpeg(resize_long_edge(image, 768), 85, 2))
        return
    if cell == "random_codec":
        codec, quality = random_codec_choice(source)
        if codec == "jpeg":
            dest.write_bytes(encode_jpeg(image, quality, 2))
        else:
            dest.write_bytes(encode_webp(image, quality))
        return
    raise ValueError(cell)


def iter_split_sources(splits: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for split_name, records in splits["splits"].items():
        for record in records:
            yield {**record, "split": split_name}


def build_stress_rows(
    pack: Path,
    out_dir: Path,
    *,
    source_root: Path | None = None,
    cells: Sequence[str] = STRESS_CELLS,
) -> dict[str, list[dict[str, Any]]]:
    splits = json.loads((pack / "splits.json").read_text(encoding="utf-8"))
    scored = load_score_rows(pack / "scores.csv")
    # The degraded pack's cluster_id is the hash of its label-blind,
    # source-matched intermediate. Native inputs use the original-source hash,
    # so join the two representations by the immutable pre-degradation image id
    # instead of comparing those intentionally different hashes.
    surviving_image_ids = {str(row["image_id"]).split("--", 1)[0] for row in scored}
    in_root = source_root or pack / "in"
    selected = tuple(cells)
    unknown = set(selected) - set(STRESS_CELLS)
    if unknown:
        raise ValueError(f"unknown stress cells: {sorted(unknown)}")
    by_cell: dict[str, list[dict[str, Any]]] = {cell: [] for cell in selected}
    for record in iter_split_sources(splits):
        if record["split"] == "calibration":
            continue
        if str(record["image_id"]) not in surviving_image_ids:
            continue
        cluster = str(record.get("sha256") or record["image_id"])
        short = cluster[:16]
        source = in_root / record["path"]
        if not source.is_file():
            continue
        for cell in selected:
            dest = stress_destination(out_dir, cell, record, source)
            apply_stress(cell, source, dest)
            by_cell[cell].append({
                "image_id": f"{short}--{cell}",
                "path": str(dest),
                "image_sha256": str(record.get("sha256") or ""),
                "label": int(record["label"]),
                "generator": record.get("group") if int(record["label"]) == 1 else "real",
                "split": record["split"],
                "source_key": record.get("source_key") or record.get("group"),
                "cluster_id": short,
                "degradation": cell,
            })
    return by_cell


def score_stress_cell(
    rows: list[dict[str, Any]],
    model_path: Path,
    calibration_path: Path,
    out_csv: Path,
    providers: list[str],
) -> list[dict[str, Any]]:
    from score_dataset import score_image, sha256_file as model_sha

    existing: dict[str, dict[str, Any]] = {}
    if out_csv.is_file():
        with out_csv.open("r", encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                existing[row["image_id"]] = row
    fields = [
        "image_id", "path", "image_sha256", "label", "generator", "split", "source_key",
        "cluster_id", "degradation", RAW_SCORE_COLUMN, SCORE_COLUMN, "score", "model_sha256",
    ]
    pending = [
        row for row in rows
        if not (existing.get(row["image_id"]) or {}).get(SCORE_COLUMN)
        or not (existing.get(row["image_id"]) or {}).get(RAW_SCORE_COLUMN)
    ]
    if not pending:
        print(f"skip scoring {out_csv.name}: {len(rows)} cached", flush=True)
        output_rows: list[dict[str, Any]] = []
        for row in rows:
            merged = {**row, **existing[row["image_id"]]}
            merged["label"] = int(merged["label"])
            merged[SCORE_COLUMN] = float(merged[SCORE_COLUMN])
            output_rows.append(merged)
        return output_rows
    import onnxruntime as ort
    requested = [item.strip() for item in providers if item.strip()]
    available = ort.get_available_providers()
    chosen = [item for item in requested if item in available]
    if not chosen:
        raise ValueError(f"no ORT provider from {requested}; have {available}")
    session_providers: list[str | tuple[str, dict[str, object]]] = []
    for item in chosen:
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
    session = ort.InferenceSession(str(model_path), providers=session_providers)
    active = session.get_providers()
    print(f"scoring {out_csv.name}: {len(pending)} new / {len(rows)} total via {active}", flush=True)
    if "CUDAExecutionProvider" in requested and "CUDAExecutionProvider" not in active:
        raise RuntimeError(
            "CUDAExecutionProvider was requested but ORT fell back to "
            f"{active}. Put cuBLAS on PATH (torch/lib) and retry."
        )
    model_hash = model_sha(model_path)
    curve = json.loads(calibration_path.read_text(encoding="utf-8"))
    if (
        curve.get("modelSha256") != model_hash
        or curve.get("inputScoreColumn") != RAW_SCORE_COLUMN
        or curve.get("runtimePreprocessing") != "official-center-resize440-crop384"
        or curve.get("runtimeAggregation") != "single-crop"
    ):
        raise ValueError("native-battery calibration curve does not match the frozen model/runtime path")
    curve_xs = np.asarray(curve["xs"], dtype=np.float64)
    curve_ys = np.asarray(curve["ys"], dtype=np.float64)
    output_rows = []
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    dirty = 0

    def flush_csv() -> None:
        with out_csv.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for item in output_rows:
                writer.writerow({
                    **item,
                    "label": int(item["label"]),
                    SCORE_COLUMN: f"{float(item[SCORE_COLUMN]):.10f}",
                    "score": f"{float(item[SCORE_COLUMN]):.10f}",
                })

    for index, row in enumerate(rows, start=1):
        cached = existing.get(row["image_id"])
        if cached and cached.get(SCORE_COLUMN) and cached.get(RAW_SCORE_COLUMN):
            merged = {**row, **cached}
            merged["label"] = int(merged["label"])
            merged[SCORE_COLUMN] = float(merged[SCORE_COLUMN])
            output_rows.append(merged)
            continue
        image_path = Path(row["path"])
        actual_image_hash = sha256_file(image_path)
        declared_image_hash = str(row.get("image_sha256") or "").lower()
        if declared_image_hash and declared_image_hash != actual_image_hash:
            raise ValueError(f"native input hash mismatch for {row['image_id']}")
        strategies = score_image(session, image_path)
        raw_score = float(strategies[CANDIDATE])
        calibrated_score = float(np.interp(raw_score, curve_xs, curve_ys))
        output_rows.append({
            **row,
            "image_sha256": actual_image_hash,
            RAW_SCORE_COLUMN: raw_score,
            SCORE_COLUMN: calibrated_score,
            "score": calibrated_score,
            "model_sha256": model_hash,
        })
        dirty += 1
        print(
            f"[{index}/{len(rows)}] {row['image_id']}: "
            f"{CANDIDATE}={raw_score:.6f} calibrated={calibrated_score:.6f}",
            flush=True,
        )
        if dirty % 10 == 0:
            flush_csv()
    flush_csv()
    return output_rows


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")


def bind_shootout_evidence(
    shootout: dict[str, Any],
    rows: Sequence[dict[str, Any]],
    *,
    freeze: dict[str, Any],
    scores_path: Path,
    splits_path: Path,
    calibration_path: Path,
    seed: int,
) -> None:
    """Attach the immutable evidence chain required by the frozen protocol."""
    curve = json.loads(calibration_path.read_text(encoding="utf-8"))
    corpus_members = sorted(
        (
            str(row.get("image_sha256") or ""),
            int(row["label"]),
            cluster_of(row),
            str(row["split"]),
        )
        for row in rows
    )
    config = {
        "protocolVersion": "explain-it-away-v2-permutation",
        "seed": seed,
        "threshold": DECISION_THRESHOLD,
        "bootstrapSamples": shootout["detector"]["bootstrapSamples"],
        "permutationSamples": shootout["corpusGate"]["permutationSamples"],
        "permutationProbes": list(PERMUTATION_GATE_PROBES),
        "multiplicity": "Bonferroni",
        "scorePath": "official-center-resize440-crop384/single-crop/fused-calibration",
    }
    model_hashes = sorted({str(row.get("model_sha256") or "") for row in rows} - {""})
    native_format = all(str(row.get("degradation")) == "native" for row in rows)
    shootout.update({
        "formatVersion": 2,
        "type": "native-format-nuisance-battery" if native_format else "nuisance-battery",
        "protocolVersion": config["protocolVersion"],
        "status": "pass" if not shootout.get("noPassBecause") else "fail",
        "configSha256": canonical_sha256(config),
        "corpusHash": canonical_sha256(corpus_members),
        "splitsHash": sha256_file(splits_path),
        "scoreRowsSha256": sha256_file(scores_path),
        "modelSha256": model_hashes[0] if len(model_hashes) == 1 else model_hashes,
        "calibrationCurve": {
            "path": "models/calibration/fused.json",
            "sha256": sha256_file(calibration_path),
            "id": curve.get("id"),
            "fittedOn": curve.get("fittedOn"),
            "scorePath": config["scorePath"],
        },
        "freezeSha256": freeze["freezeSha256"],
        "codeCommit": freeze.get("codeCommit"),
        "worktreeDirty": freeze.get("worktreeDirty"),
        "resolvedConfig": config,
    })


def render_report(freeze: dict[str, Any], shootout: dict[str, Any], grid: dict[str, Any] | None) -> str:
    det = shootout["detector"]
    best = shootout["bestNull"]
    delta = shootout["detectorMinusBestNull"]
    lines = [
        "# Explain-it-away sprint",
        "",
        "Frozen candidate: **official_center @ 0.65**, Community Forensics INT8, no threshold sweep.",
        "Scores use the shipped fused calibration curve; `native_max` is excluded from the primary scorecard.",
        "",
        "## Predeclared win condition",
        "",
        "- Frozen official_center @ 0.65, evaluated once on a blind native-format pack",
        "- Overall BA lower 95% CI bound above 0.75",
        "- No catastrophic generator-family slice",
        "- Frozen B1-B5 cluster-label permutation gate passes",
        "- Clear paired advantage over the strongest FIT-trained null",
        "",
        "## Primary nuisance battery",
        "",
        f"- Detector BA @ 0.65: **{det['balancedAccuracy']['value']:.4f}** "
        f"95% CI [{det['balancedAccuracy']['ci'][0]:.4f}, {det['balancedAccuracy']['ci'][1]:.4f}]",
        f"- TPR {det['truePositiveRate']['value']:.4f} / TNR {det['trueNegativeRate']['value']:.4f}",
        f"- Confusion TP={det['confusion']['tp']} FN={det['confusion']['fn']} "
        f"TN={det['confusion']['tn']} FP={det['confusion']['fp']}",
        f"- Clusters: {det['aiClusters']} AI / {det['realClusters']} real; underpowered={det['underpowered']}",
        f"- Best FIT-trained null: **{best['id']}** fair BA {best.get('fairBA', float('nan')):.4f}",
        f"- Model - best null: **{delta['delta']:+.4f}** 95% CI [{delta['ci'][0]:+.4f}, {delta['ci'][1]:+.4f}] "
        f"(excludes zero: {delta['excludesZero']})",
        f"- Paired: both correct {delta['paired']['bothCorrect']}, model only {delta['paired']['modelOnly']}, "
        f"null only {delta['paired']['nullOnly']}, both wrong {delta['paired']['bothWrong']}",
        f"- Corpus gate: **{shootout['corpusGate']['status']}** (max oracle BA {shootout['corpusGate']['maxOracleBA']:.4f})",
        f"- No PASS because: {', '.join(shootout.get('noPassBecause') or ['n/a'])}",
        "",
    ]
    if shootout.get("exploratoryOfficialCenter"):
        center = shootout["exploratoryOfficialCenter"]
        lines += [
            "## Exploratory only (not primary)",
            "",
            f"- native_max BA @ 0.65: {center['balancedAccuracy']['value']:.4f} "
            f"(TPR {center['truePositiveRate']['value']:.4f}, TNR {center['trueNegativeRate']['value']:.4f})",
            "",
        ]
    lines += [
        "## Frozen permutation gate (B1-B5)",
        "",
        "| probe | oracle BA | null median | excess | corrected p | verdict |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for probe in shootout["corpusGate"].get("probes", []):
        if probe.get("status") == "invalid":
            lines.append(f"| {probe['id']} | — | — | — | — | invalid |")
        else:
            lines.append(
                f"| {probe['id']} | {probe['observedOracleBA']:.4f} | {probe['nullMedian']:.4f} | "
                f"{probe['excess']:+.4f} | {probe['correctedPValue']:.6f} | {probe['status']} |"
            )
    lines += [""]
    lines += ["## Null shootout (FIT -> Kandinsky eval)", "", "| null | fair BA | oracle BA | AUC | polarity |", "| --- | ---: | ---: | ---: | ---: |"]
    combined = {**shootout["univariate"], **shootout["multivariate"]}
    ranked = sorted(
        ((name, entry) for name, entry in combined.items() if not entry.get("skipped")),
        key=lambda item: -float(item[1].get("fairBA", -1)),
    )
    for name, entry in ranked:
        lines.append(
            f"| {name} | {entry.get('fairBA', float('nan')):.4f} | "
            f"{entry.get('oracleBA', float('nan')):.4f} | {entry.get('rocAuc', float('nan')):.4f} | "
            f"{entry.get('polarity', '')} |"
        )
    if grid:
        lines += ["", "## Representation stress grid", "",
                  "Every transform is applied identically to both classes. "
                  "Primary claim cell is **native**. Do not pick the winning transform.",
                  "",
                  "| cell | detector BA | best null | best-null id | delta | delta CI |",
                  "| --- | ---: | ---: | --- | ---: | --- |"]
        for cell in grid["selectedCells"]:
            item = grid["cells"][cell]
            det_ba = item["detector"]["balancedAccuracy"]["value"]
            null_ba = item["bestNull"].get("fairBA", float("nan"))
            delta_i = item["detectorMinusBestNull"]
            marker = " <- primary" if cell == "native" else ""
            lines.append(
                f"| {cell}{marker} | {det_ba:.4f} | {null_ba:.4f} | {item['bestNull']['id']} | "
                f"{delta_i['delta']:+.4f} | [{delta_i['ci'][0]:+.4f}, {delta_i['ci'][1]:+.4f}] |"
            )
        lines += [
            "",
            (
                f"Worst realistic detector BA cell: **{grid['worstRealisticCell']}** "
                f"({grid['cells'][grid['worstRealisticCell']]['detector']['balancedAccuracy']['value']:.4f})."
                if grid.get("worstRealisticCell")
                else "Only the frozen native cell was requested in this run."
            ),
        ]
    lines += [
        "",
        "## What not to do next",
        "",
        "Do not tune the 0.65 threshold, substitute native_max, add the held-out generator to FIT, or change architecture.",
        "",
        f"Freeze SHA-256: `{freeze['freezeSha256']}`",
        f"Commit: `{freeze.get('codeCommit', '')}` dirty={freeze.get('worktreeDirty')}",
    ]
    return "\n".join(lines) + "\n"


def parse_phases(value: str) -> set[str]:
    if value == "all":
        return {"freeze", "nulls", "stress"}
    return {item.strip() for item in value.split(",") if item.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=repo_root())
    parser.add_argument("--pack", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--model", type=Path, default=None)
    parser.add_argument(
        "--source-root",
        type=Path,
        default=None,
        help="native source tree (defaults to PACK/in)",
    )
    parser.add_argument(
        "--stress-cells",
        default=",".join(STRESS_CELLS),
        help="comma-separated cells; use 'native' for the frozen native-format battery",
    )
    parser.add_argument("--phase", default="freeze,nulls,stress")
    parser.add_argument("--bootstrap-samples", type=int, default=BOOTSTRAP_SAMPLES)
    parser.add_argument("--seed", type=int, default=PROTOCOL_SEED)
    parser.add_argument("--providers", default="CUDAExecutionProvider,CPUExecutionProvider")
    parser.add_argument("--skip-detector", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    pack = (args.pack or root / "data" / "diag" / "holdout-kandinsky").resolve()
    out_dir = (args.out or pack / "explain-it-away").resolve()
    model = (args.model or root / "models" / "weights" / "community-forensics-384-int8.onnx").resolve()
    calibration = (root / "models" / "calibration" / "fused.json").resolve()
    source_root = (args.source_root.resolve() if args.source_root else pack / "in")
    phases = parse_phases(args.phase)
    selected_cells = tuple(item.strip() for item in args.stress_cells.split(",") if item.strip())
    if not selected_cells:
        raise ValueError("stress-cells must select at least one cell")
    samples = int(args.bootstrap_samples)
    if samples < 200:
        raise ValueError("bootstrap-samples must be at least 200")
    cuda_dirs = ensure_cuda_dlls(root)
    if cuda_dirs:
        print(f"cuda dlls: {cuda_dirs[0]}", flush=True)
    if "stress" in phases:
        acquire_run_lock(out_dir / "stress.lock")

    freeze_path = out_dir / "frozen-candidate.json"
    if "freeze" in phases or not freeze_path.is_file():
        freeze = freeze_candidate(root, pack, out_dir)
        print(json.dumps({"freezeSha256": freeze["freezeSha256"], "candidate": freeze["candidate"]}, indent=2))
    else:
        freeze = json.loads(freeze_path.read_text(encoding="utf-8"))
        verify_freeze(freeze, root, pack)

    shootout = None
    if "nulls" in phases:
        verify_freeze(freeze, root, pack)
        rows = load_score_rows(pack / "scores.csv")
        hashes = {row.get("model_sha256") for row in rows if row.get("model_sha256")}
        if hashes and hashes != {EXPECTED_MODEL_SHA256}:
            raise ValueError(f"score CSV model hash {hashes} != frozen {EXPECTED_MODEL_SHA256}")
        rows = attach_features(rows, pack, out_dir / "feature-cache.json")
        shootout = run_null_shootout(rows, samples=samples, seed=args.seed)
        bind_shootout_evidence(
            shootout,
            rows,
            freeze=freeze,
            scores_path=pack / "scores.csv",
            splits_path=pack / "splits.json",
            calibration_path=calibration,
            seed=args.seed,
        )
        write_json(out_dir / "null-shootout.json", shootout)
        print(json.dumps({
            "detectorBA": shootout["detector"]["balancedAccuracy"],
            "bestNull": {"id": shootout["bestNull"]["id"], "fairBA": shootout["bestNull"].get("fairBA")},
            "delta": shootout["detectorMinusBestNull"]["delta"],
            "deltaCI": shootout["detectorMinusBestNull"]["ci"],
            "corpusGate": shootout["corpusGate"],
        }, indent=2))

    grid = None
    if "stress" in phases:
        verify_freeze(freeze, root, pack)
        by_cell = build_stress_rows(
            pack,
            out_dir,
            source_root=source_root,
            cells=selected_cells,
        )
        cells: dict[str, Any] = {}
        for cell, cell_rows in by_cell.items():
            print(f"stress cell {cell}: {len(cell_rows)} images", flush=True)
            cached_cell = out_dir / "stress" / f"nulls-{cell}.json"
            if cached_cell.is_file() and (out_dir / "stress" / f"scores-{cell}.csv").is_file():
                with (out_dir / "stress" / f"scores-{cell}.csv").open("r", encoding="utf-8-sig", newline="") as stream:
                    scored_n = sum(1 for _ in csv.DictReader(stream))
                if scored_n >= len(cell_rows):
                    print(f"skip cell {cell}: cached nulls", flush=True)
                    cells[cell] = json.loads(cached_cell.read_text(encoding="utf-8"))
                    continue
            if not args.skip_detector:
                cell_rows = score_stress_cell(
                    cell_rows,
                    model,
                    calibration,
                    out_dir / "stress" / f"scores-{cell}.csv",
                    [item.strip() for item in args.providers.split(",")],
                )
            cell_rows = attach_features(cell_rows, Path("."), out_dir / f"feature-cache-{cell}.json")
            if args.skip_detector:
                for row in cell_rows:
                    row[SCORE_COLUMN] = 0.5
            result = run_null_shootout(cell_rows, samples=samples, seed=args.seed)
            cell_scores_path = out_dir / "stress" / f"scores-{cell}.csv"
            bind_shootout_evidence(
                result,
                cell_rows,
                freeze=freeze,
                scores_path=cell_scores_path,
                splits_path=pack / "splits.json",
                calibration_path=calibration,
                seed=args.seed,
            )
            print(json.dumps({
                "cell": cell,
                "detectorBA": result["detector"]["balancedAccuracy"]["value"],
                "bestNull": result["bestNull"]["id"],
                "nullBA": result["bestNull"].get("fairBA"),
                "delta": result["detectorMinusBestNull"]["delta"],
                "deltaCI": result["detectorMinusBestNull"]["ci"],
            }), flush=True)
            cells[cell] = {
                "detector": result["detector"],
                "bestNull": result["bestNull"],
                "detectorMinusBestNull": result["detectorMinusBestNull"],
                "corpusGate": result["corpusGate"],
                "univariate": result["univariate"],
                "multivariate": result["multivariate"],
            }
            write_json(out_dir / "stress" / f"nulls-{cell}.json", cells[cell])
            if cell == "native":
                shootout = result
                write_json(out_dir / "null-shootout.json", shootout)
        realistic = tuple(
            name for name in ("jpeg_only", "resize_ar", "resize_jpeg", "random_codec", "square_pad_crop")
            if name in cells
        )
        worst = (
            min(realistic, key=lambda name: cells[name]["detector"]["balancedAccuracy"]["value"])
            if realistic
            else None
        )
        grid = {
            "primaryClaimCell": "native",
            "doNotSelectWinningTransform": True,
            "worstRealisticCell": worst,
            "selectedCells": list(selected_cells),
            "cells": cells,
        }
        write_json(out_dir / "stress-grid.json", grid)

    if shootout is None and (out_dir / "null-shootout.json").is_file():
        shootout = json.loads((out_dir / "null-shootout.json").read_text(encoding="utf-8"))
    if shootout is not None:
        report = render_report(freeze, shootout, grid)
        (out_dir / "REPORT.md").write_text(report, encoding="utf-8")
        try:
            print(report)
        except UnicodeEncodeError:
            print(report.encode("ascii", "replace").decode("ascii"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
