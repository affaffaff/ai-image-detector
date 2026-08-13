# AI Image Detector — Chrome Extension

A Manifest V3 Chrome extension that automatically analyzes images on ordinary web
pages and displays a confidence score for each one. **All inference runs locally in
the browser.** No image, hash, or derived feature ever leaves the device.

License: **MIT** (see [`LICENSE`](LICENSE)).

---

## Status

> **Pre-release.** The sections marked _TBD_ below are placeholders until the
> corresponding code lands. Do not treat them as working instructions yet.

---

## How it works

Three decorrelated signals are fused into a single calibrated probability.

| Signal | Method | Weight |
|---|---|---|
| **Provenance** | C2PA manifest verification, EXIF/XMP `Software`, IPTC `digitalSourceType` | Override / very high |
| **Learned detector** | ONNX vision transformer, WebGPU with WASM fallback | Primary verdict |
| **Frequency features** | FFT/DCT artifacts, JPEG-grid inconsistency | Weak third vote |

Fusion is calibrated log-odds:

```
L = logit(prior) + Σ_i w_i · log( p_i / (1 − p_i) )
P(AI) = σ(L)
```

Weights `w_i` are fitted from measured log-likelihood-ratio quality on a held-out
split, not hand-tuned. A valid signed C2PA manifest short-circuits the fusion
rather than voting in it.

**Calibration.** The output is monotonically remapped so that the
balanced-accuracy-optimal decision boundary lands at **0.65**. This is a
calibration fit on our own validation data — it contains no benchmark-specific
information and no precomputed answers.

### Architecture

```
content script  ──> collects candidate <img>/CSS images
   │                 (MutationObserver + IntersectionObserver,
   │                  min-size filter, viewport priority)
   ▼
service worker  ──> fetches bytes cross-origin (canvas is tainted otherwise)
   │                 no scan state held in SW memory (~30s idle death)
   ▼
offscreen doc   ──> ONNX Runtime Web inference
   │                 (WebGPU is unavailable in MV3 service workers)
   ▼
badge overlay   ──> pending state instantly, score when inference lands
```

### Privacy

Every image is analyzed on-device. There is no backend, no telemetry, and no
network access after the one-time setup download described below.

---

## Install

### From source

```bash
git clone https://github.com/affaffaff/ai-image-detector.git
cd ai-image-detector
npm ci
npm run build          # emits dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `dist/`.

### First-run model download

On first launch the extension downloads model weights once from a public host,
verifies them against a pinned SHA-256, and stores them in OPFS. This is the only
network request the extension ever makes. After setup it runs fully offline; the
download is resumable if interrupted.

Pinned hashes and source URLs live in [`models/manifest.json`](models/manifest.json). _(TBD)_

### Reproducible build

`npm ci` against the committed lockfile with pinned toolchain versions produces a
byte-identical `dist/`. CI verifies this on every commit. _(TBD)_

---

## Evaluation

Reported on our own held-out replica set, at the fixed 0.65 threshold, using
**balanced accuracy** = mean(TPR, TNR).

| Split | Balanced accuracy |
|---|---|
| Clean | _TBD_ |
| Web-realistic degraded | _TBD_ |
| **Unseen generators** | _TBD_ |

The unseen-generator row is the number that matters. Random splits overstate
performance badly, because near-duplicates and generator fingerprints leak across
them.

Reproduce with: `npm run eval -- --set <path>` _(TBD)_

---

## Roadmap — accuracy improvements not yet implemented

Everything below is deliberately deferred. The current build uses **off-the-shelf
public weights with no additional training**, which keeps the toolchain fully
reproducible from source and the whole pipeline auditable. The items here need
GPU time, large-scale data collection, or both, and each one is an independent
increment.

Ordered by expected accuracy gain per unit of effort.

### 1. Domain-adapted finetune of the primary detector

The dominant known failure mode in the literature is degradation, not
architecture: detectors that score well on clean generated images collapse on
recompressed, rescaled, screenshotted copies. Published cross-detector benchmarks
put the drop between clean and realistic mixtures at tens of points.

**Approach:** finetune the existing ONNX backbone on native-resolution crops with
matched degradation chains (JPEG q50–95, WebP, rescale, double-compression,
screenshot simulation). Export int8.

**Two rules that determine whether this works:**

- **Train on native-resolution crops, never on resized whole images.** Downscaling
  destroys the high-frequency evidence before the model sees it. Crops must match
  the tiling used at inference.
- **Augment both classes from the same degradation distribution.** The classic
  leak is clean-PNG positives versus recompressed-JPEG negatives, which teaches
  the model that compression means "real" and produces a validation number that
  evaporates on held-out data. Audit for it by training a classifier on
  degradation metadata alone — if it separates the classes, the split is leaking.

**Cost:** hours on a single modern GPU, once the data exists.

### 2. Second decorrelated model on the noise residual

A small CNN (~5M params, ~5MB int8) trained on SRM / high-pass filtered input
rather than RGB. The different input representation is the point: two RGB
transformers make correlated errors, and the fusion weights collapse toward a
single effective vote. Decorrelation is where the ensemble gains live.

### 3. Larger training corpus of current-generation outputs

The real bottleneck, and the one compute alone does not solve. Needs:

- Locally generated positives at volume from open weights (SDXL, Flux schnell,
  SD 3.5) with degradation chains applied — cheap and unlimited.
- Scraped positives from closed generators (Midjourney, Firefly, and successors),
  which cannot be generated locally and must be collected.
- Real-photo negatives spanning phone cameras, DSLRs, screenshots, and
  social-platform recompression, deduplicated by perceptual hash against the
  positives and across all splits.

Split by **generator**, holding entire generators out of training, so that the
headline number predicts behavior on generators that did not exist at training
time.

### 4. Cascade for auto-scan throughput

Cheap frequency features triage every image in milliseconds; the transformer runs
only on ambiguous ones. Keeps image-heavy pages smooth within a GPU budget.
Engineering rather than training, but only worth building once the accuracy
ceiling is settled.

### 5. Per-region heatmaps

Tile-level scores are already computed for the vote aggregation. Surfacing them as
an overlay costs little and adds real explainability — the user sees *which part*
of the image drove the verdict.

### 6. Learned fusion

Replace the hand-specified log-odds combination with a small learned head over the
signal vector. Only worth it once there are more than three signals; below that,
the closed-form version is more interpretable and calibrates more reliably.

---

## Non-goals

- **No cloud inference, no external API calls, no local server.** Not a
  limitation to work around — it is the security property.
- **No shipped hash→verdict lookup tables of any kind.** Runtime memoization of
  images the user has already scanned within a session is a cache; shipping
  precomputed answers is not detection.
- Firefox and Brave compatibility is optional polish, not scope.

---

## Contributing

Model weights entering this repo must be MIT-compatible **for redistribution**,
not merely for use, and the license of the base model they derive from must permit
it too. Training data and training scripts must be committed alongside any weights
we produce ourselves — a checkpoint that cannot be rebuilt from source does not
belong here.

## License

MIT.
