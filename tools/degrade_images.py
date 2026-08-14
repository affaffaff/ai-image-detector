#!/usr/bin/env python3
"""Build deterministic, label-blind web-stress variants for the benchmark.

The same profile distribution must be applied to real and AI images. Otherwise
the detector can learn a dataset shortcut (for example, PNG means AI and JPEG
means real) instead of learning image-generation evidence.

Two modes are available:

* ``--suite sampled`` draws one weighted profile per source/variant. This is
  useful for a compact web-realistic mixture.
* ``--suite contest-core`` applies every high-value contest profile to every
  source. This is the reliable way to report per-stress results because a rare
  profile cannot disappear by chance.

Lossy operations are performed in memory. The exact bytes from the final codec
pass are written to disk; a lossless PNG envelope is used only when a chain has
no final codec. Saving a decoded result as another JPEG would add an unreported
compression pass and make ``jpeg_triple`` silently become a four-pass profile.

Examples:
    python tools/degrade_images.py --in data/raw --out data/replica \
        --suite contest-core --keep-original --seed 20260813

    python tools/degrade_images.py --in data/raw --out data/replica \
        --profiles jpeg_triple,mixed_recompress,screen_capture_jpeg

    python tools/degrade_images.py --in data/diag/in --out data/diag/matched-codecs/replica \
        --suite sampled --keep-original --seed 20260813 \
        --match-source-codec jpeg --jpeg-quality 95 \
        --match-size square --match-size-px 1024
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import pathlib
import random
import sys
from collections.abc import Callable

from PIL import Image, ImageDraw, ImageFilter

SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
Operation = Callable[[Image.Image, random.Random], tuple[Image.Image, dict]]
_ARTIFACT_BYTES = "_benchmark_encoded_bytes"
_ARTIFACT_FORMAT = "_benchmark_encoded_format"
# Web-realistic working budget. NASA originals can be 45–60MP; a 2x CMS
# upscale of those exceeds Pillow's decompression-bomb limit and is not a
# social-delivery path the contest will score.
DEFAULT_MAX_SOURCE_PIXELS = 16_000_000
DEFAULT_MAX_WORKING_PIXELS = 16_000_000


def _roundtrip(img: Image.Image, image_format: str, **save_args) -> Image.Image:
    """Encode and decode once so later operations see the delivered pixels."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format=image_format, **save_args)
    encoded = buf.getvalue()
    with Image.open(io.BytesIO(encoded)) as decoded:
        out = decoded.convert("RGB")
    # Keep the exact artifact. A later pixel operation naturally drops this
    # metadata; a later codec operation replaces it with its own final bytes.
    out.info[_ARTIFACT_BYTES] = encoded
    out.info[_ARTIFACT_FORMAT] = image_format.lower()
    return out


def _resize_long_edge(img: Image.Image, target: int) -> tuple[Image.Image, bool]:
    w, h = img.size
    if max(w, h) <= target:
        return img, False
    scale = target / max(w, h)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(size, Image.LANCZOS), True


def op_jpeg(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    quality = rng.randint(50, 95)
    subsampling = rng.choice([0, 2])
    return (
        _roundtrip(img, "JPEG", quality=quality, subsampling=subsampling),
        {"op": "jpeg", "quality": quality, "subsampling": subsampling},
    )


def op_webp(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    quality = rng.randint(55, 92)
    return _roundtrip(img, "WEBP", quality=quality), {"op": "webp", "quality": quality}


def op_rescale(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """Resize to a typical web delivery edge while preserving aspect ratio."""
    target = rng.choice([480, 640, 800, 1024, 1280, 1600, 2048])
    out, changed = _resize_long_edge(img, target)
    return out, {
        "op": "rescale",
        "target": target,
        "changed": changed,
        "to": list(out.size),
    }


def op_upscale(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """A CMS blowing up a small image destroys high-frequency evidence."""
    factor = rng.choice([1.25, 1.5, 2.0])
    w, h = img.size
    size = (max(1, round(w * factor)), max(1, round(h * factor)))
    if size[0] * size[1] > DEFAULT_MAX_WORKING_PIXELS:
        return img, {"op": "upscale", "factor": 1.0, "skipped": True, "to": [w, h]}
    return img.resize(size, Image.BICUBIC), {"op": "upscale", "factor": factor, "to": list(size)}


def op_crop(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """Editorial crop; retain at least 60% of each edge."""
    w, h = img.size
    fw, fh = rng.uniform(0.6, 0.95), rng.uniform(0.6, 0.95)
    nw, nh = max(1, int(w * fw)), max(1, int(h * fh))
    x, y = rng.randint(0, max(0, w - nw)), rng.randint(0, max(0, h - nh))
    return img.crop((x, y, x + nw, y + nh)), {
        "op": "crop",
        "box": [x, y, nw, nh],
        "fraction": [fw, fh],
    }


def op_social_feed(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """Representative feed/message delivery, not a claim about one platform."""
    profiles = [
        ("feed-1080-jpeg", 1080, "JPEG", 82),
        ("feed-1440-jpeg", 1440, "JPEG", 84),
        ("message-1280-webp", 1280, "WEBP", 80),
    ]
    profile, cap, image_format, base_quality = rng.choice(profiles)
    img, changed = _resize_long_edge(img, cap)
    quality = max(45, min(95, base_quality + rng.randint(-4, 4)))
    save_args = {"quality": quality}
    if image_format == "JPEG":
        save_args["subsampling"] = 2
    out = _roundtrip(img, image_format, **save_args)
    return out, {
        "op": "social_pipeline",
        "stage": "feed",
        "profile": profile,
        "cap": cap,
        "changed": changed,
        "codec": image_format.lower(),
        "quality": quality,
        "to": list(out.size),
    }


def op_social_thumbnail(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """A second, small-preview pass representative of thumbnail/CDN delivery."""
    profiles = [
        ("grid-320-jpeg", 320, "JPEG", 72),
        ("preview-480-webp", 480, "WEBP", 76),
        ("preview-640-jpeg", 640, "JPEG", 78),
    ]
    profile, cap, image_format, base_quality = rng.choice(profiles)
    img, changed = _resize_long_edge(img, cap)
    quality = max(40, min(92, base_quality + rng.randint(-3, 3)))
    save_args = {"quality": quality}
    if image_format == "JPEG":
        save_args["subsampling"] = 2
    out = _roundtrip(img, image_format, **save_args)
    return out, {
        "op": "social_pipeline",
        "stage": "thumbnail",
        "profile": profile,
        "cap": cap,
        "changed": changed,
        "codec": image_format.lower(),
        "quality": quality,
        "to": list(out.size),
    }


def op_screen_capture(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """Render into a browser-like viewport, then capture its display pixels."""
    viewport = rng.choice([(1280, 800), (1365, 768), (1440, 900), (1920, 1080)])
    dpr = rng.choice([1.0, 1.25, 1.5])
    capture = (round(viewport[0] * dpr), round(viewport[1] * dpr))
    toolbar_h = round(52 * dpr)
    margin = round(rng.choice([16, 24, 32]) * dpr)
    themes = [
        ((247, 247, 247), (224, 226, 230)),
        ((31, 33, 36), (50, 52, 57)),
    ]
    page_color, chrome_color = rng.choice(themes)
    canvas = Image.new("RGB", capture, page_color)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, capture[0], toolbar_h), fill=chrome_color)

    # Minimal browser chrome provides the large flat/UI regions seen in actual
    # captures without depending on fonts or machine-specific rendering.
    radius = max(3, round(5 * dpr))
    for i, color in enumerate(((239, 83, 80), (244, 184, 72), (99, 193, 105))):
        cx, cy = round((18 + i * 20) * dpr), toolbar_h // 2
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color)
    address_left = round(92 * dpr)
    address_top = round(13 * dpr)
    draw.rounded_rectangle(
        (address_left, address_top, capture[0] - margin, toolbar_h - address_top),
        radius=max(2, round(8 * dpr)),
        fill=(235, 236, 239) if page_color[0] > 100 else (70, 72, 77),
    )

    avail_w = max(1, capture[0] - 2 * margin)
    avail_h = max(1, capture[1] - toolbar_h - 2 * margin)
    fill = rng.choice([0.72, 0.86, 1.0])
    scale = min(avail_w / img.width, avail_h / img.height) * fill
    render_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    resample = Image.BILINEAR if scale < 1.0 else Image.BICUBIC
    rendered = img.resize(render_size, resample)
    x = (capture[0] - render_size[0]) // 2
    y = toolbar_h + margin + (avail_h - render_size[1]) // 2
    canvas.paste(rendered, (x, y))

    if rng.random() < 0.5:
        canvas = canvas.filter(ImageFilter.UnsharpMask(radius=0.55, percent=35, threshold=2))
    canvas = _roundtrip(canvas, "PNG")
    return canvas, {
        "op": "screen_capture",
        "viewport_css": list(viewport),
        "device_pixel_ratio": dpr,
        "capture_size": list(capture),
        "rendered_rect": [x, y, render_size[0], render_size[1]],
    }


def _cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize and center-crop an image so it covers ``size``."""
    scale = max(size[0] / img.width, size[1] / img.height)
    resized = img.resize(
        (max(1, math.ceil(img.width * scale)), max(1, math.ceil(img.height * scale))),
        Image.LANCZOS,
    )
    left = max(0, (resized.width - size[0]) // 2)
    top = max(0, (resized.height - size[1]) // 2)
    return resized.crop((left, top, left + size[0], top + size[1]))


def op_canonical_square(img: Image.Image, _rng: random.Random) -> tuple[Image.Image, dict]:
    """Remove source dimensions/aspect ratio with one fixed delivered canvas.

    This is an evaluation-control profile, not a claim that every web image is
    square.  It makes tile count, output dimensions, codec, and codec settings
    identical across labels so a score cannot ride on the source-size shortcut.
    """
    target = (768, 768)
    return _cover(img, target), {
        "op": "canonical_square",
        "target": list(target),
        "resample": "lanczos",
        "crop": "center-cover",
    }


def op_fixed_jpeg(img: Image.Image, _rng: random.Random) -> tuple[Image.Image, dict]:
    """Apply identical final codec settings to every canonical control image."""
    quality = 82
    subsampling = 2
    return (
        _roundtrip(img, "JPEG", quality=quality, subsampling=subsampling),
        {"op": "jpeg", "quality": quality, "subsampling": subsampling, "fixed": True},
    )


def op_canonical_square_lowres(img: Image.Image, _rng: random.Random) -> tuple[Image.Image, dict]:
    """A fixed 384px square control for compressed thumbnail robustness."""
    target = (384, 384)
    return _cover(img, target), {
        "op": "canonical_square",
        "target": list(target),
        "resample": "lanczos",
        "crop": "center-cover",
    }


def op_fixed_jpeg_lowres(img: Image.Image, _rng: random.Random) -> tuple[Image.Image, dict]:
    """Use one deliberately harsh but identical thumbnail encode."""
    quality = 65
    subsampling = 2
    return (
        _roundtrip(img, "JPEG", quality=quality, subsampling=subsampling),
        {"op": "jpeg", "quality": quality, "subsampling": subsampling, "fixed": True},
    )


def op_modern_canvas(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    """Place content on a modern feed/story/ultrawide canvas without distortion."""
    profiles = [
        ("story-9x16", (1080, 1920)),
        ("feed-4x5", (1080, 1350)),
        ("landscape-16x9", (1920, 1080)),
        ("ultrawide-21x9", (2100, 900)),
        ("large-portrait-9x16", (1440, 2560)),
    ]
    profile, target = rng.choice(profiles)
    background = _cover(img, target).filter(ImageFilter.GaussianBlur(radius=24))
    shade = Image.new("RGB", target, (24, 24, 24))
    background = Image.blend(background, shade, 0.20)

    fit_scale = min((target[0] * 0.92) / img.width, (target[1] * 0.92) / img.height)
    foreground_size = (
        max(1, round(img.width * fit_scale)),
        max(1, round(img.height * fit_scale)),
    )
    foreground = img.resize(foreground_size, Image.LANCZOS)
    x = (target[0] - foreground.width) // 2
    y = (target[1] - foreground.height) // 2
    background.paste(foreground, (x, y))
    return background, {
        "op": "modern_canvas",
        "profile": profile,
        "target": list(target),
        "foreground_rect": [x, y, foreground.width, foreground.height],
    }


# Existing profiles stay available; the new contest profiles are additive.
CHAINS: list[tuple[str, list[Operation]]] = [
    ("pristine", []),
    ("jpeg", [op_jpeg]),
    ("jpeg_double", [op_jpeg, op_jpeg]),
    ("jpeg_triple", [op_jpeg, op_jpeg, op_jpeg]),
    ("mixed_recompress", [op_jpeg, op_rescale, op_webp, op_jpeg]),
    ("rescale_jpeg", [op_rescale, op_jpeg]),
    ("crop_jpeg", [op_crop, op_jpeg]),
    ("webp", [op_webp]),
    ("rescale_webp", [op_rescale, op_webp]),
    ("social_feed", [op_social_feed]),
    ("social_thumbnail", [op_social_feed, op_social_thumbnail]),
    ("screen_capture", [op_screen_capture]),
    ("screen_capture_jpeg", [op_screen_capture, op_jpeg]),
    ("upscale_jpeg", [op_upscale, op_jpeg]),
    ("modern_canvas_jpeg", [op_modern_canvas, op_jpeg]),
    ("canonical_square_jpeg", [op_canonical_square, op_fixed_jpeg]),
    ("canonical_square_lowres_jpeg", [op_canonical_square_lowres, op_fixed_jpeg_lowres]),
]
# The canonical control is explicit-only: sampled web-stress distributions
# must remain unchanged when the control profile is added.
CHAIN_WEIGHTS = [3, 11, 7, 4, 5, 11, 5, 6, 5, 10, 7, 4, 5, 4, 5, 0, 0]

# Small enough to be practical, broad enough to hit the contest-relevant gaps.
CONTEST_CORE = [
    "jpeg_triple",
    "mixed_recompress",
    "social_thumbnail",
    "screen_capture",
    "screen_capture_jpeg",
    "modern_canvas_jpeg",
]

CHAIN_MAP = dict(CHAINS)
LOSSY_OPS = {"jpeg", "webp", "social_pipeline"}


def stable_rng(seed: int, key: str) -> random.Random:
    digest = hashlib.sha256(f"{seed}:{key}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def apply_chain(img: Image.Image, name: str, rng: random.Random) -> tuple[Image.Image, dict]:
    steps: list[dict] = []
    for op in CHAIN_MAP[name]:
        img, meta = op(img, rng)
        steps.append(meta)
    return img, {
        "chain": name,
        "steps": steps,
        "chain_index": [chain_name for chain_name, _ in CHAINS].index(name),
        "lossy_encode_count": sum(step.get("op") in LOSSY_OPS for step in steps),
    }


def draw_sampled_chain(img: Image.Image, rng: random.Random) -> tuple[Image.Image, dict]:
    idx = rng.choices(range(len(CHAINS)), weights=CHAIN_WEIGHTS, k=1)[0]
    return apply_chain(img, CHAINS[idx][0], rng)


def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_output(img: Image.Image, stem: pathlib.Path) -> tuple[pathlib.Path, dict]:
    encoded = img.info.get(_ARTIFACT_BYTES)
    image_format = str(img.info.get(_ARTIFACT_FORMAT, "")).lower()
    suffixes = {"jpeg": ".jpg", "webp": ".webp", "png": ".png"}
    # Append the suffix. Path.with_suffix() treats "sd-1.5-00000" as
    # stem "sd-1" + suffix ".5-00000" and would collapse every SD 1.5
    # (or Kandinsky 2.2) file onto one path.
    if isinstance(encoded, bytes) and image_format in suffixes:
        path = stem.parent / f"{stem.name}{suffixes[image_format]}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        storage = "exact-final-encode"
    else:
        path = stem.parent / f"{stem.name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        img.convert("RGB").save(path, format="PNG", compress_level=6)
        image_format = "png"
        storage = "lossless-envelope"
    return path, {
        "output_format": image_format,
        "output_storage": storage,
        "output_width": img.width,
        "output_height": img.height,
        "output_bytes": path.stat().st_size,
        "output_sha256": _sha256_file(path),
    }


def apply_source_match(
    img: Image.Image,
    *,
    codec: str,
    jpeg_quality: int,
    match_size: str,
    match_size_px: int,
) -> tuple[Image.Image, dict]:
    """Force every source through the same geometry and/or codec before degrade.

    Matching is label-blind: the same canvas and JPEG settings are applied to
    every readable source. That is an evaluation-control pre-step so
    ``source_format`` / file magic / native pixel count cannot separate AI from
    real. It is not a claim that every web image is a 1024px JPEG square.

    Size matching uses center-cover (same rule for both classes). Landscapes
    lose more of the frame than already-square generators; that tradeoff is
    accepted so metadata cannot carry the label. Codec matching re-encodes the
    matched canvas so keep-original and empty ``pristine`` chains write the
    same container as every other source.
    """
    meta: dict = {}
    if match_size == "square":
        if match_size_px < 1:
            raise ValueError("--match-size-px must be at least 1")
        if match_size_px * match_size_px > DEFAULT_MAX_WORKING_PIXELS:
            raise ValueError("--match-size-px exceeds the working pixel budget")
        img = _cover(img, (match_size_px, match_size_px))
        meta.update({
            "match_size": "square",
            "match_size_px": match_size_px,
            "match_size_resample": "lanczos",
            "match_size_crop": "center-cover",
        })
    elif match_size != "none":
        raise ValueError(f"unknown --match-size {match_size}")

    if codec == "jpeg":
        if not 1 <= jpeg_quality <= 95:
            raise ValueError("--jpeg-quality must be in 1..95")
        img = _roundtrip(img, "JPEG", quality=jpeg_quality, subsampling=2)
        encoded = img.info[_ARTIFACT_BYTES]
        if not isinstance(encoded, bytes):
            raise TypeError("matched JPEG roundtrip did not retain encoded bytes")
        meta.update({
            "match_source_codec": "jpeg",
            "match_jpeg_quality": jpeg_quality,
            "match_jpeg_subsampling": 2,
            "matched_source_bytes": len(encoded),
            "matched_source_sha256": hashlib.sha256(encoded).hexdigest(),
        })
    elif codec != "none":
        raise ValueError(f"unknown --match-source-codec {codec}")
    return img, meta


def _parse_profiles(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    profiles = list(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    unknown = sorted(set(profiles) - set(CHAIN_MAP))
    if unknown:
        choices = ", ".join(CHAIN_MAP)
        raise ValueError(f"unknown profile(s): {', '.join(unknown)}; choices: {choices}")
    if not profiles:
        raise ValueError("--profiles must contain at least one profile")
    return profiles


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=pathlib.Path)
    ap.add_argument("--out", dest="dst", required=True, type=pathlib.Path)
    ap.add_argument("--manifest", type=pathlib.Path, default=None)
    ap.add_argument("--seed", type=int, default=20260813)
    ap.add_argument("--suite", choices=("sampled", "contest-core"), default="sampled")
    ap.add_argument(
        "--profiles",
        default=None,
        help="comma-separated explicit profiles; overrides --suite and applies each to every source",
    )
    ap.add_argument(
        "--keep-original",
        action="store_true",
        help=(
            "also store the source after optional codec/size matching so "
            "clean-vs-degraded is measurable"
        ),
    )
    ap.add_argument(
        "--match-source-codec",
        choices=("none", "jpeg"),
        default="none",
        help=(
            "re-encode every source to this codec before degrade so file magic "
            "and source_format cannot separate labels (default: none)"
        ),
    )
    ap.add_argument(
        "--jpeg-quality",
        type=int,
        default=95,
        help="JPEG quality used by --match-source-codec jpeg (default: 95)",
    )
    ap.add_argument(
        "--match-size",
        choices=("none", "square"),
        default="none",
        help=(
            "label-blind geometry match before degrade. square = center-cover "
            "to --match-size-px so native pixel count/aspect cannot separate "
            "labels. Does not upscale sources already skipped by the 16MP cap."
        ),
    )
    ap.add_argument(
        "--match-size-px",
        type=int,
        default=1024,
        help="edge length in pixels for --match-size square (default: 1024)",
    )
    ap.add_argument(
        "--variants",
        type=int,
        default=1,
        help="copies per source/profile; each gets deterministic parameters",
    )
    ap.add_argument(
        "--max-source-pixels",
        type=int,
        default=DEFAULT_MAX_SOURCE_PIXELS,
        help="skip sources above this pixel count (web-realistic budget)",
    )
    args = ap.parse_args()

    if not args.src.is_dir():
        sys.exit(f"input directory not found: {args.src}")
    if args.variants < 1:
        sys.exit("--variants must be at least 1")
    if args.match_source_codec == "jpeg" and not 1 <= args.jpeg_quality <= 95:
        sys.exit("--jpeg-quality must be in 1..95")
    if args.match_size == "square" and args.match_size_px < 1:
        sys.exit("--match-size-px must be at least 1")
    try:
        explicit_profiles = _parse_profiles(args.profiles)
    except ValueError as err:
        sys.exit(str(err))

    selected_profiles = explicit_profiles
    if selected_profiles is None and args.suite == "contest-core":
        selected_profiles = CONTEST_CORE

    files = sorted(path for path in args.src.rglob("*") if path.suffix.lower() in SUFFIXES)
    if not files:
        sys.exit(f"no images under {args.src}")

    records: list[dict] = []
    for path in files:
        rel = path.relative_to(args.src).as_posix()
        try:
            with Image.open(path) as opened:
                source_format = (opened.format or path.suffix.lstrip(".")).lower()
                source_width, source_height = opened.size
                if args.max_source_pixels > 0 and source_width * source_height > args.max_source_pixels:
                    print(
                        f"  skip (too large): {rel}: {source_width}x{source_height}",
                        file=sys.stderr,
                    )
                    continue
                opened.load()
                base = opened.convert("RGB")
        except Exception as err:  # noqa: BLE001 - one corrupt file must not stop a corpus run
            print(f"  skip (unreadable): {rel}: {err}", file=sys.stderr)
            continue

        original_bytes = path.stat().st_size
        original_sha256 = _sha256_file(path)
        try:
            base, match_meta = apply_source_match(
                base,
                codec=args.match_source_codec,
                jpeg_quality=args.jpeg_quality,
                match_size=args.match_size,
                match_size_px=args.match_size_px,
            )
        except ValueError as err:
            sys.exit(str(err))

        matched_format = "jpeg" if args.match_source_codec == "jpeg" else source_format
        source_meta = {
            "src": rel,
            "source_format": matched_format,
            "source_width": base.width,
            "source_height": base.height,
            "source_bytes": int(match_meta.get("matched_source_bytes", original_bytes)),
            "source_sha256": str(match_meta.get("matched_source_sha256", original_sha256)),
            "original_source_format": source_format,
            "original_source_width": source_width,
            "original_source_height": source_height,
            "original_source_bytes": original_bytes,
            "original_source_sha256": original_sha256,
            **{
                key: value
                for key, value in match_meta.items()
                if key not in {"matched_source_bytes", "matched_source_sha256"}
            },
        }

        try:
            if args.keep_original:
                output_stem = args.dst / "pristine" / pathlib.Path(rel).with_suffix("")
                out, output_meta = _write_output(base, output_stem)
                records.append({
                    **source_meta,
                    "out": out.relative_to(args.dst).as_posix(),
                    "chain": "pristine",
                    "steps": [],
                    "chain_index": 0,
                    "lossy_encode_count": 0,
                    **output_meta,
                })

            for variant in range(args.variants):
                if selected_profiles is None:
                    rng = stable_rng(args.seed, f"{rel}#sampled#{variant}")
                    img, chain_meta = draw_sampled_chain(base.copy(), rng)
                    output_stem = f"{pathlib.Path(rel).with_suffix('')}__v{variant}"
                else:
                    for profile in selected_profiles:
                        rng = stable_rng(args.seed, f"{rel}#{profile}#{variant}")
                        img, chain_meta = apply_chain(base.copy(), profile, rng)
                        output_stem = f"{pathlib.Path(rel).with_suffix('')}__{profile}__v{variant}"
                        out, output_meta = _write_output(img, args.dst / "degraded" / output_stem)
                        records.append({
                            **source_meta,
                            "out": out.relative_to(args.dst).as_posix(),
                            **chain_meta,
                            **output_meta,
                        })
                    continue

                out, output_meta = _write_output(img, args.dst / "degraded" / output_stem)
                records.append({
                    **source_meta,
                    "out": out.relative_to(args.dst).as_posix(),
                    **chain_meta,
                    **output_meta,
                })
        except Exception as err:  # noqa: BLE001 - one bad chain must not stop a corpus run
            print(f"  skip (failed): {rel}: {err}", file=sys.stderr)
            continue

    manifest_path = args.manifest or (args.dst / "degradation-manifest.json")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 2,
        "seed": args.seed,
        "suite": "explicit" if explicit_profiles is not None else args.suite,
        "profiles": selected_profiles,
        "match_source_codec": args.match_source_codec,
        "jpeg_quality": args.jpeg_quality if args.match_source_codec == "jpeg" else None,
        "match_size": args.match_size,
        "match_size_px": args.match_size_px if args.match_size != "none" else None,
        "storage": {
            "policy": "exact-final-encode-or-lossless-png",
            "purpose": "prevents an unreported final recompression while keeping files compact",
        },
        "source_count": len({record["src"] for record in records}),
        "count": len(records),
        "records": records,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    counts: dict[str, int] = {}
    for record in records:
        counts[record["chain"]] = counts.get(record["chain"], 0) + 1
    print(f"wrote {len(records)} images from {manifest['source_count']} sources -> {args.dst}")
    for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {name:24s} {count}")
    print(f"manifest: {manifest_path}")
    print("\nNext: run tools/audit_leakage.py on the manifest + labels.")
    print("If source/degradation metadata predicts the label, the replica leaks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
