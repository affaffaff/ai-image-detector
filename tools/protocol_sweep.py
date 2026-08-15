#!/usr/bin/env python3
"""Delivery-path protocol sweep (c143-survey PROTOCOL.md) for this submission.

Applies the survey's eleven fixed pipelines — copied verbatim from
https://github.com/agentatwork/local-ai-image-detector/blob/main/tools/robust.py
(the reference implementation named by PROTOCOL.md) — to every pristine image
in the archived holdout corpus (data/holdout/in, labels in
data/holdout/labels.json), then scores each result with the pinned INT8
artifact through the shipped official-center transform
(tools/score_dataset.py, the offline counterpart of src/offscreen/preprocess.js)
and the shipped fused.json calibration. Decisions are read at the fixed 0.65
operating point. Nothing is fitted here.

Output: data/protocol-sweep/scores.csv  (one row per image x condition)
Resumable: rows already in scores.csv are skipped, and --max-seconds makes the
script stop cleanly so a driver can re-invoke it.

Caveats recorded alongside the output:
- The base corpus overlaps the archived native-max strategy bake-off pool, and
  13 of its 131 source clusters also appear in the shipped calibration split.
  Nothing is fitted on it here, but it is not a virgin held-out set.
- AI images come from 2 generators only (kandinsky-2.2, sd-1.5).
- Python/Pillow bilinear stands in for the browser's Skia 'high' canvas
  resize; measured divergence is concentrated in the upscale regime
  (delivered short edge < 440 px) and is reported separately.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score_dataset import official_center_tensor, sigmoid  # noqa: E402

Image.MAX_IMAGE_PIXELS = 200_000_000

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "data/holdout/in"
LABELS = json.load(open(ROOT / "data/holdout/labels.json"))
FUSED = json.load(open(ROOT / "models/calibration/fused.json"))
XS = np.asarray(FUSED["xs"], dtype=np.float64)
YS = np.asarray(FUSED["ys"], dtype=np.float64)
MODEL = ROOT / "models/weights/community-forensics-384-int8.onnx"
MODEL_SHA256 = FUSED["modelSha256"]
OUT_DIR = ROOT / "data/protocol-sweep"
OUT_CSV = OUT_DIR / "scores.csv"

# --- BEGIN verbatim copy: agentatwork/local-ai-image-detector tools/robust.py
def _roundtrip(im, fmt, **kw):
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    buf.seek(0)
    out = Image.open(buf)
    out.load()
    return out.convert("RGB")


def _fit(im, longest, resample=Image.LANCZOS):
    w, h = im.size
    if max(w, h) <= longest:
        return im
    s = longest / max(w, h)
    return im.resize((max(1, round(w * s)), max(1, round(h * s))), resample)


COND = {
    "none": lambda im: im,
    "jpeg90": lambda im: _roundtrip(im, "JPEG", quality=90),
    "jpeg75": lambda im: _roundtrip(im, "JPEG", quality=75),
    "jpeg60": lambda im: _roundtrip(im, "JPEG", quality=60),
    "cms1600": lambda im: _roundtrip(_fit(im, 1600), "JPEG", quality=85),
    "cms1024": lambda im: _roundtrip(_fit(im, 1024), "JPEG", quality=85),
    "cms640": lambda im: _roundtrip(_fit(im, 640), "JPEG", quality=80),
    "webp80": lambda im: _roundtrip(im, "WEBP", quality=80),
    "rescale90": lambda im: im.resize((max(1, round(im.size[0] * .9)),
                                       max(1, round(im.size[1] * .9))), Image.BICUBIC),
    "sieve_web": lambda im: _roundtrip(_fit(im, 768), "JPEG", quality=60),
    "sieve_hard": lambda im: _roundtrip(_fit(im, 512), "JPEG", quality=40),
}
# --- END verbatim copy

FIELDS = [
    "image_id", "condition", "label", "generator", "cluster_id",
    "delivered_width", "delivered_height", "upscale_regime",
    "raw_score", "calibrated", "decision_ai",
]


def interp(raw: float) -> float:
    """Clamped piecewise-linear rule of src/fusion/calibration.js (verified
    against score_official_calibrated on all 3,057 sealed rows, max err 5e-11)."""
    if raw <= XS[0]:
        return float(YS[0])
    if raw >= XS[-1]:
        return float(YS[-1])
    i = int(np.searchsorted(XS, raw, side="right")) - 1
    x0, x1 = XS[i], XS[i + 1]
    y0, y1 = YS[i], YS[i + 1]
    return float(y0 if x1 == x0 else y0 + (y1 - y0) * (raw - x0) / (x1 - x0))


def load_done() -> set[tuple[str, str]]:
    if not OUT_CSV.exists():
        return set()
    with open(OUT_CSV, newline="", encoding="utf-8") as fh:
        return {(r["image_id"], r["condition"]) for r in csv.DictReader(fh)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-seconds", type=float, default=280)
    ap.add_argument("--conditions", default=",".join(COND))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    deadline = time.time() + args.max_seconds

    # Verify the artifact is the pinned one before spending any compute.
    import hashlib
    digest = hashlib.sha256(MODEL.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        raise SystemExit(f"model hash mismatch: {digest} != pinned {MODEL_SHA256}")

    # Image-level parallelism; ORT stays single-threaded per call so total
    # CPU use ~= workers (Pillow and ORT both release the GIL).
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"], sess_options=so)

    conditions = [c for c in args.conditions.split(",") if c in COND]
    items = sorted(LABELS.items())  # deterministic order
    done = load_done()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    new_file = not OUT_CSV.exists()
    fh = open(OUT_CSV, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(fh, fieldnames=FIELDS)
    if new_file:
        writer.writeheader()
        fh.flush()

    def work(rel: str, label: int, cond: str):
        with Image.open(BASE / rel) as decoded:
            image = ImageOps.exif_transpose(decoded).convert("RGB")
            delivered = COND[cond](image)
            tensor = official_center_tensor(delivered)
        logit = float(sess.run(["fake_logit"], {"pixel_values": tensor})[0].reshape(-1)[0])
        raw = sigmoid(logit)
        cal = interp(raw)
        parts = rel.split("/")
        cluster = parts[1] if parts[0] in ("ai", "real") else parts[0]
        return {
            "image_id": rel,
            "condition": cond,
            "label": int(label),
            "generator": cluster if label == 1 else "real",
            "cluster_id": f"{'ai' if label == 1 else 'real'}:{cluster}",
            "delivered_width": delivered.width,
            "delivered_height": delivered.height,
            "upscale_regime": int(min(delivered.size) < 440),
            "raw_score": f"{raw:.10f}",
            "calibrated": f"{cal:.10f}",
            "decision_ai": int(cal >= 0.65),
        }

    from concurrent.futures import ThreadPoolExecutor
    scored = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for cond in conditions:
            todo = [(rel, int(label)) for rel, label in items if (rel, cond) not in done]
            futures = {}
            for rel, label in todo:
                if time.time() > deadline:
                    break
                futures[pool.submit(work, rel, label, cond)] = rel
            for fut in futures:
                if time.time() > deadline:
                    break
                writer.writerow(fut.result())
                scored += 1
                if scored % 100 == 0:
                    fh.flush()
                    print(f"  {cond}: {scored} new rows", flush=True)
            fh.flush()
            print(f"  {cond}: submitted {len(futures)}, time left {max(0, deadline - time.time()):.0f}s", flush=True)
            if time.time() > deadline:
                break
    fh.close()
    total = len(load_done())
    expected = len(items) * len(conditions)
    print(f"{'complete' if total >= expected else 'checkpoint'}: +{scored} rows this run ({total}/{expected})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
