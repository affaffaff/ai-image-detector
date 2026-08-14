# Privacy

**No image, hash, score, URL, or derived feature ever leaves your device.**

This is not a policy promise layered over a service — there is no service. The
extension has no backend, no analytics, no telemetry, no error reporting, and no
account. Every image is analyzed by a model running inside your own browser.

## What the extension does with data

| Data | Where it goes | Lifetime |
|---|---|---|
| Image pixels | Decoded in the extension's offscreen document, fed to the local model, released immediately | Never persisted |
| Image URLs | Used to fetch the image; kept in an in-memory/session cache so the same image is not rescanned | Cleared when the browser closes |
| Scores | Rendered as a badge; cached per session alongside the URL | Cleared when the browser closes |
| Settings (enabled toggle) | `chrome.storage.local` | Until you change or uninstall |
| Model weights | Downloaded once at setup, stored in OPFS | Until you uninstall |

Nothing above is transmitted anywhere.

## Network activity, exhaustively

The extension makes exactly two kinds of request, and you can verify both in
DevTools' Network panel:

1. **One-time model weight download at setup.** From a public host, verified
   against a SHA-256 pinned in [`models/manifest.json`](../models/manifest.json).
   This setup-only exception is part of the documented architecture. After it
   completes, the extension is fully functional with networking disabled.
2. **Image fetches.** To read pixels the extension must fetch the image — from
   the same origin the page already loaded it from. This adds no new party: that
   server already served you the image when the page rendered.

There is no third kind of *network* request, and no `fetch()` to any third party
in any scan path.

For completeness, since grepping the source will turn them up: the extension
also calls `fetch()` on its own bundled files via `chrome.runtime.getURL(...)` —
the model manifest and the calibration curves. Those resolve to
`chrome-extension://` URLs, are read from the installed extension on disk, and
never touch the network. They are how the extension reads its own resources,
not requests to anyone.

## Cookies on image requests

Image requests are sent with **`credentials: 'omit'`** — your cookies are *not*
attached.

This is a deliberate trade-off worth being explicit about, because the opposite
choice is easy to make silently. Sending cookies would let the extension read
auth-gated images (private albums, logged-in feeds) and score them. It would
also mean the extension issues credentialed requests to every image host you
encounter. We chose privacy: auth-gated images are simply reported as
unscannable rather than fetched with your session attached.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `host_permissions: <all_urls>` | To fetch image bytes for analysis. Cross-origin canvas access is tainted by the browser, so pixels cannot be read from the page directly. This grants **no** access to browsing history, form data, or page content beyond images |
| `offscreen` | WebGPU and the WASM runtime are unavailable in MV3 service workers; inference runs in an offscreen document |
| `storage` | Settings and the session scan cache |
| `unlimitedStorage` | The model weights exceed the default quota |

Notably absent: no `tabs`, no `history`, no `cookies`, no `webRequest`, no
`downloads`.

## Verifying these claims yourself

You do not have to take any of this on trust:

- Read the source. The entire scan path is a few hundred lines across
  [`src/content/`](../src/content/), [`src/background/`](../src/background/),
  and [`src/offscreen/`](../src/offscreen/).
- Search the tree for `fetch(`. Every occurrence is one of three things: the
  one-time weight download, an image fetch, or a `chrome-extension://` read of
  the extension's own bundled files.
- **Cut your internet connection** after the initial setup download and keep
  browsing. Detection continues to work, which is only possible because
  inference is genuinely local.
