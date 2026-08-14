#!/usr/bin/env python3
"""Flatten deduplicated split JSON into the detector's score CSV contract."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import pathlib


FIELDS = [
    "image_id",
    "path",
    "label",
    "generator",
    "split",
    "phash",
    "degradation",
    "source",
    "source_key",
    "license",
    "dataset_revision",
    "cluster_id",
    "image_sha256",
    "source_sha256",
    "source_format",
    "source_width",
    "source_height",
    "source_bytes",
    "output_format",
    "output_width",
    "output_height",
    "output_bytes",
    "dataset_manifest_sha256",
]


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--splits", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    args = parser.parse_args()

    payload = json.loads(args.splits.read_text(encoding="utf-8"))
    dataset_manifest_sha256 = sha256_file(args.splits)
    split_map = payload.get("splits", {})
    rows: list[dict] = []
    for split in ("fit", "calibration", "eval"):
        for record in split_map.get(split, []):
            source_path = (args.root / record["path"]).resolve()
            image_sha256 = record.get("sha256") or sha256_file(source_path)
            relative_path = pathlib.Path(os.path.relpath(source_path, args.out.parent.resolve())).as_posix()
            rows.append({
                "image_id": record.get("image_id") or record["sha256"][:16],
                "path": relative_path,
                "label": int(record["label"]),
                "generator": record["group"],
                "split": split,
                "phash": record["phash"],
                "degradation": record.get("degradation", "clean"),
                "source": record.get("source", ""),
                "source_key": record.get("source_key", ""),
                "license": record.get("license", ""),
                "dataset_revision": record.get("dataset_revision", ""),
                "cluster_id": record.get("source_sha256") or record.get("source_key") or record["group"],
                "image_sha256": image_sha256,
                "source_sha256": record.get("source_sha256", image_sha256),
                "source_format": record.get("source_format", source_path.suffix.lower().lstrip(".")),
                "source_width": record.get("source_width", ""),
                "source_height": record.get("source_height", ""),
                "source_bytes": record.get("source_bytes", source_path.stat().st_size),
                "output_format": record.get("output_format", source_path.suffix.lower().lstrip(".")),
                "output_width": record.get("output_width", record.get("source_width", "")),
                "output_height": record.get("output_height", record.get("source_height", "")),
                "output_bytes": record.get("output_bytes", source_path.stat().st_size),
                "dataset_manifest_sha256": dataset_manifest_sha256,
            })

    for split in ("calibration", "eval"):
        labels = {row["label"] for row in rows if row["split"] == split}
        if labels != {0, 1}:
            raise ValueError(f"split '{split}' must contain both classes, got {sorted(labels)}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
