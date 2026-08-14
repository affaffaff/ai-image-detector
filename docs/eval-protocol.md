# Evaluation protocol — FROZEN v1

Every constant in this document is load-bearing. Two people following it must
compute the same number from the same bytes.

**Change policy.** Editing any definition or constant here is a protocol version
bump. Reports carry `protocolVersion`; numbers produced under different versions
are not comparable and must not appear in the same table. Freezing is the point:
a threshold that moves after seeing a result is not a threshold.

Scope: the fixed-0.65 balanced-accuracy report, the null-baseline battery that
decides whether that report means anything, and the confidence interval.

---

## 1. Decision rule

Fixed and non-negotiable: an image is called AI when `score >= 0.65`. No
threshold flag exists anywhere in the evaluator. Balanced accuracy is
`(TPR + TNR) / 2` at that threshold.

---

## 2. Common image intake

Every probe and the detector itself see the same pixels, obtained the same way:

1. Read the **exact stored bytes** of the delivered file. Never a re-encode.
2. Decode, then apply EXIF orientation (`ImageOps.exif_transpose` equivalent).
3. If the image has alpha, composite over the opaque fill `(124, 116, 104)` —
   the same mean fill the runtime tiler pads with, so probe and detector never
   disagree about what the image is.
4. Convert to luma in float64, **without gamma linearization**:

   `Y = 0.299·R + 0.587·G + 0.114·B`, on sRGB 8-bit channel values in `[0,255]`.

   We deliberately measure the delivered, gamma-encoded signal: that is what the
   detector receives and what a compression artifact lives in.

Dimensions used by any probe are post-transpose decoded dimensions.

---

## 3. Null-baseline battery

The purpose is not to build a detector. It is to answer one question: **can a
statistic that performs no image forensics reproduce the detector's score on
this corpus?** If yes, the corpus is measuring sourcing, not detection.

### B1 — pixel count
`b1 = log10(width · height)`

### B2 — encoded size
`b2 = log10(byte length of the stored file)`

### B3 — encoded density
`b3 = log10(byte length / (width · height))`

### B4 — spectral high-frequency ratio

Applied to the luma plane `Y` of shape `(h, w)`:

1. Mean-subtract: `A = Y − mean(Y)`.
2. Apply a separable symmetric Hann window `A ← A · wᵥ ⊗ wₕ`, where for length
   `N`: `w[n] = 0.5 − 0.5·cos(2πn / (N−1))`, `n = 0 … N−1` (i.e. `numpy.hanning`).
   **The window is mandatory**, because the DFT treats the image as periodic and
   the resulting edge discontinuity smears broadband energy along the frequency
   axes — an unwindowed statistic partly measures how the photograph was framed.
   That argument is the reason for the choice. (On our corpus windowing also
   happened to raise the measured leak from AUC 0.886 to 0.914, but a single
   corpus cannot justify a probe definition; picking the variant that scores
   higher is the same selection-on-outcome error this document exists to
   prevent.)
3. `F = |fftshift(fft2(A))|`.
4. Normalized radial frequency, with the DC bin at index `(⌊h/2⌋, ⌊w/2⌋)`:

   `fy[i] = (i − ⌊h/2⌋) / (h/2)`, `fx[j] = (j − ⌊w/2⌋) / (w/2)`, `r = hypot(fy, fx)`

   Per-axis normalization makes `r` resolution-independent; `r = 1` at the edge
   midpoints, `√2` at the corners.
5. Bands: `LOW = {r ≤ 0.20}` **excluding the DC bin**; `HIGH = {r ≥ 0.70}`.
6. `b4 = log10( (mean F[HIGH] + 1e−12) / (mean F[LOW] + 1e−12) )`

Undefined (returns null) when `min(h, w) < 64`.

### B5 — JPEG blockiness
On unwindowed, non-mean-subtracted luma, with `grid = 8`:

- Vertical gaps `dᵥ[i] = |Y[i+1] − Y[i]|`, `i = 0 … h−2`; gap `i` is **on-grid**
  iff `i mod 8 == 7`. Horizontal gaps defined symmetrically.
- `b5 = log10( (mean of on-grid gaps + 1e−6) / (mean of off-grid gaps + 1e−6) )`

Undefined when either axis is `< 24` px (fewer than two on-grid gaps).

B5 detects the classic codec-mismatch leak. On our current corpora it sits at
chance — two-sided oracle 0.58–0.68 against a null whose *mean* is 0.614 at
n = 25 — so the degradation chains carry no detectable codec leak. That is a
genuine pass, but a weak one: at this sample size the probe could not have
detected a moderate leak either.

**Known limitation:** the definition assumes JPEG grid phase 0, i.e. it sees the
*terminal* encode's grid. An image cropped after an earlier JPEG pass carries a
phase-shifted grid this probe cannot see. I tested max-over-8-phases against the
frozen phase-0 form on all three corpora and it changes nothing here (AUC 0.474
vs 0.474, 0.634 vs 0.634, 0.592 vs 0.614), because the terminal encode dominates.
A future corpus with cropped-after-compression sources needs the max-phase form,
which is a protocol version bump.

### Polarity

**Every baseline is evaluated two-sided.** A probe is a leak whether it points
up or down, and the polarity flips between corpora: on our canonical 768 px set
AI carries *more* high-frequency energy (AUC 0.914), while on the 384 px and
social-thumbnail sets AI carries *less* (AUC 0.336 and 0.338). Scoring
one-sided would have reported the latter two as "below chance" and dismissed
them. Formally: a baseline's score is the better of the feature and its
negation, and the report records which polarity won.

---

## 4. Baseline threshold fitting — two numbers, two purposes

Each baseline is reported twice. Conflating them is the mistake this section
exists to prevent.

| Row | Threshold and polarity chosen on | Answers |
|---|---|---|
| `fair` | the **calibration** split | "Does the detector beat a trivial statistic given the same fitting budget?" |
| `oracle` | the **eval** split itself | "Does this corpus *admit* a trivial solution at all?" |

The `fair` row is the honest comparison: the detector's curve is fitted on
`calibration`, so its null gets exactly the same data and no more.

The `oracle` row is deliberately optimistic and is **not** a comparison — it is
a property of the corpus. A corpus on which some trivial statistic reaches 0.94
at its best threshold is contaminated regardless of whether a fitting procedure
would have found that threshold. Corpus gating therefore uses `oracle`.

### Gates

**The gate is a permutation p-value, not a fixed balanced-accuracy threshold.**

An earlier draft of this document gated on `oracle BA ≥ 0.70 ⇒ FAIL`,
`≥ 0.60 ⇒ WARN`, by analogy with `tools/audit_leakage.py`. That is wrong, and
measurably so. The oracle statistic maximizes over thresholds *and* polarity, so
its null value depends strongly on sample size. Simulated null (random feature,
balanced labels, 20 000 trials):

| n/class | mean | p95 | p99 | P(≥0.60) | P(≥0.70) |
|---|---|---|---|---|---|
| 25 | 0.614 | 0.680 | 0.720 | **0.711** | 0.036 |
| 50 | 0.582 | 0.630 | 0.660 | 0.272 | 0.001 |
| 100 | 0.559 | 0.595 | 0.610 | 0.036 | 0.000 |
| 200 | 0.542 | 0.568 | 0.580 | 0.000 | 0.000 |
| 550 | 0.526 | 0.540 | 0.548 | 0.000 | 0.000 |

At 25 clusters per class a **purely random probe** trips the old WARN gate 71%
of the time, and with five probes trips the old FAIL gate about one run in six.
A fixed threshold there measures the optimism of the max operator, not leakage.

Frozen gate:

1. **Null by cluster-label permutation.** Permute labels **at the cluster level**
   (§6), never at the row level — permuting rows destroys the dependence
   structure and produces a null that is too tight. `B_perm = 10000`, same RNG
   discipline as §5.
2. `p = (1 + #{null ≥ observed}) / (1 + B_perm)`, one per probe, on the
   two-sided oracle statistic.
3. **Multiplicity:** Bonferroni across the probes in the battery (currently 5).
4. **Effect size:** `excess = oracle BA − null median`, reported alongside `p`.

| Condition | Verdict |
|---|---|
| corrected `p < 0.01` **and** `excess ≥ 0.10` | **FAIL** — corpus contaminated |
| corrected `p < 0.05` | **WARN** — reportable only with the probe table alongside |
| otherwise | pass |

Both conditions are required for FAIL: significance alone will condemn a
negligible leak once the corpus is large, and effect size alone will condemn
noise while it is small. The absolute BA is still reported, for interpretation,
but nothing is gated on it.

The metadata audit in `tools/audit_leakage.py` stays in force separately, with
its own thresholds. Note what it does and does not show: its features are
largely **source** metadata, which the model never sees. A metadata FAIL is
evidence that a corpus is *sourced* in a class-correlated way, and therefore a
reason to go looking for a pixel-level consequence — it is not itself proof that
the detector exploited anything. The probe battery is what establishes the
consequence. Metadata audit and pixel probes are not
redundant: the metadata audit cannot see an artifact that a canonicalization
step *introduces into the pixels*, which is exactly the failure we have.

### Detector credit

`detectorMargin = detectorBA − max(fair baseline BA)`

The detector is credited with working only if the **95% CI on the paired
difference excludes zero** — bootstrapped over the same cluster resamples as
the point estimate (§5), never from two independently computed intervals.

---

## 5. Confidence intervals

- **Level:** 95%, two-sided. Reported as `[lo, hi]`.
- **Method:** percentile bootstrap, **clustered by source** (§6), **stratified by
  class**.
- **Replicates:** `B = 10000`.
- **RNG:** `numpy.random.Generator(PCG64(20260813))`, seeded once per report and
  consumed in a fixed order: point statistic, then replicates in sequence. The
  seed is published in the report.

### Procedure

1. Partition clusters by class: `C₁` (AI), `C₀` (real).
2. For each replicate: draw `|C₁|` clusters from `C₁` with replacement and
   `|C₀|` from `C₀` with replacement. A cluster drawn `k` times contributes all
   of its rows `k` times. **Rows are never drawn directly** — degradation
   variants of one source are not independent samples and resampling them
   individually understates the interval.
3. Recompute the statistic at the fixed 0.65 threshold on the replicate.
4. If a replicate leaves a class empty, discard and redraw; cap at 100
   consecutive discards, then abort the report. Record `discardedReplicates`.
5. Interval = the 2.5th and 97.5th percentiles of the replicate statistics
   (linear interpolation between order statistics).
6. **The point estimate is computed on the observed data, not as the bootstrap
   mean.**

### Power floor

`nClusters` per class is reported. Below **100 clusters per class** the report
sets `"underpowered": true` and **may not carry a PASS verdict**.

At the current 25 clusters per class, the normal approximation puts the 95% CI at
about ±9.5 points. Treat that as a *floor* on the true width, not an estimate:
at TNR ≈ 0.92 and n = 25, `n·p·(1−p) ≈ 1.8`, well below the usual ≥ 5 needed for
the approximation to hold, so the real interval is wider and asymmetric. Either
way it cannot separate 0.75 from 0.86, which is the only thing the number has to
do. Note also that the percentile bootstrap in §5 is itself anti-conservative at
this sample size — the power floor exists because *no* interval method is
trustworthy down here.

### Per-degradation rows

`byDegradation` entries share clusters with each other and with the pooled row.
Their intervals are **not** independent and must never be compared across rows
as though they were. The report marks them `"dependent": true`.

---

## 6. Source-cluster identity

A **cluster** is one underlying real-world or generated asset, together with
every degraded variant of it. Clusters are the unit of resampling, the unit of
holdout, and the unit of the power floor.

Resolution order — first rule that applies wins:

1. An explicit `cluster_id` column, when the corpus builder emits one.
2. `source` + basename of `source_key`, normalized (lowercased, extension
   stripped) — the dataset-level identity of the underlying asset.
3. `image_id` truncated at the first `--` — the convention
   `tools/prepare_degraded_score_manifest.py` already produces when it appends a
   degradation suffix.

### Cluster validators (corpus build fails if violated)

- **No cluster spans two splits.**
- **Near-duplicates are one cluster.** Any two rows in *different* clusters with
  pHash Hamming distance ≤ 6 must be merged or the build fails. This closes the
  hole in the current evaluator, which skips same-split pairs entirely and so
  treats two variants of one photo as two independent observations.
- **Cluster labels are unique.** A cluster carrying both labels is a build error.

---

## 7. Missing-data policy

Silently dropping a failure is how a detector's error rate disappears into a
rounding difference. Three cases, three different treatments, all counted:

| Case | Treatment | Field |
|---|---|---|
| File absent or undecodable at **corpus build** | Excluded from the manifest before any scoring | `exclusions.build` |
| Decodes, but inference yields no score, a non-finite score, or a timeout | **Counted as incorrect for its true class.** Never dropped, never imputed | `exclusions.inferenceFailures` |
| A **probe** is undefined for an image (too small per §3) | Image stays in the detector metrics; excluded from *that probe's* metrics only, with the probe's own `n` reported | `probes[].nUndefined` |

Rules:

- A probe is never gated on a different sample than it was computed on.
- Build exclusions above **1% of either class** invalidate the report.
- Any non-zero inference-failure count appears in the headline report, not a log.
- All three counts appear even when zero.

---

## 8. Required report fields

Beyond the existing schema:

```
protocolVersion, seed, threshold (0.65)
nImages / nClusters, per class
balancedAccuracy, tpr, tnr, ci: [lo, hi], underpowered
probes[]: { id, polarity, fairBA, oracleBA, nUndefined }
corpusGate: pass | warn | fail
detectorMargin, detectorMarginCI: [lo, hi]
exclusions: { build, inferenceFailures }
corpusHash, splitsHash, configHash, modelSha256
calibrationCurve: { sha256, id, fittedOn, scorePath }
codeCommit, worktreeDirty
```

Hashes are SHA-256 over a canonical serialization, defined so two machines agree:
JSON with sorted keys, no insignificant whitespace, UTF-8, LF endings.

- `corpusHash` — over the sorted list of `(member sha256, label, cluster, split)`.
- `splitsHash` — over the splits file in that canonical form.
- `configHash` — over the resolved config after defaults are applied, with all
  filesystem paths made repo-relative and any absolute path or timestamp
  excluded, so the same run on two machines hashes identically.

`calibrationCurve.scorePath` must equal the runtime aggregation actually used.
A report whose curve was fitted on a different scoring path than the one being
measured is invalid — this is not hypothetical, it is the defect that produced a
0.86 headline for a pipeline that scores 0.77.

---

## 9. Reference values from the current corpus

Recorded so a future implementation can verify it reproduces them. These are
measurements of a corpus that **fails** the gate; they are fixtures, not targets.

Eval split (`opensdid-flux`, 25 AI + 25 real), two-sided oracle. **Read against
the n = 25 null: mean 0.614, p95 0.680, p99 0.720.**

| Corpus | B4 spectral | B4 AUC | B5 blockiness | Reading |
|---|---|---|---|---|
| canonical 768 px / q82 | **0.940** (pol +) | **0.914** | 0.580 | **FAIL** — far beyond p99; AUC ≈ 5 SE from chance |
| canonical 384 px / q65 | 0.680 (pol −) | 0.336 | 0.640 | at the null p95; **not significant** after multiplicity |
| social thumbnail | 0.720 (pol −) | 0.338 | 0.680 | at the null p99; **marginal at best** after multiplicity |

Every B5 value is at or below the null p95.

**This corrects an overstatement in the audit that produced this document**,
which read all three corpora as leaking (FAIL / WARN / FAIL) by comparing raw
balanced accuracies against fixed thresholds. Only the 768 px canonical corpus
is demonstrably contaminated at the pixel level. The 384 px and social readings
are within noise at n = 25 — they are not evidence of a clean corpus either,
merely an absence of evidence at a sample size too small to distinguish the two.

Three findings are **unaffected** by this correction, because none of them
depends on a max-over-threshold statistic:

- Source metadata separates the classes perfectly and deterministically: AI is
  1248×832, real is 640×480, and `pixels > 500k ⇒ AI` scores balanced accuracy
  1.000 on the undegraded corpus. Disjoint ranges need no significance test.
- The canonical resample direction is disjoint by class on the eval split: reals
  upscaled 1.20–2.31×, AI downscaled 0.75–0.92×.
- The 768 px corpus, the one that is demonstrably contaminated, is half of the
  pooled `canonical-mixed` set the 0.86 headline was measured on.
