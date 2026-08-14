# Publishing the pinned ONNX artifact

The setup path is ready, but production publication requires an account-owned
public host and explicit authorization to upload there.

> [!IMPORTANT]
> Publication is currently blocked before hosting: the frozen native-format
> nuisance battery fails. `models[0].url` must remain null and the curve must
> remain quarantined until a new native corpus passes the unchanged protocol in
> `NUISANCE_BATTERY_REPORT.md`.

The only acceptable artifact is:

| Field | Value |
|---|---|
| Path | `models/weights/community-forensics-384-int8.onnx` |
| Bytes | `23,967,155` |
| SHA-256 | `df1aade56566b892178154793bfa95cf5808339d77593ec8137e7c5e306f2035` |
| Weight license | MIT |
| Base-model license | Apache-2.0 |

Use an immutable public release asset or model-repository revision. After the
upload, set `models[0].url` in `models/manifest.json` to a direct-download URL;
then run `npm run assert:shipping`. The assertion refuses a public URL while
the calibration curve is quarantined, lacks passing leakage audits/split
hashes, fails the fixed-0.65 accuracy gate, lacks owner-approved provenance or
passing INT8 evidence, or lacks a passing frozen native nuisance battery. Do
not change the pinned byte length or digest.

Publication is complete only after all of these checks pass:

1. Download the URL into a new file and verify its byte length and SHA-256.
2. Build the normal release with `npm ci && npm run build`.
3. Load `dist/` in a fresh browser profile and let automatic setup finish.
4. Confirm the popup reaches `ready` and the installed OPFS file verifies.
5. Disable networking and complete an ORT scan with `tools/smoke_extension.mjs`.
6. Reopen the browser while offline and confirm scanning still works without a
   second download.

Do not use a mutable branch/raw URL, a page URL that returns HTML, or a host
that requires authentication. Repository policy also forbids Codex from adding
a Git remote or pushing; the owner must choose the host and authorize the
upload explicitly.
