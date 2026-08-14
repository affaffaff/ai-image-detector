"""Shared, deterministic primitives for gated detector evaluation.

This module deliberately contains no model code.  It owns the evidence
contract used by the leakage audit, calibration fitter, evaluator, and
precision-comparison runner: stable hashes, source-clustered confidence
intervals, and the append-only hash-chained evaluation log.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
from collections import defaultdict
from typing import Any, Iterable, Sequence

import numpy as np


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def set_sha256(values: Iterable[str]) -> str:
    """Hash a set without leaking ordering or platform newline differences."""
    return canonical_sha256(sorted(set(values)))


def cluster_id(row: dict[str, Any]) -> str:
    """Return the independent-source identity carried by a score row."""
    for field in ("cluster_id", "source_sha256", "source_key", "image_id"):
        value = str(row.get(field, "")).strip()
        if value:
            return value
    raise ValueError("score row has no cluster_id/source identity")


def _point_metrics(labels: np.ndarray, scores: np.ndarray, threshold: float) -> tuple[float, float, float]:
    positives = labels == 1
    negatives = labels == 0
    if not positives.any() or not negatives.any():
        raise ValueError("selection must contain both real and AI images")
    tpr = float(np.mean(scores[positives] >= threshold))
    tnr = float(np.mean(scores[negatives] < threshold))
    return tpr, tnr, (tpr + tnr) / 2.0


def clustered_metrics(
    rows: Sequence[dict[str, Any]],
    *,
    threshold: float,
    score_column: str = "score",
    bootstrap_samples: int = 2000,
    confidence: float = 0.95,
    seed: int = 20260814,
) -> dict[str, Any]:
    """Fixed-threshold metrics with a source-cluster bootstrap interval.

    Every degradation of the same source is resampled as one unit.  Resampling
    within each class preserves the metric's balanced-class definition.
    """
    if bootstrap_samples < 200:
        raise ValueError("bootstrap_samples must be at least 200")
    if not 0.5 < confidence < 1.0:
        raise ValueError("confidence must be in (0.5, 1)")

    labels = np.asarray([int(row["label"]) for row in rows], dtype=np.int8)
    scores = np.asarray([float(row[score_column]) for row in rows], dtype=np.float64)
    if labels.size == 0 or not np.isfinite(scores).all():
        raise ValueError("selection is empty or contains a non-finite score")
    if not np.isin(labels, [0, 1]).all() or np.any((scores < 0) | (scores > 1)):
        raise ValueError("labels must be 0/1 and scores must be in [0, 1]")

    cluster_names = np.asarray([cluster_id(row) for row in rows], dtype=object)
    cluster_labels: dict[str, set[int]] = defaultdict(set)
    cluster_indices: dict[str, list[int]] = defaultdict(list)
    for index, (name, label) in enumerate(zip(cluster_names, labels, strict=True)):
        cluster_labels[str(name)].add(int(label))
        cluster_indices[str(name)].append(index)
    conflicts = sorted(name for name, values in cluster_labels.items() if len(values) != 1)
    if conflicts:
        raise ValueError(f"source clusters have conflicting labels: {', '.join(conflicts[:5])}")

    names_by_class = {
        label: sorted(name for name, values in cluster_labels.items() if next(iter(values)) == label)
        for label in (0, 1)
    }
    if not names_by_class[0] or not names_by_class[1]:
        raise ValueError("selection must contain independent clusters from both classes")

    tpr, tnr, balanced = _point_metrics(labels, scores, threshold)
    rng = np.random.default_rng(seed)
    samples = np.empty((bootstrap_samples, 3), dtype=np.float64)
    for sample_index in range(bootstrap_samples):
        sampled_indices: list[int] = []
        for label in (0, 1):
            names = names_by_class[label]
            chosen = rng.choice(names, size=len(names), replace=True)
            for name in chosen:
                sampled_indices.extend(cluster_indices[str(name)])
        index_array = np.asarray(sampled_indices, dtype=np.int64)
        samples[sample_index] = _point_metrics(labels[index_array], scores[index_array], threshold)

    alpha = (1.0 - confidence) / 2.0
    lower = np.quantile(samples, alpha, axis=0)
    upper = np.quantile(samples, 1.0 - alpha, axis=0)

    def estimate(value: float, low: float, high: float) -> dict[str, float]:
        return {"value": value, "ciLower": float(low), "ciUpper": float(high)}

    positives = int(np.sum(labels == 1))
    negatives = int(np.sum(labels == 0))
    return {
        "images": int(labels.size),
        "aiImages": positives,
        "realImages": negatives,
        "clusters": len(cluster_labels),
        "aiClusters": len(names_by_class[1]),
        "realClusters": len(names_by_class[0]),
        "threshold": threshold,
        "confidence": confidence,
        "bootstrapSamples": bootstrap_samples,
        "bootstrapSeed": seed,
        "truePositiveRate": estimate(tpr, lower[0], upper[0]),
        "trueNegativeRate": estimate(tnr, lower[1], upper[1]),
        "balancedAccuracy": estimate(balanced, lower[2], upper[2]),
        "nullBaselines": {
            "alwaysReal": {"truePositiveRate": 0.0, "trueNegativeRate": 1.0, "balancedAccuracy": 0.5},
            "alwaysAi": {"truePositiveRate": 1.0, "trueNegativeRate": 0.0, "balancedAccuracy": 0.5},
            "prevalenceRandom": {
                "positivePredictionRate": positives / int(labels.size),
                "expectedBalancedAccuracy": 0.5,
            },
        },
    }


def append_hash_chained_log(path: pathlib.Path, entry: dict[str, Any]) -> dict[str, Any]:
    """Append one canonical JSONL record linked to the previous record hash."""
    previous_hash: str | None = None
    if path.exists():
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if lines:
            previous = json.loads(lines[-1])
            expected = previous.get("entrySha256")
            unsigned_previous = {key: value for key, value in previous.items() if key != "entrySha256"}
            actual = canonical_sha256(unsigned_previous)
            if expected != actual:
                raise ValueError("evaluation log tail hash is invalid; refusing to append")
            previous_hash = actual

    rendered = {**entry, "previousEntrySha256": previous_hash}
    rendered["entrySha256"] = canonical_sha256(rendered)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(canonical_json_bytes(rendered).decode("utf-8") + "\n")
    return rendered


def finite_probability(value: Any, *, field: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or not 0.0 <= parsed <= 1.0:
        raise ValueError(f"{field} must be finite and in [0, 1]")
    return parsed
