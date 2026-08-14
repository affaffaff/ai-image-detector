# Compliance and release status

Last updated: 2026-08-14.

**Overall status: not yet ready for a distributable production release.** The
extension, local inference path, and fixed-threshold accuracy evidence exist.
Release is still blocked by a failing source build, an incomplete nuisance/null
battery, an unresolved INT8-versus-FP32 gate, model-redistribution sign-off,
publication of the pinned model artifact, and final hosted-artifact
verification.

A check means the requirement is implemented and supported by current local
evidence. A construction marker means work or authorization is still required
before the normal release build can satisfy the requirement.

| Requirement | Status | Current evidence / remaining work |
|---|:---:|---|
| Native Manifest V3 extension | ✅ | `src/manifest.json`; MV3 service worker, offscreen document, and content script |
| MIT-licensed source and third-party notices | ✅ | `LICENSE` and `THIRD_PARTY_NOTICES.md` identify the source, model-weight, backbone, and evaluation-corpus licenses |
| Final model-redistribution diligence | 🚧 | The three-way audit is complete and recorded in `PROVENANCE_AUDIT.md` — all three columns verified against first-party sources on 2026-08-14, verdict PASS — and is pending owner sign-off |
| All inference local | ✅ | `src/offscreen/ort-engine.js`; ONNX Runtime Web WASM; real-ORT browser E2E pass |
| No cloud detector, telemetry, or local backend | ✅ | Browser-only runtime; Python is export/evaluation tooling only; network behavior is documented in `PRIVACY.md` |
| Automatic first-run model setup | 🚧 | Resume, retry, recovery, OPFS storage, size checking, and SHA-256 verification are implemented; `models/manifest.json` still has `url: null` |
| Automatically analyze webpage images | ✅ | Mutation/intersection observers, lazy-source handling, frames, shadow roots, CSS backgrounds, candidate tests, and the 262/262 live-site coverage baseline |
| Real calibrated confidence evidence | ✅ | The exact ORT-Web `official-center` signal has a disjoint calibration fit and a passing fixed-0.65 held-out evaluation in `models/calibration/fused.json` |
| Calibrated confidence in the normal release build | 🚧 | The curve remains `quarantined` until the non-statistical release gates pass; with no public model URL, the normal build reports setup not configured |
| Fully reproducible source build | 🚧 | The deterministic CI procedure exists, but the current `npm run build` fails locally because esbuild cannot resolve `./src/background/service-worker.js` from `tools/build.mjs`; two-build hash comparison cannot run until this is fixed |
| Reproducible model export | ✅ | Pinned official checkpoint, strict state load, deterministic ONNX serialization, and PyTorch/FP32 parity guards |
| Hash-bound evaluation chain | ✅ | The evaluation config/report now pin the current `fused.json` SHA-256 (`671efd4e…`), and the JSONL tail matches the current report |
| Nuisance/null battery | 🚧 | The detector-minus-best-null margin passes, but the battery verdict does not: the tool still uses the superseded fixed oracle-BA rule and the recorded run is not native-format |
| INT8-versus-FP32 release report | 🚧 | Produced and retained on 2026-08-14 in `INT8_FP32_REPORT.md`. It fails p99 score drift at the recorded 0.15 limit (0.2409); the other three gates pass. The runner now defaults to 0.25, so code and retained evidence disagree and require an explicit, non-silent decision |
| Release metadata and public docs agree | 🚧 | `README.md`, the manifest commentary, and `fused.json`'s quarantine reason still omit or contradict current blockers; synchronize them after the technical decisions are made |
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
| Nuisance/null challenge — margin | Pass; detector minus best fitted null = +0.2545 BA, 95% CI [0.2135, 0.2957], excluding zero |
| Nuisance/null challenge — battery verdict | **Not a pass.** `null-shootout.json` records `noPassBecause: ["corpusGate=warn", "not native-format"]`. The warn comes from the superseded fixed-threshold rule the tool still implements (max oracle BA 0.6827 against a `>= 0.60` warn line) rather than the permutation gate frozen in `eval-protocol.md`; the second reason is that the battery ran on the degraded pack, not a native-format pack. See the known-gap note in `EVALUATION_GATES.md` |

Primary evidence:

- `models/calibration/fused.json`
- `data/matched/leakage-audit-all-construction.json`
- `data/matched/gated-eval-all.json`
- `data/matched/pack-all/explain-it-away/null-shootout.json`

These figures establish the repository's fixed-threshold acceptance result for
this pinned model, preprocessing contract, and evaluation design. They are not
a claim of universal accuracy across every generator, image source, or future
web transformation.

## Remaining release gates

1. Fix the source build. `npm run build` currently fails in esbuild while
   resolving the service-worker entry from `tools/build.mjs`. After it passes,
   build twice and compare every output hash before restoring the reproducible
   build checkmark.
2. Implement the cluster-label permutation corpus gate frozen in
   `eval-protocol.md` (`B_perm = 10000`, Bonferroni correction), run the nuisance
   battery on the required blind native-format pack, and retain a hash-bound
   passing artifact. The current positive detector-minus-null margin is not a
   substitute for the battery's own verdict.
3. Resolve the INT8-versus-FP32 precision result. The retained report fails p99
   score drift at 0.2409 against its 0.15 limit, while the current runner has
   changed the default to 0.25. Choose and record one option from
   `INT8_FP32_REPORT.md` (explicit waiver, improved quantization, or an
   independently justified limit), then make the tool, report, and docs agree.
   Do not turn the existing failure into a pass merely by rerunning with the
   post-measurement default.
4. Sign off the three-way model redistribution/provenance audit. It is complete
   and recorded in [`PROVENANCE_AUDIT.md`](PROVENANCE_AUDIT.md) with a PASS
   verdict against first-party evidence; the owner sign-off line is still blank.
   Do not change the curve from `quarantined` to `validated` before it is
   signed.
5. Correct the remaining metadata/documentation inconsistencies before commit:
   `README.md` still gives the superseded Community Forensics dataset license
   and describes the precision report as pending rather than present-but-failed;
   the manifest commentary and `fused.json` quarantine reason also imply that
   all measurable gates passed even though the nuisance battery and precision
   gate remain unresolved.
6. Publish the exact pinned INT8 artifact to an immutable, account-owned public
   location and set `models[0].url` to its direct-download URL.
7. After all prior gates pass, change the curve to `validated`, run
   `npm run assert:shipping`, build the normal release, and repeat the
   fresh-profile online setup, offline scan, and offline browser-restart checks
   in `MODEL_PUBLISHING.md`.

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

- `npm run check`: pass (typecheck plus 98 Node tests).
- Calibration, evaluation-contract, data-tool, nuisance-smoke, and adversarial
  fixture suites: pass in their configured Python environments.
- `npm run assert:shipping`: pass in the expected unconfigured/quarantined
  state.
- `npm run build`: **fail** at the first esbuild entry-point resolution, so the
  reproducible two-build comparison and final package checks are not currently
  runnable.

For a local real-model browser build, export the pinned checkpoint and run
`npm run build:local-model`. That build is labeled as a local verification
build and is not the final hosted-model release package.
