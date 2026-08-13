#!/usr/bin/env python3
"""
End-to-end smoke test for fit_calibration.py on synthetic data.

Two overlapping score distributions (real ~ N(0.35, 0.12), AI ~ N(0.7, 0.12))
whose optimal boundary is nowhere near 0.65 raw — exactly the situation the
shift exists for. Asserts on the emitted knot table:

  1. xs strictly increasing, ys non-decreasing (the legitimacy invariant);
  2. <= max_knots knots;
  3. balanced accuracy at the FIXED 0.65 threshold after calibration, on a
     held-out sample, is within tolerance of the sweep-optimal balanced
     accuracy — i.e. the shift actually moved the operating point to 0.65.

Run: python tools/test_fit_calibration_smoke.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np

HERE = pathlib.Path(__file__).parent
RNG = np.random.default_rng(1234)


def synth(n: int) -> tuple[np.ndarray, np.ndarray]:
    labels = RNG.integers(0, 2, size=n)
    scores = np.where(
        labels == 1,
        RNG.normal(0.70, 0.12, size=n),
        RNG.normal(0.35, 0.12, size=n),
    ).clip(0.0, 1.0)
    return scores.astype(np.float64), labels.astype(np.int64)


def balanced_accuracy(labels: np.ndarray, scores: np.ndarray, thr: float) -> float:
    pred = scores >= thr
    pos = labels == 1
    tpr = (pred & pos).sum() / pos.sum()
    tnr = (~pred & ~pos).sum() / (~pos).sum()
    return 0.5 * (tpr + tnr)


def main() -> int:
    fit_scores, fit_labels = synth(4000)
    ev_scores, ev_labels = synth(2000)

    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        np.save(tdp / "s.npy", fit_scores)
        np.save(tdp / "l.npy", fit_labels)
        np.save(tdp / "es.npy", ev_scores)
        np.save(tdp / "el.npy", ev_labels)
        out = tdp / "cal.json"

        subprocess.run(
            [
                sys.executable,
                str(HERE / "fit_calibration.py"),
                "--scores", str(tdp / "s.npy"),
                "--labels", str(tdp / "l.npy"),
                "--eval-scores", str(tdp / "es.npy"),
                "--eval-labels", str(tdp / "el.npy"),
                "--id", "smoke",
                "--out", str(out),
            ],
            check=True,
        )

        table = json.loads(out.read_text())
        xs = np.array(table["xs"])
        ys = np.array(table["ys"])

        # 1. Monotone — the whole legitimacy argument.
        assert np.all(np.diff(xs) > 0), "xs must be strictly increasing"
        assert np.all(np.diff(ys) >= 0), "ys must be non-decreasing"

        # 2. Compact.
        assert len(xs) <= 64, f"expected <= 64 knots, got {len(xs)}"

        # 3. The boundary landed on 0.65: BA at the fixed threshold on held-out
        # data must be close to the best achievable BA at ANY threshold.
        ev_cal = np.interp(ev_scores, xs, ys)
        ba_at_065 = balanced_accuracy(ev_labels, ev_cal, 0.65)
        sweep = [balanced_accuracy(ev_labels, ev_cal, t) for t in np.linspace(0.01, 0.99, 197)]
        ba_best = max(sweep)
        assert ba_best - ba_at_065 <= 0.01, (
            f"boundary not on 0.65: BA@0.65={ba_at_065:.4f} vs best={ba_best:.4f}"
        )

        # Sanity: the synthetic problem is separable enough to be meaningful.
        assert ba_at_065 > 0.85, f"suspiciously low BA on easy synthetic data: {ba_at_065:.4f}"

        print(f"smoke ok: BA@0.65={ba_at_065:.4f}, best={ba_best:.4f}, knots={len(xs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
