"""False-positive report: human-made graphics vs the shipped detector.

Reads data/nuisance-graphics/scored-int8-official-center.csv (produced by
tools/score_dataset.py with the pinned INT8 artifact, official_center
strategy), applies the shipped fused.json calibration, and measures how often
human-authored graphics cross the 0.65 release threshold.
"""
import csv
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(sys.executable).parent.parent.parent))
from daimon_runtime import setup_plot

import numpy as np
import pandas as pd
import seaborn as sns
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "graphics-fp"
DATA = ROOT / "data" / "nuisance-graphics"
OUT.mkdir(parents=True, exist_ok=True)
TH = 0.65

cal = json.loads((ROOT / "models" / "calibration" / "fused.json").read_text())
xs, ys = np.array(cal["xs"]), np.array(cal["ys"])

rows = list(csv.DictReader((DATA / "scored-int8-official-center.csv").open()))
recs = []
for r in rows:
    raw = float(r["score_official_center"])
    calib = float(np.interp(raw, xs, ys))
    recs.append({
        "image_id": r["image_id"],
        "category": r["generator"].replace("human-graphic-", ""),
        "degradation": {"thumbnail_jpeg": "thumbnail"}.get(r["degradation"], r["degradation"]),
        "cluster_id": r["cluster_id"],
        "raw": raw,
        "calibrated": calib,
        "fp": calib >= TH,
    })
df = pd.DataFrame(recs)

# ---- summary tables -------------------------------------------------------
piv = df.pivot_table(index="category", columns="degradation", values="fp", aggfunc="mean")
piv = piv[["clean", "jpeg", "thumbnail"]]
piv["overall"] = df.groupby("category")["fp"].mean()

# cluster level: a source graphic is an FP if ANY of its 3 renditions flags
clu = df.groupby(["category", "cluster_id"])["fp"].any().reset_index()
cluster_rate = clu.groupby("category")["fp"].mean()

overall_fp = df["fp"].mean()
summary = {
    "threshold": TH,
    "images": len(df),
    "false_positives": int(df["fp"].sum()),
    "fp_rate_overall": round(overall_fp, 4),
    "fp_rate_by_degradation": df.groupby("degradation")["fp"].mean().round(4).to_dict(),
    "fp_rate_by_category_overall": df.groupby("category")["fp"].mean().round(4).to_dict(),
    "cluster_level_fp_rate": cluster_rate.round(4).to_dict(),
    "reference_photographic_tnr": 0.9396,
    "model_sha256": cal["modelSha256"],
    "calibration_id": cal["id"],
}
(DATA / "summary.json").write_text(json.dumps(summary, indent=2))
df[df["fp"]].sort_values("calibrated", ascending=False).to_csv(DATA / "false-positives.csv", index=False)
df.to_csv(DATA / "scored-calibrated.csv", index=False)

# ---- chart 1: FP-rate heatmap --------------------------------------------
setup_plot()
fig, ax = plt.subplots(figsize=(8, 5.2))
sns.heatmap(piv * 100, annot=True, fmt=".0f", cmap="Reds", vmin=0, vmax=100,
            cbar_kws={"label": "false-positive rate (%)"}, ax=ax, linewidths=0.5)
ax.set_title(f"Human-made graphics flagged as AI at the 0.65 threshold\n"
             f"({int(df['fp'].sum())}/{len(df)} images = {overall_fp:.0%} overall — "
             f"vs 6.0% FP on the photographic eval set)")
ax.set_xlabel("image rendition")
ax.set_ylabel("")
fig.savefig(OUT / "fp-rate-heatmap.png", dpi=200, bbox_inches="tight")
plt.close(fig)

# ---- chart 2: calibrated score distribution -------------------------------
fig, ax = plt.subplots(figsize=(9, 5))
order = ["clean", "jpeg", "thumbnail"]
sns.stripplot(data=df, x="degradation", y="calibrated", order=order,
              hue="fp", palette={False: "#4C72B0", True: "#C44E52"},
              size=4, alpha=0.75, jitter=0.25, ax=ax)
ax.axhline(TH, color="#C44E52", ls="--", lw=1.5)
ax.text(2.42, TH + 0.02, "release threshold 0.65", color="#C44E52", ha="right")
ax.set_title("Calibrated AI-probability scores for 540 human-made graphics")
ax.set_xlabel("image rendition")
ax.set_ylabel("calibrated P(AI)")
ax.legend(title="flagged as AI", loc="upper right")
fig.savefig(OUT / "score-distribution.png", dpi=200, bbox_inches="tight")
plt.close(fig)

print(json.dumps(summary, indent=2))

# ---- gate evaluation ------------------------------------------------------
# Shipped thresholds from src/shared/graphic-gate.js (NOT the sweep-chosen
# set recorded in data/matched/graphic-gate-sweep.json — the frozen constants
# are what runs in the extension).
GT = dict(minFlat=0.7, maxSoft=0.18, minHard=0.0005, minTop8=0.68,
          maxPatchSoft=0.16, minPixels=1024)
CAP = 0.35


def gate_fires(r):
    return (int(float(r["graphic_pixels"])) >= GT["minPixels"]
            and float(r["graphic_flat"]) >= GT["minFlat"]
            and float(r["graphic_soft"]) <= GT["maxSoft"]
            and float(r["graphic_hard"]) >= GT["minHard"]
            and float(r["graphic_top8"]) >= GT["minTop8"]
            and float(r["graphic_maxpatchsoft"]) <= GT["maxPatchSoft"])


gstats = {r["image_id"]: r for r in csv.DictReader((DATA / "stats.csv").open(encoding="utf-8-sig"))}
df["gated"] = df["image_id"].map(lambda i: gate_fires(gstats[i]))
df["fp_after_gate"] = df["fp"] & ~df["gated"]

rescued = df[df["fp"] & df["gated"]]
per_cat = (df[df["fp"]].groupby("category")
           .agg(fps=("fp", "size"), rescued=("gated", "sum")))
per_cat["rescue_rate"] = per_cat["rescued"] / per_cat["fps"]

# held-out photographic/AI eval: replay the verdict with and without the cap
ev = list(csv.DictReader((ROOT / "data" / "matched" / "gate-eval-stats.csv").open(encoding="utf-8-sig")))


def eval_metrics(rows, use_gate):
    tp = fn = tn = fpn = 0
    for r in rows:
        s = float(r["score_official_calibrated"])
        if use_gate and gate_fires(r):
            s = min(s, CAP)
        pred, lab = s >= TH, r["label"] == "1"
        tp += pred and lab
        fn += (not pred) and lab
        fpn += pred and (not lab)
        tn += (not pred) and (not lab)
    tpr, tnr = tp / (tp + fn), tn / (tn + fpn)
    return {"tpr": round(tpr, 4), "tnr": round(tnr, 4), "ba": round((tpr + tnr) / 2, 4)}


ai_rows = [r for r in ev if r["label"] == "1"]
real_rows = [r for r in ev if r["label"] == "0"]
ai_fires = [r for r in ai_rows if gate_fires(r)]
real_fires = [r for r in real_rows if gate_fires(r)]
gate_summary = {
    "thresholds": GT, "cap": CAP,
    "graphics_fired": int(df["gated"].sum()), "graphics_total": len(df),
    "fp_rescued": int(len(rescued)), "fp_total": int(df["fp"].sum()),
    "fp_rescue_rate": round(len(rescued) / df["fp"].sum(), 4),
    "fp_rescue_by_category": {c: {"fps": int(r["fps"]), "rescued": int(r["rescued"]),
                                  "rate": round(r["rescue_rate"], 4)}
                              for c, r in per_cat.iterrows()},
    "graphics_fp_rate_after_gate": round(df["fp_after_gate"].mean(), 4),
    "eval_metrics_detector_only": eval_metrics(ev, False),
    "eval_metrics_with_gate": eval_metrics(ev, True),
    "eval_gate_fires_ai": f"{len(ai_fires)}/{len(ai_rows)}",
    "eval_gate_fires_real": f"{len(real_fires)}/{len(real_rows)}",
    "eval_ai_true_positives_lost": sum(float(r["score_official_calibrated"]) >= TH for r in ai_fires),
    "eval_real_false_positives_rescued": sum(float(r["score_official_calibrated"]) >= TH for r in real_fires),
}
summary["gate"] = gate_summary
(DATA / "summary.json").write_text(json.dumps(summary, indent=2))
df.to_csv(DATA / "scored-calibrated.csv", index=False)
df[df["fp"]].sort_values("calibrated", ascending=False).to_csv(DATA / "false-positives.csv", index=False)

# ---- chart 3: FP rate before vs after the gate ----------------------------
before = df.groupby("category")["fp"].mean()
after = df.groupby("category")["fp_after_gate"].mean()
ba_df = pd.DataFrame({"category": before.index,
                      "detector only": before.values,
                      "detector + gate": after.values}).melt(
    "category", var_name="pipeline", value_name="fp_rate")
fig, ax = plt.subplots(figsize=(9, 4.8))
sns.barplot(data=ba_df, x="category", y="fp_rate", hue="pipeline",
            palette={"detector only": "#C44E52", "detector + gate": "#4C72B0"}, ax=ax)
for container in ax.containers:
    ax.bar_label(container, padding=2,
                 labels=[f"{v.get_height() * 100:.0f}%" for v in container])
ax.set_title("Graphics false-positive rate before vs after the graphic-content gate\n"
             f"overall: {df['fp'].mean():.0%} → {df['fp_after_gate'].mean():.0%} "
             f"({len(rescued)}/{int(df['fp'].sum())} FPs rescued; held-out eval BA "
             f"{gate_summary['eval_metrics_detector_only']['ba']:.4f} → "
             f"{gate_summary['eval_metrics_with_gate']['ba']:.4f})")
ax.set_ylabel("FP rate @ 0.65")
ax.set_xlabel("")
ax.set_ylim(0, max(before.max() * 1.15, 0.1))
plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
fig.savefig(OUT / "gate-before-after.png", dpi=200, bbox_inches="tight")
plt.close(fig)

print(json.dumps(gate_summary, indent=2))
print("artifacts written to", OUT)
