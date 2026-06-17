# Same-Name Identity Disambiguation & Self-Identity Resolution

**Date:** 2026-06-17
**Status:** Design — pending plan

## Problem

Multiple people in a user's graph share a name. The account owner is "Marcel
Samyn" (appears as "Marcel"), and contacts include "Marcel Szenessy" and
"Marcel Claus". When a WhatsApp conversation was ingested, the user's **own
first-person statements were attributed to a different "Marcel" node** instead
of to the user.

The same class of bug applies generally: any two same-named people (e.g. two
friends named "Sarah") can be conflated, and a bare-first-name mention can be
routed to the wrong node. The fix must be **general** (same-name
disambiguation for anyone), with the user's own identity handled as a
first-class case — but *not* via a blunt "when unsure, assume it's the user"
heuristic, which is itself a cause of mis-merges.

## Root-cause analysis (code-grounded)

The reported failure ("my words went to another Marcel") is produced by three
compounding gaps, traced through the transcript ingestion path
(`POST /ingest/transcript` → `ingestTranscript` → `extractGraph`):

1. **The speaker map carries provenance, not subject.** `speakerMap` is
   consumed only by `_resolveAssertedByKind` / `_resolveTranscriptProvenance`
   to set *who asserted* a claim (`src/lib/extract-graph.ts:1352`). It is
   never registered into `idMap`. So when the user-self speaker says "I'm
   flying to Lisbon", nothing tells the LLM to make the user the **subject** —
   it mints a fresh `temp_person` labelled "Marcel".

2. **The user-self node is invisible to name matching.** It is created with
   `label = userId` and `canonicalLabel = normalizeLabel(userId)`
   (`src/lib/transcript/resolve-speakers.ts:250`). `setUserSelfAliases` only
   writes `user_profiles.metadata.userSelfAliases`
   (`src/lib/user-profile.ts:50`) — it never names the node nor seeds the alias
   table. In the prompt context the self node shows up as a cryptic id-string
   the LLM won't recognise as "you".

3. **The resolver breaks same-name ties arbitrarily.** At extraction time
   `resolveIdentity` runs with no embedding and no claim profile
   (`src/lib/extract-graph.ts:932`), so only Signal 1 (canonical label) and
   Signal 2 (alias) can fire — both exact-match, both score `1.0`. On multiple
   matches the winner is `candidates[0]` with **no tie-break and no
   self-preference** (`src/lib/identity-resolution.ts:172`,
   `src/lib/identity-resolution.ts:662`). The minted "Marcel" therefore lands
   on whichever Person node Postgres returns first — frequently a different
   Marcel. Signal 1 even short-circuits the one correct path: the
   `"marcel" → self` alias that `resolveSpeakers` opportunistically wrote
   (`src/lib/transcript/resolve-speakers.ts:119`).

WhatsApp specifics (from `~/code/whatsapp-memory`): the user's own messages are
labelled with `SELF_ALIASES[0]` = `"Marcel"` and the payload sets
`userSelfAliasesOverride = ["Marcel", "Marcel Samyn"]`
(`src/transcripts.ts:62`, `:74`). Other people use their WhatsApp/contact name.
So self-speaker resolution itself works (it matches the `userSelfAliases`
config set directly, `resolve-speakers.ts:114`); the failure is purely in
subject assignment + ambiguous name resolution downstream.

> Note: this diagnosis is derived from code, not from the live graph. The
> Petals API key only authorises `ingest/*` and `metrics/*`
> (`~/code/petals/src/routes/api/memory/`); no query endpoint is proxied.
> Optional hard-confirmation via the authenticated Petals memory UI is listed
> under Open questions.

## Decisions (settled during brainstorming)

1. **Scope is general same-name disambiguation**, with the account owner as a
   first-class case — not a self-only patch.
2. **Self-preference lives upstream, never as a blunt resolver default.** The
   user's identity is delivered by (a) subject-wiring in transcripts and
   (b) specific, unambiguous aliases — *not* by making the resolver prefer the
   self node on an ambiguous match. A blunt "assume self" rule is the
   over-merge failure mode and is explicitly rejected.
3. **Bare first names are inherently ambiguous and must never auto-merge** —
   not into the self node, not into another same-named node.
4. **The resolver must never guess on a tie.** A unique same-name match
   resolves as today; multiple matches split into a distinct node and log for
   later consolidation, instead of taking `candidates[0]`.
5. **Build in leverage order 1 → 2 → 3 → 4.** Components 1+2 directly kill the
   reported bug at low risk; 3 generalises it; 4 is additive insurance.

## Design

Four components, each mapped to a root cause.

### Component 1 — Self-node identity hygiene  *(fixes root cause #2)*

Give the user-self node a real, *distinguishing* identity and keep the alias
table in sync, without seeding ambiguous bare first names.

- **Primary label.** The self node's `label` / `canonicalLabel` becomes the
  user's most-specific name — the longest (most tokens) entry in the effective
  alias list, e.g. `"Marcel Samyn"` rather than `"Marcel"`. Replaces the
  current `label = userId` behaviour in `ensureUserSelfPersonNode`
  (`resolve-speakers.ts:250`).
- **One hygiene helper, two call sites.** Introduce
  `ensureUserSelfIdentity(db, userId, aliases)` that ensures the self node
  exists, sets its primary label, and seeds the alias table for the self node
  with the **multi-token / distinguishing** aliases only (e.g.
  `"Marcel Samyn"`). Single-token, inherently ambiguous aliases (e.g.
  `"Marcel"`) are **not** written to the global alias table used by
  `resolveIdentity`. This helper is called from **both**:
  - `setUserSelfAliases` (`src/lib/user-profile.ts:50`) — the explicit config
    path; and
  - the transcript ingestion path (`ingestTranscript`), using the
    **effective** alias list `userSelfAliasesOverride ?? stored` — because the
    WhatsApp client (`~/code/whatsapp-memory`) sends
    `userSelfAliasesOverride` per request and never calls
    `/user/self-aliases`, so the persistent list may be empty. Hooking only
    the config endpoint would miss the real ingestion flow.
  The single-token aliases remain available for transcript *speaker* matching
  via the `userSelfAliases` config set (`resolve-speakers.ts:114`); they are
  just kept out of the identity-resolution alias table.
- **Stop writing the ambiguous self alias in speaker resolution.**
  `resolveSpeakers` no longer writes the bare user-self speaker label into the
  alias table (`resolve-speakers.ts:119`). Speaker resolution already matches
  self via the `userSelfAliases` config set (`:114`), so this is safe and
  removes the ambiguity at its source. (Alias writes for *other* participants
  are unchanged.)
- **Backfill.** A one-off maintenance route under `src/routes/maintenance/`
  renames the existing self node to the primary label, seeds distinguishing
  aliases, and removes the bare-first-name self alias if present.

### Component 2 — Wire user-self as the claim *subject*  *(fixes root cause #1)*

In the transcript path, make the user-self speaker's node the subject of that
speaker's first-person claims, so "I…" attaches to the user — never to a minted
node.

- Register every speaker node into `idMap` (real id → node id) so the LLM can
  reference it as a `subjectId`. The self node's real id is already registered
  when it appears in `cappedNodes`, but speaker nodes must be registered
  **unconditionally** (not subject to the 150-node cap), since the self/other
  speaker nodes are exactly the subjects we care about.
- Surface the user-self node in the prompt context labelled unambiguously as
  the user (e.g. `"Marcel Samyn (the user / 'you')"`), and extend the
  transcript section of the system prompt + few-shot so the model uses the
  user-self speaker's node id as the **subject** of that speaker's
  self-referential claims. The speaker section already lists `nodeId` per
  speaker (`_formatSpeakerMapSection`, `extract-graph.ts:1421`); this makes it
  usable for subjects, not just provenance.
- This keeps the byte-identical-system-prompt caching contract: dynamic
  per-user identity stays in the trailing user message / speaker section.

### Component 3 — Resolver: unique-match-wins, never guess  *(fixes root cause #3; generalises)*

Change the ambiguity behaviour of `resolveIdentity`
(`src/lib/identity-resolution.ts`) for the exact-match signals (canonical
label, alias):

- **Exactly one same-scope/same-type candidate → resolve** (unchanged).
- **More than one candidate → do not auto-merge.** Return a non-resolving
  decision tagged ambiguous. The caller (`_processAndInsertNewNodes`,
  `extract-graph.ts:956`) then creates a fresh distinct node (the existing
  null-path behaviour = "split") and emits a new observability event
  (`identity.ambiguous_skip`) carrying the candidate set, mirroring the
  existing `identity.cross_scope_merge_refused` pattern. Consolidation is left
  to the background identity re-eval / `cleanup/dedup-sweep`, which *do* have
  embeddings + claim profiles to disambiguate with.
- **No blunt self-prior.** `isUserSelf` is recorded in the decision trace for
  observability and may serve as an *evidence-gated* tiebreak only (see Open
  questions), but is never a default winner — to avoid resurrecting the
  over-merge failure.

Net effect with Components 1+2 in place:
- A third-party bare "Marcel" mention that matches several nodes → split +
  logged (no arbitrary mis-route), instead of silently grabbing `candidates[0]`.
- A specific "Marcel Samyn" mention (document/conversation, no speaker map) →
  unique alias match → resolves to the self node correctly.
- A transcript first-person "I…" → attached to self by subject-wiring
  (Component 2), never reaching the ambiguous name path.

### Component 4 — Prompt injection on all paths  *(cheap insurance)*

Inject "who the user is" (primary name + aliases) into the **document** and
**conversation** extraction prompts too (today only transcripts get speaker
context), in the cache-safe trailing user message. Instruct the model to emit
the **most specific** label it can for people ("Marcel Szenessy", not bare
"Marcel") and to not conflate a different same-named person with the user. This
raises the rate of unique matches in Component 3 and reduces ambiguity at the
source.

## Data flow (transcript, post-change)

```
WhatsApp → ingestTranscript
  ├─ resolveSpeakers: "Marcel"→self via userSelfAliases (no bare alias written)
  ├─ self node has label "Marcel Samyn", aliases {"Marcel Samyn"}        [C1]
  ├─ speakerMap → registered into idMap as valid subject ids             [C2]
  └─ extractGraph
       ├─ prompt: user-self node shown as "you"; use its id for "I…"     [C2]
       ├─ first-person claim subject = self node id  → attaches to user  [C2]
       └─ minted third-party "Marcel" → resolveIdentity
            ├─ 1 candidate  → resolve                                    [C3]
            └─ >1 candidate → split + identity.ambiguous_skip log        [C3]
```

## Testing

- **Unit (resolver):** multiple same-scope/type candidates → no resolution +
  ambiguous decision; single candidate → resolves; cross-scope unchanged.
- **Unit (self hygiene):** `setUserSelfAliases` names the self node, seeds only
  multi-token aliases, never seeds bare first names; `resolveSpeakers` no
  longer writes the bare self alias.
- **Integration (transcript):** a user-self utterance "I live in Lisbon"
  attaches `LIVES_IN Lisbon` to the self node (subject = self), with a separate
  same-named participant present — assert the claim is **not** on the
  participant node. Extends the multi-party story
  (`src/evals/memory/stories/10-multi-party-transcript.ts`) and
  `ingest-transcript.test.ts`.
- **Integration (document):** a document naming "Marcel Samyn" resolves to the
  self node; a bare third-party "Marcel" does not merge into self.
- Tests run locally against the test DB on `:5431` (CI does not run vitest).

## Scope

**In scope:** Components 1–4 as above; one-off self-node backfill; new
`identity.ambiguous_skip` event.

**Out of scope (future):** richer extraction-time disambiguation using a
candidate claim profile built from co-extracted claims; automatic merge of
`ambiguous_skip` splits beyond the existing dedup-sweep; per-user timezone or
multi-account-owner cases.

## Open questions

1. **Evidence-gated self tiebreak:** should Component 3 ever prefer the
   self node when it is *one of several* candidates and there is corroborating
   self-evidence, or always split on >1? Default proposal: always split (no
   self tiebreak) for maximum safety.
2. **Primary-label selection:** longest alias by token count vs an explicit
   "primary name" field on the profile. Default proposal: longest alias, with
   an explicit field deferred until needed.
3. **Live-graph confirmation:** verify against the actual nodes via the
   authenticated Petals memory UI before implementing, or proceed on the
   code-grounded diagnosis. Default: proceed; verify opportunistically.
