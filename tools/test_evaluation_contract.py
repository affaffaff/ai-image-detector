#!/usr/bin/env python3
"""Integration test for audit-bound calibration and fixed-threshold evaluation."""

from __future__ import annotations

import csv
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

from eval_common import canonical_sha256, set_sha256


HERE = pathlib.Path(__file__).parent
MODEL_HASH = "a" * 64
MANIFEST_HASH = "b" * 64


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, *args], capture_output=True, text=True)


def main() -> int:
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        rows = []
        hashes = []
        for split_index, split in enumerate(("calibration", "eval")):
            for label in (0, 1):
                for index in range(100):
                    payload = f"{split}:{label}:{index}".encode()
                    image_hash = hashlib.sha256(payload).hexdigest()
                    image = root / f"{image_hash}.bin"
                    image.write_bytes(payload)
                    hashes.append(image_hash)
                    raw_score = (0.08 + index / 1000) if label == 0 else (0.88 + index / 1000)
                    rows.append({
                        "image_id": f"{split}-{label}-{index}",
                        "path": image.name,
                        "label": label,
                        "generator": f"generator-{split}-{label}-{index}",
                        "split": split,
                        "phash": f"{split_index * 10000 + label * 100 + index:016x}",
                        "degradation": "synthetic-web",
                        "cluster_id": f"source-{split}-{label}-{index}",
                        "image_sha256": image_hash,
                        "dataset_manifest_sha256": MANIFEST_HASH,
                        "model_sha256": MODEL_HASH,
                        "score_official_browser": f"{raw_score:.10f}",
                        "score": f"{raw_score:.10f}",
                    })
        fields = list(rows[0])
        score_set = root / "scores.csv"
        with score_set.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)

        audit = {
            "formatVersion": 1,
            "type": "dataset-leakage-audit",
            "status": "pass",
            "thresholds": {"warnRocAuc": 0.60, "failRocAuc": 0.70},
            "config": {"pixelFeaturesIncluded": True},
            "inputs": {"degradationManifestSha256": MANIFEST_HASH, "labelsSha256": "c" * 64},
            "coverage": {
                "failures": [],
                "outputSha256s": sorted(hashes),
                "outputSetSha256": set_sha256(hashes),
            },
            "result": {"groupedCrossValidatedRocAuc": 0.5},
        }
        audit["contentSha256"] = canonical_sha256(audit)
        audit_path = root / "audit.json"
        audit_path.write_text(json.dumps(audit))

        # Dedicated calibration and eval selections are enforced and hashed.
        curve = root / "curve.json"
        calibrated = root / "calibrated.csv"
        fitted = run(
            str(HERE / "calibrate_score_csv.py"),
            "--set", str(score_set),
            "--audit", str(audit_path),
            "--out", str(calibrated),
            "--curve", str(curve),
        )
        assert fitted.returncode == 0, fitted.stdout + fitted.stderr
        curve_payload = json.loads(curve.read_text())
        assert curve_payload["inputScoreColumn"] == "score_official_browser"
        assert curve_payload["calibrationRowsSha256"] != curve_payload["evalRowsSha256"]

        same_split = run(
            str(HERE / "calibrate_score_csv.py"),
            "--set", str(score_set), "--audit", str(audit_path),
            "--out", str(root / "bad.csv"), "--curve", str(root / "bad.json"),
            "--calibration-split", "eval", "--eval-split", "eval",
        )
        assert same_split.returncode != 0

        non_production = run(
            str(HERE / "calibrate_score_csv.py"),
            "--set", str(score_set), "--audit", str(audit_path),
            "--out", str(root / "bad2.csv"), "--curve", str(root / "bad2.json"),
            "--score-column", "score_native_browser",
        )
        assert non_production.returncode != 0

        config = {
            "formatVersion": 1,
            "id": "synthetic-unseen-generator",
            "scenario": "unseen-generator",
            "split": "eval",
            "scoreColumn": "score",
            "threshold": 0.65,
            "expectedModelSha256": MODEL_HASH,
            "verifyImageFiles": True,
            "phashDistance": 0,
            "gates": {
                "minBalancedAccuracy": 0.75,
                "requireCiLowerBound": True,
                "minImagesPerClass": 100,
                "minClustersPerClass": 100,
                "minAuditCoverage": 1.0,
                "requiredDegradations": {"synthetic-web": {"minImagesPerClass": 100}},
            },
            "bootstrap": {"samples": 200, "confidence": 0.95, "seed": 7},
        }
        config_path = root / "eval-config.json"
        config_path.write_text(json.dumps(config))
        report_path = root / "report.json"
        log_path = root / "eval.jsonl"
        evaluated = run(
            str(HERE / "evaluate_scores.py"),
            "--set", str(calibrated),
            "--audit", str(audit_path),
            "--config", str(config_path),
            "--out", str(report_path),
            "--log", str(log_path),
        )
        assert evaluated.returncode == 0, evaluated.stdout + evaluated.stderr
        report = json.loads(report_path.read_text())
        assert report["status"] == "pass"
        assert set(report["headline"]) == {"truePositiveRate", "trueNegativeRate", "balancedAccuracy"}
        assert report["nullBaselines"]["alwaysReal"]["balancedAccuracy"] == 0.5
        assert report["auditCoverage"]["fraction"] == 1.0
        entry = json.loads(log_path.read_text().splitlines()[0])
        assert entry["entrySha256"] == canonical_sha256(
            {key: value for key, value in entry.items() if key != "entrySha256"}
        )

        print("evaluation contract integration: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
