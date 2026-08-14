# Corpus taxonomy — what counts as a generator family and an independent real source

Holding out "a generator" is meaningless until *generator* is defined, and the
definition decides whether the headline number estimates generalization or
memorization. Same for the real class, where the question is usually not asked
at all.

Companion to `docs/eval-protocol.md`. Both are frozen together: changing a
grouping rule changes what every past number meant.

---

## Part 1 — Generator family

### Purpose

The eval split holds out **whole families** so the reported number estimates
performance on a generator the pipeline has never seen. A family boundary drawn
too finely (per checkpoint) produces an inflated number that looks like
generalization and is not.

### Rule

Two checkpoints are the **same family** if **any** of the following holds:

1. **Shared decoder lineage.** They use the same VAE/decoder weights, or one's
   decoder is a fine-tune of the other's. For latent diffusion this dominates:
   the decoder writes the last artifact layer onto every pixel, and it is the
   signal these detectors mostly key on.
2. **Derivation.** One is a fine-tune, LoRA merge, distillation, quantization,
   or re-release of the other, or both derive from a common ancestor.
3. **Same release line.** Same architecture *and* same training-corpus lineage
   from the same lab's release sequence (SD 1.4 / 1.5 / 2.1 are one family).

Two checkpoints are **different families** only when they have independent
decoder lineage **and** independent training. Uncertainty resolves toward
*same family* — the conservative direction, because wrongly splitting a family
inflates the number while wrongly merging one only costs holdout budget.

### The terminal-resampler clause

**The family key includes any post-generation resampling or restoration stage.**

`family = (generator lineage, terminal upscaler/restorer lineage)`

An upscaler (Real-ESRGAN, Topaz, a latent upscale pass) writes its own decoder
artifacts *over* the generator's, and is frequently the strongest signal in the
image. If eval images and fit images passed through the same upscaler, the
"unseen family" claim is void no matter how exotic the generators were. This is
the least obvious way to lose a holdout and it is invisible in a filename.

### Working classification

| Family | Members | Notes |
|---|---|---|
| A | SD 1.x, SD 2.x, derivatives | KL-f8 VAE lineage |
| B | SDXL + fine-tunes | retrained VAE, same architectural family as A — record as correlated with A |
| C | SD 3.x | 16-channel VAE, MMDiT |
| D | FLUX (schnell, dev, pro) | 16-channel VAE, rectified flow |
| E | Midjourney v6 / v7 | stack undisclosed; treat as one family absent evidence |
| F | DALL·E 3 | |
| G | Imagen | |
| H | Firefly | |
| I | GPT Image | |
| J | StyleGAN lineage | non-diffusion; a different artifact regime entirely |

C and D share an architectural generation from different labs. They are separate
families but must be recorded as a **correlated pair** (`familyCorrelation`) so a
holdout of one while training on the other is not reported as fully unseen.

### Holdout requirements

- **≥ 8 families** in the corpus, **≥ 2** held out in eval.
- No held-out family may share a decoder lineage, a terminal upscaler, or a
  correlated-pair partner with any family in fit or calibration.
- The held-out set **must include at least one non-latent-diffusion family**
  (E–J). Otherwise the report must state, in the headline and not a footnote:
  *this estimate covers latent-diffusion generators only.*

### Where the current corpus lands

sd2, sd3, sdxl, flux are families A, C, B, D. All four are latent diffusion with
a VAE decoder; the holdout (flux) is a family whose architectural generation
(rectified-flow, 16-channel VAE) is shared with sd3, which is in **fit**. Under
this taxonomy the current eval is: 4 families, 1 held out, correlated with a
training family, zero non-latent-diffusion coverage. It does not meet the bar and
its number should be described as *unseen SD-family checkpoint*, not *unseen
generator*.

---

## Part 2 — Independent real source

### Purpose

Symmetric to Part 1, and the half that is normally skipped. Balanced accuracy
punishes real-class errors equally, and the shipped pipeline's weakness is TNR
(0.68). A real class that is one homogeneous corpus measures nothing about
whether TNR survives contact with a different camera pipeline.

### Rule

Two images share a **source** if **any** of the following holds:

1. **Same capture device instance** — camera body serial, or phone model in the
   hands of the same owner.
2. **Same operator** — photographer, authoring account, or uploader identity.
3. **Same session** — same shoot: same day and location cluster.
4. **Same processing pipeline instance** — same RAW converter with the same
   export preset, same phone computational-photography stack and version.
5. **Same origin corpus, when that corpus is a single scrape with a homogeneous
   pipeline.**

### Rule 5 is the one that bites

**MS COCO is one independent real source, not one per image.** It is a single
scrape, normalized through a single resize-and-encode pipeline, with a
characteristic resolution envelope and JPEG history shared by every member.
Drawing 25 images from it yields 25 clusters (§6 of the protocol) but **one
source**. Clusters govern the confidence interval; sources govern the holdout.
They are different counts and the report carries both.

Consequence for the current corpus: the real class has **1 independent source**
across fit, calibration and eval. Real-class generalization is not merely
under-measured, it is unmeasured — and this is the class the competing
submission failed on.

### Group key

```
real:{provenance_authority}:{operator_id}:{device_id}
```

Fallbacks, in order, with each fallback widening the group:

1. Full triple, when provenance records it (`fetch_public_reals.py` records
   artist; `fetch_nasa_reals.py` records center/photographer).
2. `real:{authority}:{operator_id}` when the device is unknown.
3. `real:{dataset}` — **the entire dataset collapses to one group.** This is
   correct, not a degradation to be worked around.

### Prohibited

**A real image's group may never be derived from the AI generator it was
shelved alongside.** The current index assigns reals `group = opensdid-{split}`,
i.e. it names them after the generator in the adjacent directory. Whole-group
holdout then constrains nothing on the real side while appearing, in the splits
report, to constrain everything. A validator must reject any real group whose
key matches a generator family key.

### Composition requirements

- **≥ 5 independent real sources** in the corpus, **≥ 2 held out** in eval.
- No single source exceeds **35%** of the real class within any split.
- The real class must span at least: modern phone computational photography,
  dedicated-camera originals, screen captures, and CDN/platform re-encodes.
  A corpus missing a category names it in the report rather than omitting it
  silently.
- Held-out real sources and held-out generator families are chosen
  **independently** — the eval split is the intersection of both holdouts, not a
  single directory.

---

## On the numeric thresholds in this document

`≥8 families`, `≥2 held out`, `≥5 real sources`, `≤35% of a split's real class`
are **conventions, not derived quantities.** They are set to make the holdout
structurally meaningful — enough families that holding two out still leaves a
usable fit set, enough sources that no single one dominates — and they are not
calibrated against any measured relationship between corpus composition and
generalization error, because we have no such measurement. They are defensible
defaults to be argued with, and they should be revised if evidence arrives.

The two rules in this document that are *not* conventions, and that carry the
weight, are the family-boundary rule (shared decoder lineage ⇒ same family) and
the single-scrape rule (a homogeneous scrape is one source). Both follow from
what the detector actually keys on, and both change the current corpus's
description regardless of where the numeric thresholds land.

## Validators to implement

Both parts reduce to checks a build can run:

1. No family spans two splits. *(exists)*
2. No **cluster** spans two splits. *(new — §6 of the protocol)*
3. No real group key equals or derives from a generator family key. *(new)*
4. Held-out families share no decoder lineage, terminal upscaler, or
   correlated-pair partner with fit/calibration. *(new — needs a declared
   lineage field per family)*
5. `≥8` families, `≥2` held out, `≥1` held-out family non-latent-diffusion.
6. `≥5` real sources, `≥2` held out, no source `>35%` of a split's real class.
7. Both `nClusters` and `nSources` are reported per class per split, never one
   standing in for the other.

Requirements 4–6 need corpus acquisition, not code. Until then the validators
should **fail loudly and be recorded as failing**, rather than being relaxed to
match what is currently on disk.
