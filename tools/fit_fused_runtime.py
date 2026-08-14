#!/usr/bin/env python3
"""Refit the shipped curve on the exact official-center browser runtime signal.

Inputs may contain several web-realistic variants.  Only rows named by the
calibration split fit the curve; the eval split is opened after the curve is
frozen.  Leakage-audit artifacts must cover every selected image.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
from collections import Counter

import numpy as np

from eval_common import canonical_sha256, cluster_id, clustered_metrics, sha256_file
from fit_calibration import TARGET_THRESHOLD, platt_shift_curve


ROOT = pathlib.Path(__file__).resolve().parent.parent
SCORE_COLUMN = "score_official_browser"


def load_rows(paths: list[pathlib.Path]) -> list[dict]:
    rows: list[dict] = []
    for path in paths:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            current = list(csv.DictReader(stream))
        for row in current:
            row["_source_score_file"] = path.name
        rows.extend(current)
    return rows


def load_audits(paths: list[pathlib.Path]) -> tuple[set[str], list[dict]]:
    covered: set[str] = set()
    summaries: list[dict] = []
    for path in paths:
        artifact = json.loads(path.read_text(encoding="utf-8"))
        unsigned = {key: value for key, value in artifact.items() if key != "contentSha256"}
        if artifact.get("contentSha256") != canonical_sha256(unsigned):
            raise ValueError(f"audit content hash is invalid: {path}")
        if artifact.get("status") not in {"pass", "warn"} or artifact.get("coverage", {}).get("failures"):
            raise ValueError(f"audit did not pass: {path}")
        covered.update(artifact["coverage"]["outputSha256s"])
        summaries.append({
            "sha256": sha256_file(path),
            "manifestSha256": artifact["inputs"]["degradationManifestSha256"],
            "status": artifact["status"],
            "rocAuc": artifact["result"]["groupedCrossValidatedRocAuc"],
        })
    return covered, summaries


def row_digest(rows: list[dict]) -> str:
    return canonical_sha256(sorted(
        (
            row["_source_score_file"],
            row["image_sha256"],
            row["image_id"],
            row[SCORE_COLUMN],
        )
        for row in rows
    ))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", action="append", required=True, type=pathlib.Path, dest="score_sets")
    parser.add_argument("--audit", action="append", required=True, type=pathlib.Path, dest="audits")
    parser.add_argument("--out", type=pathlib.Path, default=ROOT / "models/calibration/fused.json")
    parser.add_argument("--calibration-split", default="calibration")
    parser.add_argument("--eval-split", default="eval")
    parser.add_argument("--min-images-per-class", type=int, default=30)
    parser.add_argument("--min-heldout-ba", type=float, default=0.75)
    parser.add_argument("--bootstrap-samples", type=int, default=5000)
    args = parser.parse_args()

    if args.calibration_split == args.eval_split:
        raise ValueError("calibration and eval split names must differ")
    rows = load_rows(args.score_sets)
    required = {
        "image_id", "label", "generator", "split", "image_sha256", SCORE_COLUMN,
    }
    if not rows or not required <= set(rows[0]):
        raise ValueError(f"browser score CSVs must contain {sorted(required)}")
    calibration = [row for row in rows if row["split"] == args.calibration_split]
    held_out = [row for row in rows if row["split"] == args.eval_split]
    if not calibration or not held_out:
        raise ValueError("calibration and eval selections must both be present")
    for row in calibration + held_out:
        row["label"] = int(row["label"])
        row[SCORE_COLUMN] = float(row[SCORE_COLUMN])

    calibration_clusters = {cluster_id(row) for row in calibration}
    eval_clusters = {cluster_id(row) for row in held_out}
    if calibration_clusters & eval_clusters:
        raise ValueError("source clusters cross calibration and eval")
    calibration_generators = {row["generator"] for row in calibration}
    eval_generators = {row["generator"] for row in held_out}
    if calibration_generators & eval_generators:
        raise ValueError("generators cross calibration and eval")

    for name, selection in (("calibration", calibration), ("eval", held_out)):
        counts = Counter(row["label"] for row in selection)
        if counts[0] < args.min_images_per_class or counts[1] < args.min_images_per_class:
            raise ValueError(
                f"{name} minimum-count gate failed: real={counts[0]}, AI={counts[1]}, "
                f"need {args.min_images_per_class} each"
            )

    audited_images, audit_summaries = load_audits(args.audits)
    selected_images = {row["image_sha256"] for row in calibration + held_out}
    missing = selected_images - audited_images
    if missing:
        raise ValueError(f"leakage audits do not cover {len(missing)} calibration/eval images")

    model_hashes = {row.get("model_sha256", "") for row in calibration + held_out} - {""}
    if len(model_hashes) != 1:
        raise ValueError("browser score rows must identify exactly one model artifact")
    model_hash = next(iter(model_hashes))

    calibration_scores = np.asarray([row[SCORE_COLUMN] for row in calibration], dtype=np.float64)
    calibration_labels = np.asarray([row["label"] for row in calibration], dtype=int)
    xs, ys, t_star, fit_ba = platt_shift_curve(calibration_scores, calibration_labels, 64)
    for row in held_out:
        row["score"] = float(np.interp(row[SCORE_COLUMN], xs, ys, left=ys[0], right=ys[-1]))
    heldout_metrics = clustered_metrics(
        held_out,
        threshold=TARGET_THRESHOLD,
        score_column="score",
        bootstrap_samples=args.bootstrap_samples,
        confidence=0.95,
        seed=20260814,
    )
    heldout_ba = heldout_metrics["balancedAccuracy"]["value"]
    if heldout_ba < args.min_heldout_ba:
        raise ValueError(
            f"official-center refit held-out BA {heldout_ba:.4f} is below {args.min_heldout_ba:.4f}"
        )

    refit_config = {
        "inputScoreColumn": SCORE_COLUMN,
        "calibrationSplit": args.calibration_split,
        "evalSplit": args.eval_split,
        "threshold": TARGET_THRESHOLD,
        "maxKnots": 64,
        "minImagesPerClass": args.min_images_per_class,
        "minHeldOutBalancedAccuracy": args.min_heldout_ba,
        "bootstrapSamples": args.bootstrap_samples,
        "bootstrapSeed": 20260814,
    }
    table = {
        "formatVersion": 2,
        "id": "cf384-browser-official-center-pooled-webrealistic-v2",
        "xs": [round(float(value), 8) for value in xs],
        "ys": [round(float(value), 8) for value in ys],
        "inputScoreColumn": SCORE_COLUMN,
        "runtimePreprocessing": "official-center-resize440-crop384",
        "runtimeAggregation": "single-crop",
        "modelSha256": model_hash,
        "fittedOn": "official-center browser ORT-Web scores; dedicated calibration split only",
        "calibrationSplit": args.calibration_split,
        "evalSplit": args.eval_split,
        "calibrationImages": len(calibration),
        "evalImages": len(held_out),
        "calibrationClassCounts": dict(sorted(Counter(row["label"] for row in calibration).items())),
        "evalClassCounts": dict(sorted(Counter(row["label"] for row in held_out).items())),
        "calibrationGenerators": sorted(calibration_generators),
        "evalGenerators": sorted(eval_generators),
        "calibrationRowsSha256": row_digest(calibration),
        "evalRowsSha256": row_digest(held_out),
        "sourceScoreFiles": [
            {"file": path.name, "sha256": sha256_file(path)} for path in args.score_sets
        ],
        "leakageAudits": audit_summaries,
        "refitConfig": refit_config,
        "refitConfigSha256": canonical_sha256(refit_config),
        "tStar": round(float(t_star), 8),
        "target": TARGET_THRESHOLD,
        "calibrationFitBalancedAccuracy": round(float(fit_ba), 8),
        "heldOut": {
            "truePositiveRate": heldout_metrics["truePositiveRate"],
            "trueNegativeRate": heldout_metrics["trueNegativeRate"],
            "balancedAccuracy": heldout_metrics["balancedAccuracy"],
            "confidence": heldout_metrics["confidence"],
            "bootstrapSamples": heldout_metrics["bootstrapSamples"],
            "bootstrapSeed": heldout_metrics["bootstrapSeed"],
        },
        "heldOutBalancedAccuracy": round(float(heldout_ba), 8),
        "shippingGate": {"minimumBalancedAccuracy": args.min_heldout_ba, "passed": True},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(table, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "curve": str(args.out),
        "calibrationImages": len(calibration),
        "evalImages": len(held_out),
        "headline": table["heldOut"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
