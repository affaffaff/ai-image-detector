#!/usr/bin/env python3
"""Deterministically export the official Community Forensics 384px model.

This script downloads only the authors' MIT-licensed model checkpoint. It does
not access the CommunityForensics training/evaluation datasets. The official
checkpoint revision and its Git-LFS SHA-256 are pinned below, then verified
again before deserialization.

Outputs are written under models/weights/ (gitignored):
  community-forensics-384-fp32.onnx
  community-forensics-384-int8.onnx
  export-metadata.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import timm
import torch
from huggingface_hub import hf_hub_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from safetensors.torch import load_file
from torch import nn


REPO_ID = "OwensLab/commfor-model-384"
REVISION = "87b013b3d134dea22518e743bd7a1901e52fe9da"
CHECKPOINT_FILE = "model.safetensors"
CHECKPOINT_SHA256 = "b89f36275f3bf5e2b040eee36597a8f19db051bff9a473a9cf7b2466284fb387"
LEGACY_CHECKPOINT_FILE = "model_v11_ViT_384_base_ckpt.pt"
LEGACY_CHECKPOINT_SHA256 = "d134f6f2c6185c9146ed54e7ea1c43e9f67ea42d98e9bdc88791d4163095dcde"
TIMM_MODEL = "vit_small_patch16_384.augreg_in21k_ft_in1k"
INPUT_NAME = "pixel_values"
OUTPUT_NAME = "fake_logit"
INPUT_SIZE = 384
SEED = 11997733


class CommunityForensics384(nn.Module):
    """Exact architecture declared by the authors' models.py."""

    def __init__(self) -> None:
        super().__init__()
        # pretrained=False is intentional: the final official state dict is
        # loaded strictly below, so no second network download can occur.
        self.vit = timm.create_model(TIMM_MODEL, pretrained=False)
        self.vit.head = nn.Linear(in_features=384, out_features=1, bias=True)

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        return self.vit(pixel_values)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_onnx(path: Path) -> None:
    """Remove exporter-version noise and serialize protobuf deterministically."""
    model = onnx.load(path, load_external_data=False)
    model.producer_name = "ai-image-detector"
    model.producer_version = "1"
    model.domain = ""
    model.model_version = 1
    model.doc_string = ""
    del model.metadata_props[:]
    model.graph.doc_string = ""
    for node in model.graph.node:
        node.doc_string = ""
    path.write_bytes(model.SerializeToString(deterministic=True))


def export_fp32(model: nn.Module, example: torch.Tensor, output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="commfor-onnx-") as temp_dir:
        temporary = Path(temp_dir) / "model.onnx"
        torch.onnx.export(
            model,
            example,
            temporary,
            input_names=[INPUT_NAME],
            output_names=[OUTPUT_NAME],
            opset_version=18,
            do_constant_folding=True,
            dynamo=False,
        )
        normalize_onnx(temporary)
        output.write_bytes(temporary.read_bytes())


def export_int8(fp32: Path, output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="commfor-int8-") as temp_dir:
        temporary = Path(temp_dir) / "model.int8.onnx"
        quantize_dynamic(
            model_input=fp32,
            model_output=temporary,
            per_channel=True,
            reduce_range=False,
            weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul", "Gemm"],
        )
        normalize_onnx(temporary)
        output.write_bytes(temporary.read_bytes())


def first_logit(session: ort.InferenceSession, sample: np.ndarray) -> float:
    return float(np.asarray(session.run([OUTPUT_NAME], {INPUT_NAME: sample})[0]).reshape(-1)[0])


def verify_parity(
    model: nn.Module,
    fp32_path: Path,
    int8_path: Path,
    example: torch.Tensor,
) -> dict[str, float]:
    onnx.checker.check_model(onnx.load(fp32_path, load_external_data=False), full_check=True)
    onnx.checker.check_model(onnx.load(int8_path, load_external_data=False), full_check=True)

    providers = ["CPUExecutionProvider"]
    fp32_session = ort.InferenceSession(str(fp32_path), providers=providers)
    int8_session = ort.InferenceSession(str(int8_path), providers=providers)
    sample = example.detach().cpu().numpy()
    with torch.inference_mode():
        torch_logit = float(model(example).reshape(-1)[0])
    fp32_logit = first_logit(fp32_session, sample)
    int8_logit = first_logit(int8_session, sample)

    fp32_error = abs(torch_logit - fp32_logit)
    int8_error = abs(fp32_logit - int8_logit)
    if fp32_error > 1e-4:
        raise RuntimeError(f"PyTorch/ONNX parity failed: abs logit error {fp32_error:.8f}")
    # This is an artifact-corruption guard, not an accuracy gate. Dataset-level
    # acceptance belongs to the generator-held-out benchmark replica.
    if int8_error > 0.5:
        raise RuntimeError(f"int8 drift is unexpectedly large: abs logit error {int8_error:.8f}")
    return {
        "pytorchLogit": torch_logit,
        "fp32Logit": fp32_logit,
        "int8Logit": int8_logit,
        "fp32AbsError": fp32_error,
        "int8AbsError": int8_error,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=Path("models/weights"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/model-export"))
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="use an already-downloaded official model.safetensors file",
    )
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)

    if args.checkpoint:
        checkpoint = args.checkpoint
    else:
        checkpoint = Path(
            hf_hub_download(
                repo_id=REPO_ID,
                filename=CHECKPOINT_FILE,
                revision=REVISION,
                cache_dir=args.cache_dir,
            )
        )
    if not checkpoint.is_file():
        raise FileNotFoundError(checkpoint)
    actual_checkpoint_hash = sha256_file(checkpoint)
    expected_checkpoint_hash = (
        LEGACY_CHECKPOINT_SHA256
        if checkpoint.name == LEGACY_CHECKPOINT_FILE
        else CHECKPOINT_SHA256
    )
    if actual_checkpoint_hash != expected_checkpoint_hash:
        raise RuntimeError(
            f"official checkpoint hash mismatch: expected {expected_checkpoint_hash}, "
            f"got {actual_checkpoint_hash}"
        )

    model = CommunityForensics384().cpu().eval()
    if checkpoint.name == LEGACY_CHECKPOINT_FILE:
        legacy = torch.load(checkpoint, map_location="cpu", weights_only=True)
        state = legacy["model"]
        source_kind = "official-dropbox-pytorch"
    else:
        state = load_file(checkpoint, device="cpu")
        source_kind = "official-huggingface-safetensors"
    model.load_state_dict(state, strict=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = args.out_dir / "community-forensics-384-fp32.onnx"
    int8_path = args.out_dir / "community-forensics-384-int8.onnx"

    generator = torch.Generator(device="cpu").manual_seed(SEED)
    example = torch.rand((1, 3, INPUT_SIZE, INPUT_SIZE), generator=generator)
    export_fp32(model, example, fp32_path)
    export_int8(fp32_path, int8_path)
    parity = verify_parity(model, fp32_path, int8_path, example)

    metadata = {
        "formatVersion": 1,
        "source": {
            "repo": REPO_ID,
            "revision": REVISION,
            "kind": source_kind,
            "file": checkpoint.name,
            "sha256": actual_checkpoint_hash,
            "license": "MIT",
        },
        "baseModel": {"id": TIMM_MODEL, "license": "Apache-2.0"},
        "io": {
            "input": {"name": INPUT_NAME, "shape": [1, 3, INPUT_SIZE, INPUT_SIZE]},
            "output": {"name": OUTPUT_NAME, "semantic": "fake-logit"},
        },
        "artifacts": {
            "fp32": {
                "file": fp32_path.name,
                "bytes": fp32_path.stat().st_size,
                "sha256": sha256_file(fp32_path),
            },
            "int8": {
                "file": int8_path.name,
                "bytes": int8_path.stat().st_size,
                "sha256": sha256_file(int8_path),
            },
        },
        "parity": parity,
    }
    metadata_path = args.out_dir / "export-metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
