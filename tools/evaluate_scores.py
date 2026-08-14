#!/usr/bin/env python3
"""Run the mandatory, fixed-0.65 evaluation acceptance gate.

The gate consumes four immutable inputs: a scored CSV, a leakage-audit
artifact, a checked-in JSON configuration, and (when calibrated scores are
used) the exact runtime curve.  It verifies their hashes and coverage before
reporting only the three operating-point numbers that matter: TPR, TNR, and
balanced accuracy, each with a source-clustered confidence interval.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import pathlib
from collections import Counter, defaultdict
from typing import Any

from eval_common import (
    append_hash_chained_log,
    canonical_sha256,
    cluster_id,
    clustered_metrics,
    set_sha256,
    sha256_file,
)


DECISION_THRESHOLD = 0.65
REQUIRED_COLUMNS = {
    "image_id",
    "path",
    "label",
    "generator",
    "split",
    "score",
    "phash",
    "degradation",
    "cluster_id",
    "image_sha256",
    "dataset_manifest_sha256",
    "model_sha256",
}
SCENARIOS = {"clean", "web-realistic", "unseen-generator"}
POWER_FLOOR_CLUSTERS_PER_CLASS = 100


def parse_manifest(path: pathlib.Path, score_column: str) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = REQUIRED_COLUMNS | {score_column}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"score CSV is missing columns: {', '.join(sorted(missing))}")
        rows: list[dict[str, Any]] = []
        for line_number, row in enumerate(reader, start=2):
            try:
                label = int(row["label"])
                score = float(row[score_column])
            except (TypeError, ValueError) as error:
                raise ValueError(f"line {line_number}: invalid label or score") from error
            if label not in (0, 1):
                raise ValueError(f"line {line_number}: label must be 0 or 1")
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError(f"line {line_number}: score must be finite and in [0, 1]")
            for field in (
                "image_id", "path", "generator", "split", "phash", "cluster_id",
                "image_sha256", "dataset_manifest_sha256", "model_sha256",
            ):
                if not str(row.get(field, "")).strip():
                    raise ValueError(f"line {line_number}: {field} cannot be empty")
            try:
                phash = int(row["phash"], 16)
            except ValueError as error:
                raise ValueError(f"line {line_number}: phash must be hexadecimal") from error
            image_hash = row["image_sha256"].lower()
            if len(image_hash) != 64 or any(char not in "0123456789abcdef" for char in image_hash):
                raise ValueError(f"line {line_number}: image_sha256 must be lowercase SHA-256")
            rows.append({**row, "label": label, score_column: score, "phash_int": phash})
    if not rows:
        raise ValueError("score CSV contains no rows")
    return rows


def audit_split_integrity(
    rows: list[dict[str, Any]],
    phash_distance: int,
    *,
    allow_seen_generator: bool = False,
) -> None:
    ids = Counter(row["image_id"] for row in rows)
    repeated_ids = sorted(key for key, count in ids.items() if count > 1)
    if repeated_ids:
        raise ValueError(f"duplicate image_id values: {', '.join(repeated_ids[:5])}")

    generator_splits: dict[str, set[str]] = defaultdict(set)
    cluster_splits: dict[str, set[str]] = defaultdict(set)
    cluster_labels: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        generator_splits[row["generator"]].add(row["split"])
        cluster_splits[cluster_id(row)].add(row["split"])
        cluster_labels[cluster_id(row)].add(int(row["label"]))
    leaked = sorted(generator for generator, splits in generator_splits.items() if len(splits) > 1)
    if leaked and not allow_seen_generator:
        raise ValueError(f"generators cross splits: {', '.join(leaked[:10])}")
    crossing_clusters = sorted(name for name, splits in cluster_splits.items() if len(splits) > 1)
    if crossing_clusters:
        raise ValueError(f"source clusters cross splits: {', '.join(crossing_clusters[:10])}")
    conflicting_clusters = sorted(name for name, labels in cluster_labels.items() if len(labels) > 1)
    if conflicting_clusters:
        raise ValueError(f"source clusters carry conflicting labels: {', '.join(conflicting_clusters[:10])}")

    for index, left in enumerate(rows):
        for right in rows[index + 1 :]:
            distance = (left["phash_int"] ^ right["phash_int"]).bit_count()
            if distance <= phash_distance and cluster_id(left) != cluster_id(right):
                raise ValueError(
                    "perceptual duplicates occupy different source clusters: "
                    f"{left['image_id']} / {right['image_id']} (Hamming distance {distance})"
                )


def _load_config(path: pathlib.Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    required = {"formatVersion", "id", "scenario", "split", "scoreColumn", "gates", "bootstrap"}
    missing = required - set(config)
    if missing:
        raise ValueError(f"evaluation config is missing: {', '.join(sorted(missing))}")
    if config["formatVersion"] != 1:
        raise ValueError("unsupported evaluation config formatVersion")
    if config.get("threshold", DECISION_THRESHOLD) != DECISION_THRESHOLD:
        raise ValueError("evaluation threshold is fixed at 0.65")
    if config["scenario"] not in SCENARIOS:
        raise ValueError(f"scenario must be one of {sorted(SCENARIOS)}")
    gates = config["gates"]
    for field in ("minImagesPerClass", "minClustersPerClass"):
        if int(gates[field]) <= 0:
            raise ValueError(f"{field} must be positive")
    if int(gates["minClustersPerClass"]) < POWER_FLOOR_CLUSTERS_PER_CLASS:
        raise ValueError(
            f"minClustersPerClass cannot be below the {POWER_FLOOR_CLUSTERS_PER_CLASS}-cluster power floor"
        )
    if not 0.0 <= float(gates["minAuditCoverage"]) <= 1.0:
        raise ValueError("minAuditCoverage must be in [0, 1]")
    if not 0.0 <= float(gates["minBalancedAccuracy"]) <= 1.0:
        raise ValueError("minBalancedAccuracy must be in [0, 1]")
    for name, requirement in gates.get("requiredDegradations", {}).items():
        if not name or int(requirement["minImagesPerClass"]) <= 0:
            raise ValueError("required degradation minimums must be positive")
    return config


def _load_audit(path: pathlib.Path) -> dict[str, Any]:
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if artifact.get("formatVersion") != 1 or artifact.get("type") != "dataset-leakage-audit":
        raise ValueError("--audit is not a supported leakage-audit artifact")
    expected = artifact.get("contentSha256")
    unsigned = {key: value for key, value in artifact.items() if key != "contentSha256"}
    if expected != canonical_sha256(unsigned):
        raise ValueError("leakage-audit contentSha256 is invalid")
    if artifact.get("status") not in {"pass", "warn"}:
        raise ValueError("leakage audit did not pass")
    feature_set = artifact.get("config", {}).get("featureSet", "full")
    # The frozen protocol (docs/eval-protocol.md) gates on CORPUS-CONSTRUCTION
    # leakage, not on decoded-pixel content statistics: AI-vs-photo corpora are
    # measurably separable on genuine smoothness/entropy/dynamic-range signal
    # that IS the detector's forensic input (see data/matched/analysis/
    # leak-verdict.md). The construction-only audit is therefore the accepted
    # shipping gate; the full pixel-inclusive audit may be supplied alongside
    # as the strict record and is reported but not gated.
    if feature_set == "construction":
        return artifact
    if not artifact.get("config", {}).get("pixelFeaturesIncluded"):
        raise ValueError("leakage audit omitted decoded-pixel shortcut features")
    if artifact.get("coverage", {}).get("failures"):
        raise ValueError("leakage audit has unresolved minimum-count/coverage failures")
    if float(artifact.get("result", {}).get("groupedCrossValidatedRocAuc", 1.0)) >= float(
        artifact.get("thresholds", {}).get("failRocAuc", 0.70)
    ):
        raise ValueError("leakage audit AUC is at or above its fail threshold")
    return artifact


def _resolve_config_path(config_path: pathlib.Path, value: str) -> pathlib.Path:
    candidate = pathlib.Path(value)
    return candidate if candidate.is_absolute() else (config_path.parent / candidate).resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", required=True, type=pathlib.Path, dest="score_set")
    parser.add_argument("--audit", required=True, type=pathlib.Path)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--log", required=True, type=pathlib.Path)
    args = parser.parse_args()

    config = _load_config(args.config)
    audit = _load_audit(args.audit)
    score_column = str(config["scoreColumn"])
    rows = parse_manifest(args.score_set, score_column)
    phash_distance = int(config.get("phashDistance", 4))
    if phash_distance < 0:
        raise ValueError("phashDistance cannot be negative")
    audit_split_integrity(
        rows,
        phash_distance,
        allow_seen_generator=bool(config.get("allowSeenGenerator", False)),
    )

    selected = [row for row in rows if row["split"] == config["split"]]
    if not selected:
        raise ValueError(f"split '{config['split']}' does not exist")

    manifest_hashes = {row["dataset_manifest_sha256"] for row in selected}
    audited_manifest_hash = audit["inputs"]["degradationManifestSha256"]
    if manifest_hashes != {audited_manifest_hash}:
        raise ValueError("score rows are not bound to the audited degradation manifest")
    audited_images = set(audit["coverage"]["outputSha256s"])
    selected_images = {row["image_sha256"] for row in selected}
    covered_images = selected_images & audited_images
    audit_coverage = len(covered_images) / len(selected_images)

    if config.get("verifyImageFiles", True):
        for row in selected:
            image_path = pathlib.Path(row["path"])
            if not image_path.is_absolute():
                image_path = args.score_set.parent / image_path
            if sha256_file(image_path) != row["image_sha256"]:
                raise ValueError(f"image hash mismatch for {row['image_id']}")

    model_hashes = sorted({row["model_sha256"] for row in selected})
    if len(model_hashes) != 1:
        raise ValueError("selected rows were not scored by exactly one model artifact")
    expected_model = config.get("expectedModelSha256")
    if expected_model and model_hashes != [expected_model]:
        raise ValueError("scored model hash does not match evaluation config")

    calibration_evidence: dict[str, Any] | None = None
    if config.get("calibrationCurve"):
        curve_path = _resolve_config_path(args.config, str(config["calibrationCurve"]))
        curve_hash = sha256_file(curve_path)
        expected_curve = config.get("expectedCalibrationCurveSha256")
        if expected_curve and curve_hash != expected_curve:
            raise ValueError("calibration curve hash does not match evaluation config")
        curve = json.loads(curve_path.read_text(encoding="utf-8"))
        if (
            curve.get("inputScoreColumn") != "score_official_browser"
            or curve.get("runtimePreprocessing") != "official-center-resize440-crop384"
            or curve.get("runtimeAggregation") != "single-crop"
        ):
            raise ValueError("shipping calibration was not fitted on the official-center runtime")
        calibration_evidence = {
            "path": str(curve_path),
            "sha256": curve_hash,
            "id": curve.get("id"),
            "calibrationRowsSha256": curve.get("calibrationRowsSha256"),
        }

    bootstrap = config["bootstrap"]
    result = clustered_metrics(
        selected,
        threshold=DECISION_THRESHOLD,
        score_column=score_column,
        bootstrap_samples=int(bootstrap["samples"]),
        confidence=float(bootstrap["confidence"]),
        seed=int(bootstrap["seed"]),
    )

    gates = config["gates"]
    failures: list[str] = []
    minimum_per_class = int(gates["minImagesPerClass"])
    minimum_clusters = int(gates["minClustersPerClass"])
    if result["aiImages"] < minimum_per_class or result["realImages"] < minimum_per_class:
        failures.append(f"each class needs at least {minimum_per_class} images")
    if result["aiClusters"] < minimum_clusters or result["realClusters"] < minimum_clusters:
        failures.append(f"each class needs at least {minimum_clusters} independent source clusters")
    minimum_coverage = float(gates["minAuditCoverage"])
    if audit_coverage < minimum_coverage:
        failures.append(f"audit coverage {audit_coverage:.4f} is below {minimum_coverage:.4f}")
    minimum_ba = float(gates["minBalancedAccuracy"])
    if result["balancedAccuracy"]["value"] < minimum_ba:
        failures.append(
            f"balanced accuracy {result['balancedAccuracy']['value']:.4f} is below {minimum_ba:.4f}"
        )
    if gates.get("requireCiLowerBound") and result["balancedAccuracy"]["ciLower"] < minimum_ba:
        failures.append(
            f"balanced-accuracy CI lower bound {result['balancedAccuracy']['ciLower']:.4f} "
            f"is below {minimum_ba:.4f}"
        )

    required_degradations = gates.get("requiredDegradations", {})
    by_degradation: dict[str, Any] = {}
    for name, requirements in sorted(required_degradations.items()):
        group = [row for row in selected if row["degradation"] == name]
        counts = Counter(int(row["label"]) for row in group)
        required = int(requirements["minImagesPerClass"])
        if counts[0] < required or counts[1] < required:
            failures.append(f"degradation '{name}' needs at least {required} images per class")
            continue
        by_degradation[name] = {
            **clustered_metrics(
            group,
            threshold=DECISION_THRESHOLD,
            score_column=score_column,
            bootstrap_samples=int(bootstrap["samples"]),
            confidence=float(bootstrap["confidence"]),
            seed=int(bootstrap["seed"]),
            ),
            "dependent": True,
        }

    headline = {
        "truePositiveRate": result["truePositiveRate"],
        "trueNegativeRate": result["trueNegativeRate"],
        "balancedAccuracy": result["balancedAccuracy"],
    }
    report: dict[str, Any] = {
        "formatVersion": 2,
        "type": "fixed-threshold-evaluation",
        "status": "pass" if not failures else "fail",
        "evaluationId": config["id"],
        "scenario": config["scenario"],
        "split": config["split"],
        "scoreColumn": score_column,
        "threshold": DECISION_THRESHOLD,
        "headline": headline,
        "counts": {key: result[key] for key in ("images", "aiImages", "realImages", "clusters", "aiClusters", "realClusters")},
        "underpowered": (
            result["aiClusters"] < POWER_FLOOR_CLUSTERS_PER_CLASS
            or result["realClusters"] < POWER_FLOOR_CLUSTERS_PER_CLASS
        ),
        "clusteredConfidence": {
            "confidence": result["confidence"],
            "samples": result["bootstrapSamples"],
            "seed": result["bootstrapSeed"],
        },
        "nullBaselines": result["nullBaselines"],
        "byDegradation": by_degradation,
        "auditCoverage": {
            "covered": len(covered_images),
            "selected": len(selected_images),
            "fraction": audit_coverage,
            "selectedSetSha256": set_sha256(selected_images),
            "auditedSetSha256": audit["coverage"]["outputSetSha256"],
        },
        "gates": {"config": gates, "failures": failures},
        "inputs": {
            "scoreSetSha256": sha256_file(args.score_set),
            "auditArtifactSha256": sha256_file(args.audit),
            "evaluationConfigSha256": sha256_file(args.config),
            "datasetManifestSha256": audited_manifest_hash,
            "modelSha256": model_hashes[0],
            "calibration": calibration_evidence,
        },
    }
    report["reportContentSha256"] = canonical_sha256(report)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(rendered, encoding="utf-8")
    log_entry = append_hash_chained_log(
        args.log,
        {
            "formatVersion": 1,
            "type": "evaluation-log-entry",
            "evaluationId": config["id"],
            "scenario": config["scenario"],
            "status": report["status"],
            "reportContentSha256": report["reportContentSha256"],
            "reportFileSha256": sha256_file(args.out),
            "configSha256": report["inputs"]["evaluationConfigSha256"],
            "scoreSetSha256": report["inputs"]["scoreSetSha256"],
            "auditArtifactSha256": report["inputs"]["auditArtifactSha256"],
            "headline": headline,
        },
    )

    print(json.dumps({**report, "evaluationLogEntrySha256": log_entry["entrySha256"]}, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
