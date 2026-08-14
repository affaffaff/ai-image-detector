# Live browser coverage

`tools/coverage_extension.mjs` exercises the extension on ordinary public web
pages through Chromium's DevTools Protocol. It measures the code paths that
decide real-world coverage:

- viewport-first `<img>` and CSS-background discovery, including open shadow
  roots and same-process frames;
- cross-origin image acquisition with `credentials: 'omit'` and
  `cache: 'force-cache'`;
- the streaming byte cap, image decode, service-worker routing, per-URL
  memoization, and badge completion;
- an actual visible badge placement, so a page-layering bug cannot pass merely
  because inference completed behind a hidden overlay;
- failure categories by CDN host, without retaining complete image URLs.

The dev mock is used only in place of the last ONNX call. This keeps a large
live-page run fast while leaving discovery, networking, decoding, and the rest
of the extension pipeline unchanged. Model correctness is measured separately
by the browser-native dataset scorer and ORT smoke test.

## Reproduce

Build and launch a fresh anonymous profile. On Windows PowerShell:

```powershell
npm.cmd run build:dev
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$dist = (Resolve-Path .\dist).Path
$profile = (Join-Path (Resolve-Path .\.cache).Path 'edge-coverage')
& $edge --headless=new --remote-debugging-port=9333 `
  --user-data-dir=$profile `
  --disable-extensions-except=$dist --load-extension=$dist about:blank
```

In another terminal:

```powershell
npm.cmd run coverage:browser -- --port 9333 --out .cache\live-coverage.json
```

Repeatable custom hosts can be supplied with one or more `--url` arguments:

```powershell
npm.cmd run coverage:browser -- --port 9333 `
  --url "Example=https://example.com/"
```

`AID_COVERAGE_TIMEOUT_MS` controls the per-page settle deadline and
`AID_COVERAGE_MAX_SCROLLS` controls the number of viewport stops.

## Baseline: 2026-08-13

Fresh profile, Edge 151.0.4129.78, 1365x900 viewport, five scroll stops, and a
30-second per-page deadline:

| Host | Tracked | Scored | Failed | Pending | Fetch/decode success |
|---|---:|---:|---:|---:|---:|
| Google Images | 217 | 217 | 0 | 0 | 100% |
| BBC News | 22 | 22 | 0 | 0 | 100% |
| The Guardian | 6 | 6 | 0 | 0 | 100% |
| Wikipedia | 17 | 17 | 0 | 0 | 100% |
| **Total** | **262** | **262** | **0** | **0** | **100%** |

The first Wikipedia pass exposed two SVG UI assets that Chromium could not
decode through `createImageBitmap`. SVG is not a meaningful raster-forensics
input, so candidate classification now rejects remote and data-URL SVGs before
they enter the serialized inference queue. The rerun above had no failures.

No tested public CDN required cookies for its scan-worthy raster assets. This
does not prove that all authenticated sites work: cookie-gated images are an
intentional privacy tradeoff and remain unscannable. The baseline does show no
reason to weaken `credentials: 'omit'` for normal anonymous browsing.
