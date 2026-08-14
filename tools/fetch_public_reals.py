#!/usr/bin/env python3
"""
Collect real-photo negatives from Wikimedia Commons — public domain / CC0 only.

The real class is where detectors are often weakest: train on one narrow
distribution (2014 Flickr JPEGs) and real recall collapses on anything
web-realistic. Balanced accuracy punishes that exactly as hard as missing AI
images, so breadth here is worth as much as any model change.

Design decisions that matter:

**Licence allowlist, not blocklist.** Only images whose Commons metadata says
public domain or CC0 are kept. Anything else — CC-BY-SA, "research only",
unclear — is skipped and counted. We never guess.

**Grouped by photographer, not by category.** `dedupe_and_split.py` holds whole
groups out of the eval split. Grouping by category would let one photographer's
roll straddle the boundary, which leaks the same way a shared generator does.
Artist is the honest grouping key; category is only a fallback.

**Provenance recorded per image.** Source URL, licence, artist, and SHA-256 go
into the index. That index is what makes the replica rebuildable by a third
party without us redistributing a single image — the manifest is the evidence,
not the pixels.

Politeness: descriptive User-Agent and a request delay, per the Wikimedia API
etiquette guidelines. Resumable — already-downloaded files are skipped.

Usage:
    python tools/fetch_public_reals.py --limit 200 --out data/raw/real
    python tools/fetch_public_reals.py --limit 50 --categories "Category:Smartphone photographs"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UA = "ai-image-detector-benchmark/0.1 (research; local benchmark replica; contact via GitHub affaffaff)"

# Topic queries, not categories. Commons search supports `haslicense:unrestricted`,
# which the wiki itself resolves to public-domain / CC0 media — far more reliable
# than guessing which categories happen to be PD. (Measured: the curated
# "Quality images of X" categories are almost entirely CC-BY-SA, so a
# category-driven run correctly skips ~100% of what it finds.)
#
# Topics are deliberately spread across capture conditions — phone pipelines,
# DSLR, studio, documentary — because narrow sourcing of the real class is the
# exact failure mode we are engineering against.
DEFAULT_TOPICS = [
    "landscape photograph",
    "portrait photograph",
    "food dish photograph",
    "street city photograph",
    "animal wildlife photograph",
    "building architecture photograph",
    "vehicle car photograph",
    "flower plant photograph",
    "interior room photograph",
    "sports action photograph",
]

# Kept for targeted runs; see the note above before relying on it.
DEFAULT_CATEGORIES = [
    "Category:CC-Zero",
    "Category:PD-USGov-NASA",
    "Category:Images from the Metropolitan Museum of Art",
]

# Substrings that mark a genuinely unencumbered licence.
ALLOWED_LICENCE_MARKERS = ("cc0", "public domain", "pd-", "no restrictions")

ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}


class RateLimited(RuntimeError):
    """The remote asked us to slow down. Honour it; do not hammer."""


def _open(url: str, timeout: int, attempts: int = 6):
    """
    GET with exponential backoff. A 429 is respected, not retried blindly.

    Wikimedia rate-limits in bursts: a single request from a cold start almost
    always succeeds, while a sustained crawl trips a short cooldown. The first
    version of this gave up after three tries spanning 8 seconds, which was far
    shorter than the cooldown, so a normal burst limit looked identical to a
    banned IP and aborted the whole collection run. Be patient instead —
    Retry-After when the server sends it, capped exponential backoff otherwise.
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    delay = 5.0
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as err:
            if err.code != 429:
                raise
            if attempt == attempts - 1:
                raise RateLimited(
                    f"Wikimedia returned HTTP 429 on {attempts} consecutive attempts "
                    "spanning several minutes. Raise --delay, or wait and resume "
                    "(already-downloaded files are skipped)."
                ) from err
            # Retry-After is authoritative when present; it is what the server
            # actually wants rather than what we guessed.
            wait = delay
            retry_after = err.headers.get("Retry-After") if err.headers else None
            if retry_after:
                try:
                    wait = max(wait, float(retry_after))
                except ValueError:
                    pass
            print(f"    rate limited; waiting {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            delay = min(delay * 2, 120.0)
    raise RateLimited("unreachable")


def api_get(params: dict) -> dict:
    params = {**params, "format": "json", "formatversion": "2"}
    url = f"{API}?{urllib.parse.urlencode(params)}"
    with _open(url, 45) as resp:
        return json.load(resp)


def licence_ok(meta: dict) -> tuple[bool, str]:
    ext = meta.get("extmetadata", {}) or {}
    short = (ext.get("LicenseShortName", {}) or {}).get("value", "") or ""
    lic = (ext.get("License", {}) or {}).get("value", "") or ""
    blob = f"{short} {lic}".lower()
    ok = any(m in blob for m in ALLOWED_LICENCE_MARKERS)
    return ok, short or lic or "unknown"


def strip_html(s: str) -> str:
    out, depth = [], 0
    for ch in s:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return " ".join("".join(out).split())


def artist_of(meta: dict) -> str:
    ext = meta.get("extmetadata", {}) or {}
    raw = (ext.get("Artist", {}) or {}).get("value", "") or ""
    name = strip_html(raw)[:60].strip()
    return name or "unknown-artist"


def slugify(s: str) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in s]
    out = "".join(keep)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")[:48] or "unknown"


def _records_from_pages(pages: list[dict], origin: str) -> list[dict]:
    out = []
    for page in pages:
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        info = infos[0]
        if info.get("mime") not in ALLOWED_MIME:
            continue
        ok, lic = licence_ok(info)
        out.append({
            "title": page.get("title", ""),
            "url": info.get("thumburl") or info.get("url"),
            "descriptionurl": info.get("descriptionurl", ""),
            "licence": lic,
            "licence_ok": ok,
            "artist": artist_of(info),
            "category": origin,
            "width": info.get("thumbwidth") or info.get("width"),
            "height": info.get("thumbheight") or info.get("height"),
        })
    return out


def fetch_topic(topic: str, want: int, width: int, delay: float) -> list[dict]:
    """
    Search-based collection using `haslicense:unrestricted`, which Commons
    resolves to public-domain / CC0 media. The per-image licence check still
    runs afterwards — the search filter is a narrowing step, not a substitute
    for verifying what we actually downloaded.
    """
    found: list[dict] = []
    offset = 0
    while len(found) < want:
        data = api_get({
            "action": "query",
            "generator": "search",
            "gsrsearch": f"{topic} filetype:bitmap haslicense:unrestricted",
            "gsrnamespace": "6",
            "gsrlimit": "50",
            "gsroffset": str(offset),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|size|mime",
            "iiurlwidth": str(width),
        })
        pages = data.get("query", {}).get("pages", [])
        if not pages:
            break
        found.extend(_records_from_pages(pages, f"search:{topic}"))
        if "continue" not in data:
            break
        offset += 50
        time.sleep(delay)
    return found[:want]


def fetch_category(category: str, want: int, width: int, delay: float) -> list[dict]:
    """Yield image records with metadata from one category, paging as needed."""
    found: list[dict] = []
    cont: dict = {}
    while len(found) < want:
        data = api_get({
            "action": "query",
            "generator": "categorymembers",
            "gcmtitle": category,
            "gcmtype": "file",
            "gcmlimit": "50",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|size|mime",
            "iiurlwidth": str(width),
            **cont,
        })
        pages = data.get("query", {}).get("pages", [])
        if not pages:
            break
        for page in pages:
            infos = page.get("imageinfo") or []
            if not infos:
                continue
            info = infos[0]
            if info.get("mime") not in ALLOWED_MIME:
                continue
            ok, lic = licence_ok(info)
            found.append({
                "title": page.get("title", ""),
                "url": info.get("thumburl") or info.get("url"),
                "descriptionurl": info.get("descriptionurl", ""),
                "licence": lic,
                "licence_ok": ok,
                "artist": artist_of(info),
                "category": category,
                "width": info.get("thumbwidth") or info.get("width"),
                "height": info.get("thumbheight") or info.get("height"),
            })
            if len(found) >= want:
                break
        if "continue" not in data:
            break
        cont = data["continue"]
        time.sleep(delay)
    return found


def download(url: str, dest: pathlib.Path, delay: float) -> bytes | None:
    try:
        with _open(url, 60) as resp:
            data = resp.read()
    except RateLimited:
        raise
    except Exception as err:  # noqa: BLE001 - one bad file must not kill the run
        print(f"    download failed: {err}", file=sys.stderr)
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    time.sleep(delay)
    return data


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/raw/real"))
    ap.add_argument("--index", type=pathlib.Path, default=pathlib.Path("data/real-index.json"))
    ap.add_argument("--limit", type=int, default=200, help="total images to collect")
    ap.add_argument("--topics", nargs="*", default=None,
                    help="search topics (default); uses haslicense:unrestricted")
    ap.add_argument("--categories", nargs="*", default=None,
                    help="use Commons categories instead of topic search")
    ap.add_argument("--width", type=int, default=1600, help="max delivered width (web-realistic)")
    ap.add_argument("--delay", type=float, default=0.3, help="seconds between requests")
    args = ap.parse_args()

    use_categories = args.categories is not None
    sources = args.categories if use_categories else (args.topics or DEFAULT_TOPICS)
    per_cat = max(1, args.limit // len(sources))

    records: list[dict] = []
    skipped_licence = 0
    existing = {}
    if args.index.exists():
        for r in json.loads(args.index.read_text()).get("records", []):
            existing[r["path"]] = r
        print(f"resuming: {len(existing)} already in index")

    for cat in sources:
        print(f"\n{cat}  (target {per_cat})")
        try:
            candidates = (
                fetch_category(cat, per_cat * 2, args.width, args.delay)
                if use_categories
                else fetch_topic(cat, per_cat * 3, args.width, args.delay)
            )
        except RateLimited as err:
            print(f"\nSTOPPING: {err}", file=sys.stderr)
            break
        except Exception as err:  # noqa: BLE001
            print(f"  query failed: {err}", file=sys.stderr)
            continue

        kept = 0
        stop = False
        for c in candidates:
            if kept >= per_cat:
                break
            if not c["licence_ok"]:
                skipped_licence += 1
                continue
            if not c["url"]:
                continue
            name = pathlib.Path(urllib.parse.unquote(c["title"])).name
            group = slugify(c["artist"])
            rel = f"{group}/{slugify(pathlib.Path(name).stem)}{pathlib.Path(name).suffix.lower() or '.jpg'}"
            dest = args.out / rel
            key = str(dest).replace("\\", "/")
            if key in existing:
                kept += 1
                continue
            if dest.exists():
                data = dest.read_bytes()
                records.append({
                    "path": key,
                    "label": 0,
                    "group": f"commons:{group}",
                    "source": "wikimedia-commons",
                    "source_page": c["descriptionurl"],
                    "licence": c["licence"],
                    "artist": c["artist"],
                    "category": cat,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                })
                existing[key] = records[-1]
                kept += 1
                print(f"  recovered {rel}  ({c['licence']})")
                continue

            try:
                data = download(c["url"], dest, args.delay)
            except RateLimited as err:
                # Save what we have rather than losing the run. Resumable:
                # re-running skips everything already in the index.
                print(f"\nSTOPPING: {err}", file=sys.stderr)
                stop = True
                break
            if data is None:
                continue
            records.append({
                "path": str(dest).replace("\\", "/"),
                "label": 0,
                "group": f"commons:{group}",
                "source": "wikimedia-commons",
                "source_page": c["descriptionurl"],
                "licence": c["licence"],
                "artist": c["artist"],
                "category": cat,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            })
            existing[str(dest).replace("\\", "/")] = records[-1]
            kept += 1
            print(f"  [{len(records):4d}] {rel}  ({c['licence']})", flush=True)

        if stop:
            break

    all_records = list(existing.values()) + records
    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(json.dumps({
        "source": "wikimedia-commons",
        "licence_policy": "public domain / CC0 only; everything else skipped",
        "count": len(all_records),
        "records": all_records,
    }, indent=2) + "\n")

    groups = {r["group"] for r in all_records}
    print(f"\ncollected {len(records)} new (index total {len(all_records)})")
    print(f"skipped for licence: {skipped_licence}")
    print(f"distinct photographer groups: {len(groups)}")
    print(f"index: {args.index}")
    if len(groups) < 8:
        print("\nNOTE: few groups. Whole-group holdout needs breadth — widen --categories.")
    print("\nThis is the REAL class only. AI positives still need generation/collection.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
