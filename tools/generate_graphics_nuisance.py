#!/usr/bin/env python3
"""Generate a deterministic graphics/text/chart nuisance set.

The graphic-content gate (src/shared/graphic-gate.js) exists because the
photo-vs-generated detector produces noise on rasterized vector art — text
stickers, logos, charts, UI screenshots — and that noise badges human-made
graphics as AI. This script renders exactly that content class locally with
PIL primitives, so the gate's recall can be measured on pixels we own,
license-clean, with no scraping.

Every source is rendered three ways, mirroring how graphics actually reach a
browser: the clean PNG, a full-size web JPEG, and a thumbnail-sized JPEG
(what an image-search grid serves). All images carry label 0: they are
human-authored graphics, not generative-model output.

Usage:
    .venv/Scripts/python tools/generate_graphics_nuisance.py \
        --out data/nuisance-graphics [--per-category 20] [--seed 20260814]

Outputs <out>/img/*.png|jpg, <out>/index.json and <out>/manifest.csv (the
column contract of tools/score_dataset_browser.mjs).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import pathlib
import random
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dedupe_and_split import phash  # noqa: E402


FONT_DIR = pathlib.Path("C:/Windows/Fonts")
FONT_CANDIDATES = [
    "arial.ttf", "arialbd.ttf", "ariblk.ttf", "verdana.ttf", "verdanab.ttf",
    "segoeui.ttf", "segoeuib.ttf", "seguisb.ttf", "tahoma.ttf", "tahomabd.ttf",
    "times.ttf", "timesbd.ttf", "georgia.ttf", "georgiab.ttf", "impact.ttf",
    "comic.ttf", "comicbd.ttf", "trebuc.ttf", "trebucbd.ttf", "calibri.ttf",
    "calibrib.ttf", "consola.ttf", "consolab.ttf", "cour.ttf", "courbd.ttf",
]

WORDS = [
    "Hi!", "HELLO", "SALE", "50% OFF", "NEW", "WOW", "OK!", "Yes", "No",
    "Hi there", "Welcome", "Thanks", "GO!", "Stop", "Open", "Free", "Hot",
    "Cool", "Best", "Top 10", "Win", "Play", "Now", "Live", "News",
]

LOREM = (
    "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
    "tempor incididunt ut labore et dolore magna aliqua ut enim ad minim "
    "veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea "
    "commodo consequat duis aute irure dolor in reprehenderit in voluptate "
    "velit esse cillum dolore eu fugiat nulla pariatur excepteur sint "
    "occaecat cupidatat non proident sunt in culpa qui officia deserunt"
).split()

PALETTE = [
    (231, 76, 60), (52, 152, 219), (46, 204, 113), (241, 196, 15),
    (155, 89, 182), (230, 126, 34), (26, 188, 156), (52, 73, 94),
    (233, 30, 99), (0, 150, 136), (63, 81, 181), (255, 87, 34),
    (96, 125, 139), (121, 85, 72), (0, 188, 212), (205, 220, 57),
]

CATEGORIES = [
    "word_sticker", "speech_bubble", "flat_icon", "logo_badge",
    "line_chart", "bar_chart", "pie_chart", "text_paragraph", "ui_card",
]


def load_fonts() -> list[pathlib.Path]:
    fonts = [FONT_DIR / name for name in FONT_CANDIDATES if (FONT_DIR / name).exists()]
    if not fonts:
        raise SystemExit("no usable TrueType fonts found under C:/Windows/Fonts")
    return fonts


def pick_bg(rng: random.Random) -> tuple:
    roll = rng.random()
    if roll < 0.40:
        return (255, 255, 255)
    if roll < 0.52:
        v = rng.randint(240, 252)
        return (v, v, v)
    if roll < 0.62:
        v = rng.randint(16, 40)
        return (v, v, v)
    return rng.choice(PALETTE)


def contrasting(bg: tuple, rng: random.Random) -> tuple:
    luma = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
    dark = (rng.randint(0, 60), rng.randint(0, 60), rng.randint(0, 60))
    light = (rng.randint(235, 255), rng.randint(235, 255), rng.randint(235, 255))
    if rng.random() < 0.5:
        choice = rng.choice(PALETTE)
        choice_luma = 0.299 * choice[0] + 0.587 * choice[1] + 0.114 * choice[2]
        if abs(choice_luma - luma) > 80:
            return choice
    return dark if luma > 128 else light


def maybe_gradient(image: Image.Image, rng: random.Random) -> Image.Image:
    """A minority of backgrounds get a subtle vertical gradient, like real
    banner design. These are expected to defeat the palette test sometimes;
    the measurement wants that case represented, not hidden."""
    if rng.random() > 0.15:
        return image
    base = image.getpixel((0, 0))
    top = tuple(max(0, min(255, c + rng.randint(-60, 60))) for c in base[:3])
    width, height = image.size
    for y in range(height):
        t = y / max(1, height - 1)
        row = tuple(round(top[i] + (base[i] - top[i]) * t) for i in range(3))
        ImageDraw.Draw(image).line([(0, y), (width, y)], fill=row)
    return image


def font_at(fonts: list[pathlib.Path], rng: random.Random, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(rng.choice(fonts)), size=size)


def canvas(rng: random.Random, wide_ok: bool = True) -> Image.Image:
    long_edge = rng.randint(420, 1200)
    if wide_ok and rng.random() < 0.4:
        width, height = long_edge, rng.randint(int(long_edge * 0.4), long_edge)
    else:
        width = height = long_edge
    image = Image.new("RGB", (width, height), pick_bg(rng))
    return maybe_gradient(image, rng)


def centered_text(draw: ImageDraw.ImageDraw, box: tuple, text: str, font, fill, stroke=0, stroke_fill=None):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    x = box[0] + (box[2] - box[0] - (right - left)) / 2 - left
    y = box[1] + (box[3] - box[1] - (bottom - top)) / 2 - top
    draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)


def draw_word_sticker(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    text = rng.choice(WORDS)
    color = contrasting(image.getpixel((2, 2)), rng)
    size = int(min(width, height) * rng.uniform(0.18, 0.34))
    stroke = rng.choice([0, 0, max(2, size // 14)])
    stroke_fill = contrasting(color, rng) if stroke else None
    centered_text(draw, (0, 0, width, height), text, font_at(fonts, rng, size), color, stroke, stroke_fill)
    if rng.random() < 0.5:  # accent shapes around the word
        accent = rng.choice(PALETTE)
        for _ in range(rng.randint(1, 4)):
            x, y = rng.randint(0, width), rng.randint(0, height // 5)
            r = rng.randint(6, 18)
            draw.ellipse([x - r, y - r, x + r, y + r], fill=accent)


def draw_speech_bubble(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    bubble = rng.choice(PALETTE) if rng.random() < 0.4 else (255, 255, 255)
    outline = (20, 20, 20)
    margin = int(min(width, height) * 0.12)
    box = (margin, margin, width - margin, int(height * 0.68))
    line = max(3, min(width, height) // 90)
    if rng.random() < 0.5:
        draw.ellipse(box, fill=bubble, outline=outline, width=line)
    else:
        draw.rounded_rectangle(box, radius=min(width, height) // 10, fill=bubble, outline=outline, width=line)
    tail_x = rng.randint(width // 3, 2 * width // 3)
    draw.polygon(
        [(tail_x, int(height * 0.85)), (tail_x - width // 12, int(height * 0.64)), (tail_x + width // 12, int(height * 0.64))],
        fill=bubble, outline=outline,
    )
    size = int(min(width, height) * rng.uniform(0.12, 0.2))
    centered_text(draw, box, rng.choice(WORDS), font_at(fonts, rng, size), contrasting(bubble, rng))


def draw_flat_icon(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cx, cy = width // 2, height // 2
    radius = int(min(width, height) * rng.uniform(0.26, 0.4))
    colors = rng.sample(PALETTE, 3)
    shape = rng.random()
    if shape < 0.34:
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=colors[0])
        draw.ellipse([cx - radius // 2, cy - radius // 2, cx + radius // 2, cy + radius // 2], fill=colors[1])
    elif shape < 0.67:
        points = []
        sides = rng.choice([3, 5, 6])
        for i in range(sides):
            angle = 2 * math.pi * i / sides - math.pi / 2
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
        draw.polygon(points, fill=colors[0])
        draw.ellipse([cx - radius // 3, cy - radius // 3, cx + radius // 3, cy + radius // 3], fill=colors[1])
    else:
        bar_width = radius // 2
        for i, dx in enumerate((-1.5, 0, 1.5)):
            bar_height = radius * rng.uniform(0.6, 1.4)
            x = cx + int(dx * bar_width)
            draw.rectangle([x - bar_width // 2, cy + radius - int(bar_height), x + bar_width // 2, cy + radius], fill=colors[i % 3])
    if rng.random() < 0.4:
        size = int(min(width, height) * 0.1)
        centered_text(draw, (0, int(height * 0.78), width, height), rng.choice(WORDS), font_at(fonts, rng, size), contrasting(image.getpixel((2, 2)), rng))


def draw_logo_badge(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cx, cy = width // 2, int(height * 0.44)
    radius = int(min(width, height) * rng.uniform(0.22, 0.34))
    main, ring = rng.sample(PALETTE, 2)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=main, outline=ring, width=max(4, radius // 8))
    initials = "".join(rng.choice("ABCDEFGHIKLMNOPRSTUW") for _ in range(rng.randint(1, 3)))
    centered_text(draw, (cx - radius, cy - radius, cx + radius, cy + radius), initials, font_at(fonts, rng, int(radius * 0.9)), (255, 255, 255))
    caption = rng.choice(["STUDIO", "COMPANY", "BRAND", "AGENCY", "DESIGN", "MEDIA"])
    size = int(min(width, height) * 0.08)
    centered_text(draw, (0, cy + radius, width, min(height, cy + radius + size * 3)), caption, font_at(fonts, rng, size), contrasting(image.getpixel((2, 2)), rng))


def chart_frame(image: Image.Image, rng: random.Random, fonts) -> tuple:
    """Light chart background, axes, gridlines, tick labels. Returns plot box."""
    draw = ImageDraw.Draw(image)
    width, height = image.size
    axis = (60, 60, 70)
    left, top = int(width * 0.14), int(height * 0.14)
    right, bottom = int(width * 0.94), int(height * 0.86)
    grid = (208, 212, 220) if sum(image.getpixel((2, 2))[:3]) > 380 else (70, 74, 84)
    small = font_at(fonts, rng, max(10, int(min(width, height) * 0.035)))
    for i in range(5):
        y = top + (bottom - top) * i // 4
        draw.line([(left, y), (right, y)], fill=grid, width=1)
        draw.text((left - int(width * 0.06), y - 6), str((4 - i) * 25), font=small, fill=axis)
    draw.line([(left, top), (left, bottom)], fill=axis, width=3)
    draw.line([(left, bottom), (right, bottom)], fill=axis, width=3)
    title_size = max(12, int(min(width, height) * 0.05))
    centered_text(draw, (0, 0, width, top), rng.choice(["Revenue by quarter", "Traffic 2026", "Sensor output", "Results", "Weekly totals"]), font_at(fonts, rng, title_size), axis)
    return left, top, right, bottom


def draw_line_chart(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = chart_frame(image, rng, fonts)
    for color in rng.sample(PALETTE, rng.randint(1, 3)):
        points = []
        steps = rng.randint(6, 12)
        for i in range(steps):
            x = left + (right - left) * i / (steps - 1)
            y = bottom - (bottom - top) * rng.uniform(0.08, 0.92)
            points.append((x, y))
        draw.line(points, fill=color, width=max(2, (right - left) // 220))
        if rng.random() < 0.5:
            r = max(3, (right - left) // 160)
            for x, y in points:
                draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_bar_chart(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = chart_frame(image, rng, fonts)
    bars = rng.randint(4, 9)
    colors = rng.sample(PALETTE, 2)
    span = (right - left) / bars
    for i in range(bars):
        bar_height = (bottom - top) * rng.uniform(0.15, 0.95)
        x0 = left + span * i + span * 0.18
        x1 = left + span * (i + 1) - span * 0.18
        draw.rectangle([x0, bottom - bar_height, x1, bottom], fill=colors[i % len(colors)])


def draw_pie_chart(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cx, cy = int(width * 0.42), int(height * 0.52)
    radius = int(min(width, height) * 0.3)
    wedges = rng.randint(3, 6)
    weights = [rng.uniform(0.5, 2.0) for _ in range(wedges)]
    total = sum(weights)
    colors = rng.sample(PALETTE, wedges)
    angle = -90.0
    small = font_at(fonts, rng, max(10, int(min(width, height) * 0.04)))
    labels = ["Alpha", "Beta", "Gamma", "Delta", "Other", "Rest"]
    for i in range(wedges):
        sweep = 360 * weights[i] / total
        draw.pieslice([cx - radius, cy - radius, cx + radius, cy + radius], angle, angle + sweep, fill=colors[i], outline=(255, 255, 255), width=2)
        angle += sweep
        ly = int(height * 0.2) + i * int(small.size * 1.7)
        lx = int(width * 0.78)
        draw.rectangle([lx, ly, lx + small.size, ly + small.size], fill=colors[i])
        draw.text((lx + small.size + 6, ly), labels[i], font=small, fill=(50, 50, 60))


def draw_text_paragraph(image: Image.Image, rng: random.Random, fonts) -> None:
    width, height = image.size
    dark_mode = rng.random() < 0.25
    bg = (24, 26, 32) if dark_mode else (255, 255, 255)
    image.paste(bg, (0, 0, width, height))
    draw = ImageDraw.Draw(image)
    ink = (222, 226, 232) if dark_mode else (28, 30, 34)
    margin = int(width * 0.08)
    y = margin
    heading = font_at(fonts, rng, int(width * 0.05))
    draw.text((margin, y), " ".join(rng.sample(LOREM, 3)).title(), font=heading, fill=ink)
    y += int(heading.size * 1.8)
    body = font_at(fonts, rng, max(12, int(width * 0.026)))
    words = rng.sample(LOREM * 3, min(len(LOREM) * 3, rng.randint(60, 140)))
    line = ""
    for word in words:
        if y > height - margin:
            break
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=body) > width - 2 * margin:
            draw.text((margin, y), line, font=body, fill=ink)
            y += int(body.size * 1.5)
            line = word
        else:
            line = trial
    if line and y <= height - margin:
        draw.text((margin, y), line, font=body, fill=ink)


def draw_ui_card(image: Image.Image, rng: random.Random, fonts) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    card = (255, 255, 255) if sum(image.getpixel((2, 2))[:3]) < 600 else (246, 248, 250)
    margin = int(min(width, height) * 0.1)
    box = (margin, margin, width - margin, height - margin)
    draw.rounded_rectangle(box, radius=margin // 2, fill=card, outline=(210, 214, 220), width=2)
    accent = rng.choice(PALETTE)
    avatar_r = int(min(width, height) * 0.08)
    ax, ay = box[0] + avatar_r * 2, box[1] + avatar_r * 2
    draw.ellipse([ax - avatar_r, ay - avatar_r, ax + avatar_r, ay + avatar_r], fill=accent)
    name = font_at(fonts, rng, max(12, int(min(width, height) * 0.05)))
    draw.text((ax + avatar_r + 12, ay - name.size), rng.choice(["Alex Chen", "Sam Lee", "Mia Park", "Jo Ray", "Kim Novak"]), font=name, fill=(30, 32, 36))
    line_y = ay + avatar_r + int(height * 0.04)
    for _ in range(rng.randint(2, 5)):
        line_width = rng.uniform(0.4, 0.85) * (box[2] - box[0] - 2 * avatar_r)
        draw.rounded_rectangle([box[0] + avatar_r, line_y, box[0] + avatar_r + line_width, line_y + int(height * 0.025)], radius=6, fill=(224, 228, 234))
        line_y += int(height * 0.05)
    button = (box[0] + avatar_r, box[3] - int(height * 0.14), box[0] + avatar_r + int(width * 0.3), box[3] - int(height * 0.06))
    draw.rounded_rectangle(button, radius=10, fill=accent)
    centered_text(draw, button, rng.choice(["Follow", "Open", "Reply", "Share"]), font_at(fonts, rng, max(11, int(min(width, height) * 0.04))), (255, 255, 255))


DRAWERS = {
    "word_sticker": draw_word_sticker,
    "speech_bubble": draw_speech_bubble,
    "flat_icon": draw_flat_icon,
    "logo_badge": draw_logo_badge,
    "line_chart": draw_line_chart,
    "bar_chart": draw_bar_chart,
    "pie_chart": draw_pie_chart,
    "text_paragraph": draw_text_paragraph,
    "ui_card": draw_ui_card,
}


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--per-category", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260814)
    args = parser.parse_args()

    fonts = load_fonts()
    img_dir = args.out / "img"
    img_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for category in CATEGORIES:
        for index in range(args.per_category):
            rng = random.Random(f"{args.seed}:{category}:{index}")
            image = canvas(rng, wide_ok=category not in ("flat_icon", "logo_badge"))
            DRAWERS[category](image, rng, fonts)

            stem = f"{category}-{index:03d}"
            variants = []
            native = img_dir / f"{stem}__clean.png"
            image.save(native, format="PNG")
            variants.append((native, "clean"))

            jpeg = img_dir / f"{stem}__jpeg.jpg"
            image.save(jpeg, format="JPEG", quality=rng.randint(62, 90), subsampling=2)
            variants.append((jpeg, "jpeg"))

            # The image-search-grid case from the bug report: downscale to a
            # thumbnail, then JPEG. Antialiasing softens the vector edges;
            # the gate has to survive that or it misses the pages that matter.
            short = rng.randint(120, 280)
            scale = short / min(image.size)
            thumb = image.resize((max(64, round(image.size[0] * scale)), max(64, round(image.size[1] * scale))), Image.LANCZOS)
            thumb_path = img_dir / f"{stem}__thumb.jpg"
            thumb.save(thumb_path, format="JPEG", quality=rng.randint(68, 86), subsampling=2)
            variants.append((thumb_path, "thumbnail_jpeg"))

            for path, degradation in variants:
                records.append({
                    "path": path.relative_to(args.out).as_posix(),
                    "category": category,
                    "cluster": f"{category}-{index:03d}",
                    "degradation": degradation,
                    "seed": f"{args.seed}:{category}:{index}",
                })

    index_path = args.out / "index.json"
    index_path.write_text(json.dumps({"formatVersion": 1, "type": "graphics-nuisance-index", "records": records}, indent=2), encoding="utf-8")
    manifest_hash = sha256_file(index_path)

    manifest_path = args.out / "manifest.csv"
    with manifest_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=[
            "image_id", "path", "label", "generator", "split", "phash",
            "degradation", "cluster_id", "image_sha256", "dataset_manifest_sha256",
        ])
        writer.writeheader()
        for record in records:
            path = args.out / record["path"]
            hash_value = phash(path)
            if hash_value is None:
                raise SystemExit(f"unreadable generated image: {path}")
            writer.writerow({
                "image_id": pathlib.Path(record["path"]).name,
                "path": record["path"],
                "label": 0,
                "generator": f"human-graphic-{record['category']}",
                "split": "eval",
                "phash": f"{hash_value:016x}",
                "degradation": record["degradation"],
                "cluster_id": record["cluster"],
                "image_sha256": sha256_file(path),
                "dataset_manifest_sha256": manifest_hash,
            })

    print(f"wrote {len(records)} images -> {img_dir}")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
