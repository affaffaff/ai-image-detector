#!/usr/bin/env python3
"""
Fit a monotone calibration curve and place the decision boundary on 0.65.

Runs offline, on CPU, in seconds. Emits a small JSON table of knots that the
extension loads at runtime (src/fusion/calibration.js).

Two steps, composed into one shipped curve:

  1. Isotonic regression maps raw scores to true empirical P(AI | score).
  2. A piecewise-linear shift sends the balanced-accuracy-optimal threshold t*
     to 0.65, stretching [0, t*] onto [0, 0.65] and [t*, 1] onto [0.65, 1].

Both steps are non-decreasing, so the composition is non-decreasing: no pair of
images ever swaps order, and ROC/AUC are untouched. What changes is only where
the fixed 0.65 cut falls on a curve we already had.

Usage:
    python tools/fit_calibration.py \
        --scores fit_scores.npy --labels fit_labels.npy \
        --eval-scores holdout_scores.npy --eval-labels holdout_labels.npy \
        --id detector-primary \
        --out models/calibration/detector-primary.json

IMPORTANT: --scores must come from a split that was NOT used to select the
model or fit the fusion weights. Fitting calibration on selection data tunes the
mapping to noise and lands the boundary slightly wrong on anything new.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import numpy as np
from sklearn.isotonic import IsotonicRegression

TARGET_THRESHOLD = 0.65


def balanced_accuracy(labels: np.ndarray, scores: np.ndarray, thr: float) -> float:
    pred = scores >= thr
    pos = labels == 1
    neg = ~pos
    if not pos.any() or not neg.any():
        raise ValueError("need both classes present")
    tpr = float((pred & pos).sum()) / float(pos.sum())
    tnr = float((~pred & neg).sum()) / float(neg.sum())
    return 0.5 * (tpr + tnr)


def best_threshold(labels: np.ndarray, scores: np.ndarray) -> tuple[float, float]:
    """Sweep every distinct score and return (t*, balanced accuracy there)."""
    candidates = np.unique(scores)
    # Midpoints avoid sitting exactly on a tie.
    if candidates.size > 1:
        candidates = np.concatenate(
            [candidates, (candidates[:-1] + candidates[1:]) / 2.0]
        )
    best_t, best_ba = 0.5, -1.0
    for t in candidates:
        ba = balanced_accuracy(labels, scores, float(t))
        if ba > best_ba:
            best_t, best_ba = float(t), ba
    return best_t, best_ba


def shift_to_target(y: np.ndarray, t_star: float, target: float = TARGET_THRESHOLD) -> np.ndarray:
    """Piecewise-linear, strictly increasing map sending t_star -> target."""
    eps = 1e-9
    t = min(max(t_star, eps), 1.0 - eps)
    out = np.empty_like(y, dtype=np.float64)
    lower = y <= t
    out[lower] = y[lower] / t * target
    out[~lower] = target + (y[~lower] - t) / (1.0 - t) * (1.0 - target)
    return np.clip(out, 0.0, 1.0)


def thin(xs: np.ndarray, ys: np.ndarray, max_knots: int) -> tuple[np.ndarray, np.ndarray]:
    """Drop collinear interior points, then subsample to max_knots."""
    keep = [0]
    for i in range(1, len(xs) - 1):
        if abs(ys[i] - ys[keep[-1]]) > 1e-9 or abs(ys[i + 1] - ys[i]) > 1e-9:
            keep.append(i)
    keep.append(len(xs) - 1)
    idx = np.array(sorted(set(keep)))
    if len(idx) > max_knots:
        sel = np.linspace(0, len(idx) - 1, max_knots).round().astype(int)
        idx = idx[np.unique(sel)]
    return xs[idx], ys[idx]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scores", required=True, help=".npy raw scores (calibration split)")
    ap.add_argument("--labels", required=True, help=".npy labels, 1 = AI")
    ap.add_argument("--eval-scores", help=".npy raw scores (held-out report split)")
    ap.add_argument("--eval-labels", help=".npy labels for the report split")
    ap.add_argument("--id", default="unnamed", help="signal identifier")
    ap.add_argument("--max-knots", type=int, default=64)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    args = ap.parse_args()

    raw = np.load(args.scores).astype(np.float64).ravel()
    lab = np.load(args.labels).astype(int).ravel()
    if raw.shape != lab.shape:
        sys.exit("scores and labels must be the same length")

    # --- step 1: isotonic ----------------------------------------------------
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    iso.fit(raw, lab)
    cal = iso.predict(raw)

    # --- step 2: locate and move the boundary --------------------------------
    t_star, ba_star = best_threshold(lab, cal)
    print(f"[{args.id}] optimal threshold on calibrated scores: {t_star:.4f}  BA={ba_star:.4f}")
    if t_star < 0.02 or t_star > 0.98:
        print("  WARNING: optimal threshold is near an endpoint. The remap will be", file=sys.stderr)
        print("  extreme and unstable. Check for class imbalance or a degenerate signal.", file=sys.stderr)

    ba_naive = balanced_accuracy(lab, cal, TARGET_THRESHOLD)
    print(f"[{args.id}] BA at 0.65 WITHOUT the shift: {ba_naive:.4f}  (delta {ba_star - ba_naive:+.4f})")

    # --- compose into one shipped curve --------------------------------------
    grid = np.linspace(raw.min(), raw.max(), 512)
    ys = shift_to_target(iso.predict(grid), t_star)
    xs, ys = thin(grid, ys, args.max_knots)

    assert np.all(np.diff(xs) > 0), "xs must be strictly increasing"
    assert np.all(np.diff(ys) >= -1e-12), "ys must be non-decreasing"

    table = {
        "id": args.id,
        "xs": [round(float(v), 6) for v in xs],
        "ys": [round(float(v), 6) for v in ys],
        "fittedOn": pathlib.Path(args.scores).name,
        "n": int(raw.size),
        "tStar": round(t_star, 6),
        "target": TARGET_THRESHOLD,
    }

    # --- honest report on untouched data -------------------------------------
    if args.eval_scores and args.eval_labels:
        ev_raw = np.load(args.eval_scores).astype(np.float64).ravel()
        ev_lab = np.load(args.eval_labels).astype(int).ravel()
        ev_cal = np.interp(ev_raw, xs, ys, left=ys[0], right=ys[-1])
        ba_eval = balanced_accuracy(ev_lab, ev_cal, TARGET_THRESHOLD)
        print(f"[{args.id}] HELD-OUT BA at 0.65 after shift: {ba_eval:.4f}   <-- the number that counts")
        table["heldOutBA"] = round(ba_eval, 6)
    else:
        print("  NOTE: no held-out set given. The numbers above are fit-set optimistic.", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(table, indent=2) + "\n")
    print(f"[{args.id}] wrote {args.out} ({len(xs)} knots)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
