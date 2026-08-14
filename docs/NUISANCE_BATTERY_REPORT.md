# Native-format nuisance battery

Run date: 2026-08-14. Verdict: **FAIL - release blocking.**

This is the retained public summary of the frozen native-format run. The local
JSON and score rows live under `data/matched/native-battery/` and are
gitignored because they contain corpus paths and per-image scores.

## Frozen contract

| Field | Value |
|---|---|
| Candidate | Community Forensics dynamic INT8, official-center preprocessing, fused calibration, threshold 0.65 |
| Model SHA-256 | `df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035` |
| Calibration SHA-256 | `671efd4e8c217db7700fc3ade810a28f6d1f3498a06be6d1fd76ce44a9417171` |
| FIT / evaluation images | 207 / 698 native sources |
| Evaluation clusters | 230 AI / 468 real |
| Bootstrap / permutation replicates | 10,000 / 10,000 |
| Multiplicity | Bonferroni across frozen probes B1-B5 |
| Freeze SHA-256 | `3074633815e3ec9cf49782d07fd3c61ea8b2b816504676789fecdf8e3387d8c5` |

## Detector and fitted-null result

| Metric | Result |
|---|---:|
| TPR at 0.65 | 0.8391, 95% clustered CI [0.7913, 0.8870] |
| TNR at 0.65 | 0.8910, 95% clustered CI [0.8611, 0.9188] |
| Balanced accuracy at 0.65 | 0.8651, 95% clustered CI [0.8369, 0.8922] |
| Strongest FIT-trained null | codec, BA 0.8889 |
| Detector minus strongest null | -0.0238, 95% clustered CI [-0.0602, 0.0105] |

The detector clears the absolute 0.75 accuracy floor, but it does not beat the
strongest FIT-trained nuisance null: the paired interval includes zero.

## Frozen cluster-label permutation gate

`p = (1 + count(null >= observed)) / (1 + 10000)`. Labels are permuted at the
source-cluster level. Corrected p-values are Bonferroni-adjusted across B1-B5.

| Probe | Oracle BA | Null median | Excess | Corrected p | Verdict |
|---|---:|---:|---:|---:|---|
| B1 log pixels | 0.9145 | 0.5312 | +0.3834 | 0.000500 | **fail** |
| B2 log bytes | 0.6969 | 0.5327 | +0.1642 | 0.000500 | **fail** |
| B3 log density | 0.8806 | 0.5328 | +0.3478 | 0.000500 | **fail** |
| B4 spectral ratio | 0.5704 | 0.5326 | +0.0377 | 0.015498 | warn |
| B5 blockiness | 0.7854 | 0.5326 | +0.2528 | 0.000500 | **fail** |

The corpus therefore fails the frozen contamination rule independently of the
detector-minus-null failure. Dimensions, encoding, density, and JPEG structure
remain class-correlated in the native source pack.

## Evidence hashes

| Artifact | SHA-256 |
|---|---|
| Resolved config | `b8e245222151aa94c526c3d8dfecd07efe8c8ceb37a88ce1117b10e8a14e6c5c` |
| Corpus membership | `bfcc083b9207751c781448b1cea06677325f3a8c23b713efeace8e650287117d` |
| Split JSON | `14d027b659a70b8d8d64e3a287c1867189fe4cdfebd595935dc8afa12e96b514` |
| Native score rows | `ad54344542cb062c31cd26aee698c4383064c294935cd475228fd422508e7f73` |
| Final JSON report file | `789f729b16a9f69643187cabddedfc4ca5647dc318406f97ef51462565f0cd74` |

This result must not be converted into a pass by changing the threshold,
dropping probes, canonicalizing only one class, or substituting the degraded
web-realistic evaluation. A new native corpus must remove the measured class
shortcuts under the same frozen protocol before the curve can be validated.
