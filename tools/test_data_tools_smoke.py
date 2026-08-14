#!/usr/bin/env python3
"""End-to-end smoke tests for the benchmark-replica tooling.

The tests use synthetic images and cover the properties that decide whether
the replica is trustworthy: byte determinism, explicit contest-stress
coverage, perceptual deduplication/group splits, and leakage-audit sensitivity.

Run: python tools/test_data_tools_smoke.py
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).parent
CONTEST_CORE = {
    "jpeg_triple",
    "mixed_recompress",
    "social_thumbnail",
    "screen_capture",
    "screen_capture_jpeg",
    "modern_canvas_jpeg",
}


def synth_image(path: pathlib.Path, seed: int, size=(320, 240)) -> None:
    """Textured noise + waves: enough high-frequency content for pHash."""
    rng = np.random.default_rng(seed)
    width, height = size
    base = rng.integers(0, 255, size=(height, width, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:height, 0:width]
    base[..., 0] = ((np.sin(xx / (6 + seed % 7)) + 1) * 110).astype(np.uint8)
    base[..., 1] = ((np.cos(yy / (5 + seed % 5)) + 1) * 110).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base).save(path, format="PNG")


def run(args: list[str]) -> subprocess.CompletedProcess:
    # -E: this machine's shell injects a broken PIL from the Hermes venv into
    # child Python processes; -E keeps the smoke test on this venv's packages.
    return subprocess.run([sys.executable, "-E", *args], capture_output=True, text=True)


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        root = pathlib.Path(temp_dir)
        raw = root / "raw"

        # 12 distinct images across 4 groups, plus two recompressed near-dupes.
        index = []
        for group_index, group in enumerate(["gen-a", "gen-b", "real-src-x", "real-src-y"]):
            label = 1 if group.startswith("gen") else 0
            for image_index in range(3):
                rel = f"{group}/{image_index:03d}.png"
                synth_image(raw / rel, seed=group_index * 10 + image_index)
                index.append({"path": rel, "label": label, "group": group})
        for group in ("gen-a", "real-src-x"):
            with Image.open(raw / f"{group}/000.png") as source:
                rel = f"{group}/000_copy.jpg"
                source.convert("RGB").save(raw / rel, format="JPEG", quality=88)
            index.append({"path": rel, "label": 1 if group.startswith("gen") else 0, "group": group})

        # 1. Same seed and source must produce the exact same output bytes.
        out_a, out_b = root / "deg_a", root / "deg_b"
        for output in (out_a, out_b):
            result = run([
                str(HERE / "degrade_images.py"),
                "--in", str(raw),
                "--out", str(output),
                "--seed", "424242",
            ])
            assert result.returncode == 0, f"degrade failed:\n{result.stdout}\n{result.stderr}"
        man_a = json.loads((out_a / "degradation-manifest.json").read_text())
        man_b = json.loads((out_b / "degradation-manifest.json").read_text())
        chains_a = {record["src"]: record["chain"] for record in man_a["records"]}
        chains_b = {record["src"]: record["chain"] for record in man_b["records"]}
        assert chains_a == chains_b, "same seed produced different chains"
        assert len(set(chains_a.values())) > 1, "degradation collapsed to one chain"
        hashes_a = {record["src"]: record["output_sha256"] for record in man_a["records"]}
        hashes_b = {record["src"]: record["output_sha256"] for record in man_b["records"]}
        assert hashes_a == hashes_b, "same seed produced different output bytes"
        for record in man_a["records"]:
            output = out_a / record["out"]
            assert sha256(output) == record["output_sha256"], "manifest output hash is stale"
            assert record["output_storage"] in {"exact-final-encode", "lossless-envelope"}
        print(
            f"1. determinism ok - {len(chains_a)} images, "
            f"{len(set(chains_a.values()))} distinct chains, stable bytes"
        )

        # 2. A single source must receive every named contest-core profile.
        core_raw = root / "core_raw"
        synth_image(core_raw / "one.png", seed=99, size=(96, 64))
        core_out = root / "core"
        result = run([
            str(HERE / "degrade_images.py"),
            "--in", str(core_raw),
            "--out", str(core_out),
            "--suite", "contest-core",
            "--seed", "424242",
        ])
        assert result.returncode == 0, f"contest-core failed:\n{result.stdout}\n{result.stderr}"
        core_manifest = json.loads((core_out / "degradation-manifest.json").read_text())
        core_records = core_manifest["records"]
        assert {record["chain"] for record in core_records} == CONTEST_CORE
        assert len(core_records) == len(CONTEST_CORE)
        assert all(record["source_format"] == "png" for record in core_records)
        assert all(record["output_storage"] == "exact-final-encode" for record in core_records)
        triple = next(record for record in core_records if record["chain"] == "jpeg_triple")
        assert triple["lossy_encode_count"] == 3
        mixed = next(record for record in core_records if record["chain"] == "mixed_recompress")
        assert mixed["lossy_encode_count"] == 3
        assert {step["op"] for step in mixed["steps"]} >= {"jpeg", "webp", "rescale"}
        screen = next(record for record in core_records if record["chain"] == "screen_capture")
        assert screen["steps"][0]["capture_size"] == [screen["output_width"], screen["output_height"]]
        assert pathlib.Path(screen["out"]).suffix == ".png"
        assert pathlib.Path(triple["out"]).suffix == ".jpg"
        modern = next(record for record in core_records if record["chain"] == "modern_canvas_jpeg")
        assert max(modern["output_width"], modern["output_height"]) >= 1350
        print("2. contest-core ok - recompression, thumbnails, capture, and modern canvas")

        # 3. Near-duplicates are removed and a group never spans splits.
        index_path = root / "index.json"
        index_path.write_text(json.dumps(index))
        splits_path = root / "splits.json"
        result = run([
            str(HERE / "dedupe_and_split.py"),
            "--index", str(index_path),
            "--root", str(raw),
            "--out", str(splits_path),
        ])
        assert result.returncode == 0, f"split failed:\n{result.stdout}\n{result.stderr}"
        splits = json.loads(splits_path.read_text())
        assert splits["dropped_duplicates"] >= 2
        seen: dict[str, str] = {}
        for split_name, rows in splits["splits"].items():
            for record in rows:
                previous = seen.setdefault(record["group"], split_name)
                assert previous == split_name, f"group {record['group']} leaked across splits"
        print(
            f"3. dedupe+split ok - dropped {splits['dropped_duplicates']} near-dupes, "
            f"{len(seen)} groups, no group spans two splits"
        )

        # 4a. Label-blind sampled degradation should not fail the audit.
        labels = {record["path"]: record["label"] for record in index}
        labels_path = root / "labels.json"
        labels_path.write_text(json.dumps(labels))
        clean = run([
            str(HERE / "audit_leakage.py"),
            "--manifest", str(out_a / "degradation-manifest.json"),
            "--labels", str(labels_path),
            "--root", str(out_a),
            "--out", str(root / "clean-audit.json"),
            "--min-records-per-degradation-class", "0",
        ])
        assert clean.returncode == 0, f"balanced corpus failed audit:\n{clean.stdout}{clean.stderr}"
        assert "ROC-AUC" in clean.stdout

        # 4b. Degradation itself perfectly encodes the label.
        poisoned = {"seed": 1, "records": []}
        for record in index:
            is_ai = labels[record["path"]] == 1
            poisoned["records"].append({
                "src": record["path"],
                "out": record["path"],
                "chain": "pristine" if is_ai else "jpeg",
                "steps": [] if is_ai else [{"op": "jpeg", "quality": 55}],
            })
        poisoned_path = root / "poisoned.json"
        poisoned_path.write_text(json.dumps(poisoned))
        degradation_leak = run([
            str(HERE / "audit_leakage.py"),
            "--manifest", str(poisoned_path),
            "--labels", str(labels_path),
            "--root", str(raw),
            "--out", str(root / "degradation-leak-audit.json"),
            "--min-records-per-degradation-class", "0",
        ])
        assert degradation_leak.returncode == 1, (
            "audit missed class-correlated degradation:\n"
            f"{degradation_leak.stdout}{degradation_leak.stderr}"
        )
        assert "FAIL" in degradation_leak.stdout

        # 4c. Degradation is identical, but source codec and dimensions encode
        # the label - the square-PNG-generator vs landscape-JPEG-photo shortcut.
        source_poisoned = {"seed": 2, "records": []}
        source_labels = {}
        for label in (0, 1):
            for image_index in range(12):
                extension = "png" if label else "jpg"
                source = f"source-leak/{label}/{image_index:03d}.{extension}"
                source_labels[source] = label
                synth_image(root / f"neutral/{label}-{image_index:03d}.png", seed=100 + label * 20 + image_index)
                source_poisoned["records"].append({
                    "src": source,
                    "out": f"neutral/{label}-{image_index:03d}.png",
                    "chain": "jpeg",
                    "steps": [{"op": "jpeg", "quality": 80}],
                    "source_format": "png" if label else "jpeg",
                    "source_width": 1024 if label else 1600,
                    "source_height": 1024 if label else 900,
                    "source_bytes": 1_000_000,
                    "output_format": "png",
                    "output_width": 800,
                    "output_height": 600,
                    "output_bytes": 500_000,
                })
        source_poisoned_path = root / "source-poisoned.json"
        source_labels_path = root / "source-labels.json"
        source_poisoned_path.write_text(json.dumps(source_poisoned))
        source_labels_path.write_text(json.dumps(source_labels))
        source_leak = run([
            str(HERE / "audit_leakage.py"),
            "--manifest", str(source_poisoned_path),
            "--labels", str(source_labels_path),
            "--root", str(root),
            "--out", str(root / "source-leak-audit.json"),
            "--min-records-per-degradation-class", "0",
        ])
        assert source_leak.returncode == 1, (
            "audit missed source format/dimension leakage:\n"
            f"{source_leak.stdout}{source_leak.stderr}"
        )
        assert "source_format" in source_leak.stdout
        print("4. leak audit ok - catches degradation and source-format/dimension shortcuts")

        # 5. Codec/size matching makes mixed PNG/JPEG sources share container + canvas.
        mix_raw = root / "mix_raw"
        synth_image(mix_raw / "ai.png", seed=21, size=(80, 64))
        with Image.open(mix_raw / "ai.png") as source:
            source.convert("RGB").save(mix_raw / "real.jpg", format="JPEG", quality=80)
        mix_out = root / "mix_out"
        result = run([
            str(HERE / "degrade_images.py"),
            "--in", str(mix_raw),
            "--out", str(mix_out),
            "--keep-original",
            "--seed", "424242",
            "--match-source-codec", "jpeg",
            "--jpeg-quality", "95",
            "--match-size", "square",
            "--match-size-px", "96",
        ])
        assert result.returncode == 0, f"matched-codec degrade failed:\n{result.stdout}\n{result.stderr}"
        mix_manifest = json.loads((mix_out / "degradation-manifest.json").read_text())
        assert mix_manifest["match_source_codec"] == "jpeg"
        assert mix_manifest["match_size"] == "square"
        assert {record["source_format"] for record in mix_manifest["records"]} == {"jpeg"}
        assert all(record["source_width"] == 96 and record["source_height"] == 96 for record in mix_manifest["records"])
        jpeg_magic = b"\xff\xd8\xff"
        for record in mix_manifest["records"]:
            payload = (mix_out / record["out"]).read_bytes()
            if record["output_format"] == "jpeg":
                assert payload.startswith(jpeg_magic), record["out"]
        print("5. matched-codec ok - mixed PNG/JPEG sources enter degrade as 96px JPEG")

    print("\nall data-tool smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
