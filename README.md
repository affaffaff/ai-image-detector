<h1 align="center">AI Image Detector</h1>

<p align="center">
  <strong>Local neural image forensics for Chrome.</strong><br>
  Automatic detection | Official checkpoint preprocessing | Zero cloud inference
</p>

<p align="center">
  <img alt="Chrome Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white">
  <img alt="Inference: on-device" src="https://img.shields.io/badge/inference-on--device-00A67E?style=flat-square">
  <img alt="Runtime: ONNX" src="https://img.shields.io/badge/runtime-ONNX_WASM-005CED?style=flat-square&logo=onnx&logoColor=white">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-CB2E6D?style=flat-square">
</p>

AI Image Detector is a Manifest V3 extension that finds images on ordinary web
pages and analyzes them **locally, inside the browser**. No image, URL, hash, or
score is uploaded to a detector service—there is no detector service.

| `LOCAL BY DESIGN` | `VERIFIED MODEL` | `RESILIENT SETUP` | `AUDITABLE BUILD` |
|:---:|:---:|:---:|:---:|
| No backend or telemetry | Pinned size + SHA-256 | Resume + retry + recovery | Deterministic source build |

> [!NOTE]
> The project is MIT licensed. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
> for model attribution and [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) for the
> requirement-by-requirement release status.

> [!IMPORTANT]
> **Release status (2026-08-14):** the fixed-0.65 unseen-generator evaluation
> passes at **0.8799 balanced accuracy**, but this is not yet a distributable
> production release. The build, owner-approved redistribution audit, and
> INT8-versus-FP32 report pass. The model URL is still null and the calibration
> curve remains quarantined because the frozen native-format nuisance battery
> fails; publication and hosted checks therefore cannot proceed.

---

## How it works

```text
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  content script  │───▶│  service worker  │───▶│ offscreen runtime│
│ discover + badge │    │ route + calibrate│    │ ONNX · WASM · OPFS│
└──────────────────┘    └──────────────────┘    └──────────────────┘
         ▲                                               │
         └────────────── local verdict ──────────────────┘
```

Four constraints drive that shape:

- **The ONNX browser runtime cannot run in an MV3 service worker**, so inference
  lives in an offscreen document using the broadly compatible WASM backend.
- **Cross-origin canvas is tainted**, so pixels are fetched as bytes rather than
  read from the page.
- **The service worker dies after ~30s idle**, so no scan state is held in its
  memory; computed results are cached in `chrome.storage.session`.
- **Preprocessing must match calibration.** The shipped Community Forensics
  checkpoint uses its official evaluation transform: resize the short edge to
  440, then take one centered 384 px crop. The archived native-grid/max bake-off
  remains evidence, but is not the production signal.

### Signals

| Signal | Method | Status |
|---|---|---|
| Learned detector | ONNX ViT-S/16 384, official center crop | **Implemented** |
| Provenance | C2PA manifest, EXIF/XMP `Software`, IPTC `digitalSourceType` | Planned — override path, never a vote |
| Frequency | FFT/DCT artifacts, JPEG-grid inconsistency | Planned — weak third vote |

Fusion is calibrated log-odds, and the order is load-bearing:

```text
raw scores -> per-signal calibration -> weighted log-odds sum
           -> sigmoid -> monotone shift -> compare against 0.65
```

Calibrating only at the end is wrong: the fusion sums log-likelihood ratios, and
a raw score that is not a probability produces a meaningless LLR. The
implementation and its reasoning are in [`src/fusion/`](src/fusion/).

---

## Build and load

Requirements: **Node.js 22 or newer** and npm. CI pins 26.5.0 via
[`.nvmrc`](.nvmrc); the build itself depends on the pinned lockfile and esbuild,
not on the Node major version.

```bash
npm ci
npm run check
npm run build
```

The normal build currently produces the intentional **release/no-model**
verification package: it exercises the real release behavior, but reports that
model setup is not configured because the production artifact URL is still
null. Use the local real-model build below for scored scans during development.

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `dist/`.

### First-run model setup

The installer is implemented and browser-tested, but the production artifact
has not been published yet. Once its direct URL is pinned, the extension will
download the model on first install, verify its byte length and SHA-256, and
move it into private OPFS storage. Interrupted downloads resume with HTTP Range
requests. Browser startup recovers an unfinished attempt, and the popup shows
durable progress plus a manual retry action. Every trigger joins the same
download rather than opening competing network requests or OPFS writers.

After verification, inference is fully local and the model is not downloaded
again. The artifact contract and publication checks are documented in
[`docs/MODEL_PUBLISHING.md`](docs/MODEL_PUBLISHING.md); current release readiness
is tracked in [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

### Development build

```bash
npm run build:dev
```

Enables a deterministic mock engine and an on-page diagnostic HUD, and renames
the extension to *"AI Image Detector (DEV — simulated scores)"*. Release builds
compile `__DEV_BUILD__` to `false`, so every mock path is dead-code eliminated —
a shipped build cannot display a fabricated score.

### Local real-model verification build

Model artifacts under `models/weights/` are generated and gitignored.

```bash
py -3.11 -m venv .venv-export
.venv-export/Scripts/python -m pip install -r tools/requirements-export.txt
.venv-export/Scripts/python tools/export_onnx.py
npm run build:local-model
```

If the pinned Hugging Face download is unavailable, pass an already-downloaded
official checkpoint with `--checkpoint <path>`. The exporter rejects any file
whose SHA-256 does not match a pinned official artifact.

`build:local-model` embeds the locally exported INT8 artifact and labels the
extension **AI Image Detector (Local Model)**. It exercises the same verified OPFS and ORT
path, but it is a verification build — not the production package.

---

## Verifying our claims

Nothing here needs to be taken on trust.

**Tests and types**

```bash
npm run check
```

**Reproducible build** — the same source must produce byte-identical output.
This is what CI does on every commit:

```bash
npm run build
find dist -type f | sort | xargs sha256sum > /tmp/a.sum
npm run build
find dist -type f | sort | xargs sha256sum > /tmp/b.sum
diff /tmp/a.sum /tmp/b.sum
```

An empty diff is the pass condition. [`.gitattributes`](.gitattributes) forces
LF so source bytes are identical across platforms.

**Offline operation** — use a local real-model build (or, after publication, a
normal build whose one-time setup has finished), disable networking, and scan
locally available images. Inference continues from the verified OPFS artifact
without a backend or second model download.

**Data tooling**

```bash
npm run test:data
```

**Live-site coverage** — the browser harness measures viewport discovery,
anonymous CDN fetches, decoding, routing, and badge completion on image-heavy
public pages. See [`docs/LIVE_COVERAGE.md`](docs/LIVE_COVERAGE.md) for the
fresh-profile baseline and reproduction command.

**Extension E2E** — release/no-model, dev/mock, and local/ORT browser modes are
covered by [`tools/smoke_extension.mjs`](tools/smoke_extension.mjs). The passed
matrix and commands are in [`docs/E2E_TESTS.md`](docs/E2E_TESTS.md).

---

## Model contract

- **Checkpoint:** OwensLab Community Forensics 384px — **MIT** weights.
- **Backbone:** `vit_small_patch16_384.augreg_in21k_ft_in1k` — **Apache-2.0**.
- **Input:** float32 `[1, 3, 384, 384]`, ImageNet normalization.
- **Output:** one fake-image logit, converted with sigmoid.
- **Browser artifact:** dynamic INT8 ONNX, 23,967,155 bytes, SHA-256
  `df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035`.

The exporter verifies the ONNX graph and PyTorch/FP32 numerical parity.
Exporting twice from the same pinned checkpoint produces byte-identical FP32,
INT8, and metadata files.

### Licensing diligence

Hosting weights makes us a distributor, not merely a user, so every publicly
released weight file must pass a **three-way check** — the weights' own licence,
the base model's, and the training data's terms. The owner-approved
[`docs/PROVENANCE_AUDIT.md`](docs/PROVENANCE_AUDIT.md) records a PASS: the
Community Forensics weights are MIT, the timm backbone is Apache-2.0 and
contributes no pretrained bytes, and this project does not use or redistribute
the training dataset.

One result is worth stating explicitly, because it is easy to get wrong: the
Community Forensics **weights are marked MIT**, while the Community Forensics
dataset card states **CC BY 4.0**, with research-purpose and per-image-license
qualifiers for dataset users. We do **not** download, train on, evaluate
against, or redistribute that dataset.
Calibration and evaluation use independent sources, including OpenSDID+ under
CC BY-SA 4.0 and separately sourced real images. The normal build does not yet
distribute the model weights because a separate nuisance-battery gate fails.

---

## Evaluation

The release threshold is fixed at **0.65**. The evaluator has no threshold
override and will not run without a hash-valid leakage audit, fixed config,
output report, and hash-chained log.

The full-power, unseen-generator acceptance run now passes:

| Metric at 0.65 | Result | Source-clustered 95% CI |
|---|---:|---:|
| True-positive rate | 0.8203 | [0.7739, 0.8638] |
| True-negative rate | 0.9396 | [0.9225, 0.9559] |
| **Balanced accuracy** | **0.8799** | **[0.8554, 0.9034]** |

The result covers 2,097 web-degraded images from 230 AI and 469 real source
clusters. It clears the 0.75 gate, meets the 100-cluster-per-class power floor,
and records `underpowered: false`. The construction-only shortcut audit passes
at grouped-CV AUC 0.5192, and the detector beats the strongest fitted nuisance
null on the source-matched web-realistic pack by +0.2545 BA (95% CI [0.2135,
0.2957]). That does not override the independent native-format result: the
frozen B1-B5 permutation battery fails, and its codec null reaches 0.8889 BA
against the detector's 0.8651. See
[`docs/NUISANCE_BATTERY_REPORT.md`](docs/NUISANCE_BATTERY_REPORT.md).

The local evidence workspace retains the scored rows and acceptance report at
`data/matched/browser-scores-all.csv` and
`data/matched/gated-eval-all.json`. Dataset images and score arrays are
deliberately gitignored. The report pins the exact calibration bytes used for
the run, and that seal is current: the calibration hash recorded in
`gated-eval-all.json` equals the SHA-256 of the shipped `fused.json`
(`01f62f01…`), and the last entry of the hash-chained `gated-eval-all.jsonl`
log matches the report file on disk. No re-seal is outstanding.

With an evaluation environment activated and `tools/requirements.txt`
installed, the evaluator and shipping contract have standalone integration
checks:

```bash
npm run test:evaluation
npm run assert:shipping
```

The manifest also propagates `cluster_id`, `image_sha256`, and
`dataset_manifest_sha256`; scorers add `score` and `model_sha256`. See
[`docs/EVALUATION_GATES.md`](docs/EVALUATION_GATES.md) for the evidence schema,
coverage/count gates, clustered CIs, null baselines, calibration isolation, and
the INT8-versus-FP32 runner.

### Evaluation toolchain

The replica is built by tooling in [`tools/`](tools/), because an accuracy
number nobody can rebuild is not evidence:

| Step | Tool | Guarantee |
|---|---|---|
| Collect real negatives | `fetch_public_reals.py` | Public-domain/CC0 only, licence re-checked per image, grouped by photographer, full provenance recorded |
| Degrade both classes | `degrade_images.py` | Chains sampled **label-blind** from one distribution; byte-deterministic per (seed, path) |
| Audit construction shortcuts | `audit_leakage.py` | Hash-bound, source-grouped audit of degradation/container/dimension metadata. **≥0.70 grouped-CV AUC fails** |
| Dedupe and split | `dedupe_and_split.py` | Perceptual dedupe first, then whole-**group** holdout; asserts no group spans two splits |
| Fit calibration | `calibrate_score_csv.py` | Audit-bound, disjoint split; official-browser curve with hashed fit/eval rows |
| Challenge nuisance explanations | `explain_it_away.py` | Fit-only appearance, codec, spectral, geometry, blockiness, multivariate, and 32×32 nulls; paired detector-minus-best-null cluster CI |

Two disciplines these encode, both of which silently inflate results when
skipped:

- **Both classes are degraded from the same distribution.** The classic leak is
  pristine AI against recompressed real, which teaches "compression ⇒ real" and
  fails to generalize to held-out data.
- **Calibration is fitted on a split used for nothing else.** Fitting on data
  that also drove model selection tunes the curve to noise and lands the fixed
  boundary slightly wrong on everything new.

### Reporting contract

| Split | Meaning |
|---|---|
| Clean | Upper bound. Comparable to published figures; not predictive |
| Web-realistic degraded | The realistic operating point |
| **Unseen generators** | The number that counts |

Only the unseen-generator figure is treated as predictive; random splits are
inflated by generator fingerprints and are not reported. The current
perceptually deduplicated, generator-held-out result passes the statistical
gate. It is evidence for this pinned model, preprocessing contract, and corpus
design—not a universal accuracy guarantee and not, by itself, release approval.

---

## Repository layout

```text
ai-image-detector/
├── src/
│   ├── background/   # MV3 routing, scheduling, fusion
│   ├── content/      # image discovery and isolated badge overlay
│   ├── fusion/       # calibration and log-odds fusion
│   ├── offscreen/    # ONNX/WASM inference + resumable installer
│   └── popup/        # status, progress, and recovery UI
├── models/           # pinned artifact contract + calibration curves
├── test/             # node:test suites
├── tools/            # build, export, dataset, and evaluation tooling
└── docs/             # compliance, privacy, and methodology
```

---

## Privacy

Every image is analyzed on-device. Full accounting in
[`docs/PRIVACY.md`](docs/PRIVACY.md); the essentials:

```text
pixels ──▶ browser inference ──▶ calibrated verdict
  └─────── never sent to an AI detection service ────────┘
```

- **No cloud inference, external detection API, telemetry, or local server.**
- Once the production artifact is published, one-time model setup will download
  it from the pinned public host and accept it only after SHA-256 verification.
  The current normal build has no model URL and makes no setup download.
- To analyze cross-origin images without a tainted canvas, the extension reads
  bytes from the image's existing URL. It never sends them to a detector
  service, and requests use **`credentials: 'omit'`**, so cookies are not
  attached. Auth-gated images are reported unscannable.
- **No shipped image-hash verdict table.** Session memoization caches only
  results computed locally during the current browser session, and is empty at
  every browser start.

## Non-goals

- Firefox and Brave compatibility is optional polish, not current scope.
- No cloud fallback of any kind that is the security property, not a
  limitation to work around.
