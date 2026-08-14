#!/usr/bin/env python3
"""Collect public-domain NASA stills as real-class negatives.

Wikimedia Commons rate-limits aggressively from a single IP. NASA's images API
is a second, independently rate-limited public-domain source so the real class
is not blocked on one host.

US government NASA imagery is public domain unless a caption says otherwise.
Items whose description mentions copyright, courtesy-of third parties, or
trademark restrictions are skipped. Grouping key is NASA center (or named
photographer) so holdout still has structure.

Writes the same index shape as fetch_public_reals.py so both feeds merge.

Usage:
    python tools/fetch_nasa_reals.py --limit 80 --out data/raw/real --index data/real-index.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://images-api.nasa.gov/search"
UA = "ai-image-detector-benchmark/0.1 (research; local benchmark replica; contact via GitHub affaffaff)"
SKIP_MARKERS = (
    "copyright",
    "all rights reserved",
    "courtesy of",
    "used with permission",
    "trademark",
)
QUERIES = (
    "earth landscape photograph",
    "crew portrait",
    "spacecraft assembly",
    "desert canyon",
    "ocean coastline",
    "aircraft in flight",
    "city lights at night",
    "laboratory interior",
)


def slugify(s: str) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in s]
    out = "".join(keep)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "unknown"


def get_json(url: str, timeout: int = 45) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def download(url: str, dest: pathlib.Path, attempts: int = 3) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                if ctype not in {"image/jpeg", "image/png", "image/jpg"}:
                    return None
                data = resp.read()
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return data
        except Exception as err:  # noqa: BLE001
            last_err = err
            print(f"    download failed ({attempt}/{attempts}): {err}", file=sys.stderr)
            time.sleep(min(8.0, 1.5 * attempt))
    print(f"    giving up: {last_err}", file=sys.stderr)
    return None


def restricted(text: str) -> bool:
    blob = text.lower()
    return any(m in blob for m in SKIP_MARKERS)


def original_url(collection_url: str) -> str | None:
    try:
        listing = get_json(collection_url)
    except Exception:
        return None
    if not isinstance(listing, list):
        return None
    urls = [u for u in listing if isinstance(u, str)]
    originals = [
        u
        for u in urls
        if u.lower().endswith((".jpg", ".jpeg", ".png"))
        and "~thumb" not in u.lower()
        and "~small" not in u.lower()
        and "~medium" not in u.lower()
    ]
    pool = originals or [u for u in urls if u.lower().endswith((".jpg", ".jpeg", ".png"))]
    if not pool:
        return None
    # Prefer the orig / largest-looking asset without downloading every candidate.
    pool.sort(key=lambda u: ("~orig" not in u.lower(), "~large" not in u.lower(), len(u)))
    return pool[0]


def search(query: str, want: int) -> list[dict]:
    params = urllib.parse.urlencode(
        {"q": query, "media_type": "image", "page_size": min(100, max(want * 3, 20))}
    )
    payload = get_json(f"{API}?{params}")
    items = (((payload or {}).get("collection") or {}).get("items")) or []
    found = []
    for item in items:
        data = (item.get("data") or [{}])[0]
        if data.get("media_type") != "image":
            continue
        title = data.get("title") or ""
        desc = data.get("description") or ""
        if restricted(f"{title}\n{desc}"):
            continue
        href = item.get("href")
        if not href:
            continue
        photographer = (data.get("photographer") or "").strip()
        center = (data.get("center") or "").strip() or "nasa"
        found.append(
            {
                "nasa_id": data.get("nasa_id") or "",
                "title": title,
                "collection": href,
                "photographer": photographer,
                "center": center,
                "page": f"https://images.nasa.gov/details-{urllib.parse.quote(data.get('nasa_id') or '')}",
            }
        )
        if len(found) >= want:
            break
    return found


def recover_unindexed(out: pathlib.Path, existing: dict) -> list[dict]:
    """Files on disk that never made the index (killed mid-run) still count."""
    recovered = []
    if not out.exists():
        return recovered
    for path in out.rglob("*"):
        if not path.is_file():
            continue
        key = str(path).replace("\\", "/")
        if key in existing:
            continue
        data = path.read_bytes()
        group = slugify(path.parent.name)
        recovered.append(
            {
                "path": key,
                "label": 0,
                "group": f"nasa:{group}",
                "source": "nasa-images",
                "source_page": "",
                "licence": "US-government work / public domain",
                "artist": path.parent.name,
                "category": "recovered-from-disk",
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
        )
    return recovered


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/raw/real"))
    ap.add_argument("--index", type=pathlib.Path, default=pathlib.Path("data/real-index.json"))
    ap.add_argument("--limit", type=int, default=80)
    ap.add_argument("--delay", type=float, default=0.4)
    args = ap.parse_args()

    existing = {}
    if args.index.exists():
        for r in json.loads(args.index.read_text(encoding="utf-8")).get("records", []):
            existing[r["path"]] = r
        print(f"resuming: {len(existing)} already in index", flush=True)

    recovered = recover_unindexed(args.out, existing)
    if recovered:
        print(f"recovered {len(recovered)} files already on disk", flush=True)
        for r in recovered:
            existing[r["path"]] = r

    per_q = max(1, args.limit // len(QUERIES))
    records: list[dict] = []

    for query in QUERIES:
        print(f"\n{query}  (target {per_q})", flush=True)
        try:
            candidates = search(query, per_q * 3)
        except Exception as err:  # noqa: BLE001
            print(f"  query failed: {err}", file=sys.stderr)
            continue
        kept = 0
        for c in candidates:
            if kept >= per_q:
                break
            url = original_url(c["collection"])
            time.sleep(args.delay)
            if not url:
                continue
            artist = c["photographer"] or c["center"]
            group = slugify(artist)
            stem = slugify(c["nasa_id"] or c["title"])[:80]
            suffix = ".jpg" if not re.search(r"\.(png|jpe?g)$", url, re.I) else pathlib.Path(url).suffix.lower()
            rel = f"{group}/{stem}{suffix}"
            dest = args.out / rel
            key = str(dest).replace("\\", "/")
            if key in existing:
                kept += 1
                continue
            if dest.exists():
                data = dest.read_bytes()
            else:
                data = download(url, dest)
                time.sleep(args.delay)
            if data is None:
                continue
            records.append(
                {
                    "path": key,
                    "label": 0,
                    "group": f"nasa:{group}",
                    "source": "nasa-images",
                    "source_page": c["page"],
                    "licence": "US-government work / public domain",
                    "artist": artist,
                    "category": query,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                }
            )
            kept += 1
            print(f"  [{len(records):4d}] {rel}", flush=True)

    all_records = list(existing.values()) + records
    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(
        json.dumps(
            {
                "source": "wikimedia-commons + nasa-images",
                "licence_policy": "public domain / CC0 / US-government work; copyrighted captions skipped",
                "count": len(all_records),
                "records": all_records,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    groups = {r["group"] for r in all_records}
    print(f"\ncollected {len(records)} new (index total {len(all_records)})")
    print(f"distinct groups: {len(groups)}")
    print(f"index: {args.index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
