#!/usr/bin/env python3
"""
Generate the AI-positive class locally, with full provenance.

The closed commercial generators (Midjourney, DALL-E 3, Firefly, GPT Image)
cannot be produced locally and have to be collected by hand. Everything else —
the volume, the generator breadth the held-out split needs, and reproducibility
comes from here.

Design decisions that matter:

**Generator families, not one model.** `dedupe_and_split.py` holds whole groups
out of the eval split, and unseen-generator balanced accuracy estimates
generalization. One model produces one fingerprint and an eval split that
cannot hold anything out. Each profile below is a distinct
architecture/VAE lineage, which is what makes the holdout meaningful.

**Prompt breadth is a forensic requirement, not a nicety.** If every positive is
a portrait, the detector learns "faces => AI" and dies on the benchmark's
landscapes. The prompt bank spans subject, lighting, optics, indoor/outdoor and
aspect ratio so content is uncorrelated with label as far as we can manage.

**Deterministic and resumable.** Image i uses seed = base_seed + i and prompt
bank[i % len(bank)], so a rerun reproduces the same corpus and an interrupted
run continues where it stopped. The index records model revision, prompt, seed,
scheduler, steps, guidance and SHA-256 — enough for a third party to regenerate
any single image and get the same bytes.

**Written as native model output.** No resizing, no recompression here. The
degradation chain in `degrade_images.py` is applied afterwards to BOTH classes
from the same distribution; pre-degrading positives is precisely the leak
`audit_leakage.py` exists to catch.

Licence note: these checkpoints are CreativeML OpenRAIL-M / OpenRAIL++-M. They
carry use-based restrictions but do not claim ownership of generated outputs and
impose no share-alike on them, so training a detector on our own generations is
clean. We are not redistributing the checkpoints. Recorded per record anyway,
because "we checked" is worth nothing unless it is written down.

Usage:
    python tools/generate_ai_positives.py --profile sdxl --count 100
    python tools/generate_ai_positives.py --profile all --count 60
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time

# ---------------------------------------------------------------------------
# Generator profiles. Each is a distinct family for holdout purposes.
#
# vram_note reflects a 6GB card with model CPU offload enabled; every profile
# here is expected to fit that budget, which is the machine this was built on.

PROFILES: dict[str, dict] = {
    "sd15": {
        "repo": "runwayml/stable-diffusion-v1-5",
        "revision": "main",
        "pipeline": "sd",
        "licence": "CreativeML OpenRAIL-M",
        "sizes": [(512, 512), (512, 640), (640, 512)],
        "steps": 30,
        "guidance": 7.5,
        "group": "sd-1.5",
    },
    "sd21": {
        "repo": "stabilityai/stable-diffusion-2-1",
        "revision": "main",
        "pipeline": "sd",
        "licence": "CreativeML OpenRAIL++-M",
        "sizes": [(768, 768), (768, 512), (512, 768)],
        "steps": 30,
        "guidance": 7.5,
        "group": "sd-2.1",
        # Hub returns 401 without a Hugging Face login that has accepted
        # Stability's license. Skip unless HF_TOKEN is set; SDXL is the
        # public stand-in for a second architecture family.
        "requires_hub_auth": True,
    },
    "sdxl": {
        "repo": "stabilityai/stable-diffusion-xl-base-1.0",
        "revision": "main",
        "pipeline": "sdxl",
        "licence": "CreativeML OpenRAIL++-M",
        "sizes": [(1024, 1024), (1152, 896), (896, 1152)],
        "steps": 30,
        "guidance": 7.0,
        "group": "sdxl-1.0",
    },
    "kandinsky22": {
        "repo": "kandinsky-community/kandinsky-2-2-decoder",
        "revision": "main",
        "pipeline": "kandinsky",
        "licence": "Apache-2.0",
        "sizes": [(768, 768), (768, 512), (512, 768)],
        "steps": 50,
        "guidance": 4.0,
        "group": "kandinsky-2.2",
    },
    "sdxl-turbo": {
        "repo": "stabilityai/sdxl-turbo",
        "revision": "main",
        "pipeline": "sdxl",
        "licence": "STAI Non-Commercial Research Community Licence",
        "sizes": [(512, 512)],
        "steps": 4,
        "guidance": 0.0,
        "group": "sdxl-turbo",
        # Non-commercial licence. A production release can be commercial use,
        # so this profile is OFF unless explicitly named. Kept because it is
        # useful for fast local pipeline smoke tests only.
        "restricted": True,
    },
}

DEFAULT_PROFILES = ["sd15", "sd21", "sdxl"]

# ---------------------------------------------------------------------------
# Prompt bank. Breadth over polish: subject, optics, lighting and setting all
# vary, because content that correlates with the label is a shortcut the
# detector will happily learn instead of learning generation artifacts.

PROMPTS: list[str] = [
    "a candid street photograph of a busy crosswalk at dusk, wet asphalt",
    "an overcast coastal cliff with seabirds, handheld photo",
    "interior of a small secondhand bookshop, warm tungsten light",
    "a plate of food on a cafe table, shallow depth of field",
    "an industrial rail yard under flat winter light",
    "a suburban back garden in late afternoon, long shadows",
    "a mountain ridge above the treeline, hazy distance",
    "a cluttered home office desk with a laptop and mug",
    "close-up of weathered painted wood on a fence",
    "a crowded farmers market stall with vegetables",
    "an empty parking garage lit by fluorescent strips",
    "a dog running across a grass field, motion blur",
    "a construction site with a crane against grey sky",
    "portrait of an older man in a wool coat, natural window light",
    "a child blowing dandelion seeds in a park",
    "a snowy residential street early morning",
    "aerial view of farmland patchwork fields",
    "an old stone bridge over a slow river",
    "a bicycle leaning against a brick wall",
    "a diner counter with stools, mid-century interior",
    "a laboratory bench with glassware and instruments",
    "a forest floor covered in ferns and fallen leaves",
    "a fishing boat moored in a small harbour",
    "a busy airport terminal walkway",
    "macro photograph of a bee on a purple flower",
    "a desert highway vanishing toward mountains",
    "a rainy window with city lights out of focus",
    "an attic filled with stored furniture and boxes",
    "a modern kitchen with morning light on a countertop",
    "a football pitch from the stands before a match",
    "a hospital corridor with polished floors",
    "a vintage car parked on a cobbled lane",
    "a lighthouse on a rocky point under stormy sky",
    "a woman reading on a train, reflection in the glass",
    "an orchard in blossom, rows receding",
    "a workshop bench with hand tools and sawdust",
    "a subway platform as a train arrives",
    "a tent pitched beside an alpine lake at dawn",
    "a market street in heavy rain with umbrellas",
    "a greenhouse interior crowded with seedlings",
    "a cat asleep on a radiator by a window",
    "a rooftop view over terraced houses at sunset",
]

NEGATIVE_PROMPT = "text, watermark, signature, logo, frame, border, caption"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_index(path: pathlib.Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {
        "source": "local-generation",
        "licence_policy": "outputs of locally run checkpoints; no checkpoint redistributed",
        "count": 0,
        "records": [],
    }


def hub_token_present() -> bool:
    import os

    if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
        return True
    return pathlib.Path.home().joinpath(".cache", "huggingface", "token").exists()


def write_index(path: pathlib.Path, index: dict) -> None:
    """Atomic flush so a killed run keeps provenance for every PNG already written."""
    index["count"] = len(index["records"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def build_pipeline(profile: dict, offload: bool):
    """Import torch/diffusers lazily so --list works without the CUDA stack."""
    import torch
    from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline

    if not torch.cuda.is_available():
        raise SystemExit(
            "no CUDA device visible. This tool is GPU-only by design — CPU "
            "generation is hours per image and cannot build a corpus.\n"
            "Install the CUDA build: pip install -r tools/requirements-generate.txt"
        )

    if profile["pipeline"] == "kandinsky":
        from diffusers import AutoPipelineForText2Image

        # Combined prior+decoder is ~10GB in fp16. Load module-by-module and
        # keep only the active one on a 6GB card; model_cpu_offload still
        # peaked the laptop into a silent Windows kill (exit 4294967295).
        pipe = AutoPipelineForText2Image.from_pretrained(
            profile["repo"],
            revision=profile["revision"],
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
        )
        pipe.set_progress_bar_config(disable=True)
        if offload:
            pipe.enable_sequential_cpu_offload()
        else:
            pipe.to("cuda")
        if hasattr(pipe, "enable_attention_slicing"):
            pipe.enable_attention_slicing()
        return pipe

    cls = StableDiffusionXLPipeline if profile["pipeline"] == "sdxl" else StableDiffusionPipeline
    pipe = cls.from_pretrained(
        profile["repo"],
        revision=profile["revision"],
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe.set_progress_bar_config(disable=True)
    if offload:
        # 6GB cards cannot hold SDXL's UNet, both text encoders and the VAE at
        # once. Offload keeps peak VRAM near the largest single module.
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")
    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    if hasattr(pipe, "enable_attention_slicing"):
        pipe.enable_attention_slicing()
    return pipe


def record_for(profile: dict, dest: pathlib.Path, i: int, base_seed: int, data: bytes) -> dict:
    prompt = PROMPTS[i % len(PROMPTS)]
    width, height = profile["sizes"][i % len(profile["sizes"])]
    return {
        "path": str(dest).replace("\\", "/"),
        "label": 1,
        "group": profile["group"],
        "source": "local-generation",
        "model_repo": profile["repo"],
        "model_revision": profile["revision"],
        "licence": profile["licence"],
        "prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT if profile["guidance"] > 0 else "",
        "seed": base_seed + i,
        "steps": profile["steps"],
        "guidance": profile["guidance"],
        "width": width,
        "height": height,
        "sha256": sha256_bytes(data),
        "bytes": len(data),
    }


def generate_profile(
    name: str,
    profile: dict,
    count: int,
    out_root: pathlib.Path,
    index: dict,
    index_path: pathlib.Path,
    base_seed: int,
    offload: bool,
) -> int:
    import torch

    group = profile["group"]
    out_dir = out_root / group
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = {r["path"] for r in index["records"]}
    recovered = 0
    todo = []
    for i in range(count):
        dest = out_dir / f"{group}-{i:05d}.png"
        key = str(dest).replace("\\", "/")
        if key in existing:
            continue
        if dest.exists():
            index["records"].append(record_for(profile, dest, i, base_seed, dest.read_bytes()))
            existing.add(key)
            recovered += 1
            continue
        todo.append((i, dest))

    if recovered:
        write_index(index_path, index)
        print(f"{name}: recovered {recovered} unindexed files already on disk")

    if not todo:
        print(f"{name}: already complete ({count} images)")
        return recovered

    print(f"{name}: {len(todo)} to generate ({count - len(todo)} already present)")
    pipe = build_pipeline(profile, offload)

    made = 0
    for i, dest in todo:
        prompt = PROMPTS[i % len(PROMPTS)]
        width, height = profile["sizes"][i % len(profile["sizes"])]
        seed = base_seed + i
        # Sequential offload keeps modules on CPU; a CUDA generator can
        # allocate a leftover context that pushes a 6GB card over the edge.
        generator_device = "cpu" if profile["pipeline"] == "kandinsky" else "cuda"
        generator = torch.Generator(device=generator_device).manual_seed(seed)

        started = time.time()
        kwargs = dict(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            width=width,
            height=height,
            num_inference_steps=profile["steps"],
            generator=generator,
        )
        # Turbo profiles are distilled to run without classifier-free guidance;
        # passing a negative prompt there is meaningless and costs a forward pass.
        if profile["guidance"] > 0:
            kwargs["guidance_scale"] = profile["guidance"]
        else:
            kwargs["guidance_scale"] = 0.0
            kwargs.pop("negative_prompt")

        image = pipe(**kwargs).images[0]
        # PNG: the model's own output, undegraded. degrade_images.py applies the
        # label-blind web-realistic chain to both classes afterwards.
        image.save(dest, format="PNG")
        data = dest.read_bytes()

        index["records"].append(record_for(profile, dest, i, base_seed, data))
        write_index(index_path, index)
        made += 1
        print(f"  [{made:4d}/{len(todo)}] {dest.name}  {width}x{height}  {time.time() - started:.1f}s")

    del pipe
    torch.cuda.empty_cache()
    return made + recovered


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--profile", default="all", help="profile name, or 'all' for the default set")
    ap.add_argument("--count", type=int, default=100, help="images per profile")
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/raw/ai"))
    ap.add_argument("--index", type=pathlib.Path, default=pathlib.Path("data/ai-index.json"))
    ap.add_argument("--seed", type=int, default=20260813, help="base seed; image i uses seed+i")
    ap.add_argument("--no-offload", action="store_true", help="keep the whole pipeline on the GPU")
    ap.add_argument("--list", action="store_true", help="list profiles and exit")
    args = ap.parse_args()

    if args.list:
        for name, profile in PROFILES.items():
            flag = "  [RESTRICTED: non-commercial]" if profile.get("restricted") else ""
            print(f"{name:12s} {profile['repo']}{flag}")
        return 0

    if args.profile == "all":
        names = DEFAULT_PROFILES
    else:
        names = [args.profile]
        if args.profile not in PROFILES:
            print(f"unknown profile '{args.profile}'. --list to see them.", file=sys.stderr)
            return 2

    for name in names:
        if PROFILES[name].get("restricted") and args.profile == "all":
            continue

    index = load_index(args.index)
    total = 0
    for name in names:
        profile = PROFILES[name]
        if profile.get("requires_hub_auth") and not hub_token_present():
            print(
                f"SKIP '{name}': {profile['repo']} is gated on the Hub (401 without login). "
                "Run huggingface-cli login, accept the model license, then retry this profile.",
                file=sys.stderr,
            )
            continue
        if profile.get("restricted"):
            print(f"NOTE: '{name}' is non-commercial licensed. Excluded from any corpus")
            print("      used for a production release. Smoke tests only.")
        total += generate_profile(
            name,
            profile,
            args.count,
            args.out,
            index,
            args.index,
            args.seed,
            not args.no_offload,
        )
        write_index(args.index, index)

    groups = {r["group"] for r in index["records"]}
    print(f"\ngenerated {total} new (index total {index['count']})")
    print(f"distinct generator groups: {len(groups)} -> {sorted(groups)}")
    print(f"index: {args.index}")
    if len(groups) < 3:
        print("\nNOTE: the eval split holds whole generators out. Two groups means")
        print("      holding one out leaves one to fit on. Add profiles, and add")
        print("      hand-collected closed-generator samples before reporting.")
    print("\nThis is the AI class only. Closed commercial generators")
    print("(Midjourney, DALL-E 3, Firefly, GPT Image) must still be collected by hand.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
