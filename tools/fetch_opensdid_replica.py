#!/usr/bin/env python3
"""Fetch a small, balanced OpenSDID+ benchmark replica through HF's rows API.

Only selected image rows are downloaded; the 145 GB dataset is never cloned.
The observed dataset revision, license, row index, source key, byte hash, and
generator family are recorded for every file. Data stays under gitignored
``data/`` and never ships in the extension.

OpenSDID+ license: CC-BY-SA-4.0
Dataset: https://huggingface.co/datasets/nebula/OpenSDIDplus
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image


DATASET = "nebula/OpenSDIDplus"
CONFIG = "default"
LICENSE = "CC-BY-SA-4.0"
# The datasets-server cached-asset URL embeds the source revision. Fail closed
# if main moves: a replica must never silently change underneath a measurement.
DATASET_REVISION = "ce647ee3eb7802e9a26ca1e89bb7dfddaa19d92f"
SPLITS = ("sd2", "sd3", "sdxl", "flux")
API = "https://datasets-server.huggingface.co"
USER_AGENT = "ai-image-detector-replica/0.1 (selective local evaluation)"
# OpenSDID+ is ordered by manipulation mode and class. Both classes in each
# pinned population share the same prefix; every returned row is checked so a
# future reorder fails closed instead of creating a label shortcut.
ROW_OFFSETS = {
    "entire": {1: 0, 0: 20_000},
    "partial": {1: 100_000, 0: 150_000},
}


def request_bytes(url: str, attempts: int = 7) -> tuple[bytes, str]:
    delay = 2.0
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read(), response.headers.get_content_type()
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
            retry_after = error.headers.get("Retry-After")
            wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
        except (TimeoutError, urllib.error.URLError):
            if attempt == attempts - 1:
                raise
            wait = delay
        time.sleep(min(wait, 60.0))
        delay = min(delay * 2.0, 60.0)
    raise RuntimeError("unreachable")


def query_rows(split: str, label: int, count: int, population: str) -> list[dict]:
    params = urllib.parse.urlencode({
        "dataset": DATASET,
        "config": CONFIG,
        "split": split,
        "offset": ROW_OFFSETS[population][label],
        "length": count,
    })
    payload, _ = request_bytes(f"{API}/rows?{params}")
    parsed = json.loads(payload)
    rows = parsed.get("rows", [])
    if len(rows) != count:
        raise RuntimeError(f"{split}/label={label}: requested {count} rows, got {len(rows)}")
    return rows


def suffix_for(key: str, content_type: str) -> str:
    suffix = pathlib.Path(key).suffix.lower()
    if suffix in (".jpg", ".jpeg", ".png", ".webp"):
        return suffix
    return mimetypes.guess_extension(content_type) or ".img"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/raw/opensdid"))
    parser.add_argument("--index", type=pathlib.Path, default=pathlib.Path("data/opensdid-index.json"))
    parser.add_argument("--per-class", type=int, default=25, help="rows per class and generator (max 100)")
    parser.add_argument("--population", choices=tuple(ROW_OFFSETS), default="entire")
    parser.add_argument("--delay", type=float, default=0.2, help="polite delay between asset requests")
    args = parser.parse_args()
    if not 1 <= args.per_class <= 100:
        parser.error("--per-class must be in [1, 100]")
    if args.delay < 0:
        parser.error("--delay cannot be negative")

    records: list[dict] = []
    total = len(SPLITS) * 2 * args.per_class
    completed = 0
    for split in SPLITS:
        for label in (0, 1):
            rows = query_rows(split, label, args.per_class, args.population)
            for wrapped in rows:
                row_index = int(wrapped["row_idx"])
                row = wrapped["row"]
                if int(row["label"]) != label:
                    raise RuntimeError(f"dataset filter returned the wrong label at row {row_index}")
                key = str(row["key"])
                if not key.startswith(f"{args.population}/{split}/"):
                    raise RuntimeError(
                        f"pinned {split}/label={label} slice changed population at row {row_index}: {key}"
                    )
                source_url = str(row["image"]["src"])
                if f"/{DATASET_REVISION}/" not in source_url:
                    raise RuntimeError(
                        "OpenSDID+ revision changed; audit the new revision before updating "
                        f"DATASET_REVISION (row {row_index})"
                    )

                guessed_suffix = pathlib.Path(key).suffix.lower() or ".jpg"
                destination = args.out / split / ("ai" if label else "real") / f"{row_index:09d}{guessed_suffix}"
                if destination.exists():
                    data = destination.read_bytes()
                    content_type = mimetypes.guess_type(destination.name)[0] or "application/octet-stream"
                else:
                    data, content_type = request_bytes(source_url)
                    suffix = suffix_for(key, content_type)
                    destination = destination.with_suffix(suffix)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    time.sleep(args.delay)

                try:
                    with Image.open(destination) as image:
                        image.load()
                        width, height = image.size
                except Exception as error:  # noqa: BLE001
                    destination.unlink(missing_ok=True)
                    raise RuntimeError(f"invalid image payload for {split} row {row_index}") from error

                path = destination.resolve().relative_to(pathlib.Path.cwd().resolve()).as_posix()
                records.append({
                    "image_id": f"opensdid-{split}-{row_index}",
                    "path": path,
                    "label": label,
                    "group": f"opensdid-{split}",
                    "generator": split,
                    "degradation": f"opensdid-{args.population}",
                    "source": DATASET,
                    "source_key": key,
                    "source_row": row_index,
                    "source_page": f"https://huggingface.co/datasets/{DATASET}",
                    "license": LICENSE,
                    "dataset_revision": DATASET_REVISION,
                    "sha256": sha256(data),
                    "bytes": len(data),
                    "width": width,
                    "height": height,
                    "content_type": content_type,
                })
                completed += 1
                print(f"[{completed:4d}/{total}] {split} label={label} row={row_index} {width}x{height}", flush=True)

    records.sort(key=lambda record: (record["group"], record["label"], record["source_row"]))
    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(records)} records -> {args.index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
