#!/usr/bin/env python3
"""Sweep and freeze the graphic-content gate thresholds.

Inputs are component-statistics CSVs produced by the extension's own runtime
(`score_dataset_browser.mjs --stats-only`), so the numbers being swept are
exactly the numbers the shipped code computes.

Selection discipline: the sweep sees ONLY the fit split of the photo/AI
corpus plus the locally generated graphics nuisance set. The eval split is
never an input here; it is scored once, later, with the frozen thresholds.

Constraints and objective:
  - zero gate fires on fit-split AI images (a fire on an AI image forces a
    false "real" verdict — direct TPR loss);
  - at most --max-real-rate fires on fit-split real photos (label-harmless,
    kept low so the cap stays rare outside its target class);
  - subject to those, maximize recall on the graphics nuisance set;
  - ties break toward the more conservative gate (harder to fire).

Output: the chosen thresholds as JSON plus rate tables, ready to be frozen
into src/shared/graphic-gate.js (GRAPHIC_GATE_THRESHOLDS).
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import pathlib
from collections import defaultdict


def load(path: pathlib.Path) -> list[dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    if not rows:
        raise SystemExit(f"{path} has no rows")
    required = {"graphic_flat", "graphic_soft", "graphic_hard", "graphic_top8", "graphic_maxpatchsoft", "graphic_pixels"}
    missing = required - set(rows[0])
    if missing:
        raise SystemExit(f"{path} is missing columns: {sorted(missing)}")
    return rows


def fires(row: dict, t: dict, min_pixels: int = 1024) -> bool:
    return (
        int(row["graphic_pixels"]) >= min_pixels
        and float(row["graphic_flat"]) >= t["minFlatFraction"]
        and float(row["graphic_soft"]) <= t["maxSoftFraction"]
        and float(row["graphic_hard"]) >= t["minHardFraction"]
        and float(row["graphic_top8"]) >= t["minTop8Mass"]
        and float(row["graphic_maxpatchsoft"]) <= t["maxPatchSoftFraction"]
    )


def rate(rows: list[dict], t: dict) -> tuple[int, int]:
    fired = sum(1 for row in rows if fires(row, t))
    return fired, len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fit-stats", required=True, type=pathlib.Path)
    parser.add_argument("--graphics-stats", required=True, type=pathlib.Path)
    parser.add_argument("--max-real-rate", type=float, default=0.02)
    parser.add_argument("--out", type=pathlib.Path)
    args = parser.parse_args()

    fit = load(args.fit_stats)
    graphics = load(args.graphics_stats)
    fit_ai = [row for row in fit if row["label"] == "1"]
    fit_real = [row for row in fit if row["label"] == "0"]
    if not fit_ai or not fit_real:
        raise SystemExit("fit stats must contain both labels")

    grid = {
        "minFlatFraction": [0.50, 0.55, 0.60, 0.65, 0.70],
        "maxSoftFraction": [0.10, 0.12, 0.14, 0.16, 0.18],
        "minHardFraction": [0.002, 0.004, 0.006, 0.008],
        "minTop8Mass": [0.50, 0.55, 0.60, 0.65],
        "maxPatchSoftFraction": [0.15, 0.18, 0.20, 0.22, 0.25, 0.30],
    }

    best = None
    for values in itertools.product(*grid.values()):
        t = dict(zip(grid.keys(), values))
        ai_fired, ai_total = rate(fit_ai, t)
        if ai_fired > 0:
            continue
        real_fired, real_total = rate(fit_real, t)
        if real_fired / real_total > args.max_real_rate:
            continue
        graphics_fired, graphics_total = rate(graphics, t)
        recall = graphics_fired / graphics_total
        # Conservatism tiebreak: fewer real fires, then a harder-to-fire gate.
        key = (
            recall,
            -real_fired,
            t["minFlatFraction"],
            -t["maxSoftFraction"],
            t["minTop8Mass"],
            -t["maxPatchSoftFraction"],
            t["minHardFraction"],
        )
        if best is None or key > best[0]:
            best = (key, t, {
                "fitAiFired": ai_fired, "fitAiTotal": ai_total,
                "fitRealFired": real_fired, "fitRealTotal": real_total,
                "graphicsFired": graphics_fired, "graphicsTotal": graphics_total,
                "graphicsRecall": recall,
            })

    if best is None:
        raise SystemExit("no threshold combination satisfied the constraints")

    _, chosen, summary = best

    by_degradation: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    by_category: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in graphics:
        fired = fires(row, chosen)
        for keymap, key in ((by_degradation, row.get("degradation", "?")), (by_category, row.get("generator", "?"))):
            keymap[key][1] += 1
            keymap[key][0] += 1 if fired else 0

    report = {
        "chosenThresholds": chosen,
        "summary": summary,
        "graphicsByDegradation": {k: {"fired": v[0], "total": v[1], "rate": v[0] / v[1]} for k, v in sorted(by_degradation.items())},
        "graphicsByCategory": {k: {"fired": v[0], "total": v[1], "rate": v[0] / v[1]} for k, v in sorted(by_category.items())},
        "inputs": {
            "fitStats": str(args.fit_stats),
            "graphicsStats": str(args.graphics_stats),
            "maxRealRate": args.max_real_rate,
        },
    }
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
