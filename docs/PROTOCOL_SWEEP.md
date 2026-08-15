# Delivery-path protocol sweep — c143-survey PROTOCOL.md run against this submission

Date: 2026-08-15. Protocol: https://github.com/agentatwork/c143-survey/blob/main/PROTOCOL.md
Pipeline implementations copied verbatim from the reference named by the protocol
(`agentatwork/local-ai-image-detector` `tools/robust.py`, `COND`).

This is the public summary. Per-image scored rows (7,854) and the
machine-readable summary are retained in the local evidence workspace
(`data/protocol-sweep/`, deliberately not committed — the same eval-data
policy as the sealed acceptance chain). Tooling is committed:
`tools/protocol_parity_check.py`, `tools/protocol_sweep.py` (resumable),
`tools/protocol_sweep_analyze.py`.

**Sealed acceptance headline is unchanged: 0.8799 balanced accuracy at 0.65 on
the unseen-generator web-degraded corpus.** This sweep is a separate
measurement on a different, generator-poor corpus; read the composition
section before quoting any number from it.

## What is fixed (per protocol) and how this run satisfies it

1. **Operating point 0.65, does not move** — decisions read at calibrated ≥ 0.65 using
   the shipped `models/calibration/fused.json` (sha256-pinned model
   `df1aade5…f2035`, verified before scoring). Nothing was fitted in this sweep.
2. **Balanced accuracy** — (recall + specificity) / 2.
3. **Both classes separately** — recall (AI) and specificity (real) in every row.
4. **Delivery path first** — the eleven fixed Pillow pipelines, applied to the decoded
   image, re-opened from encoded bytes.
5. **Generators held out** — see the LOGO note below; with only 2 AI generator clusters
   in this corpus the fold structure is degenerate and we say so rather than hide it.

## Image set (not fixed by the protocol; stated per protocol)

Archived pristine holdout corpus `data/holdout/in`, 714 images:
**180 AI** (kandinsky-2.2 ×80, sd-1.5 ×100, both locally generated 2022-era latent
diffusion) and **534 real** (129 source clusters: Wikimedia Commons photographers and
collections, NASA JSC/KSC/GRC/JPL/MSFC imagery). Class balance 180/534 in every
condition. This set is *not* the sealed acceptance corpus: its AI side is
generator-poor and generator-easy relative to the sealed eval (which adds OpenSDID
FLUX/SD2/SD3/SDXL). 13 of its 131 source clusters also appear in the shipped
calibration split (archival overlap; nothing was fitted here).

## Scoring path and its measured fidelity

Pinned INT8 artifact via Python onnxruntime, `official_center` transform
(tools/score_dataset.py — the documented offline counterpart of
src/offscreen/preprocess.js). Calibration interpolation reproduces the sealed
`score_official_calibrated` column on all 3,057 sealed rows with max |err| 5e-11.
Raw-score parity against the sealed browser path (150-image stratified sample):
median |diff| 1.6e-4, p95 0.158, max 0.507 — divergence is concentrated in the
**upscale regime** (delivered short edge < 440 px), where the browser's Skia
`imageSmoothingQuality:'high'` resize and Pillow's bilinear genuinely differ.
Per-condition worst-case bounds under that measured drift are in the table
(at-risk = upscale-regime images within p95 drift of the boundary, all flipping
adversely).

## Results — fixed 0.65, n_ai=180, n_real=534

| pipeline | bal_acc | recall (AI) | specificity (real) | 95% CI | ≥75% | worst-case under path drift |
|---|---:|---:|---:|---|:---:|---:|
| none | 92.2% | 100.0% | 84.5% | [89.5, 94.5] | PASS | 92.0% |
| jpeg90 | 92.9% | 99.4% | 86.3% | [90.6, 95.0] | PASS | 92.8% |
| jpeg75 | 94.6% | 98.9% | 90.3% | [92.8, 96.2] | PASS | 94.5% |
| jpeg60 | 95.9% | 97.8% | 94.0% | [93.9, 97.4] | PASS | 95.8% |
| cms1600 | 95.8% | 99.4% | 92.1% | [93.6, 97.2] | PASS | 95.6% |
| cms1024 | 96.0% | 99.4% | 92.5% | [93.4, 97.5] | PASS | 95.6% |
| cms640 | 94.8% | 99.4% | 90.1% | [92.3, 96.4] | PASS | 86.4% |
| webp80 | 93.1% | 99.4% | 86.7% | [91.0, 94.7] | PASS | 92.9% |
| rescale90 | 92.3% | 100.0% | 84.6% | [89.9, 94.3] | PASS | 92.1% |
| sieve_web | 95.7% | 97.8% | 93.6% | [94.2, 97.2] | PASS | 95.4% |
| sieve_hard | 89.2% | 81.1% | 97.2% | [86.3, 92.0] | PASS | 75.2% |

**Pipelines clearing 75.0%: 11/11. Mean 93.9%, worst sieve_hard 89.2%.**
CI: percentile bootstrap, 5,000 resamples, seed 20260815; real side resampled by
source cluster, AI side at image level (only 2 generator clusters — intervals on the
AI side are understated; read the per-generator rows instead).

Per-generator recall (fixed shipped curve, all real images as the negative class):

| pipeline | kandinsky-2.2 (n=80) | sd-1.5 (n=100) |
|---|---:|---:|
| none | 100.0% | 100.0% |
| sieve_web | 97.5% | 98.0% |
| sieve_hard | 81.2% | 81.0% |

(All other conditions ≥97.5% on both.)

## What to conclude and what not to

- On the survey's one comparable axis: sieve_web 95.7% / sieve_hard 89.2% vs
  sieve 87.3/84.6, originlens 87.3/84.6, aidetect 87.7/84.5, agentatwork 79.4/79.0.
  **Not rankable**: our AI side is 2 generators they don't all share; the survey's
  whole point is that cross-benchmark comparisons are noise. What *is* established:
  under the protocol's two hardest published insults, this build's worst row
  (89.2%, CI [86.3, 92.0]) clears the bar with its whole interval, and even the
  adverse-drift bound (75.2%) does not fall below it.
- Degradation *helps* mid-range conditions (jpeg60/cms1024: ~96%) because
  recompression raises specificity on real photos faster than it costs recall —
  consistent with the detector reading generation artifacts that survive one
  re-encode. sieve_hard is where recall finally breaks (81%), and it breaks on
  both generators equally (81.2/81.0), i.e. it is the quantization, not a
  generator-specific blind spot, in this corpus.
- This does **not** clear the release quarantine: the native-format nuisance
  battery failure (codec null 0.8889 vs detector 0.8651) stands untouched —
  this sweep measures robustness to *further* delivery degradation of pristine
  images, not the codec-shortcut question on native-format images.

## Reproduce

```
.venv-export/Scripts/python tools/protocol_parity_check.py   # path validation
.venv-export/Scripts/python tools/protocol_sweep.py          # resumable, checkpoints to scores.csv
.venv-export/Scripts/python tools/protocol_sweep_analyze.py
```

## Incidental finding

14 real-source files on disk carry cp1252-mangled filenames (UTF-8 names decoded as
cp1252 by the fetcher, e.g. `strÃ¶mkajen` for `strömkajen`); `labels.json` has the
correct NFC keys. Analysis normalizes them back. Harmless to scoring (the bytes on
disk are what was scored), worth fixing in the fetcher.
