# C2PA override and audit artifact — threat model

Two adversaries, deliberately in one document because they are defended
differently. The first wants a specific image misclassified. The second is us,
under deadline pressure, and the defense is evidence a reviewer can check.

---

# Part 1 — The C2PA override path

## Current behaviour

`src/fusion/fuse.js:102`:

```js
const override = signals.find((s) => s.override);
if (override) {
  const p = clampProb(override.overrideP ?? 1 - PROB_EPS);
  return { probability: p, isAI: p >= DECISION_THRESHOLD, … , path: 'override' };
}
```

A valid manifest short-circuits fusion in **either direction**, with unbounded
authority. Five defects are visible in those four lines before any attacker
appears:

| # | Defect |
|---|---|
| D1 | No check that the overriding signal **is** the provenance signal. Any signal object with `override: true` short-circuits. The typedef says "C2PA only"; nothing enforces it. |
| D2 | `find` takes the **first in array order**. Two conflicting manifests are resolved by array position. |
| D3 | `overrideP ?? 1 - PROB_EPS` — an override with a **missing** probability defaults to *AI at full confidence*. A malformed override should produce no override, not a maximal verdict. |
| D4 | No verification receipt is required. The boolean *is* the trust decision; nothing in the type system distinguishes "cryptographically verified" from "someone set a flag". |
| D5 | Fusion is not computed on the override path, so override/detector **disagreement is unmeasurable**. A systematic C2PA-based evasion would be invisible in every eval we run. |

**These are decisions, not oversights.** `test/fusion/fuse.test.js:77` asserts
"a camera-capture attestation overrides toward real" and `:90` asserts "defaults
to near-certain AI when overrideP omitted" — D3 and the bidirectional override
are deliberate and covered. Adopting the policy below means *changing two
passing tests*, which is the correct signal that this is a design argument to be
won on the merits, not a bug to be quietly patched.

## Adversary

Motivated, technically capable, wants one image to pass. Not a nation-state; the
relevant question is cost, and every attack below is cheap.

## Attack catalog

### A1 — Forged capture claim (dominant threat)

Generate an AI image, attach a **validly signed** manifest asserting camera
capture. Routes, in ascending cost:

- **Analog hole.** Display the AI image on a good monitor, photograph it with a
  C2PA-signing camera. The resulting manifest is *genuinely valid and truthful*:
  it attests a real capture. Of a screen. No cryptography is broken and no
  policy can detect it from the manifest.
- Obtain a signing certificate that chains to any authority on the trust list.
- Use a leaked or compromised signer key.

**Payoff: total.** The detector never runs. **Cost: low.** This is the attack the
override path exists to enable, and it is entirely one-sided — an attacker is
motivated to forge "I am a camera capture" and has no reason whatsoever to forge
"I am AI-generated".

### A2 — Strip and go

Remove the manifest. The override goes inactive and the detector runs normally.
Not a break — but note what it means for expected value: essentially all web
images have stripped or broken manifests, so the override's expected accuracy
contribution is near zero, while its worst-case cost (A1) is a total bypass.
**We are accepting an unbounded downside for a benefit that rounds to zero.**

### A3 — False AI attribution

Attach a validly signed manifest asserting `trainedAlgorithmicMedia` to a
genuine photograph, to have it flagged and suppressed. Cheaper than A1 because
the claim need not be *plausible*, only valid. Currently succeeds.

### A4 — Content-binding mismatch

Copy a valid manifest from image X onto image Y. Defeated **only** if the hard
binding is verified against the exact bytes fetched — not the decoded pixels,
not a re-encode. Related: a manifest whose hard binding covers a pre-delivery
version while the CDN served a re-encode is *invalid*, and must be treated as
absent rather than as evidence.

### A5 — Revocation is unenforceable offline

The no-network invariant forbids OCSP and CRL at scan time. **A revoked or
compromised signer stays trusted until the extension ships a new trust list.**
This is not a bug to fix; it is a permanent property of the architecture and
must be stated in the policy: ship a pinned trust list with explicit
`validFrom`/`validUntil`, and treat anything signed outside that window as
*unverified*, never as *valid*.

### A6 — No trusted clock

Certificate expiry can only be checked against a trusted timestamp token. Absent
one, expiry is advisory. Do not fail closed on expiry alone (it would make the
override flap with the host clock); do not treat a long-expired cert as valid.

### A7 — Parser attack surface

Manifests are CBOR inside JUMBF inside an image container, parsed from fully
attacker-controlled bytes inside the offscreen document. A parser bug here is the
most severe issue in this document — it is memory-safety in the extension's
privileged context, and no accuracy consideration compares. Requires: a
memory-safe parser, hard caps on manifest size, box depth, and box count, and a
wall-clock parse budget.

### A8 — Internal override spoofing

Given D1 and D4, anything that can put a signal object into the fusion input can
bypass detection: a future adapter with a bug, or a poisoned record rehydrated
from `chrome.storage.session`. The override is the highest-authority path in the
system and currently has the weakest type contract.

### A9 — Conflict resolution

Two manifests, or a manifest plus a future override source, disagreeing.
Currently array order wins silently.

## Proposed policy

**The override becomes asymmetric.** This is the substantive recommendation:

- A verified `trainedAlgorithmicMedia` assertion **may** short-circuit to AI.
  Forging this has no attacker payoff (A3 is the exception and is bounded by
  requiring full verification).
- A verified capture assertion **may not** short-circuit to real. It contributes
  a normal, weight-capped negative log-odds term so a confident detector can
  still outvote it. The cap `|contribution| ≤ 2 bits` is a placeholder, not a
  derived value — it should be fitted from measured LLR quality on a corpus
  containing genuine signed captures, the same way every other signal weight is
  fitted. Until that corpus exists, any number here is a guess, and it should be
  labelled one in the code.

Rationale: the two directions have opposite risk profiles, and the current design
grants unbounded authority to precisely the direction an adversary is paid to
forge. Under the asymmetric policy, A1 degrades from *total bypass* to *bounded
nudge*, and the analog-hole attack — which no cryptographic check can catch —
stops being a complete defeat.

> **This contradicts a stated invariant** ("a valid C2PA manifest short-circuits
> fusion... it never votes"). Check it against `notes/bounty-rules-and-combos.md`
> before adopting: if the rules mandate honoring C2PA symmetrically, the policy
> stands as written and the residual risk is accepted and documented instead.
> This is a decision, not a defect to fix silently.

### Verification preconditions (all required for any override)

1. Signature verifies.
2. Certificate chains to the **pinned** trust list, within its validity window.
3. Hard binding verifies against the **exact fetched bytes**.
4. Exactly one manifest applies; **any conflict ⇒ no override**, fall through to
   fusion, record the conflict.
5. Parser limits respected; a limit breach is a parse failure, not a soft pass.
6. Assertion type explicitly recognized. An unrecognized `digitalSourceType` is
   *no override*, never a default.

Failing any precondition means **the manifest is absent**. It never means "real",
and it never means "AI".

### Implementation hardening

- Require `signal.name === 'provenance'` **and** a verification receipt object
  carrying the checks above. Remove the bare boolean.
- Remove the `?? 1 - PROB_EPS` default — a missing `overrideP` is a programming
  error and should throw, not resolve to maximum confidence.
- Replace `find` with: collect all overrides, and if more than one, drop to
  fusion and record.
- Replace `bits: Infinity` with a sentinel the UI can render.
- **Compute the fusion result even when overriding**, at least under an eval
  flag, and record both. D5 is why we would not notice an evasion campaign; it is
  also how the C2PA path earns a row in the three-number report.

### Test fixtures required

Valid AI-assertion manifest; valid capture manifest; **manifest lifted from
another asset** (A4); manifest valid but re-encoded after signing; expired cert;
cert outside the pinned list; revoked-but-unrevokable signer (A5); two
conflicting manifests; truncated and depth-bomb CBOR (A7); a signal object with
`override: true` and no receipt (A8). Every one asserts *no override*, except the
first two, which assert the asymmetric policy.

---

# Part 2 — Audit artifact threat model

## Adversary

Us, at 2 a.m., wanting the number to be higher. Not malicious — subject to
ordinary selective-reporting pressure, which has already produced one 0.86
headline that was the maximum of seven attempts.

Assets: the eval log, the corpus, the config, the reported number, and the
reviewer's ability to check any of it.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Rerun until good, delete the losing entries | Hash-chained entries; commit the chain head after every eval so a truncation is visible as a chain that does not extend a published head |
| T2 | Corpus swapped under a stable name | `corpusHash` = hash over sorted (member sha256, label, cluster, split) in every entry |
| T3 | Config or code drift between runs | `configHash` + git commit + `worktreeDirty`; refuse to emit a report from a dirty worktree without an explicit flag that is recorded in the entry |
| T4 | Curve fitted on a different scoring path than the one measured | Entry embeds model sha256, curve sha256, and `fittedOn`; evaluator asserts `curve.scorePath == runtime aggregation` (this already happened once) |
| T5 | Splits reassigned after seeing results | `splitsHash` in every entry; a changed splits file starts a visibly new lineage rather than continuing the old one |
| T6 | Selective reporting across lineages | Every report states the **count of prior eval entries for the same `corpusHash`**. A number that is the seventh attempt says so on its face |
| T7 | Entry reordering via clock manipulation | Order by monotonic sequence number; timestamps advisory only |

## Residual risk — stated plainly

Every mitigation above is **detectable-by-a-diligent-reviewer, not prevented**.
A local append-only log with a hash chain does not survive an adversary who
deletes the whole file and starts over; it only makes deletion *visible* to
someone who already holds an earlier head. That is the honest limit, and it
matches the assessment already in the plan.

The cheap strong version, given the constraint that this repo is not pushed
until publication: **commit the chain head into git at each eval.** Git history
is then the notarization, and at publication the whole chain becomes externally
verifiable with no additional infrastructure — the reviewer can check that the
head committed alongside the submission extends the heads committed weeks
earlier. External WORM or timestamp notarization buys little beyond that here.

One caveat worth internalizing: the artifact proves *what was run*, not *that the
number is right*. A perfectly chained log of runs against a contaminated corpus
is a rigorous record of a meaningless measurement. The chain is necessary and
nowhere near sufficient — which is why the corpus gate in `docs/eval-protocol.md`
sits upstream of it.
