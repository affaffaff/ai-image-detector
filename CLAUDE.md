# CLAUDE.md

MV3 Chrome extension that auto-detects AI-generated images on web pages, fully
in-browser. Built for a bounty: ≥75.0% balanced accuracy at a FIXED 0.65
threshold, judged on a private, web-realistic benchmark. Winner-take-all.

Full design rationale, decision log, and strategy: `notes/architecture-brief-v1.md`.
Compliance source of truth: `notes/bounty-rules-and-combos.md`. Both are
**gitignored — this repo is public from day one, the notes are not.** Read the
brief before any significant design change; never commit anything from `notes/`.

## Hard constraints — a violation disqualifies the submission

- NO network access at scan time. No external APIs, no local server, no
  localhost. The only permitted network call, ever: the one-time model-weight
  download at setup (public host, SHA-256 verified, resumable).
- The 0.65 decision threshold is fixed by the rules. Never tune it. We calibrate
  our scores TO it (`src/fusion/`) — never the reverse.
- No shipped hash→verdict lookup tables. Session-scoped runtime memoization is
  fine; precomputed answers for specific images are not. Litmus test: "does this
  perform real inference on the image?"
- MIT only, redistribution-grade: every weight file passes the three-way license
  check (weights license + base-model license + training-data terms) before it
  enters the repo. Self-trained weights ship with committed training data and
  scripts, or they don't ship.
- Reproducible build: `npm ci && npm run build` must yield a byte-identical
  `dist/`. Pin all deps and toolchain versions. CI verifies.

## Engineering invariants — violating these loses accuracy silently

- NEVER resize a whole image to model input size. Tile at native resolution and
  aggregate tile votes. Downscaling destroys the forensic signal; it is the
  suspected cause of the sub-60% baseline's failure.
- Calibration order is load-bearing: per-signal calibration → weighted log-odds
  fusion → sigmoid → post-fusion monotone shift to 0.65. See the header of
  `src/fusion/fuse.js`. Skipping per-signal calibration corrupts the fusion
  weights with no visible error.
- Calibration curves are fitted ONLY on the dedicated calibration split — never
  on data used for model selection or fusion-weight fitting.
- Eval splits are BY GENERATOR (whole generators held out), pHash-deduped first.
  Unseen-generator balanced accuracy is the only number that predicts the
  private benchmark; random-split numbers are inflated and are not reported.
- WebGPU runs only in the offscreen document (unavailable in MV3 service
  workers). The WASM path must clear the accuracy bar alone — WebGPU is a
  latency optimization, never an accuracy prerequisite. ORT-web in extensions:
  `env.backends.onnx.wasm.numThreads = 1`.
- The service worker dies after ~30s idle: no scan state in SW memory; use
  `chrome.storage.session`.
- Cross-origin pixels: fetch bytes in the background worker
  (`host_permissions: <all_urls>`) — content-script canvas is tainted.
- A valid C2PA manifest short-circuits fusion (override path). It never votes.

## Do not

- No RL training loops (rejected in the decision log; supervised training plus
  post-hoc calibration solves the stated problem).
- No VLMs for detection: they read semantics, not compression artifacts, and
  cannot fit the ~22MB weight budget anyway.
- No `fetch()` in any scan path, ever — including "just telemetry".
- Do not commit `notes/` or eval datasets before submission.

## Commands

- Build: `npm run build` *(TBD until the MV3 skeleton lands)*
- Eval: `npm run eval -- --set <path>` *(TBD)*
- Fit calibration:
  `python tools/fit_calibration.py --scores S.npy --labels L.npy --eval-scores ES.npy --eval-labels EL.npy --id <signal> --out models/calibration/<signal>.json`

## Layout notes

- `src/fusion/` — calibration + log-odds fusion. Implemented and test-first.
- `tools/` — offline fitting scripts (Python, CPU, seconds).
- `models/manifest.json` — pinned weight URLs + SHA-256 *(TBD)*.
- `notes/` — PRIVATE, gitignored: briefs, strategy, eval data.
