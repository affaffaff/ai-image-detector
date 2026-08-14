#!/usr/bin/env python3
"""Join degradation provenance to labels/groups and emit a score CSV."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import pathlib
import sys
from collections import Counter

from dedupe_and_split import phash


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
    parser.add_argument("--index", required=True, type=pathlib.Path)
    parser.add_argument("--source-root", required=True, type=pathlib.Path)
    parser.add_argument("--degradation-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--degraded-root", required=True, type=pathlib.Path)
    parser.add_argument("--splits", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--labels-out", type=pathlib.Path)
    args = parser.parse_args()

    source_root = args.source_root.resolve()
    originals = json.loads(args.index.read_text(encoding="utf-8"))
    by_source: dict[str, dict] = {}
    for record in originals:
        path = pathlib.Path(record["path"])
        if not path.is_absolute():
            path = source_root / path
        relative = path.resolve().relative_to(source_root).as_posix()
        by_source[relative] = record
    splits_payload = json.loads(args.splits.read_text(encoding="utf-8"))
    assignment = splits_payload["group_assignment"]
    path_to_split: dict[str, str] = {}
    for split_name, split_rows in splits_payload.get("splits", {}).items():
        for row in split_rows:
            path_to_split[pathlib.Path(row["path"]).as_posix()] = split_name
    degradation = json.loads(args.degradation_manifest.read_text(encoding="utf-8"))
    degradation_manifest_sha256 = sha256_file(args.degradation_manifest)

    rows = []
    labels = {}
    seen_hashes: dict[str, str] = {}
    for degraded in degradation["records"]:
        original = by_source.get(degraded["src"])
        if not original:
            raise ValueError(f"degraded source absent from index: {degraded['src']}")
        image_path = (args.degraded_root / degraded["out"]).resolve()
        perceptual = phash(image_path)
        if perceptual is None:
            raise ValueError(f"unreadable degraded image: {image_path}")
        hash_hex = f"{perceptual:016x}"
        previous_split = seen_hashes.get(hash_hex)
        original_key = pathlib.Path(original["path"]).as_posix()
        split = path_to_split.get(original_key) or assignment.get(original["group"])
        if not split or split == "internal":
            print(f"skip (no split): {original_key}", file=sys.stderr)
            continue
        if previous_split is not None and previous_split != split:
            print(
                f"skip (pHash crosses splits): {hash_hex} {original_key} {degraded['chain']}",
                file=sys.stderr,
            )
            continue
        seen_hashes[hash_hex] = split
        output_path = pathlib.Path(os.path.relpath(image_path, args.out.parent.resolve())).as_posix()
        # Include the output path so keep-original and a sampled `pristine`
        # chain cannot collide on `{id}--pristine`.
        out_key = pathlib.Path(degraded["out"]).as_posix().replace("/", "__")
        image_id = f"{original['image_id']}--{out_key}"
        rows.append({
            "image_id": image_id,
            "path": output_path,
            "label": int(original["label"]),
            "generator": original["group"],
            "split": split,
            "phash": hash_hex,
            "degradation": degraded["chain"],
            "source": original["source"],
            "source_key": original["source_key"],
            "license": original["license"],
            "dataset_revision": original["dataset_revision"],
            "cluster_id": (
                original.get("source_sha256")
                or degraded.get("source_sha256")
                or original.get("source_key")
                or original["image_id"]
            ),
            "image_sha256": degraded.get("output_sha256") or sha256_file(image_path),
            "source_sha256": degraded.get("source_sha256", original.get("sha256", "")),
            "source_format": degraded.get("source_format", ""),
            "source_width": degraded.get("source_width", ""),
            "source_height": degraded.get("source_height", ""),
            "source_bytes": degraded.get("source_bytes", ""),
            "output_format": degraded.get("output_format", ""),
            "output_width": degraded.get("output_width", ""),
            "output_height": degraded.get("output_height", ""),
            "output_bytes": degraded.get("output_bytes", ""),
            "dataset_manifest_sha256": degradation_manifest_sha256,
        })
        labels[degraded["src"]] = int(original["label"])

    repeated = [key for key, count in Counter(row["image_id"] for row in rows).items() if count > 1]
    if repeated:
        raise ValueError(f"duplicate image_id values: {', '.join(repeated[:5])}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    if args.labels_out:
        args.labels_out.parent.mkdir(parents=True, exist_ok=True)
        args.labels_out.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} rows -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
