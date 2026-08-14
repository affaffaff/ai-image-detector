# Evaluation evidence and release gates

An accuracy number is accepted only when its inputs form one hash-bound chain:

```text
degradation manifest -> leakage audit -> score manifest -> model scores
    -> calibration curve -> evaluation config -> report -> chained JSONL log
```

Console output is diagnostic. The JSON artifacts are the evidence.

## Leakage audit

`audit_leakage.py` uses grouped cross-validation, keeping every variant of one
source in one fold. Minimum source and per-degradation counts are gates, not
warnings. Two feature sets are emitted (see
[`eval-protocol.md`](eval-protocol.md) and `data/matched/analysis/leak-verdict.md`
for the reasoning):

* `--feature-set full` (default): degradation/container/dimension metadata plus
  weak decoded-pixel statistics (colour moments, entropy, clipping, saturation,
  edge energy). This is the strict record. On AI-vs-photo corpora it is
  expected to sit at or above the 0.70 line because it also measures genuine
  content statistics (smoothness/luma variance/clipped highlights) that are the
  detector's own forensic signal, not a construction shortcut. It is recorded,
  never silently dropped, and **not gated for release**.
* `--feature-set construction`: chain/format identity, dimensions, and codec /
  crop / dpr step parameters only — the corpus-construction shortcuts the audit
  exists to catch. **AUC at or above `0.70` fails**; this is the release gate
  consumed by `fit_fused_runtime.py` and `evaluate_scores.py`.

```powershell
python tools/audit_leakage.py `
  --manifest data/matched/degradation-manifest-all.json `
  --labels data/matched/labels-all.json `
  --root data/matched/replica-all `
  --feature-set construction `
  --out data/matched/leakage-audit-all-construction.json
```

The artifact records the manifest/label hashes and every decoded output hash.
`prepare_degraded_score_manifest.py` propagates the manifest hash, image hash,
source cluster, formats, dimensions, and byte counts into the score CSV.

## Calibration isolation

`calibrate_score_csv.py` requires the audit artifact and rejects overlapping
calibration/eval selections, crossing source clusters or generators, low class
counts, uncovered inputs, and any score column other than the shipped browser
signal.

The production input is `score_official_browser`, emitted by the exact built
ORT-Web Resize(440-short-edge) + CenterCrop(384) single-crop path. The older
native-grid/max fit is retained separately as `fused-native-max.json`; it must
not replace the authoritative `fused.json`. Curve JSON records the audit,
model, manifest, calibration-row, and eval-row hashes.

## Mandatory evaluator

`evaluate_scores.py` has no threshold option. It requires `--audit`,
`--config`, `--out`, and `--log`; omitting any one is an error.

```powershell
python tools/evaluate_scores.py `
  --set data/matched/browser-scores-all.csv `
  --audit data/matched/leakage-audit-all-construction.json `
  --config data/matched/eval-config-full.json `
  --out data/matched/gated-eval-all.json `
  --log data/matched/gated-eval-all.jsonl
```

`docs/evaluation-config.example.json` is the committed, public template for the
`--config` argument; the run above uses the local full-corpus config.

The gate verifies hashes, score/image/audit coverage, pHash and generator split
integrity, one-model consistency, minimum image/cluster/degradation counts, and
the configured balanced-accuracy requirement. Confidence intervals bootstrap
independent source clusters. Always-real, always-AI, and prevalence-random null
baselines are recorded.

The release power floor is 100 source clusters per class; a config cannot lower
it. The deeper `explain_it_away.py` battery follows
[`eval-protocol.md`](eval-protocol.md): fit-only geometry, codec, appearance,
spectral, blockiness, multivariate, and 32×32-pixel nulls; oracle contamination
checks; and paired detector-minus-best-null cluster intervals.

> [!IMPORTANT]
> **Known gap — the corpus gate in the tool is not the one this project froze.**
> `eval-protocol.md` replaces the fixed oracle-BA thresholds with a cluster-label
> permutation test (`B_perm = 10000`, Bonferroni across probes, FAIL on corrected
> `p < 0.01` **and** `excess >= 0.10`), and shows the fixed rule is wrong: at 25
> clusters per class a purely random probe trips the old WARN threshold 71% of
> the time. `explain_it_away.py:939` still applies the old rule
> (`>= 0.70` fail, `>= 0.60` warn), and no permutation test exists anywhere in
> `tools/`. Consequently the current battery artifact reports
> `corpusGate: "warn"` at max oracle BA 0.6827 — a value the frozen protocol
> would not by itself treat as evidence of contamination at this sample size.
> Read that warn against the protocol, not at face value, until the gate is
> implemented.

Every report leads with exactly three operating-point values at `0.65`: TPR,
TNR, and balanced accuracy, each with its clustered 95% CI. Run separate,
hashed configs for `clean`, `web-realistic`, and `unseen-generator`; the last is
the release number. The JSONL log links every entry to the prior entry hash and
refuses to append to a tampered tail.

## Precision and shipping

```powershell
python tools/compare_int8_fp32.py `
  --set data/matched/compare-int8-fp32-eval.csv `
  --fp32-model models/weights/community-forensics-384-fp32.onnx `
  --int8-model models/weights/community-forensics-384-int8.onnx `
  --curve models/calibration/fused.json `
  --out data/matched/int8-vs-fp32-eval.json `
  --pairs-out data/matched/int8-vs-fp32-pairs.csv
```

The manifest is the same 2,097-image held-out evaluation split the release
number is computed on, so the comparison and the accuracy gate describe the same
images. Manifest `path` fields resolve relative to the manifest's own directory.

The paired report runs both models through that same official-center transform
and gates mean/p99 score drift, fixed-threshold disagreement, and INT8
balanced-accuracy loss while recording all model/config hashes.

`data/` is gitignored, so the JSON report itself stays local. The committed,
public-facing record of the result is
[`INT8_FP32_REPORT.md`](INT8_FP32_REPORT.md), which carries the measured
numbers, the gate limits, and every input hash needed to re-run it.

`npm run assert:shipping` verifies INT8-only packaging and the
model/runtime/curve contract. A public model URL is rejected unless the curve
is `validated`, references passing leakage audits (construction feature set),
carries split/config hashes, and clears 0.75 on a power-compliant eval (>= 100
source clusters per class). The current URL is null and the curve is quarantined
pending the provenance/license shipping audit and hosting, not because of the
leakage or accuracy gates — those pass (construction audit AUC 0.519; held-out
BA 0.8799 CI [0.855, 0.904]; null-battery margin +0.2545 excluding zero).
