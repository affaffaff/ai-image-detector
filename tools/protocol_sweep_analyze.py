#!/usr/bin/env python3
"""Analyze the delivery-path protocol sweep (data/protocol-sweep/scores.csv).

Reporting format follows c143-survey PROTOCOL.md:
one row per pipeline: pipeline, n_ai, n_real, balanced_acc, recall,
specificity, plus a held-out-generator note and the count clearing 75.0%.

Intervals: percentile bootstrap, 5,000 resamples, seed fixed. Real images are
resampled by source cluster (photographer/collection). The AI side has only
two generator clusters, so the image-level bootstrap interval is reported with
that stated limitation and per-generator recall is reported alongside.
"""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/protocol-sweep"
THRESHOLD = 0.65
BOOT = 5000
SEED = 20260815
# p95 |python - browser| raw-score drift measured in tools/protocol_parity_check.py
# on 150 sealed eval images, concentrated in the upscale regime.
PARITY_P95 = 0.158


def fix_id(image_id: str) -> str:
    """Undo the cp1252 mis-decode of labels.json keys (14 real sources)."""
    try:
        return image_id.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return image_id


def load_rows():
    rows = []
    with open(OUT / "scores.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            r["image_id"] = fix_id(r["image_id"])
            r["label"] = int(r["label"])
            r["calibrated"] = float(r["calibrated"])
            r["decision_ai"] = int(r["calibrated"] >= THRESHOLD)
            r["upscale_regime"] = int(r["upscale_regime"])
            rows.append(r)
    return rows


def metrics(rows):
    ai = [r for r in rows if r["label"] == 1]
    real = [r for r in rows if r["label"] == 0]
    tpr = float(np.mean([r["decision_ai"] for r in ai])) if ai else float("nan")
    tnr = float(1 - np.mean([r["decision_ai"] for r in real])) if real else float("nan")
    return (tpr + tnr) / 2, tpr, tnr, len(ai), len(real)


def bootstrap_ba(rows, rng):
    """Cluster bootstrap on the real side; image-level on the 2-generator AI side."""
    by_cluster = defaultdict(list)
    ai_rows = []
    for r in rows:
        (ai_rows if r["label"] == 1 else by_cluster[r["cluster_id"]]).append(r)
    clusters = sorted(by_cluster)
    bas = []
    ai_arr = np.asarray(ai_rows)
    for _ in range(BOOT):
        if len(ai_arr):
            idx = rng.integers(0, len(ai_arr), len(ai_arr))
            tpr = float(np.mean([ai_arr[i]["decision_ai"] for i in idx]))
        else:
            tpr = float("nan")
        picked = rng.choice(clusters, len(clusters), replace=True)
        sample = [r for c in picked for r in by_cluster[c]]
        tnr = float(1 - np.mean([r["decision_ai"] for r in sample]))
        bas.append((tpr + tnr) / 2)
    return float(np.percentile(bas, 2.5)), float(np.percentile(bas, 97.5))


def main() -> None:
    rows = load_rows()
    rng = np.random.default_rng(SEED)
    by_cond = defaultdict(list)
    for r in rows:
        by_cond[r["condition"]].append(r)

    order = ["none", "jpeg90", "jpeg75", "jpeg60", "cms1600", "cms1024",
             "cms640", "webp80", "rescale90", "sieve_web", "sieve_hard"]

    labels = json.load(open(ROOT / "data/holdout/labels.json", encoding="utf-8"))
    assert {r["image_id"] for r in rows} == set(labels), "coverage mismatch"

    print(f"{'pipeline':<12} {'n_ai':>4} {'n_real':>6} {'bal_acc':>8} "
          f"{'recall':>7} {'spec':>7} {'95% CI':>17} {'>=75%':>6} {'upsc%':>6} {'atrisk':>6}")
    summary = {}
    passes = 0
    for cond in order:
        rs = by_cond[cond]
        ba, tpr, tnr, n_ai, n_real = metrics(rs)
        lo, hi = bootstrap_ba(rs, rng)
        up = float(np.mean([r["upscale_regime"] for r in rs]))
        # images close enough to the boundary that measured Python/browser
        # drift (p95) could flip them
        risk = sum(1 for r in rs if abs(r["calibrated"] - THRESHOLD) <= PARITY_P95)
        ok = ba >= 0.75
        passes += ok
        summary[cond] = {
            "n_ai": n_ai, "n_real": n_real,
            "balanced_acc": ba, "recall": tpr, "specificity": tnr,
            "ci95": [lo, hi], "upscale_share": up, "boundary_at_risk": risk,
        }
        print(f"{cond:<12} {n_ai:>4} {n_real:>6} {ba * 100:>7.1f}% "
              f"{tpr * 100:>6.1f}% {tnr * 100:>6.1f}% "
              f"[{lo * 100:5.1f},{hi * 100:5.1f}] {'PASS' if ok else 'FAIL':>6} "
              f"{up * 100:>5.1f}% {risk:>6}")

    print(f"\npipelines clearing 75.0%: {passes}/11")

    print("\nper-generator recall (LOGO with 2 generators is degenerate; "
          "this is each generator scored against all real, fixed shipped curve):")
    for cond in order:
        rs = by_cond[cond]
        per_gen = {}
        for gen in ("kandinsky-2.2", "sd-1.5"):
            g = [r for r in rs if r["label"] == 1 and r["cluster_id"] == f"ai:{gen}"]
            per_gen[gen] = float(np.mean([r["decision_ai"] for r in g])) if g else float("nan")
        print(f"  {cond:<12} kandinsky {per_gen['kandinsky-2.2'] * 100:5.1f}%   "
              f"sd-1.5 {per_gen['sd-1.5'] * 100:5.1f}%")

    mean_ba = float(np.mean([summary[c]["balanced_acc"] for c in order]))
    worst = min(order, key=lambda c: summary[c]["balanced_acc"])
    print(f"\nmean BA across 11: {mean_ba * 100:.1f}%   "
          f"worst: {worst} {summary[worst]['balanced_acc'] * 100:.1f}%")

    (OUT / "summary.json").write_text(json.dumps({
        "threshold": THRESHOLD,
        "corpus": "data/holdout/in pristine; 180 AI (kandinsky-2.2 x80, sd-1.5 x100) "
                  "+ 534 real (129 source clusters)",
        "modelSha256": json.load(open(ROOT / "models/calibration/fused.json"))["modelSha256"],
        "calibration": "models/calibration/fused.json (shipped, quarantined curve)",
        "scoring": "Python onnxruntime INT8, official_center; parity vs sealed browser path "
                   "median |diff| 1.6e-4, p95 0.158 concentrated in upscale regime",
        "bootstrap": {"samples": BOOT, "seed": SEED,
                      "note": "real side clustered by source; AI side image-level "
                              "(2 generator clusters only)"},
        "passes75": passes,
        "mean_balanced_acc": mean_ba,
        "conditions": summary,
    }, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT / 'summary.json'}")


if __name__ == "__main__":
    main()
