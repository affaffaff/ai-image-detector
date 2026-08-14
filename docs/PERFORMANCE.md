# Badge latency requirement

Speed is a product requirement, not an optional optimization.

## Acceptance gate

For a fresh browser profile running the local real-model build, the first
visible 384×384 raster image must receive a scored badge within **5,000 ms** of
the image `load` event.

The measurement includes the user-visible cold path after the image becomes
available:

- service-worker and offscreen-document startup;
- bundled-model verification, OPFS installation/read, and ORT initialization;
- image acquisition, decode, preprocessing, inference, and calibration;
- badge creation and exposure in Chromium's accessibility tree.

Browser process launch and page navigation occur before the timed interval and
are excluded. The fixture is an inline 384×384 PNG, so CDN and internet latency
cannot disguise a detector regression.

`tools/smoke_extension.mjs` owns the fixed 5,000 ms boundary. The limit has no
environment-variable override: a slower real-ORT run fails. Mock and no-model
modes still report timing for diagnostics but cannot satisfy this requirement.

## Current evidence

On 2026-08-14, a fresh-profile run on Edge 151.0.4129.78 produced its first
real-ORT badge in **4,402.1 ms**. The subsequent direct inference took
808.1 ms. The browser test also verified the pinned model SHA-256, calibrated
score, and rendered badge.

This is a regression boundary for the recorded browser test environment, not a
claim that every device or network will have identical latency. Changes that
affect startup, scheduling, preprocessing, inference, or rendering must rerun
the real-ORT smoke test and remain below the fixed ceiling.
