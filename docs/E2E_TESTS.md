# Extension end-to-end tests

`tools/smoke_extension.mjs` drives a real Chromium extension through the
DevTools Protocol. It injects a 384px image into a normal HTTPS page and checks
the complete path from discovery to the isolated overlay badge.

The smoke test also calls the inference host directly and verifies that the
page badge matches the shipped calibration curve. For memoizable HTTP(S)
fixtures it compares the stored probability to within `1e-6`; for inline
fixtures, which are intentionally excluded from session storage, it compares
the visible rounded badge to the calibrated direct result.

## Completed matrix

Edge 151.0.4129.78, fresh profile per mode, 2026-08-13:

| Build | Expected engine | Result | Assertions covered |
|---|---|---|---|
| Release, model URL absent | `no-model` | Pass | `not-configured` status, inference returns `no-model`, setup-required badge, one isolated overlay |
| Development | `mock` | Pass | deterministic mock inference, explicit `engine: mock`, calibrated scored badge, session memo, one isolated overlay |
| Local-model verification | `ort` | Pass | real ORT Web WASM inference, calibrated scored badge, session memo, one isolated overlay |

The mock implementation is compiled out of the release build. It exists only
to test pipeline behavior without running the model and is labeled as mock in
every result.

## Running a mode

Build one of the three variants:

```powershell
npm.cmd run build                 # no-model while the public URL is absent
npm.cmd run build:dev             # mock
npm.cmd run build:local-model     # real ORT
```

Launch `dist/` in a fresh Chromium profile with a debugging port, then run:

```powershell
$env:AID_CDP_PORT = '9333'
$env:AID_EXPECT_MODE = 'no-model' # or mock / ort
node tools\smoke_extension.mjs
```

Each mode must use the matching build and a fresh profile so an OPFS model or
cached setting from another test cannot change the result.
