#!/usr/bin/env python3
"""Adversarial fixture suite for the benchmark-replica data tooling.

Exercises every known degradation profile and every documented gate, plus
independent INT8/FP32 and null-baseline reproductions:

  1.  degradation-profile sweep  - all 17 chains via degrade_images.py, with
      manifest schema/hash/storage verification (exact-final-encode vs
      lossless-envelope, lossy_encode_count vs steps, output_sha256 vs disk)
  2.  stale/mismatched audit reports - partial label maps, too-small classes,
      stale output_sha256, missing output files, artifact self-consistency
  3.  altered manifests - unknown src, unknown/missing/duplicate assignment
      groups, malformed evaluation config, quarantined official_center column
  4.  duplicate sources - duplicate image_id, cross-split phash duplicates,
      generators crossing splits, and the path-alias label-conflict gap
  5.  too-small classes - single-class splits, min-count and min-cluster gates
  6.  fit/calibration overlap - same arrays, identical content, same split id,
      overlapping masks/clusters/generators (gate closed in both calibrators)
  7.  modified eval logs - hash-chain tail-integrity detection, chain walk,
      report content-hash self-consistency
  8.  JSON schema + report-field completeness - every artifact type
  9.  INT8/FP32 parity - tiny ONNX model exported fp32 + dynamic-quantized
      int8, drift computed independently with numpy, compared to the tool
      gates and to the shipped export-metadata parity numbers
  10. null-baseline reproduction - clustered_metrics null baselines verified
      by direct computation on constant and random score fixtures

Run (Windows venv, isolated from any injected site-packages):
    .venv-export/Scripts/python.exe -E tools/test_adversarial_fixtures.py
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import pathlib
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
PY = sys.executable
RNG = np.random.default_rng(20260814)

DECISION_THRESHOLD = 0.65
MODEL_HASH = "a" * 64

# --- every chain the degrade tool can emit (mirror of CHAINS in degrade_images.py)
ALL_CHAINS = [
    "pristine", "jpeg", "jpeg_double", "jpeg_triple", "mixed_recompress",
    "rescale_jpeg", "crop_jpeg", "webp", "rescale_webp", "social_feed",
    "social_thumbnail", "screen_capture", "screen_capture_jpeg",
    "upscale_jpeg", "modern_canvas_jpeg",
    "canonical_square_jpeg", "canonical_square_lowres_jpeg",
]
CONTEST_CORE = [
    "jpeg_triple", "mixed_recompress", "social_thumbnail", "screen_capture",
    "screen_capture_jpeg", "modern_canvas_jpeg",
]
LOSSY_OPS = {"jpeg", "webp", "social_pipeline"}

# --- schema tables ----------------------------------------------------------
AUDIT_REQUIRED = {
    "formatVersion": int, "type": str, "status": str, "thresholds": dict,
    "config": dict, "inputs": dict, "coverage": dict, "result": dict,
    "contentSha256": str,
}
AUDIT_COVERAGE_REQUIRED = {
    "records": int, "sources": int, "aiRecords": int, "realRecords": int,
    "aiSources": int, "realSources": int, "byDegradation": dict,
    "outputSha256s": list, "outputSetSha256": str, "failures": list,
}
DEGRADE_RECORD_REQUIRED = {
    "src": str, "out": str, "chain": str, "steps": list,
    "chain_index": int, "lossy_encode_count": int, "source_format": str,
    "source_width": int, "source_height": int, "source_bytes": int,
    "source_sha256": str, "output_format": str, "output_storage": str,
    "output_width": int, "output_height": int, "output_bytes": int,
    "output_sha256": str,
}
EVAL_REPORT_REQUIRED = {
    "formatVersion": int, "type": str, "status": str, "evaluationId": str,
    "scenario": str, "split": str, "scoreColumn": str, "threshold": (int, float),
    "headline": dict, "counts": dict, "clusteredConfidence": dict,
    "nullBaselines": dict, "byDegradation": dict, "auditCoverage": dict,
    "gates": dict, "inputs": dict, "reportContentSha256": str,
}


@dataclass
class Result:
    name: str
    ok: bool
    detail: str = ""
    skipped: bool = False


@dataclass
class Suite:
    results: list = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append(Result(name, bool(ok), detail))

    def check_run(self, name: str, proc: subprocess.CompletedProcess, expect_rc: int) -> None:
        ok = proc.returncode == expect_rc
        detail = f"rc={proc.returncode} (want {expect_rc})"
        if not ok:
            tail = (proc.stdout or "")[-500:] + (proc.stderr or "")[-500:]
            detail += "\n" + tail.strip()
        self.check(name, ok, detail)

    def section(self, title: str) -> None:
        self.results.append(Result(f"=== {title} ===", True, ""))  # marker

    def summary(self) -> tuple[int, int, int]:
        real = [r for r in self.results if not r.name.startswith("===")]
        failed = [r for r in real if not r.ok and not r.skipped]
        skipped = [r for r in real if r.skipped]
        print("\n" + "=" * 78)
        print(f"adversarial fixture suite: {len(real) - len(failed) - len(skipped)} passed, "
              f"{len(failed)} FAILED, {len(skipped)} skipped")
        for r in failed:
            print(f"  FAIL  {r.name}")
            if r.detail:
                print("        " + r.detail.replace("\n", "\n        "))
        for r in real:
            if r.skipped:
                print(f"  SKIP  {r.name}")
        print("=" * 78)
        return len(real), len(failed), len(skipped)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True,
                   separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()


def run_tool(tool: str, *args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PY, "-E", str(HERE / tool), *(str(a) for a in args)],
        capture_output=True, text=True,
    )


def synth_image(path: pathlib.Path, seed: int, size=(400, 300)) -> None:
    """Synthetic image whose pixel statistics carry NO class information.

    Structure is a random per-path block pattern upscaled to the canvas: every
    image gets a distinct, high-entropy DCT signature (pHash spread, no
    cross-cluster near-duplicates) while the *distribution* of pixel statistics
    is identical for both classes (a leakage audit fitted on decoded-pixel
    features must land near chance). ``seed`` is accepted for API
    compatibility only.
    """
    del seed
    path_text = path.as_posix()
    digest = hashlib.sha256(path_text.encode("utf-8")).digest()
    path_seed = int.from_bytes(digest[:8], "big")
    rng = np.random.default_rng(path_seed)
    width, height = size
    block_w, block_h = 16, 16
    pattern = rng.integers(0, 256, size=(height // block_h + 1, width // block_w + 1, 3),
                           dtype=np.uint8)
    base = np.repeat(np.repeat(pattern, block_h, axis=0), block_w, axis=1)[:height, :width]
    # light per-pixel noise so lossy chains have something to chew on
    base = np.clip(base.astype(np.int16) + rng.integers(-12, 13, size=base.shape), 0, 255).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base).save(path, format="PNG")


def schema_check(name: str, payload: dict, table: dict) -> tuple[bool, str]:
    missing = sorted(set(table) - set(payload))
    type_bad = []
    for key, expected in sorted(table.items()):
        if key in payload and not isinstance(payload[key], expected):
            type_bad.append(f"{key}:{type(payload[key]).__name__}")
    if missing or type_bad:
        return False, f"missing={missing} type_bad={type_bad}"
    return True, ""


def build_golden_corpus(root: pathlib.Path) -> dict:
    """Synthetic corpus that passes the whole gated pipeline (audit->calibrate->evaluate)."""
    raw = root / "raw"
    # 260 sources (130 AI + 130 real), each its own source cluster. The eval
    # split takes 100 clusters per class, satisfying the evaluator's 100-cluster
    # power floor while keeping the corpus fast (2 chains x 260 sources).
    groups = [(f"ai-{i:03d}", 1) for i in range(130)] + [(f"real-{i:03d}", 0) for i in range(130)]
    index = []
    for group, label in groups:
        rel = f"{group}/img.png"
        synth_image(raw / rel, seed=hash(group) & 0xFFFF)
        index.append({
            "path": rel, "label": label, "group": group,
            "image_id": group, "source": "synthetic",
            "source_key": group, "license": "MIT",
            "dataset_revision": "synthetic", "sha256": "0" * 64,
        })
    index_path = root / "index.json"
    index_path.write_text(json.dumps(index))

    deg = root / "deg"
    proc = run_tool("degrade_images.py", "--in", raw, "--out", deg,
                    "--profiles", "jpeg,webp", "--seed", "20260813")
    if proc.returncode != 0:
        raise RuntimeError("degrade_images failed:\n" + proc.stdout + proc.stderr)
    manifest = json.loads((deg / "degradation-manifest.json").read_text())

    labels = {rec["path"]: rec["label"] for rec in index}
    labels_path = root / "labels.json"
    labels_path.write_text(json.dumps(labels))

    audit_path = root / "audit.json"
    proc = run_tool("audit_leakage.py", "--manifest", deg / "degradation-manifest.json",
                    "--labels", labels_path, "--root", deg, "--out", audit_path)
    if proc.returncode != 0:
        raise RuntimeError("audit failed:\n" + proc.stdout + proc.stderr)
    audit = json.loads(audit_path.read_text())
    if audit["status"] != "pass":
        raise RuntimeError(f"golden audit not pass: {audit['status']} {audit['coverage']['failures']}")

    splits_path = root / "splits.json"
    fit_ai = ",".join(f"ai-{i:03d}=fit" for i in range(20))
    fit_real = ",".join(f"real-{i:03d}=fit" for i in range(20))
    cal_ai = ",".join(f"ai-{i:03d}=calibration" for i in range(20, 30))
    cal_real = ",".join(f"real-{i:03d}=calibration" for i in range(20, 30))
    eval_ai = ",".join(f"ai-{i:03d}=eval" for i in range(30, 130))
    eval_real = ",".join(f"real-{i:03d}=eval" for i in range(30, 130))
    assignment = ",".join([fit_ai, fit_real, cal_ai, cal_real, eval_ai, eval_real])
    proc = run_tool("dedupe_and_split.py", "--index", index_path, "--root", raw,
                    "--out", splits_path, "--assignment", assignment)
    if proc.returncode != 0:
        raise RuntimeError("split failed:\n" + proc.stdout + proc.stderr)
    splits = json.loads(splits_path.read_text())

    # manual scored CSV with every REQUIRED_COLUMNS field evaluate_scores wants
    manifest_hash = sha256_file(deg / "degradation-manifest.json")
    rows = []
    for split_name in ("fit", "calibration", "eval"):
        for rec in splits["splits"][split_name]:
            original = next(r for r in index if r["path"] == rec["path"])
            # find the degraded output(s) for this source under contest-core
            for mrec in manifest["records"]:
                if mrec["src"] != rec["path"]:
                    continue
                image_path = deg / mrec["out"]
                image_hash = sha256_file(image_path)
                label = int(original["label"])
                raw_score = (0.88 + (sum(map(ord, mrec["out"])) % 40) / 1000) if label else \
                            (0.12 + (sum(map(ord, mrec["out"])) % 40) / 1000)
                rows.append({
                    "image_id": f"{original['image_id']}--{mrec['chain']}",
                    "path": image_path.relative_to(root).as_posix(),
                    "label": label,
                    "generator": original["group"],
                    "split": split_name,
                    "phash": rec["phash"],
                    "degradation": mrec["chain"],
                    "cluster_id": original["source_key"],
                    "image_sha256": image_hash,
                    "dataset_manifest_sha256": manifest_hash,
                    "model_sha256": MODEL_HASH,
                    "score_official_browser": f"{raw_score:.10f}",
                    "score_native_browser": f"{raw_score:.10f}",
                    "score": f"{raw_score:.10f}",
                })
    fields = list(rows[0].keys())
    score_set = root / "scores.csv"
    with score_set.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    # shared synthetic score arrays for fit/calibration overlap probes
    rng = np.random.default_rng(3)
    n = 80
    cal_s = np.sort(rng.uniform(0.05, 0.95, n))
    cal_l = np.asarray([0] * (n // 2) + [1] * (n // 2))
    cal_s_path = root / "cal_s.npy"
    cal_l_path = root / "cal_l.npy"
    np.save(cal_s_path, cal_s)
    np.save(cal_l_path, cal_l)

    return {
        "root": root, "raw": raw, "deg": deg, "index": index, "index_path": index_path,
        "manifest": manifest, "labels_path": labels_path, "audit_path": audit_path,
        "audit": audit, "splits_path": splits_path, "splits": splits,
        "score_set": score_set, "manifest_hash": manifest_hash,
        "cal_s_path": cal_s_path, "cal_l_path": cal_l_path,
        "assignment": assignment,
    }


# ---------------------------------------------------------------------------
# 1. degradation-profile sweep
# ---------------------------------------------------------------------------
def test_degradation_sweep(suite: Suite, tmp: pathlib.Path) -> None:
    suite.section("1. degradation-profile sweep")
    raw = tmp / "sweep-raw"
    synth_image(raw / "one.png", seed=5, size=(256, 192))
    deg = tmp / "sweep-deg"
    proc = run_tool("degrade_images.py", "--in", raw, "--out", deg,
                    "--profiles", ",".join(ALL_CHAINS), "--seed", "7")
    suite.check_run("degrade all 17 profiles rc=0", proc, 0)
    if proc.returncode != 0:
        return
    manifest = json.loads((deg / "degradation-manifest.json").read_text())
    chains = sorted({rec["chain"] for rec in manifest["records"]})
    suite.check("all 17 chains produced", chains == sorted(ALL_CHAINS),
                f"got {chains}")
    seen = set()
    for rec in manifest["records"]:
        chain = rec["chain"]
        ok, detail = schema_check("record", rec, DEGRADE_RECORD_REQUIRED)
        suite.check(f"schema: {chain} record fields", ok, detail)
        # hash / storage / lossy-count consistency
        payload = deg / rec["out"]
        hash_ok = sha256_file(payload) == rec["output_sha256"]
        suite.check(f"hash: {chain} output_sha256 matches disk", hash_ok)
        lossy = sum(1 for step in rec["steps"] if step.get("op") in LOSSY_OPS)
        suite.check(f"lossy count: {chain}", rec["lossy_encode_count"] == lossy,
                    f"declared {rec['lossy_encode_count']} != computed {lossy}")
        with Image.open(payload) as im:
            dims = im.size
        suite.check(f"dims: {chain}", dims == (rec["output_width"], rec["output_height"]),
                    f"file {dims} != declared {rec['output_width']}x{rec['output_height']}")
        suite.check(f"storage: {chain}",
                    rec["output_storage"] in {"exact-final-encode", "lossless-envelope"},
                    rec["output_storage"])
        seen.add(chain)
    # keep-original pristine path
    deg2 = tmp / "sweep-deg2"
    proc = run_tool("degrade_images.py", "--in", raw, "--out", deg2,
                    "--profiles", "jpeg", "--keep-original", "--seed", "7")
    if proc.returncode == 0:
        m2 = json.loads((deg2 / "degradation-manifest.json").read_text())
        chains2 = sorted({rec["chain"] for rec in m2["records"]})
        suite.check("keep-original emits pristine+jpeg", chains2 == ["jpeg", "pristine"],
                    str(chains2))
    # unknown profile must be rejected
    proc = run_tool("degrade_images.py", "--in", raw, "--out", tmp / "deg-bad",
                    "--profiles", "not_a_real_profile")
    suite.check("unknown profile rejected", proc.returncode != 0,
                f"rc={proc.returncode}")


# ---------------------------------------------------------------------------
# 2. stale / mismatched audit reports
# ---------------------------------------------------------------------------
def test_audit_reports(suite: Suite, corpus: dict) -> None:
    suite.section("2. stale/mismatched audit reports")
    root: pathlib.Path = corpus["root"]
    deg: pathlib.Path = corpus["deg"]

    # partial label map (missing sources) must exit nonzero
    labels_all = json.loads(corpus["labels_path"].read_text())
    partial = dict(list(labels_all.items())[:10])
    p = root / "labels-partial.json"
    p.write_text(json.dumps(partial))
    proc = run_tool("audit_leakage.py", "--manifest", deg / "degradation-manifest.json",
                    "--labels", p, "--root", deg, "--out", root / "audit-partial.json")
    suite.check("audit: partial label map rejected (missing both classes)",
                proc.returncode != 0, f"rc={proc.returncode}")

    # too few independent sources per class
    tiny = {"ai-g0/000.png": 1, "real-r0/000.png": 0}
    p = root / "labels-tiny.json"
    p.write_text(json.dumps(tiny))
    proc = run_tool("audit_leakage.py", "--manifest", deg / "degradation-manifest.json",
                    "--labels", p, "--root", deg, "--out", root / "audit-tiny.json")
    suite.check("audit: too-small minority class rejected",
                proc.returncode != 0, f"rc={proc.returncode}")

    # stale output_sha256 -> rejected
    stale = json.loads((deg / "degradation-manifest.json").read_text())
    stale["records"][0]["output_sha256"] = "f" * 64
    p = root / "manifest-stale.json"
    p.write_text(json.dumps(stale))
    proc = run_tool("audit_leakage.py", "--manifest", p, "--labels", corpus["labels_path"],
                    "--root", deg, "--out", root / "audit-stale.json")
    suite.check("audit: stale output_sha256 rejected", proc.returncode != 0,
                f"rc={proc.returncode} "
                f"{'stale output_sha256' in (proc.stdout + proc.stderr)}")

    # missing output file -> rejected
    missing = json.loads((deg / "degradation-manifest.json").read_text())
    missing["records"][0]["out"] = "does-not-exist/ghost.png"
    p = root / "manifest-missing.json"
    p.write_text(json.dumps(missing))
    proc = run_tool("audit_leakage.py", "--manifest", p, "--labels", corpus["labels_path"],
                    "--root", deg, "--out", root / "audit-missing.json")
    suite.check("audit: missing output file rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # golden artifact: schema + self-consistency + content hash
    audit = corpus["audit"]
    ok, detail = schema_check("audit artifact", audit, AUDIT_REQUIRED)
    suite.check("audit: artifact schema complete", ok, detail)
    ok, detail = schema_check("audit coverage", audit["coverage"], AUDIT_COVERAGE_REQUIRED)
    suite.check("audit: coverage schema complete", ok, detail)
    unsigned = {k: v for k, v in audit.items() if k != "contentSha256"}
    suite.check("audit: contentSha256 self-consistent",
                audit["contentSha256"] == canonical_sha256(unsigned))
    suite.check("audit: nullRocAuc is 0.5",
                audit["result"].get("nullRocAuc") == 0.5,
                str(audit["result"].get("nullRocAuc")))

    # tampered artifact must fail downstream consumers
    tampered = json.loads(json.dumps(audit))
    tampered["contentSha256"] = "f" * 64
    p = root / "audit-tampered.json"
    p.write_text(json.dumps(tampered))
    proc = run_tool("evaluate_scores.py", "--set", corpus["score_set"],
                    "--audit", p, "--config", root / "eval-config.json",
                    "--out", root / "eval-tampered.json", "--log", root / "log-tampered.jsonl")
    suite.check("evaluate: tampered audit contentSha256 rejected",
                proc.returncode != 0, f"rc={proc.returncode}")


# ---------------------------------------------------------------------------
# 3. altered manifests
# ---------------------------------------------------------------------------
def test_altered_manifests(suite: Suite, corpus: dict) -> None:
    suite.section("3. altered manifests")
    root: pathlib.Path = corpus["root"]

    # unknown src in degraded manifest -> prepare_degraded rejects
    bogus = {"records": [dict(corpus["manifest"]["records"][0])]}
    bogus["records"][0]["src"] = "ghost/not-in-index.png"
    p = root / "bogus-manifest.json"
    p.write_text(json.dumps(bogus))
    proc = run_tool("prepare_degraded_score_manifest.py",
                    "--index", corpus["index_path"], "--source-root", corpus["raw"],
                    "--degradation-manifest", p, "--degraded-root", corpus["deg"],
                    "--splits", corpus["splits_path"], "--out", root / "pdsm.csv")
    suite.check("manifest: unknown src rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # --assignment with unknown / missing / duplicate groups
    assignment = corpus["assignment"]
    groups = [f"ai-{i:03d}" for i in range(130)] + [f"real-{i:03d}" for i in range(130)]
    for label, bad in (
        ("unknown group", assignment + ",ghost=eval"),
        ("missing group", assignment.replace(",ai-129=eval", "")),
        ("duplicate group", assignment + ",ai-129=eval"),
    ):
        proc = run_tool("dedupe_and_split.py", "--index", corpus["index_path"],
                        "--root", corpus["raw"], "--out", root / "bad-splits.json",
                        "--assignment", bad)
        suite.check(f"split: {label} rejected", proc.returncode != 0, f"rc={proc.returncode}")

    # duplicate index entry (same path listed twice) must not crash; the
    # deduper drops the second copy as an exact duplicate
    dup_index = json.loads(corpus["index_path"].read_text()) + [dict(json.loads(corpus["index_path"].read_text())[0])]
    p = root / "dup-index.json"
    p.write_text(json.dumps(dup_index))
    proc = run_tool("dedupe_and_split.py", "--index", p, "--root", corpus["raw"],
                    "--out", root / "dup-splits.json", "--assignment", assignment)
    suite.check("split: duplicate index entry does not crash", proc.returncode == 0,
                f"rc={proc.returncode}")

    # quarantine: calibrate_score_csv refuses any score column other than the
    # shipped score_official_browser signal (native_browser is the rejected one)
    proc = run_tool("calibrate_score_csv.py", "--set", corpus["score_set"],
                    "--audit", corpus["audit_path"],
                    "--out", root / "q-out.csv", "--curve", root / "q-curve.json",
                    "--score-column", "score_native_browser")
    suite.check("calibrate: non-official score column quarantined",
                proc.returncode != 0, f"rc={proc.returncode}")


# ---------------------------------------------------------------------------
# 4. duplicate sources
# ---------------------------------------------------------------------------
def test_duplicate_sources(suite: Suite, corpus: dict) -> None:
    suite.section("4. duplicate sources")
    root: pathlib.Path = corpus["root"]
    score_set: pathlib.Path = corpus["score_set"]
    config = root / "eval-config.json"

    rows = list(csv.DictReader(score_set.open()))
    fields = list(rows[0].keys())

    # duplicate image_id
    dup = rows + [dict(rows[0])]
    p = root / "dup-id.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(dup)
    proc = run_tool("evaluate_scores.py", "--set", p, "--audit", corpus["audit_path"],
                    "--config", config, "--out", root / "eval-dup.json",
                    "--log", root / "log-dup.jsonl")
    suite.check("evaluate: duplicate image_id rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # cross-split phash duplicate (same phash in two splits)
    cross = [dict(r) for r in rows]
    # find two rows in different splits, force same phash
    splits = {}
    for r in cross:
        splits.setdefault(r["split"], []).append(r)
    r1 = splits["eval"][0]
    r2 = splits["calibration"][0]
    r2["phash"] = r1["phash"]
    p = root / "dup-phash.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(cross)
    proc = run_tool("evaluate_scores.py", "--set", p, "--audit", corpus["audit_path"],
                    "--config", config, "--out", root / "eval-phash.json",
                    "--log", root / "log-phash.jsonl")
    suite.check("evaluate: cross-split phash duplicate rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # generator crossing splits
    gen = [dict(r) for r in rows]
    gen[0]["split"] = "eval" if gen[0]["split"] == "fit" else "fit"
    p = root / "gen-cross.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(gen)
    proc = run_tool("evaluate_scores.py", "--set", p, "--audit", corpus["audit_path"],
                    "--config", config, "--out", root / "eval-gen.json",
                    "--log", root / "log-gen.jsonl")
    suite.check("evaluate: generator crossing splits rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # PATH-ALIAS LABEL CONFLICT: same physical output file under two textual src
    # variants with opposite labels. The audit canonicalizes source paths and
    # must reject the conflicting labels (gate closed by _canonical_source).
    alias = json.loads((corpus["deg"] / "degradation-manifest.json").read_text())
    base = alias["records"][0]
    alias["records"].append(dict(base))
    alias["records"][-1]["src"] = base["src"].replace("/", "//", 1)
    p = root / "alias-manifest.json"
    p.write_text(json.dumps(alias))
    labels_alias = json.loads(corpus["labels_path"].read_text())
    labels_alias[alias["records"][-1]["src"]] = 1 - labels_alias[base["src"]]
    lp = root / "labels-alias.json"
    lp.write_text(json.dumps(labels_alias))
    proc = run_tool("audit_leakage.py", "--manifest", p, "--labels", lp,
                    "--root", corpus["deg"], "--out", root / "alias-audit.json")
    suite.check("audit: path-alias label conflict rejected (canonicalized)",
                proc.returncode != 0,
                f"rc={proc.returncode} "
                f"{'alias' in (proc.stdout + proc.stderr).lower()}")

    # benign label map that only uses canonical keys must still pass the alias
    # pre-check (no false positive on a clean corpus)
    clean_proc = run_tool("audit_leakage.py", "--manifest", corpus["deg"] / "degradation-manifest.json",
                          "--labels", corpus["labels_path"], "--root", corpus["deg"],
                          "--out", root / "clean-audit.json")
    suite.check("audit: clean corpus unaffected by canonicalization",
                clean_proc.returncode == 0, f"rc={clean_proc.returncode}")


# ---------------------------------------------------------------------------
# 5. too-small classes
# ---------------------------------------------------------------------------
def test_too_small_classes(suite: Suite, corpus: dict) -> None:
    suite.section("5. too-small classes")
    root: pathlib.Path = corpus["root"]
    score_set: pathlib.Path = corpus["score_set"]
    config = root / "eval-config.json"

    rows = list(csv.DictReader(score_set.open()))
    fields = list(rows[0].keys())

    # single-class split
    single = [r for r in rows if r["label"] == "1"]
    p = root / "single-class.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(single)
    proc = run_tool("evaluate_scores.py", "--set", p, "--audit", corpus["audit_path"],
                    "--config", config, "--out", root / "eval-single.json",
                    "--log", root / "log-single.jsonl")
    suite.check("evaluate: single-class split rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # config gate minImagesPerClass above supply
    strict_config = json.loads(config.read_text())
    strict_config["gates"]["minImagesPerClass"] = 10_000
    p = root / "strict-config.json"
    p.write_text(json.dumps(strict_config))
    proc = run_tool("evaluate_scores.py", "--set", score_set, "--audit", corpus["audit_path"],
                    "--config", p, "--out", root / "eval-strict.json",
                    "--log", root / "log-strict.jsonl")
    suite.check("evaluate: minImagesPerClass gate enforced", proc.returncode != 0,
                f"rc={proc.returncode}")

    # audit min-sources-per-class gate
    proc = run_tool("audit_leakage.py", "--manifest", corpus["deg"] / "degradation-manifest.json",
                    "--labels", corpus["labels_path"], "--root", corpus["deg"],
                    "--out", root / "audit-min.json", "--min-sources-per-class", 10_000)
    suite.check("audit: min-sources-per-class gate enforced", proc.returncode != 0,
                f"rc={proc.returncode}")

    # constant scores -> calibration refuses to fit
    cal_rows = [r for r in rows if r["split"] == "calibration"]
    for r in cal_rows:
        r["score_official_browser"] = "0.5000000000"
    p = root / "const.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(cal_rows)
    proc = run_tool("calibrate_score_csv.py", "--set", p, "--audit", corpus["audit_path"],
                    "--out", root / "const-out.csv", "--curve", root / "const-curve.json")
    suite.check("calibrate: constant scores rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # calibration minimum-count gate
    thin_rows = [r for r in rows if r["split"] == "calibration"][:8]
    labels_present = {r["label"] for r in thin_rows}
    for r in rows:
        if r["split"] == "calibration" and len(thin_rows) < 12 and r["label"] not in labels_present:
            thin_rows.append(r)
            labels_present.add(r["label"])
    p = root / "thin-cal.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader(); w.writerows(thin_rows)
    proc = run_tool("calibrate_score_csv.py", "--set", p, "--audit", corpus["audit_path"],
                    "--out", root / "thin-out.csv", "--curve", root / "thin-curve.json",
                    "--min-calibration-images-per-class", 1000)
    suite.check("calibrate: min-calibration-images-per-class gate enforced",
                proc.returncode != 0, f"rc={proc.returncode}")


# ---------------------------------------------------------------------------
# 6. fit/calibration overlap (gate closed)
# ---------------------------------------------------------------------------
def test_overlap_gate(suite: Suite, corpus: dict) -> None:
    suite.section("6. fit/calibration overlap")
    root: pathlib.Path = corpus["root"]
    rng = np.random.default_rng(3)
    n = 80
    cal_s = np.load(corpus["cal_s_path"])
    cal_l = np.load(corpus["cal_l_path"])
    s_path = corpus["cal_s_path"]
    l_path = corpus["cal_l_path"]

    # same file for calibration and eval
    proc = run_tool("fit_calibration.py", "--scores", s_path, "--labels", l_path,
                    "--eval-scores", s_path, "--eval-labels", l_path,
                    "--id", "overlap", "--out", root / "ov.json")
    suite.check("fit: same file as cal+eval rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # distinct paths, identical content
    s2 = root / "cal_s_copy.npy"
    l2 = root / "cal_l_copy.npy"
    np.save(s2, cal_s)
    np.save(l2, cal_l)
    proc = run_tool("fit_calibration.py", "--scores", s_path, "--labels", l_path,
                    "--eval-scores", s2, "--eval-labels", l2,
                    "--id", "overlap2", "--out", root / "ov2.json")
    suite.check("fit: identical content as cal+eval rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # same split id
    proc = run_tool("fit_calibration.py", "--scores", s_path, "--labels", l_path,
                    "--eval-scores", s2, "--eval-labels", l2,
                    "--calibration-split-id", "x", "--eval-split-id", "x",
                    "--id", "overlap3", "--out", root / "ov3.json")
    suite.check("fit: same split id rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # calibrate_score_csv: same split name
    score_set: pathlib.Path = corpus["score_set"]
    proc = run_tool("calibrate_score_csv.py", "--set", score_set, "--audit", corpus["audit_path"],
                    "--out", root / "ov-out.csv", "--curve", root / "ov-curve.json",
                    "--calibration-split", "eval", "--eval-split", "eval")
    suite.check("calibrate: same split name rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # calibrate_score_csv: generator overlap across cal/eval selections
    rows = list(csv.DictReader(score_set.open()))
    gens = sorted({r["generator"] for r in rows if r["split"] == "calibration"})
    shared = gens[0]
    proc = run_tool("calibrate_score_csv.py", "--set", score_set, "--audit", corpus["audit_path"],
                    "--out", root / "ovg-out.csv", "--curve", root / "ovg-curve.json",
                    "--calibration-generators", f"{shared},ai-g0", "--eval-generators", shared)
    suite.check("calibrate: generator overlap across selections rejected",
                proc.returncode != 0, f"rc={proc.returncode}")

    # calibrate_score_csv: overlapping rows (same split name for both)
    proc = run_tool("calibrate_score_csv.py", "--set", score_set, "--audit", corpus["audit_path"],
                    "--out", root / "ovc-out.csv", "--curve", root / "ovc-curve.json",
                    "--calibration-split", "calibration", "--eval-split", "calibration")
    suite.check("calibrate: overlapping selections rejected", proc.returncode != 0,
                f"rc={proc.returncode}")

    # healthy fit still works (guard does not over-reject)
    healthy_rng = np.random.default_rng(99)  # different seed: content must differ
    ev_s = np.sort(healthy_rng.uniform(0.05, 0.95, n))
    ev_l = np.asarray([0] * (n // 2) + [1] * (n // 2))
    es = root / "ev_s.npy"; el = root / "ev_l.npy"
    np.save(es, ev_s)
    np.save(el, ev_l)
    proc = run_tool("fit_calibration.py", "--scores", s_path, "--labels", l_path,
                    "--eval-scores", es, "--eval-labels", el,
                    "--id", "healthy", "--out", root / "healthy.json")
    suite.check("fit: healthy disjoint fit still passes", proc.returncode == 0,
                f"rc={proc.returncode}")


# ---------------------------------------------------------------------------
# 7. modified eval logs
# ---------------------------------------------------------------------------
def test_eval_logs(suite: Suite, corpus: dict) -> None:
    suite.section("7. modified eval logs")
    root: pathlib.Path = corpus["root"]
    log_path = root / "chain.jsonl"

    sys.path.insert(0, str(HERE))
    from eval_common import append_hash_chained_log, canonical_sha256 as csha

    entries = []
    for i in range(3):
        entry = append_hash_chained_log(log_path, {
            "formatVersion": 1, "type": "evaluation-log-entry",
            "evaluationId": f"e{i}", "status": "pass",
        })
        entries.append(entry)
    lines = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]
    suite.check("log: chain linked", all(
        lines[i]["previousEntrySha256"] ==
        (lines[i - 1]["entrySha256"] if i else None)
        for i in range(len(lines))
    ))
    suite.check("log: entry self-hash valid", all(
        line["entrySha256"] == csha({k: v for k, v in line.items() if k != "entrySha256"})
        for line in lines
    ))

    # tamper the TAIL entry -> next append must refuse
    lines_out = [json.loads(l) for l in log_path.read_text().splitlines() if l.strip()]
    lines_out[-1]["status"] = "fail"  # content changed, hash now stale
    log_path.write_text("\n".join(json.dumps(l) for l in lines_out) + "\n")
    try:
        append_hash_chained_log(log_path, {"formatVersion": 1, "type": "x", "evaluationId": "e9"})
        suite.check("log: tampered tail refused on append", False, "append succeeded")
    except ValueError as exc:
        suite.check("log: tampered tail refused on append", "tail hash" in str(exc), str(exc))

    # tamper a MIDDLE entry -> tail hash still valid, append proceeds. Documented
    # property: the chain guards the tail, not historical integrity.
    mid = [json.loads(l) for l in log_path.read_text().splitlines() if l.strip()]
    mid[0]["evaluationId"] = "CHANGED"
    log_path.write_text("\n".join(json.dumps(l) for l in mid) + "\n")
    try:
        append_hash_chained_log(log_path, {"formatVersion": 1, "type": "x", "evaluationId": "e10"})
        suite.check("log: middle tamper caught by chain walk (gap)", False,
                    "append succeeded; mid-chain tampering is not detected by tail check")
    except ValueError:
        suite.check("log: middle tamper caught by chain walk", True)

    # report artifact schema + self-consistency from a golden run
    config = root / "eval-config.json"
    report_path = root / "report.json"
    log2 = root / "report.jsonl"
    proc = run_tool("evaluate_scores.py", "--set", corpus["score_set"],
                    "--audit", corpus["audit_path"], "--config", config,
                    "--out", report_path, "--log", log2)
    suite.check_run("evaluate: golden run rc=0", proc, 0)
    if proc.returncode == 0:
        report = json.loads(report_path.read_text())
        ok, detail = schema_check("evaluation report", report, EVAL_REPORT_REQUIRED)
        suite.check("report: schema complete", ok, detail)
        unsigned = {k: v for k, v in report.items() if k != "reportContentSha256"}
        suite.check("report: reportContentSha256 self-consistent",
                    report["reportContentSha256"] == csha(unsigned))
        suite.check("report: nullBaselines present",
                    report.get("nullBaselines", {}).get("alwaysReal", {}).get("balancedAccuracy") == 0.5)
        # the eval log entry should embed the report hash
        entry = json.loads(log2.read_text().splitlines()[0])
        suite.check("log: entry links report content hash",
                    entry.get("reportContentSha256") == report["reportContentSha256"])


# ---------------------------------------------------------------------------
# 8. INT8/FP32 independent reproduction (tiny ONNX model)
# ---------------------------------------------------------------------------
def test_int8_fp32(suite: Suite, tmp: pathlib.Path) -> None:
    suite.section("8. INT8/FP32 parity (tiny ONNX fixture)")
    try:
        import onnx
        import onnxruntime as ort
        from onnx import helper, numpy_helper, TensorProto
    except ImportError as exc:
        suite.check("int8/fp32: onnx stack available", False, str(exc))
        return

    # ---- tiny model: pixel_values (1,3,8,8) -> ReduceMean -> MatMul -> logit
    rng = np.random.default_rng(42)
    W = rng.normal(0, 0.5, size=(3, 1)).astype(np.float32)

    def build_model() -> bytes:
        node_reduce = helper.make_node("ReduceMean", ["pixel_values"], ["means"],
                                       axes=[2, 3], keepdims=0)
        node_matmul = helper.make_node("MatMul", ["means", "W"], ["fake_logit"])
        graph = helper.make_graph(
            [node_reduce, node_matmul],
            "tiny",
            [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 8, 8])],
            [helper.make_tensor_value_info("fake_logit", TensorProto.FLOAT, [1, 1])],
            [numpy_helper.from_array(W, name="W")],
        )
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
        model.ir_version = 8
        return model.SerializeToString()

    fp32_bytes = build_model()
    fp32_path = tmp / "tiny-fp32.onnx"
    fp32_path.write_bytes(fp32_bytes)
    int8_path = tmp / "tiny-int8.onnx"
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        quantize_dynamic(
            model_input=str(fp32_path), model_output=str(int8_path),
            per_channel=True, weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul"],
        )
    except Exception as exc:  # noqa: BLE001
        suite.check("int8/fp32: dynamic quantization ran", False, str(exc))
        return

    # ---- independent FP32 reference: mean over spatial dims then W^T x
    def numpy_fp32(x: np.ndarray) -> np.ndarray:
        means = x.mean(axis=(2, 3))  # (1,3)
        return means @ W  # (1,1)

    sessions = {
        "fp32": ort.InferenceSession(str(fp32_path), providers=["CPUExecutionProvider"]),
        "int8": ort.InferenceSession(str(int8_path), providers=["CPUExecutionProvider"]),
    }

    max_int8_error = 0.0
    max_fp32_error = 0.0
    disagreements = 0
    trials = 60
    for trial in range(trials):
        x = rng.uniform(0.0, 1.0, size=(1, 3, 8, 8)).astype(np.float32)
        expected = numpy_fp32(x)
        fp32_logit = float(np.asarray(sessions["fp32"].run(None, {"pixel_values": x})[0]).reshape(-1)[0])
        int8_logit = float(np.asarray(sessions["int8"].run(None, {"pixel_values": x})[0]).reshape(-1)[0])
        max_fp32_error = max(max_fp32_error, abs(fp32_logit - float(expected.reshape(-1)[0])))
        max_int8_error = max(max_int8_error, abs(int8_logit - fp32_logit))
        # sigmoid agreement at the 0.65 decision point (calibrated scores)
        sig = lambda z: 1.0 / (1.0 + math.exp(-z))
        if (sig(fp32_logit) >= DECISION_THRESHOLD) != (sig(int8_logit) >= DECISION_THRESHOLD):
            disagreements += 1

    suite.check("int8/fp32: fp32 ONNX matches independent numpy reference",
                max_fp32_error < 1e-4, f"max abs error {max_fp32_error:.3e}")
    suite.check("int8/fp32: int8 drift bounded (logit scale)",
                max_int8_error < 0.5, f"max abs int8 drift {max_int8_error:.3e}")
    suite.check("int8/fp32: decision agreement at 0.65",
                disagreements == 0, f"{disagreements}/{trials} trials disagreed")

    # ---- shipped export-metadata parity numbers are internally consistent
    metadata_path = ROOT / "models" / "weights" / "export-metadata.json"
    if metadata_path.exists():
        meta = json.loads(metadata_path.read_text())
        suite.check("int8/fp32: shipped fp32 abs error <= 1e-4",
                    meta["parity"]["fp32AbsError"] <= 1e-4,
                    f"{meta['parity']['fp32AbsError']:.3e}")
        suite.check("int8/fp32: shipped int8 abs error <= 0.5 guard",
                    meta["parity"]["int8AbsError"] <= 0.5,
                    f"{meta['parity']['int8AbsError']:.3e}")
        suite.check("int8/fp32: shipped model hashes match manifest",
                    meta["artifacts"]["int8"]["sha256"] ==
                    json.loads((ROOT / "models" / "manifest.json").read_text())
                    ["models"][0]["sha256"])
    else:
        suite.check("int8/fp32: export-metadata present", False, "missing models/weights/export-metadata.json")


# ---------------------------------------------------------------------------
# 9. null-baseline reproduction
# ---------------------------------------------------------------------------
def test_null_baseline(suite: Suite, corpus: dict) -> None:
    suite.section("9. null-baseline reproduction")
    root: pathlib.Path = corpus["root"]

    sys.path.insert(0, str(HERE))
    from eval_common import clustered_metrics

    def ba(labels, scores, thr=DECISION_THRESHOLD):
        pos = np.asarray(labels) == 1
        neg = ~pos
        tpr = float(np.mean(np.asarray(scores)[pos] >= thr))
        tnr = float(np.mean(np.asarray(scores)[neg] < thr))
        return (tpr + tnr) / 2, tpr, tnr

    def rows_for(scores, labels):
        return [
            {"label": int(l), "score": float(s), "cluster_id": f"c{i}",
             "image_id": f"i{i}"}
            for i, (s, l) in enumerate(zip(scores, labels, strict=True))
        ]

    rng = np.random.default_rng(9)
    labels = np.asarray([0] * 30 + [1] * 30)

    # null baseline 1: constant score below threshold -> always-real
    scores_const_low = np.full(60, 0.3)
    b, tpr, tnr = ba(labels, scores_const_low)
    suite.check("null: constant 0.3 -> BA exactly 0.5", abs(b - 0.5) < 1e-12,
                f"BA={b:.6f} tpr={tpr:.3f} tnr={tnr:.3f}")
    m = clustered_metrics(rows_for(scores_const_low, labels), threshold=DECISION_THRESHOLD)
    suite.check("null: clustered alwaysReal matches", m["balancedAccuracy"]["value"] == 0.5,
                f"{m['balancedAccuracy']['value']:.6f}")
    suite.check("null: nullBaselines.alwaysReal == 0.5",
                m["nullBaselines"]["alwaysReal"]["balancedAccuracy"] == 0.5)

    # null baseline 2: constant score above threshold -> always-AI
    scores_const_high = np.full(60, 0.9)
    b, tpr, tnr = ba(labels, scores_const_high)
    suite.check("null: constant 0.9 -> BA exactly 0.5", abs(b - 0.5) < 1e-12,
                f"BA={b:.6f} tpr={tpr:.3f} tnr={tnr:.3f}")
    m = clustered_metrics(rows_for(scores_const_high, labels), threshold=DECISION_THRESHOLD)
    suite.check("null: clustered alwaysAi matches", m["balancedAccuracy"]["value"] == 0.5,
                f"{m['balancedAccuracy']['value']:.6f}")
    suite.check("null: nullBaselines.alwaysAi == 0.5",
                m["nullBaselines"]["alwaysAi"]["balancedAccuracy"] == 0.5)

    # null baseline 3: random uniform scores -> expected BA 0.5. Use enough
    # rows that sampling noise cannot move the point estimate far.
    n_rand = 400
    labels_rand = np.asarray([0] * (n_rand // 2) + [1] * (n_rand // 2))
    scores_rand = rng.uniform(0.0, 1.0, size=n_rand)
    b, tpr, tnr = ba(labels_rand, scores_rand)
    # E[BA] = 0.5; sd of (tpr+tnr)/2 with n/2 per class is ~sqrt(0.35*0.65/(n/2))/2
    expected_sd = math.sqrt(0.35 * 0.65 / (n_rand / 2)) / 2
    suite.check("null: random scores within 3sd of 0.5",
                abs(b - 0.5) < 3 * expected_sd,
                f"BA={b:.4f}, expected 0.5 +/- {3 * expected_sd:.4f} (3sd, n={n_rand})")
    m = clustered_metrics(rows_for(scores_rand, labels_rand), threshold=DECISION_THRESHOLD,
                          bootstrap_samples=2000)
    suite.check("null: clustered CI brackets 0.5",
                m["balancedAccuracy"]["ciLower"] <= 0.5 <= m["balancedAccuracy"]["ciUpper"],
                f"CI [{m['balancedAccuracy']['ciLower']:.3f}, "
                f"{m['balancedAccuracy']['ciUpper']:.3f}]")
    suite.check("null: prevalenceRandom expected BA == 0.5",
                m["nullBaselines"]["prevalenceRandom"]["expectedBalancedAccuracy"] == 0.5)

    # null baseline 4: perfectly anti-correlated detector at a FIXED threshold
    # scores: AI -> 0.1 (below cut), real -> 0.9 (above cut). TPR=0, TNR=0,
    # so balanced accuracy is 0.0, not 0.5: inversion is a failure mode, not a
    # null baseline.
    scores_inverted = np.where(labels == 1, 0.1, 0.9)
    b, _, _ = ba(labels, scores_inverted)
    suite.check("null: inverted detector BA is 0.0 (anti-correlation fails)",
                abs(b) < 1e-12, f"BA={b:.6f}")

    # the report surface must expose nullBaselines
    config = root / "eval-config.json"
    report_path = root / "report.json"
    proc = run_tool("evaluate_scores.py", "--set", corpus["score_set"],
                    "--audit", corpus["audit_path"], "--config", config,
                    "--out", report_path, "--log", root / "report.jsonl")
    if proc.returncode == 0:
        report = json.loads(report_path.read_text())
        nb = report.get("nullBaselines", {})
        suite.check("report: nullBaselines.alwaysReal == 0.5",
                    nb.get("alwaysReal", {}).get("balancedAccuracy") == 0.5)
        suite.check("report: nullBaselines.alwaysAi == 0.5",
                    nb.get("alwaysAi", {}).get("balancedAccuracy") == 0.5)
        suite.check("report: nullBaselines.prevalenceRandom == 0.5",
                    nb.get("prevalenceRandom", {}).get("expectedBalancedAccuracy") == 0.5)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    suite = Suite()
    with tempfile.TemporaryDirectory(prefix="adversarial-fixtures-") as td:
        tmp = pathlib.Path(td)

        # corpus config (used by several sections)
        config = {
            "formatVersion": 1,
            "id": "synthetic-adversarial",
            "scenario": "unseen-generator",
            "split": "eval",
            "scoreColumn": "score",
            "threshold": 0.65,
            "expectedModelSha256": MODEL_HASH,
            "verifyImageFiles": True,
            "phashDistance": 0,
            "gates": {
                "minBalancedAccuracy": 0.5,
                "requireCiLowerBound": False,
                "minImagesPerClass": 8,
                "minClustersPerClass": 100,
                "minAuditCoverage": 1.0,
                "requiredDegradations": {},
            },
            "bootstrap": {"samples": 500, "confidence": 0.95, "seed": 7},
        }
        (tmp / "eval-config.json").write_text(json.dumps(config))

        corpus = build_golden_corpus(tmp)

        test_degradation_sweep(suite, tmp)
        test_audit_reports(suite, corpus)
        test_altered_manifests(suite, corpus)
        test_duplicate_sources(suite, corpus)
        test_too_small_classes(suite, corpus)
        test_overlap_gate(suite, corpus)
        test_eval_logs(suite, corpus)
        test_int8_fp32(suite, tmp)
        test_null_baseline(suite, corpus)

    total, failed, skipped = suite.summary()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
