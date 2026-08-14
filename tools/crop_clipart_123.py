"""Crop the 14 fully-visible clip-art thumbnails from the Google '123'
screenshot and build a score_dataset.py manifest. All label 0: human-made
stock clip art / app icons, regardless of Google's badge."""
import csv
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from dedupe_and_split import phash

SRC = Path(r"C:\Users\nazar\AppData\Local\Temp\kimi-desktop-attachments\1786742575907-10-image.png")
OUT = Path("data/clipart-123")
IMG = OUT / "img"
IMG.mkdir(parents=True, exist_ok=True)

# (name, left, top, right, bottom) in original 1920x945 pixels, image area only.
# Measured against full-resolution regions of the screenshot. badge = the
# extension's on-screen score for cross-checking.
TILES = [
    ("vector-green-123",      25, 175,  278, 315, "2%"),
    ("numbers-chart",        290, 175,  545, 315, None),
    ("song-cartoon-123",     558, 175,  813, 315, "26%"),
    ("glossy-balloon-123",   825, 175, 1078, 315, "16%"),
    ("pastel-red-123",      1092, 178, 1347, 355, "2%"),
    ("red-white-icon-123",  1358, 178, 1613, 430, "2%"),
    ("hanging-tags-123",    1623, 178, 1878, 430, "35%"),
    ("glossy-diagonal-123",   25, 372,  278, 665, "AI 65%"),
    ("pastel-cloud-123",     290, 372,  545, 640, None),
    ("rainbow-glitter-nums", 558, 372,  813, 760, "36%"),
    ("gold-3d-123",          825, 495, 1078, 720, "2%"),
    ("rainbow-kids-1234",   1092, 425, 1347, 665, "AI 72%"),
    ("green-app-3-full",    1358, 485, 1613, 750, "41%"),
    ("comic-pencil-123",    1623, 495, 1878, 750, "2%"),
]

im = Image.open(SRC).convert("RGB")
rows = []
import hashlib
for name, l, t, r, b, badge in TILES:
    crop = im.crop((l, t, r, b))
    p = IMG / f"{name}.png"
    crop.save(p)
    rows.append({
        "image_id": f"{name}.png",
        "badge_seen": badge or "",
        "path": f"img/{name}.png",
        "label": "0",
        "generator": "google-123-clipart",
        "split": "eval",
        # phash() opens a file path; passing the PIL Image silently returned
        # None (its except-swallow), leaving every row's phash column empty.
        "phash": phash(p),
        "degradation": "google-thumbnail",
        "cluster_id": name,
        "image_sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        "dataset_manifest_sha256": "",
    })

mf = OUT / "manifest.csv"
with mf.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"wrote {len(rows)} crops -> {IMG}")
for name, l, t, r, b, badge in TILES:
    print(f"  {name}: {r-l}x{b-t}  badge={badge}")
