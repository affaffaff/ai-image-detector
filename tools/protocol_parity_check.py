#!/usr/bin/env python3
"""One-off parity check: Python ONNX official_center vs sealed browser scores.

Scores a stratified sample of already-browser-scored eval images with the
pinned INT8 artifact through tools/score_dataset.py's official_center path and
diffs against score_official_browser. Also verifies that piecewise-linear
interpolation of models/calibration/fused.json reproduces
score_official_calibrated exactly.
"""

import csv
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score_dataset import official_center_tensor, sigmoid  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "models/weights/community-forensics-384-int8.onnx"
FUSED = json.load(open(ROOT / "models/calibration/fused.json"))
XS = np.asarray(FUSED["xs"])
YS = np.asarray(FUSED["ys"])

N_SAMPLE = 150
SEED = 20260815


def interp(raw: float) -> float:
    """Same clamped piecewise-linear rule as src/fusion/calibration.js."""
    if raw <= XS[0]:
        return float(YS[0])
    if raw >= XS[-1]:
        return float(YS[-1])
    i = int(np.searchsorted(XS, raw, side="right")) - 1
    x0, x1 = XS[i], XS[i + 1]
    y0, y1 = YS[i], YS[i + 1]
    if x1 == x0:
        return float(y0)
    return float(y0 + (y1 - y0) * (raw - x0) / (x1 - x0))


def main() -> None:
    rows = list(csv.DictReader(open(ROOT / "data/matched/browser-scores-all.csv", encoding="utf-8-sig")))
    eval_rows = [r for r in rows if r["split"] == "eval"]
    rng = random.Random(SEED)
    ai = [r for r in eval_rows if r["label"] == "1"]
    real = [r for r in eval_rows if r["label"] == "0"]
    sample = rng.sample(ai, N_SAMPLE // 2) + rng.sample(real, N_SAMPLE - N_SAMPLE // 2)
    rng.shuffle(sample)

    # 1) calibration interpolation fidelity on ALL sealed rows, not the sample
    max_cal_err = 0.0
    for r in rows:
        err = abs(interp(float(r["score_official_browser"])) - float(r["score_official_calibrated"]))
        max_cal_err = max(max_cal_err, err)
    print(f"calibration interp max |err| over {len(rows)} sealed rows: {max_cal_err:.3e}")

    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    diffs = []
    decisions_changed = 0
    t0 = time.time()
    for i, r in enumerate(sample):
        path = ROOT / "data/matched" / r["path"]
        with Image.open(path) as decoded:
            image = ImageOps.exif_transpose(decoded).convert("RGB")
            tensor = official_center_tensor(image)
        logit = float(sess.run(["fake_logit"], {"pixel_values": tensor})[0].reshape(-1)[0])
        py_score = sigmoid(logit)
        browser_score = float(r["score_official_browser"])
        diffs.append(abs(py_score - browser_score))
        if (interp(py_score) >= 0.65) != (float(r["score_official_calibrated"]) >= 0.65):
            decisions_changed += 1
        if (i + 1) % 25 == 0:
            el = time.time() - t0
            print(f"  {i + 1}/{len(sample)}  {el / (i + 1):.2f}s/img", flush=True)

    diffs = np.asarray(diffs)
    print(f"n={len(diffs)}  median|diff|={np.median(diffs):.3e}  "
          f"p95={np.percentile(diffs, 95):.3e}  max={diffs.max():.3e}")
    print(f"decisions changed at 0.65 after calibration: {decisions_changed}")
    print(f"mean seconds/image: {(time.time() - t0) / len(sample):.2f}")


if __name__ == "__main__":
    main()
