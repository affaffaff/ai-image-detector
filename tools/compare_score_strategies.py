#!/usr/bin/env python3
"""Rank preprocessing/aggregation strategies on one non-eval split only."""

from __future__ import annotations

import argparse
import csv
import json
import pathlib

import numpy as np
from sklearn.metrics import roc_auc_score

from fit_calibration import TARGET_THRESHOLD, balanced_accuracy, best_threshold


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", required=True, type=pathlib.Path, dest="score_set")
    parser.add_argument("--split", default="fit")
    parser.add_argument("--generators", help="optional comma-separated generator/group values")
    args = parser.parse_args()
    with args.score_set.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    if args.generators:
        selected = {value.strip() for value in args.generators.split(",") if value.strip()}
        rows = [row for row in rows if row.get("generator") in selected]
    else:
        rows = [row for row in rows if row["split"] == args.split]
    if not rows:
        raise ValueError(f"split '{args.split}' has no rows")
    labels = np.asarray([int(row["label"]) for row in rows], dtype=int)
    if set(labels) != {0, 1}:
        raise ValueError("selection split must contain both classes")
    columns = sorted(
        field
        for field in fields
        if field.startswith("score_")
        and field != "score_model"
        and not field.startswith("score_diagnostic_")
        and "official_center" not in field
    )
    results = []
    for column in columns:
        scores = np.asarray([float(row[column]) for row in rows], dtype=np.float64)
        threshold, optimum = best_threshold(labels, scores)
        results.append({
            "strategy": column.removeprefix("score_"),
            "column": column,
            "images": len(rows),
            "rocAuc": float(roc_auc_score(labels, scores)),
            "optimalThreshold": float(threshold),
            "optimalBalancedAccuracy": float(optimum),
            "balancedAccuracyAt065": float(
                balanced_accuracy(labels, scores, TARGET_THRESHOLD)
            ),
        })
    results.sort(key=lambda item: (-item["optimalBalancedAccuracy"], -item["rocAuc"], item["strategy"]))
    print(json.dumps({
        "selectionSplit": args.split if not args.generators else None,
        "selectionGenerators": sorted(selected) if args.generators else None,
        "strategies": results,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
