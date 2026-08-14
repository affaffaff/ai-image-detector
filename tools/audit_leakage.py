#!/usr/bin/env python3
"""Emit a machine-verifiable audit of non-semantic benchmark shortcuts.

This catches two common benchmark shortcuts:

* degradation leakage (for example, AI is pristine and real is recompressed),
* source leakage (for example, AI is square PNG and real is landscape JPEG).

The classifier receives manifest metadata plus deliberately weak decoded-pixel
statistics (colour moments, entropy, clipping, and edge energy).  These pixel
features catch codec/resolution/colour-pipeline shortcuts without becoming a
second semantic AI detector. Cross-validation groups every variant of a source
image together, so one source cannot appear in both fit and validation folds.

    ROC-AUC ~0.50  -> clean
    ROC-AUC >0.60  -> suspicious
    ROC-AUC >=0.70 -> fail; do not trust image-model accuracy yet

    --feature-set construction audits ONLY corpus-construction shortcuts
    (chain/format identity, dimensions, codec/crop/dpr step parameters). It
    deliberately EXCLUDES content-correlated signals (output byte-size and
    decoded-pixel statistics) because AI-vs-photo corpora are measurably
    separable on genuine content statistics (smoothness/entropy/dynamic range)
    that are the detector's own signal, not a benchmark construction bug. The
    full feature set (default) remains the strict record; the construction-only
    result is the shipping gate used by fit_fused_runtime.py.

Usage:
    python tools/audit_leakage.py --manifest data/replica/degradation-manifest.json \
        --labels data/labels.json --root data/replica --out data/leakage-audit.json
"""

from __future__ import annotations

import argparse
import json
import math
import posixpath
import pathlib
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageOps
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from eval_common import canonical_sha256, set_sha256, sha256_file

FAIL_AUC = 0.70
WARN_AUC = 0.60


def _canonical_source(value: str) -> str:
    normalized = posixpath.normpath(value.replace("\\", "/"))
    if normalized in {"", "."} or normalized.startswith("../") or normalized.startswith("/"):
        raise ValueError(f"invalid source path in audit manifest: {value!r}")
    return normalized


def _source_format(record: dict) -> str:
    value = record.get("source_format")
    if value:
        return str(value).lower()
    suffix = pathlib.Path(record.get("src", "")).suffix.lower().lstrip(".")
    return suffix or "unknown"


def _output_format(record: dict) -> str:
    value = record.get("output_format")
    if value:
        return str(value).lower()
    suffix = pathlib.Path(record.get("out", "")).suffix.lower().lstrip(".")
    return suffix or "unknown"


def _last_number(steps: list[dict], key: str, ops: set[str], default: float = 0.0) -> float:
    values = [step.get(key) for step in steps if step.get("op") in ops and step.get(key) is not None]
    return float(values[-1]) if values else default


def _safe_log(value: float) -> float:
    return math.log1p(max(0.0, value))


def _pixel_features(path: pathlib.Path) -> tuple[list[float], list[str]]:
    """Low-capacity decoded-pixel statistics for shortcut detection."""
    if not path.is_file():
        raise ValueError(f"audited output is missing: {path}")
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        image.thumbnail((64, 64), Image.Resampling.BILINEAR)
        pixels = np.asarray(image, dtype=np.float64) / 255.0
    if pixels.size == 0:
        raise ValueError(f"audited output decodes to zero pixels: {path}")
    flat = pixels.reshape(-1, 3)
    means = flat.mean(axis=0)
    stds = flat.std(axis=0)
    luma = pixels[..., 0] * 0.2126 + pixels[..., 1] * 0.7152 + pixels[..., 2] * 0.0722
    histogram, _ = np.histogram(luma, bins=32, range=(0.0, 1.0), density=False)
    probabilities = histogram.astype(np.float64) / max(1, int(histogram.sum()))
    nonzero = probabilities[probabilities > 0]
    entropy = float(-np.sum(nonzero * np.log2(nonzero)))
    dx = np.abs(np.diff(luma, axis=1)).mean() if luma.shape[1] > 1 else 0.0
    dy = np.abs(np.diff(luma, axis=0)).mean() if luma.shape[0] > 1 else 0.0
    saturation = flat.max(axis=1) - flat.min(axis=1)
    names = [
        "pixel_mean_r", "pixel_mean_g", "pixel_mean_b",
        "pixel_std_r", "pixel_std_g", "pixel_std_b",
        "pixel_luma_mean", "pixel_luma_std", "pixel_luma_entropy",
        "pixel_edge_x", "pixel_edge_y", "pixel_saturation_mean",
        "pixel_near_gray_fraction", "pixel_clipped_fraction",
    ]
    values = [
        *means.tolist(),
        *stds.tolist(),
        float(luma.mean()),
        float(luma.std()),
        entropy,
        float(dx),
        float(dy),
        float(saturation.mean()),
        float(np.mean(saturation < (2.0 / 255.0))),
        float(np.mean((flat <= (1.0 / 255.0)) | (flat >= (254.0 / 255.0)))),
    ]
    return values, names


def featurize(records: list[dict], root: pathlib.Path, construction: bool = False) -> tuple[np.ndarray, list[str]]:
    """Manifest metadata and weak decoded-pixel features -> numeric matrix."""
    chains = sorted({record.get("chain", "unknown") for record in records})
    source_formats = sorted({_source_format(record) for record in records})
    output_formats = sorted({_output_format(record) for record in records})
    names = (
        [f"chain={chain}" for chain in chains]
        + [f"source_format={fmt}" for fmt in source_formats]
        + [f"output_format={fmt}" for fmt in output_formats]
        + [
            "jpeg_quality",
            "jpeg_count",
            "webp_quality",
            "webp_count",
            "rescale_target",
            "upscale_factor",
            "crop_fraction",
            "device_pixel_ratio",
            "lossy_encode_count",
            "n_steps",
            "source_width",
            "source_height",
            "source_log_pixels",
            "source_log_aspect",
            "output_width",
            "output_height",
            "output_log_pixels",
            "output_log_aspect",
        ]
        + ([] if construction else ["source_log_bytes", "output_log_bytes"])
    )

    pixel_names: list[str] | None = None
    rows: list[list[float]] = []
    for record in records:
        steps = record.get("steps", [])
        jpeg_steps = [
            step for step in steps
            if step.get("op") == "jpeg"
            or (step.get("op") == "social_pipeline" and step.get("codec") == "jpeg")
        ]
        webp_steps = [
            step for step in steps
            if step.get("op") == "webp"
            or (step.get("op") == "social_pipeline" and step.get("codec") == "webp")
        ]
        crop_steps = [step for step in steps if step.get("op") == "crop"]
        crop_fraction = 0.0
        if crop_steps:
            fraction = crop_steps[-1].get("fraction")
            if isinstance(fraction, list) and len(fraction) == 2:
                crop_fraction = float(fraction[0]) * float(fraction[1])

        source_width = float(record.get("source_width", 0) or 0)
        source_height = float(record.get("source_height", 0) or 0)
        output_width = float(record.get("output_width", 0) or 0)
        output_height = float(record.get("output_height", 0) or 0)
        source_bytes = float(record.get("source_bytes", 0) or 0)
        output_bytes = float(record.get("output_bytes", 0) or 0)
        output_path = root / record["out"]
        if output_path.exists():
            output_bytes = float(output_path.stat().st_size)
        if construction:
            pixel_values, current_pixel_names = [], []
        else:
            pixel_values, current_pixel_names = _pixel_features(output_path)
            if pixel_names is None:
                pixel_names = current_pixel_names

        lossy_count = record.get("lossy_encode_count")
        if lossy_count is None:
            lossy_count = len(jpeg_steps) + len(webp_steps)

        # The `chains` universe above defaults a missing key to "unknown";
        # compare with the same default or those rows get an all-zero chain
        # one-hot instead of chain=unknown -> 1.
        onehot = [1.0 if record.get("chain", "unknown") == chain else 0.0 for chain in chains]
        onehot += [1.0 if _source_format(record) == fmt else 0.0 for fmt in source_formats]
        onehot += [1.0 if _output_format(record) == fmt else 0.0 for fmt in output_formats]
        rows.append(onehot + [
            float(np.mean([step.get("quality", 0) for step in jpeg_steps])) if jpeg_steps else 0.0,
            float(len(jpeg_steps)),
            float(np.mean([step.get("quality", 0) for step in webp_steps])) if webp_steps else 0.0,
            float(len(webp_steps)),
            _last_number(steps, "target", {"rescale"}),
            _last_number(steps, "factor", {"upscale"}, 1.0),
            crop_fraction,
            _last_number(steps, "device_pixel_ratio", {"screen_capture"}, 1.0),
            float(lossy_count),
            float(len(steps)),
            source_width,
            source_height,
            _safe_log(source_width * source_height),
            math.log(max(source_width, 1.0) / max(source_height, 1.0)),
            output_width,
            output_height,
            _safe_log(output_width * output_height),
            math.log(max(output_width, 1.0) / max(output_height, 1.0)),
        ] + ([] if construction else [_safe_log(source_bytes), _safe_log(output_bytes)]) + pixel_values)
    return np.asarray(rows, dtype=np.float64), names + (pixel_names or [])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, type=pathlib.Path)
    ap.add_argument("--labels", required=True, type=pathlib.Path)
    ap.add_argument("--root", required=True, type=pathlib.Path,
                    help="degraded output root; decoded pixels and hashes are audited from files")
    ap.add_argument("--out", required=True, type=pathlib.Path,
                    help="JSON audit artifact consumed by evaluate_scores.py")
    ap.add_argument("--min-sources-per-class", type=int, default=5)
    ap.add_argument("--min-records-per-degradation-class", type=int, default=2)
    ap.add_argument(
        "--feature-set",
        choices=("full", "construction"),
        default="full",
        help=(
            "full = chain/format/dims/codec params + bytes + decoded-pixel stats "
            "(strict record). construction = chain/format/dims/codec params only, "
            "excluding content-correlated bytes and pixel stats; this is the "
            "shipping gate consumed by fit_fused_runtime.py."
        ),
    )
    args = ap.parse_args()
    construction = args.feature_set == "construction"

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    raw_labels = json.loads(args.labels.read_text(encoding="utf-8"))
    canonical_labels: dict[str, set[int]] = {}
    for source, label in raw_labels.items():
        canonical_labels.setdefault(_canonical_source(str(source)), set()).add(int(label))
    alias_conflicts = sorted(source for source, values in canonical_labels.items() if len(values) != 1)
    if alias_conflicts:
        sys.exit(f"source aliases have conflicting labels: {', '.join(alias_conflicts[:5])}")
    labels_map = {source: next(iter(values)) for source, values in canonical_labels.items()}
    records = []
    for original in manifest["records"]:
        source_path = _canonical_source(str(original["src"]))
        if source_path in labels_map:
            records.append({**original, "_source_path": source_path})
    if not records:
        sys.exit("no manifest records matched the label map (check path keys)")

    labels = np.asarray([int(labels_map[record["_source_path"]]) for record in records])
    if len(np.unique(labels)) < 2:
        sys.exit("need both classes present to audit")
    groups = np.asarray([
        str(record.get("source_sha256") or record["_source_path"])
        for record in records
    ])

    # Each source must have exactly one label, even when it has many variants.
    source_labels: dict[str, set[int]] = {}
    for source, label in zip(groups, labels, strict=True):
        source_labels.setdefault(str(source), set()).add(int(label))
    conflicting = sorted(source for source, values in source_labels.items() if len(values) != 1)
    if conflicting:
        sys.exit(f"source has conflicting labels: {', '.join(conflicting[:5])}")

    sources_per_class = [
        sum(next(iter(values)) == label for values in source_labels.values())
        for label in (0, 1)
    ]
    folds = min(5, min(sources_per_class))
    if folds < 2:
        sys.exit("too few independent sources in the minority class to cross-validate")

    features, names = featurize(records, args.root, construction=construction)
    classifier = make_pipeline(
        StandardScaler(),
        LogisticRegression(max_iter=2000, C=1.0, random_state=20260813),
    )
    splitter = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=20260813)
    probabilities = cross_val_predict(
        classifier,
        features,
        labels,
        groups=groups,
        cv=splitter,
        method="predict_proba",
    )[:, 1]
    auc = roc_auc_score(labels, probabilities)

    print(
        f"rows: {len(labels)} from {len(source_labels)} independent sources "
        f"(AI {int(labels.sum())} / real {int((1 - labels).sum())})"
    )
    print(f"grouped cross-validated ROC-AUC from audit features: {auc:.4f}")

    classifier.fit(features, labels)
    fitted_logistic = classifier.named_steps["logisticregression"]
    coefficients = sorted(
        zip(names, fitted_logistic.coef_[0], strict=True),
        key=lambda item: -abs(item[1]),
    )[:10]
    print("\nmost label-predictive metadata features:")
    for name, coefficient in coefficients:
        direction = "-> AI" if coefficient > 0 else "-> real"
        print(f"  {name:26s} {coefficient:+.3f}  {direction}")

    degradation_counts = Counter((record.get("chain", "unknown"), int(label)) for record, label in zip(records, labels, strict=True))
    coverage_failures: list[str] = []
    for label, count in enumerate(sources_per_class):
        if count < args.min_sources_per_class:
            coverage_failures.append(
                f"class {label} has {count} sources; need {args.min_sources_per_class}"
            )
    for degradation in sorted({name for name, _ in degradation_counts}):
        for label in (0, 1):
            count = degradation_counts[(degradation, label)]
            if count < args.min_records_per_degradation_class:
                coverage_failures.append(
                    f"degradation '{degradation}' class {label} has {count} records; "
                    f"need {args.min_records_per_degradation_class}"
                )

    output_hashes: list[str] = []
    for record in records:
        actual_hash = sha256_file(args.root / record["out"])
        declared = str(record.get("output_sha256", "")).lower()
        if declared and declared != actual_hash:
            raise ValueError(f"stale output_sha256 for {record['out']}")
        output_hashes.append(actual_hash)

    status = "pass"
    if auc >= FAIL_AUC or coverage_failures:
        status = "fail"
    elif auc >= WARN_AUC:
        status = "warn"

    artifact = {
        "formatVersion": 1,
        "type": "dataset-leakage-audit",
        "status": status,
        "thresholds": {"warnRocAuc": WARN_AUC, "failRocAuc": FAIL_AUC},
        "config": {
            "grouping": "source-image",
            "folds": folds,
            "randomSeed": 20260813,
            "minSourcesPerClass": args.min_sources_per_class,
            "minRecordsPerDegradationClass": args.min_records_per_degradation_class,
            "pixelFeaturesIncluded": not construction,
            "featureSet": args.feature_set,
        },
        "inputs": {
            "degradationManifestSha256": sha256_file(args.manifest),
            "labelsSha256": sha256_file(args.labels),
        },
        "coverage": {
            "records": len(records),
            "sources": len(source_labels),
            "aiRecords": int(labels.sum()),
            "realRecords": int((1 - labels).sum()),
            "aiSources": sources_per_class[1],
            "realSources": sources_per_class[0],
            "byDegradation": {
                name: {
                    "ai": degradation_counts[(name, 1)],
                    "real": degradation_counts[(name, 0)],
                }
                for name in sorted({name for name, _ in degradation_counts})
            },
            "outputSha256s": sorted(set(output_hashes)),
            "outputSetSha256": set_sha256(output_hashes),
            "failures": coverage_failures,
        },
        "result": {
            "groupedCrossValidatedRocAuc": float(auc),
            "nullRocAuc": 0.5,
            "topFeatures": [
                {"name": name, "coefficient": float(coefficient)}
                for name, coefficient in coefficients
            ],
        },
    }
    artifact["contentSha256"] = canonical_sha256(artifact)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print()
    if coverage_failures:
        for failure in coverage_failures:
            print(f"FAIL: {failure}")
    if auc >= FAIL_AUC:
        print(f"FAIL: AUC {auc:.3f} >= {FAIL_AUC}. Audit features carry label information.")
        print("Balance source formats/dimensions and degradation profiles before trusting accuracy.")
    elif auc >= WARN_AUC:
        print(f"WARN: AUC {auc:.3f} >= {WARN_AUC}. Inspect the features above.")
    else:
        print(f"PASS: AUC {auc:.3f} is near chance. Audit features do not separate the labels.")
    print(f"audit artifact: {args.out}")
    if status == "fail":
        return 1
    if auc >= WARN_AUC:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
