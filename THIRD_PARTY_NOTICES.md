# Third-party notices

## Community Forensics 384 model weights

- Authors: Jeongsoo Park and Andrew Owens
- Paper: *Community Forensics: Using Thousands of Generators to Train Fake Image
  Detectors*, CVPR 2025 (arXiv:2411.04125)
- Source: https://huggingface.co/OwensLab/commfor-model-384
- Project: https://github.com/JeongsooP/Community-Forensics
- License stated for the released model: MIT (model card reads `License: mit`;
  read from the card directly on 2026-08-14)

The ONNX browser artifact is a deterministic export and dynamic quantization of
the authors' released 384px checkpoint. The export metadata records the exact
source checkpoint and SHA-256.

## timm ViT-S backbone

- Model: `vit_small_patch16_384.augreg_in21k_ft_in1k`
- Source: https://huggingface.co/timm/vit_small_patch16_384.augreg_in21k_ft_in1k
- License: Apache-2.0

The repository does not redistribute the Community Forensics datasets and does
not use them in its benchmark replica.

## OpenSDID+ calibration and evaluation corpus

- Dataset: `nebula/OpenSDIDplus`
- Source: https://huggingface.co/datasets/nebula/OpenSDIDplus
- Upstream project: https://github.com/iamwangyabin/OpenSDI
- License: CC BY-SA 4.0
- Pinned revision: `ce647ee3eb7802e9a26ca1e89bb7dfddaa19d92f`

The repository does not redistribute the dataset images. The shipped monotone
calibration curve was fitted on a balanced, label-blind normalized subset of
the full-synthesis SDXL group plus held-out photographer reals (source-matched
1024px JPEG, three degradation chains). The held-out evaluation split used the
unseen local generators (sd-1.5, kandinsky-2.2) and photographer groups, at
fixed threshold 0.65. The calibration file records the corpus, revision,
transform, sample count, and measured operating-point result.

## Three-way license check (shipping gate)

All three columns were read from their first-party source pages on 2026-08-14.
The full audit record is [`docs/PROVENANCE_AUDIT.md`](docs/PROVENANCE_AUDIT.md).

| Component | License | Compatible with MIT redistribution? |
|---|---|---|
| Community Forensics 384 weights | MIT | yes |
| timm ViT-S backbone | Apache-2.0 | yes, and no backbone weights are shipped: the exporter builds the architecture with `pretrained=False` and loads the authors' checkpoint with `strict=True`, so every shipped parameter comes from the MIT release |
| Training data (CommunityForensics) | CC-BY-4.0, stated as released for research purposes; individual images retain their generating models' licenses | not applicable to the artifact — the dataset is never downloaded, trained on, evaluated on, or redistributed here; the shipped weights are the authors' own MIT checkpoint, not a retrained model |

Verdict: PASS — the pinned ONNX artifact (SHA-256
`df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035`, 23,967,155
bytes) is redistribution-grade MIT. The extension never downloads or reuses any
CommunityForensics dataset at scan time or setup time.
