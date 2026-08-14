# Compliance and release status

Last updated: 2026-08-14.

**Overall project status: ready for local use and verification.** The extension,
source build, local inference path, fixed-threshold accuracy, INT8-versus-FP32
comparison, and owner-approved redistribution audit pass. A local real-model
build can run the complete detector without a backend or cloud inference.

**Public distribution status: hosted-model release pending.** Under the
repository's current public-release rules, the frozen native-format nuisance
battery must pass before the curve is marked `validated`, the model URL is
configured, and hosted-artifact checks begin. This remaining distribution gate
does not make the local project or detector implementation incomplete.

A check means the requirement is implemented and supported by current local
evidence. A construction marker means work or authorization is still required
before the normal release build can satisfy the requirement.

| Requirement | Status | Current evidence / remaining work |
|---|:---:|---|
| Native Manifest V3 extension | ✅ | `src/manifest.json`; MV3 service worker, offscreen document, and content script |
| MIT-licensed source and third-party notices | ✅ | `LICENSE` and `THIRD_PARTY_NOTICES.md` identify the source, model-weight, backbone, and evaluation-corpus licenses |
| Final model-redistribution diligence | ✅ | `PROVENANCE_AUDIT.md`; three-way first-party-source audit PASS and owner-approved by `affaffaff` on 2026-08-14 |
| All inference local | ✅ | `src/offscreen/ort-engine.js`; ONNX Runtime Web WASM; real-ORT browser E2E pass |
| No cloud detector, telemetry, or local backend | ✅ | Browser-only runtime; Python is export/evaluation tooling only; network behavior is documented in `PRIVACY.md` |
| Automatic first-run model setup | 🚧 | Resume, retry, recovery, OPFS storage, size checking, and SHA-256 verification are implemented; `models/manifest.json` still has `url: null` |
| Automatically analyze webpage images | ✅ | Mutation/intersection observers, lazy-source handling, frames, shadow roots, CSS backgrounds, candidate tests, and the 262/262 live-site coverage baseline |
| First real scored badge within 5,000 ms | ✅ | Fresh-profile Edge 151 local-ORT result: 4,402.1 ms from image `load` to the accessible scored badge; fixed gate in `tools/smoke_extension.mjs`; measurement contract in `PERFORMANCE.md` |
| Real calibrated confidence evidence | ✅ | The exact ORT-Web `official-center` signal has a disjoint calibration fit and a passing fixed-0.65 held-out evaluation in `models/calibration/fused.json` |
| Calibrated confidence in the normal release build | 🚧 | The curve remains `quarantined` because the frozen native-format nuisance and paired-null gates fail; with no public model URL, the normal build reports setup not configured |
| Fully reproducible source build | ✅ | `tools/build.mjs` uses unambiguous absolute esbuild entries; `npm run build` passes and the two-build hash comparison is part of final verification |
| Reproducible model export | ✅ | Pinned official checkpoint, strict state load, deterministic ONNX serialization, and PyTorch/FP32 parity guards |
| Hash-bound evaluation chain | ✅ | The evaluation config/report pin the current `fused.json` SHA-256 (`01f62f01…`), and the JSONL chain was re-sealed after quarantine metadata changed |
| Nuisance/null battery | ❌ | Frozen cluster-label permutation gate implemented and run on 905 native FIT/eval sources. B1/B2/B3/B5 fail; the codec null beats the detector and the paired interval includes zero. See `NUISANCE_BATTERY_REPORT.md` |
| INT8-versus-FP32 release report | ✅ | `INT8_FP32_REPORT.md`; p99 limit is consistently 0.25, measured p99 0.2409, BA drop 0.0018, decision disagreement 0.0134; all documented gates pass |
| Release metadata and public docs agree | ✅ | README, model-manifest commentary, and `fused.json` all identify the native nuisance battery as the active quarantine reason |
| No benchmark hashes or verdict lookup tables | ✅ | Pixel inference occurs on every cache miss; only current-session memoization is used |
| At least 75.0% balanced accuracy at 0.65 | ✅ | Passing unseen-generator result: 0.8799 BA, 95% clustered CI [0.8554, 0.9034] |
| Public, immutable model artifact | 🚧 | The exact 23,967,155-byte INT8 artifact is pinned by SHA-256, but it has not been published to an authorized public host |

## Accuracy acceptance evidence

The earlier statement that the corpus still needed to be produced is obsolete.
The current hash-bound evaluation artifacts record the following result for the
pinned INT8 model and shipped browser preprocessing:

| Gate | Result |
|---|---|
| Fixed operating threshold | **0.65**; the evaluator has no threshold override |
| Calibration isolation | Pass; 339 calibration images (150 AI, 189 real), with calibration/evaluation row hashes recorded in `fused.json` |
| Generator/source separation | Pass; evaluation scenario is `unseen-generator` and no gate failures are recorded |
| Label-blind degradation construction audit | Pass; grouped-CV ROC AUC 0.5192 against the 0.70 failure boundary |
| Pixel-inclusive (`full`) leakage audit | Recorded, deliberately **not** gated; it reports `status: fail` at grouped-CV AUC 0.7854. This feature set also measures genuine content statistics that are the detector's own signal, so it is expected to exceed 0.70 on any AI-vs-photo corpus. Reasoning: `EVALUATION_GATES.md` and `data/matched/analysis/leak-verdict.md` |
| Evaluation power | Pass; 230 AI and 469 real source clusters, above the 100-per-class floor; `underpowered: false` |
| TPR at 0.65 | 0.8203, 95% clustered CI [0.7739, 0.8638] |
| TNR at 0.65 | 0.9396, 95% clustered CI [0.9225, 0.9559] |
| Balanced accuracy at 0.65 | **0.8799**, 95% clustered CI **[0.8554, 0.9034]** |
| Source-matched nuisance margin | Pass on the web-realistic degraded pack: detector minus best fitted null = +0.2545 BA, 95% CI [0.2135, 0.2957] |
| Native-format detector result | 0.8651 BA, 95% clustered CI [0.8369, 0.8922], on 230 AI / 468 real evaluation clusters |
| Native-format paired null gate | **Fail.** Codec null BA 0.8889; detector-minus-null = -0.0238, 95% CI [-0.0602, 0.0105], which includes zero |
| Native-format permutation gate | **Fail.** B1/B2/B3/B5 corrected p = 0.000500 with excess >= 0.10; B4 corrected p = 0.015498 (warn) |

Primary evidence:

- `models/calibration/fused.json`
- `data/matched/leakage-audit-all-construction.json`
- `data/matched/gated-eval-all.json`
- `data/matched/native-battery/null-shootout.json` (local, gitignored)
- `docs/NUISANCE_BATTERY_REPORT.md` (retained public summary)

These figures establish the repository's fixed-threshold acceptance result for
this pinned model, preprocessing contract, and evaluation design. They are not
a claim of universal accuracy across every generator, image source, or future
web transformation.

## Remaining release gates

1. Construct a new blind native-format corpus that removes the measured
   dimension, byte-density, codec, and blockiness shortcuts without changing
   the frozen B1-B5 protocol. Re-run the battery and require both a passing
   permutation verdict and a paired detector-minus-null CI excluding zero.
2. Only after that pass, change the curve to `validated`, publish the exact
   pinned INT8 artifact to an immutable account-owned location, set
   `models[0].url`, and run `npm run assert:shipping`.
3. Complete the fresh-profile hosted online setup, offline scan, and offline
   browser-restart checks in `MODEL_PUBLISHING.md`.

Until those steps are complete, the passing statistical result does not make
the extension release-ready and the production URL must remain null.

## Model and data boundary

The released Community Forensics model weights are marked MIT by the authors;
the timm base model is Apache-2.0. The Community Forensics dataset card states
CC BY 4.0 with research-purpose and per-image-license qualifiers. Those dataset
releases are excluded from this project's training and evaluation workflow.
The current calibration/evaluation evidence instead uses independent sources
recorded in the repository, including the CC BY-SA 4.0 OpenSDID+ corpus and
separately sourced real images. Dataset images are not redistributed by this
repository.

## Verification commands

The Chrome extension and its normal source build require Node.js only. The
Python environment is development/evaluation infrastructure, not part of the
extension runtime. Activate a configured project virtual environment (or
install `tools/requirements.txt`) before running the Python-backed `test:data`,
`test:evaluation`, `test:nulls`, and `test:adversarial` commands; the plain
system Python installation may not include NumPy or the other evaluation
dependencies.

```bash
npm ci
npm run check
npm run build
npm run test:data
npm run test:evaluation
npm run test:nulls
npm run test:adversarial
npm run assert:shipping
```

`assert:shipping` currently succeeds only in the expected unconfigured state
(`configured=false`, `curve=quarantined`). It will enforce the stricter
validated-evidence checks once a public model URL is present.

Current local verification snapshot (2026-08-14):

- `npm run check`: pass (typecheck plus 109 Node tests).
- Real-ORT first-badge latency: pass at 4,402.1 ms against the fixed 5,000 ms requirement.
- Calibration, evaluation-contract, data-tool, nuisance-smoke, and adversarial
  fixture suites: pass in their configured Python environments.
- `npm run assert:shipping`: pass in the expected unconfigured/quarantined
  state.
- `npm run build`: pass after anchoring esbuild entry points unambiguously;
  two consecutive builds produced 15 byte-identical files.
- Native-format nuisance battery: **fail** as recorded in
  `NUISANCE_BATTERY_REPORT.md`; this is the active release blocker.

For a local real-model browser build, export the pinned checkpoint and run
`npm run build:local-model`. That build is labeled as a local verification
build and is not the final hosted-model release package.
