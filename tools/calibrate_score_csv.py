#!/usr/bin/env python3
"""Fit the fixed-0.65 monotone calibration from a scored benchmark CSV.

The calibration split alone fits the curve. The eval split is read only after
the curve is frozen and supplies the held-out report. The output CSV preserves
the raw model value in ``raw_score`` and places the calibrated value in
``score`` for tools/evaluate_scores.py.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib

import numpy as np

from fit_calibration import (
    TARGET_THRESHOLD,
    balanced_accuracy,
    best_threshold,
    platt_shift_curve,
)
from eval_common import canonical_sha256, cluster_id, sha256_file


def metrics(labels: np.ndarray, scores: np.ndarray) -> dict[str, float]:
    threshold, optimal = best_threshold(labels, scores)
    return {
        "optimalThreshold": float(threshold),
        "optimalBalancedAccuracy": float(optimal),
        "balancedAccuracyAt065": float(balanced_accuracy(labels, scores, TARGET_THRESHOLD)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", required=True, type=pathlib.Path, dest="score_set")
    parser.add_argument("--out", required=True, type=pathlib.Path, help="calibrated score CSV")
    parser.add_argument("--curve", required=True, type=pathlib.Path, help="runtime calibration JSON")
    parser.add_argument("--calibration-split", default="calibration")
    parser.add_argument("--eval-split", default="eval")
    parser.add_argument("--max-knots", type=int, default=64)
    parser.add_argument("--score-column", default="score_official_browser")
    parser.add_argument("--audit", required=True, type=pathlib.Path)
    parser.add_argument("--min-calibration-images-per-class", type=int, default=20)
    parser.add_argument(
        "--calibration-generators",
        help="comma-separated generator/group values; overrides --calibration-split",
    )
    parser.add_argument(
        "--eval-generators",
        help="comma-separated generator/group values; overrides --eval-split",
    )
    args = parser.parse_args()

    if args.calibration_split == args.eval_split:
        raise ValueError("calibration and eval split names must be different")
    if args.score_column != "score_official_browser":
        raise ValueError("runtime calibration must fit the shipped score_official_browser signal")

    with args.score_set.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    if not rows or not {"label", args.score_column, "split"} <= set(fields):
        raise ValueError(f"score CSV must contain label, {args.score_column}, and split columns")

    raw = np.asarray([float(row[args.score_column]) for row in rows], dtype=np.float64)
    labels = np.asarray([int(row["label"]) for row in rows], dtype=int)
    splits = np.asarray([row["split"] for row in rows], dtype=object)
    generators = np.asarray([row.get("generator", "") for row in rows], dtype=object)
    calibration_groups = (
        {value.strip() for value in args.calibration_generators.split(",") if value.strip()}
        if args.calibration_generators
        else None
    )
    eval_groups = (
        {value.strip() for value in args.eval_generators.split(",") if value.strip()}
        if args.eval_generators
        else None
    )
    calibration_mask = (
        np.isin(generators, sorted(calibration_groups))
        if calibration_groups
        else splits == args.calibration_split
    )
    eval_mask = np.isin(generators, sorted(eval_groups)) if eval_groups else splits == args.eval_split
    if not calibration_mask.any() or not eval_mask.any():
        raise ValueError("calibration and eval splits must both be present")
    for name, mask in ((args.calibration_split, calibration_mask), (args.eval_split, eval_mask)):
        if set(labels[mask]) != {0, 1}:
            raise ValueError(f"split '{name}' must contain both classes")
    if np.any(calibration_mask & eval_mask):
        raise ValueError("calibration and eval selections overlap")

    calibration_rows = [row for row, chosen in zip(rows, calibration_mask, strict=True) if chosen]
    eval_rows = [row for row, chosen in zip(rows, eval_mask, strict=True) if chosen]
    calibration_ids = {row.get("image_id", "") for row in calibration_rows}
    eval_ids = {row.get("image_id", "") for row in eval_rows}
    if (calibration_ids & eval_ids) - {""}:
        raise ValueError("image_id values overlap calibration and eval")
    calibration_clusters = {cluster_id(row) for row in calibration_rows}
    eval_clusters = {cluster_id(row) for row in eval_rows}
    overlap = calibration_clusters & eval_clusters
    if overlap:
        raise ValueError(f"source clusters cross calibration and eval: {', '.join(sorted(overlap)[:5])}")
    calibration_generator_set = {row.get("generator", "") for row in calibration_rows}
    eval_generator_set = {row.get("generator", "") for row in eval_rows}
    generator_overlap = (calibration_generator_set & eval_generator_set) - {""}
    if generator_overlap:
        raise ValueError(
            f"generators cross calibration and eval: {', '.join(sorted(generator_overlap)[:5])}"
        )

    per_class = np.bincount(labels[calibration_mask], minlength=2)
    if int(per_class.min()) < args.min_calibration_images_per_class:
        raise ValueError(
            "calibration split minimum-count gate failed: "
            f"have real={per_class[0]}, AI={per_class[1]}, "
            f"need {args.min_calibration_images_per_class} each"
        )

    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    unsigned_audit = {key: value for key, value in audit.items() if key != "contentSha256"}
    if audit.get("contentSha256") != canonical_sha256(unsigned_audit):
        raise ValueError("audit artifact content hash is invalid")
    if audit.get("status") not in {"pass", "warn"} or audit.get("coverage", {}).get("failures"):
        raise ValueError("audit artifact did not pass")
    if not audit.get("config", {}).get("pixelFeaturesIncluded"):
        raise ValueError("audit artifact omitted decoded-pixel shortcut features")
    if float(audit.get("result", {}).get("groupedCrossValidatedRocAuc", 1.0)) >= float(
        audit.get("thresholds", {}).get("failRocAuc", 0.70)
    ):
        raise ValueError("audit artifact AUC is at or above its fail threshold")
    manifest_hashes = {row.get("dataset_manifest_sha256", "") for row in calibration_rows + eval_rows}
    if manifest_hashes != {audit.get("inputs", {}).get("degradationManifestSha256")}:
        raise ValueError("calibration CSV is not bound to the audited degradation manifest")
    audited_images = set(audit.get("coverage", {}).get("outputSha256s", []))
    selected_images = {row.get("image_sha256", "") for row in calibration_rows + eval_rows}
    if "" in selected_images or not selected_images <= audited_images:
        raise ValueError("audit artifact does not cover every calibration/eval image")

    fit_raw = raw[calibration_mask]
    fit_labels = labels[calibration_mask]
    if float(fit_raw.min()) == float(fit_raw.max()):
        raise ValueError("calibration scores are constant; the detector has no usable ranking")

    xs, ys, t_star, fit_ba = platt_shift_curve(fit_raw, fit_labels, args.max_knots)
    calibrated = np.interp(raw, xs, ys, left=ys[0], right=ys[-1])

    report = {
        "formatVersion": 1,
        "target": TARGET_THRESHOLD,
        "calibrationSplit": args.calibration_split,
        "evalSplit": args.eval_split,
        "calibrationGenerators": sorted(calibration_groups) if calibration_groups else None,
        "evalGenerators": sorted(eval_groups) if eval_groups else None,
        "scoreColumn": args.score_column,
        "calibrationImages": int(calibration_mask.sum()),
        "evalImages": int(eval_mask.sum()),
        "plattThresholdBeforeShift": float(t_star),
        "calibrationFitBalancedAccuracy": float(fit_ba),
        "rawCalibration": metrics(fit_labels, fit_raw),
        "rawEval": metrics(labels[eval_mask], raw[eval_mask]),
        "calibratedEval": metrics(labels[eval_mask], calibrated[eval_mask]),
    }
    model_hashes = {row.get("model_sha256", "") for row in calibration_rows + eval_rows} - {""}
    if len(model_hashes) != 1:
        raise ValueError("calibration/eval rows must identify exactly one model artifact")
    curve = {
        "id": "cf384-official-center-browser-runtime",
        "xs": [round(float(value), 8) for value in xs],
        "ys": [round(float(value), 8) for value in ys],
        "fittedOn": f"{args.score_set.name}:{args.score_column}:{args.calibration_split}",
        "n": int(calibration_mask.sum()),
        "tStar": round(float(t_star), 8),
        "target": TARGET_THRESHOLD,
        "heldOutBA": round(float(report["calibratedEval"]["balancedAccuracyAt065"]), 8),
        "inputScoreColumn": args.score_column,
        "runtimePreprocessing": "official-center-resize440-crop384",
        "runtimeAggregation": "single-crop",
        "modelSha256": next(iter(model_hashes)),
        "datasetManifestSha256": next(iter(manifest_hashes)),
        "auditArtifactSha256": sha256_file(args.audit),
        "calibrationRowsSha256": canonical_sha256(sorted(
            (row.get("image_sha256", ""), row.get("image_id", ""), row[args.score_column])
            for row in calibration_rows
        )),
        "evalRowsSha256": canonical_sha256(sorted(
            (row.get("image_sha256", ""), row.get("image_id", ""), row[args.score_column])
            for row in eval_rows
        )),
        "calibrationCounts": {"ai": int(per_class[1]), "real": int(per_class[0])},
        "report": report,
    }

    args.curve.parent.mkdir(parents=True, exist_ok=True)
    args.curve.write_text(json.dumps(curve, indent=2) + "\n", encoding="utf-8")
    curve_sha256 = sha256_file(args.curve)
    output_fields = [field for field in fields if field not in ("raw_score", "score", "calibration_curve_sha256")]
    output_fields.extend(["raw_score", "score", "calibration_curve_sha256"])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=output_fields, extrasaction="ignore")
        writer.writeheader()
        for row, raw_value, calibrated_value in zip(rows, raw, calibrated, strict=True):
            writer.writerow({
                **row,
                "raw_score": f"{raw_value:.10f}",
                "score": f"{calibrated_value:.10f}",
                "calibration_curve_sha256": curve_sha256,
            })
    print(json.dumps(report, indent=2))
    print(f"wrote curve -> {args.curve}")
    print(f"wrote calibrated scores -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
