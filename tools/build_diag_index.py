#!/usr/bin/env python3
"""Freeze AI + current reals into a snapshot index (hardlinks, no raw rglob)."""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dest", type=pathlib.Path, default=pathlib.Path("data/diag"))
    ap.add_argument(
        "--ai-groups",
        default="sd-1.5",
        help="comma-separated AI groups to include, or 'all'",
    )
    args = ap.parse_args()
    root = pathlib.Path(".")
    ai = json.loads((root / "data/ai-index.json").read_text(encoding="utf-8"))
    real = json.loads((root / "data/real-index.json").read_text(encoding="utf-8"))
    dest_in = args.dest / "in"
    dest_in.mkdir(parents=True, exist_ok=True)
    wanted = None if args.ai_groups.strip() == "all" else {
        part.strip() for part in args.ai_groups.split(",") if part.strip()
    }

    records: list[dict] = []
    for rec in ai.get("records", []):
        group = rec.get("group", "")
        if wanted is not None and group not in wanted:
            continue
        src = pathlib.Path(rec["path"])
        rel = pathlib.Path("ai") / group / src.name
        target = dest_in / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not src.is_file():
            print(f"missing AI {src}", file=sys.stderr)
            continue
        if not target.exists():
            try:
                target.hardlink_to(src)
            except OSError:
                shutil.copy2(src, target)
        records.append({
            "path": rel.as_posix(),
            "label": 1,
            "group": group,
            "image_id": rec["sha256"][:16],
            "source": rec.get("source", "local-generation"),
            "source_key": group,
            "license": rec.get("licence", ""),
            "dataset_revision": rec.get("model_revision", ""),
            "sha256": rec["sha256"],
        })

    for rec in real.get("records", []):
        src = pathlib.Path(rec["path"])
        rel = pathlib.Path("real") / pathlib.Path(*src.parts[src.parts.index("real") + 1 :])
        target = dest_in / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not src.is_file():
            print(f"missing real {src}", file=sys.stderr)
            continue
        if not target.exists():
            try:
                target.hardlink_to(src)
            except OSError:
                shutil.copy2(src, target)
        records.append({
            "path": rel.as_posix(),
            "label": 0,
            "group": rec["group"],
            "image_id": rec["sha256"][:16],
            "source": rec.get("source", ""),
            "source_key": rec["group"],
            "license": rec.get("licence", ""),
            "dataset_revision": "",
            "sha256": rec["sha256"],
        })

    out = args.dest / "index.json"
    out.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    ai_n = sum(1 for r in records if r["label"] == 1)
    print(f"wrote {len(records)} records ({ai_n} AI, {len(records) - ai_n} real) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
