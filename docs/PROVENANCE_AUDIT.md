# Model redistribution and provenance audit

Audit date: 2026-08-14. Status: **complete and owner-approved.**

This is the three-way weights / base-model / training-data check required before
`models[0].url` may point at a public artifact. It is engineering diligence
recorded against first-party sources, not legal advice.

## Subject

Exactly one binary is redistributed by this project:

| Field | Value |
|---|---|
| File | `community-forensics-384-int8.onnx` |
| Bytes | 23,967,155 |
| SHA-256 | `df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035` |
| Produced by | `tools/export_onnx.py` (torch → ONNX → dynamic INT8) |
| Source checkpoint | `model_v11_ViT_384_base_ckpt.pt`, SHA-256 `d134f6f2c6185c9146ed54e7ea1c43e9f67ea42d98e9bdc88791d4163095dcde` |
| Source repository | `OwensLab/commfor-model-384`, revision `87b013b3d134dea22518e743bd7a1901e52fe9da` |

No other model weights are shipped, downloaded, or embedded.

## Method

Each license claim below was read from the first-party source page on
2026-08-14, rather than inferred from search snippets. The prior evidence
standard for the weight license was explicitly "search-corroborated" with an
open `VERIFY` marker; that marker is now closed.

## The three-way check

### 1. Shipped weight license — MIT

`OwensLab/commfor-model-384` states `License: mit` on its model card. The
authors' code repository, `github.com/JeongsooP/Community-Forensics`, is
likewise MIT. The same lab published both the dataset and the weights, so the
MIT grant on the weight release is the authors' own decision about their own
artifact.

MIT permits redistribution with attribution preserved. Attribution is carried in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

**Result: pass.**

### 2. Base model lineage — Apache-2.0, and no base-model bytes are shipped

The architecture is `timm/vit_small_patch16_384.augreg_in21k_ft_in1k`, stated
`License: apache-2.0`.

The stronger fact is that no timm weight bytes enter the artifact at all.
`tools/export_onnx.py:56` constructs the network with `pretrained=False`, and
`tools/export_onnx.py:208` loads the authors' checkpoint with `strict=True`.
Every parameter in the shipped ONNX therefore originates in the MIT checkpoint;
timm contributes an architecture definition at export time and nothing else.
Apache-2.0 would permit redistribution regardless, so this holds either way.

**Result: pass.**

### 3. Training-data terms — not redistributed, not used

The `OwensLab/CommunityForensics` dataset card states `cc-by-4.0`, with the
qualifier that the release is for research purposes, and notes that individual
images retain the licenses of the generative models that produced them (largely
CreativeML OpenRAIL-M). Those per-image and field-of-use statements bind
*dataset users*.

This project is not a dataset user. It does not download, train on, finetune
against, evaluate on, or redistribute any CommunityForensics release. It ships
the authors' already-trained, separately MIT-licensed checkpoint. Calibration
and evaluation use independent corpora recorded in `THIRD_PARTY_NOTICES.md`.

**Result: pass — training-data terms do not reach the shipped artifact.**

## Corrections made by this audit

Three inaccuracies in the previously committed notices were found and fixed.

1. **Author attribution was wrong.** `THIRD_PARTY_NOTICES.md` listed five
   authors, four of whom appear in no first-party source. The paper is
   *Community Forensics: Using Thousands of Generators to Train Fake Image
   Detectors* (CVPR 2025, arXiv 2411.04125) by **Jeongsoo Park and Andrew
   Owens**. This mattered beyond tidiness: MIT redistribution requires the
   copyright notice to be preserved, and an invented author list fails that.

2. **The dataset license was wrong.** The notices recorded CC-BY-NC-SA
   (non-commercial, share-alike). The dataset card states `cc-by-4.0`. The prior
   entry was stricter than reality, so no decision was made too permissively on
   the strength of it, but the published claim was inaccurate.

3. **The weight-license evidence was weaker than the claim.** The notices
   asserted MIT and a `PASS` verdict while the internal research record still
   carried an unresolved `VERIFY` on the model card text. The card has now been
   read directly.

## Verdict

**PASS.** The pinned INT8 artifact is redistribution-grade under MIT with
attribution preserved, its architecture lineage is Apache-2.0 and contributes no
shipped weights, and no training-data terms attach to it.

## Recorded observation, no action taken

The license evidence lives on the Hugging Face repository, while the exported
bytes came from the Dropbox-hosted `.pt` checkpoint linked from the authors' MIT
code repository. Both are hash-pinned and the chain is intact. `export_onnx.py`
also supports the Hugging Face `model.safetensors` checkpoint (SHA-256
`b89f36275f3bf5e2b040eee36597a8f19db051bff9a473a9cf7b2466284fb387`), which would
place bytes and license statement at the same host.

Do not re-export on this basis now. The current SHA-256 is bound to every
calibration and evaluation artifact in the repository; changing it invalidates
that evidence chain for a cosmetic gain.

## Scope

This audit covers redistribution of the model artifact only. It is not legal
advice, and it makes no claim about the licensing of images the extension
analyses at runtime.

## Sign-off

| Field | Value |
|---|---|
| Prepared | 2026-08-14 |
| Evidence sources | first-party model, dataset, backbone, and code repository pages |
| Owner sign-off | `affaffaff` - approved 2026-08-14 |

This sign-off closes the redistribution/provenance gate only. The calibration
curve remains quarantined and `models[0].url` remains null because the frozen
native-format nuisance battery fails independently; see
[`NUISANCE_BATTERY_REPORT.md`](NUISANCE_BATTERY_REPORT.md) and
[`COMPLIANCE.md`](COMPLIANCE.md).
