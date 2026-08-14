#!/usr/bin/env python3
"""
Perceptual dedupe, then split the replica BY GENERATOR.

Two invariants from CLAUDE.md, enforced here rather than trusted:

  1. pHash-dedupe FIRST, across the whole corpus. Near-duplicates that straddle
     a split boundary turn evaluation into a memory test.
  2. Split by GENERATOR, holding entire generators out. Unseen-generator
     balanced accuracy estimates generalization; a random split is inflated by
     generator fingerprints and is not reported.

Three splits, and the third is the one people get wrong:

    fit          model selection, fusion-weight fitting
    calibration  USED FOR NOTHING ELSE. Fitting calibration on data that also
                 drove selection tunes the curve to noise and lands the 0.65
                 boundary slightly wrong on everything new.
    eval         held-out generators. The reported number.

Real images have no generator, so they are split by SOURCE (camera body,
dataset, scrape origin) under the same whole-group rule — otherwise a single
photographer's roll leaks across splits the same way a generator would.

Usage:
    python tools/dedupe_and_split.py --index data/index.json --out data/splits.json

`--index` is a list of records:
    [{"path": "ai/flux/0001.png", "label": 1, "group": "flux-1.0-dev"},
     {"path": "real/dslr/0002.jpg", "label": 0, "group": "canon-r6-personal"}, ...]

`label`: 1 = AI, 0 = real. `group`: generator for AI, source for real.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict

import numpy as np
from PIL import Image

HASH_SIDE = 32   # pre-DCT grayscale side
HASH_KEEP = 8    # top-left DCT block -> 64-bit hash


def dct_matrix(n: int) -> np.ndarray:
    """Orthonormal DCT-II matrix; avoids a scipy dependency."""
    k = np.arange(n).reshape(-1, 1)
    x = np.arange(n).reshape(1, -1)
    m = np.cos(np.pi * (2 * x + 1) * k / (2 * n))
    m[0, :] *= np.sqrt(1 / n)
    m[1:, :] *= np.sqrt(2 / n)
    return m


DCT = dct_matrix(HASH_SIDE)


def phash(path: pathlib.Path) -> int | None:
    """64-bit DCT perceptual hash. Robust to rescale and recompression."""
    try:
        with Image.open(path) as im:
            im.load()
            g = im.convert("L").resize((HASH_SIDE, HASH_SIDE), Image.LANCZOS)
    except Exception:  # noqa: BLE001 - unreadable files are reported, not fatal
        return None
    a = np.asarray(g, dtype=np.float64)
    coeffs = DCT @ a @ DCT.T
    block = coeffs[:HASH_KEEP, :HASH_KEEP].flatten()
    # Exclude DC: it encodes mean brightness, not structure.
    med = np.median(block[1:])
    bits = (block > med).astype(np.uint8)
    out = 0
    for b in bits:
        out = (out << 1) | int(b)
    return out


def dedupe(records: list[dict], hashes: dict[str, int], threshold: int) -> tuple[list[dict], int]:
    """
    Keep one representative per near-duplicate cluster.

    Exact: every candidate is compared against every kept representative via a
    vectorized XOR + popcount. Hash-prefix bucketing is the usual shortcut and
    is WRONG here — numeric adjacency is not Hamming adjacency, so one flipped
    high bit hides a duplicate in a distant bucket. At replica scale (10^3–10^4
    images) the exact sweep is a second of numpy, and a missed cross-split
    duplicate silently inflates the reported accuracy.
    """
    kept: list[dict] = []
    kept_hashes = np.empty(0, dtype=np.uint64)
    dropped = 0

    for rec in records:
        h = hashes.get(rec["path"])
        if h is None:
            continue
        hv = np.uint64(h)
        if kept_hashes.size:
            dist = np.bitwise_count(np.bitwise_xor(kept_hashes, hv))
            if int(dist.min()) <= threshold:
                dropped += 1
                continue
        kept_hashes = np.append(kept_hashes, hv)
        kept.append(rec)
    return kept, dropped


def assign_groups(
    group_counts: dict[str, int], ratios: tuple[float, float, float]
) -> dict[str, str]:
    """
    Greedy whole-group assignment: largest groups first into whichever split is
    furthest below its target share. Whole groups only — that is the point.
    """
    total = sum(group_counts.values())
    targets = {
        "fit": total * ratios[0],
        "calibration": total * ratios[1],
        "eval": total * ratios[2],
    }
    current = {"fit": 0, "calibration": 0, "eval": 0}
    assignment: dict[str, str] = {}
    for group, n in sorted(group_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        split = max(targets, key=lambda s: targets[s] - current[s])
        assignment[group] = split
        current[split] += n
    return assignment


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", required=True, type=pathlib.Path)
    ap.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--phash-threshold", type=int, default=6,
                    help="Hamming distance at or below which two images are duplicates")
    ap.add_argument("--ratios", default="0.5,0.2,0.3",
                    help="fit,calibration,eval share of images (whole groups, so approximate)")
    ap.add_argument(
        "--assignment",
        help=(
            "explicit comma-separated whole-group assignment, for example "
            "flux=eval,sdxl=calibration,sd2=fit; every group must be listed"
        ),
    )
    ap.add_argument(
        "--split-internally",
        default="",
        help=(
            "comma-separated groups to split by image (seen-generator diagnostic). "
            "Other groups stay whole-group holdouts."
        ),
    )
    ap.add_argument(
        "--internal-splits",
        default="fit,calibration,eval",
        help=(
            "splits that --split-internally groups may land in. Use "
            "fit,calibration to keep a seen generator out of eval while a "
            "different generator is the whole-group holdout."
        ),
    )
    args = ap.parse_args()

    records = json.loads(args.index.read_text())
    if not isinstance(records, list) or not records:
        sys.exit("--index must be a non-empty list of records")
    for r in records:
        if not {"path", "label", "group"} <= set(r):
            sys.exit(f"record missing path/label/group: {r}")

    ratios = tuple(float(x) for x in args.ratios.split(","))
    if len(ratios) != 3 or abs(sum(ratios) - 1.0) > 1e-6:
        sys.exit("--ratios must be three numbers summing to 1")

    print(f"hashing {len(records)} images…")
    hashes: dict[str, int] = {}
    unreadable = 0
    for r in records:
        h = phash(args.root / r["path"])
        if h is None:
            unreadable += 1
            continue
        hashes[r["path"]] = h
    if unreadable:
        print(f"  {unreadable} unreadable, excluded")

    kept, dropped = dedupe(records, hashes, args.phash_threshold)
    print(f"dedupe: kept {len(kept)}, dropped {dropped} near-duplicates "
          f"(Hamming <= {args.phash_threshold})")

    group_counts: dict[str, int] = defaultdict(int)
    for r in kept:
        group_counts[r["group"]] += 1
    if len(group_counts) < 3:
        print(f"WARNING: only {len(group_counts)} groups. Whole-generator holdout needs more;",
              file=sys.stderr)
        print("         with too few groups the eval split cannot be 'unseen'.", file=sys.stderr)

    if args.assignment:
        assignment = {}
        for item in args.assignment.split(","):
            try:
                group, split = (part.strip() for part in item.split("=", 1))
            except ValueError:
                sys.exit(f"invalid --assignment item: {item!r}")
            if not group or split not in {"fit", "calibration", "eval"}:
                sys.exit(f"invalid --assignment item: {item!r}")
            if group in assignment:
                sys.exit(f"group assigned twice: {group}")
            assignment[group] = split
        missing_groups = sorted(set(group_counts) - set(assignment))
        unknown_groups = sorted(set(assignment) - set(group_counts))
        if missing_groups or unknown_groups:
            sys.exit(
                "--assignment must list every observed group exactly once; "
                f"missing={missing_groups}, unknown={unknown_groups}"
            )
    else:
        assignment = assign_groups(dict(group_counts), ratios)
    internal = {part.strip() for part in args.split_internally.split(",") if part.strip()}
    unknown_internal = sorted(internal - set(group_counts))
    if unknown_internal:
        sys.exit(f"--split-internally names unknown groups: {unknown_internal}")
    for group in internal:
        assignment[group] = "internal"

    internal_targets = [part.strip() for part in args.internal_splits.split(",") if part.strip()]
    internal_targets = list(dict.fromkeys(internal_targets))
    if not internal_targets or any(name not in {"fit", "calibration", "eval"} for name in internal_targets):
        sys.exit("--internal-splits must be a subset of fit,calibration,eval")

    ratio_by_split = {"fit": ratios[0], "calibration": ratios[1], "eval": ratios[2]}
    internal_weight = sum(ratio_by_split[name] for name in internal_targets)
    if internal_weight <= 0:
        sys.exit("--internal-splits selected splits with zero ratio mass")

    def _internal_split(record: dict) -> str:
        digest = hashes[record["path"]]
        # Keep the historical 5/2/3 bucket mapping when all three splits are open
        # so existing seen-generator diagnostics stay reproducible.
        if internal_targets == ["fit", "calibration", "eval"]:
            bucket = digest % 10
            if bucket < 5:
                return "fit"
            if bucket < 7:
                return "calibration"
            return "eval"
        unit = (digest % 1000) / 1000.0
        cumulative = 0.0
        for name in internal_targets:
            cumulative += ratio_by_split[name] / internal_weight
            if unit < cumulative:
                return name
        return internal_targets[-1]

    splits: dict[str, list[dict]] = {"fit": [], "calibration": [], "eval": []}
    for r in kept:
        split = _internal_split(r) if r["group"] in internal else assignment[r["group"]]
        splits[split].append({
            **r,
            "phash": f"{hashes[r['path']]:016x}",
        })

    # --- invariants, asserted rather than assumed ---------------------------
    seen: dict[str, str] = {}
    for name, rows in splits.items():
        for r in rows:
            if r["group"] in internal:
                continue
            prev = seen.setdefault(r["group"], name)
            assert prev == name, f"group '{r['group']}' spans {prev} and {name}"

    report = {}
    for name, rows in splits.items():
        ai = sum(1 for r in rows if int(r["label"]) == 1)
        report[name] = {
            "n": len(rows),
            "ai": ai,
            "real": len(rows) - ai,
            "groups": sorted({r["group"] for r in rows}),
        }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "phash_threshold": args.phash_threshold,
        "ratios": list(ratios),
        "dropped_duplicates": dropped,
        "internal_splits": internal_targets,
        "summary": {k: {kk: vv for kk, vv in v.items() if kk != "groups"} for k, v in report.items()},
        "group_assignment": assignment,
        "splits": splits,
    }, indent=2) + "\n")

    print("\nsplit          n     AI   real   groups")
    for name in ("fit", "calibration", "eval"):
        d = report[name]
        print(f"  {name:12s} {d['n']:5d} {d['ai']:5d} {d['real']:6d}   {len(d['groups'])}")
    for name in ("fit", "calibration", "eval"):
        d = report[name]
        if d["n"] and (d["ai"] == 0 or d["real"] == 0):
            print(f"\nWARNING: split '{name}' is single-class; balanced accuracy is undefined there.",
                  file=sys.stderr)
    print(f"\nwrote {args.out}")
    print("Reminder: 'calibration' feeds tools/fit_calibration.py and NOTHING else.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
