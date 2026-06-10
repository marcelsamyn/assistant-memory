# Screenpipe → Memory Distiller — Design

**Date:** 2026-06-10
**Status:** Approved (design); implementation pending
**Repos touched:** new `~/code/screenpipe-distiller`; `~/code/assistant-memory` (observed extraction mode); `~/code/petals` (one-line proxy passthrough)

## Context & Goal

Marcel runs Screenpipe on his personal Mac, continuously capturing screen (OCR + accessibility), audio, and input. The hypothesis driving his memory stack: *the more AI knows about you, the better it can help you.* Screen observation is the missing source — alongside the existing n8n ingestion workflows (meeting transcripts, handwritten tablet notes, Oura) — feeding **Assistant Memory** (`~/code/assistant-memory`), which his chat app **Petals** reads from.

Goal: distill each day of noisy computer-use capture into a small set of **durable, true things worth knowing about Marcel** — what he worked on, who he interacted with, the tools/stack he uses, what he read/explored — and ingest them into Assistant Memory **without polluting it** with junk tasks or wrongly-inferred preferences.

An existing Screenpipe "Obsidian pipe" (`obsidian-sync`) already writes daily notes to `/Users/marcel/Notes/screenpipe-daily-notes`. Its core failure mode — **inventing todos from passive observation** (its `pipe.md` literally says *"Extract TODOs: tasks, follow-ups, URLs to visit"*) — is the anti-pattern this design must avoid. That pipe is left untouched (different use case: a browsable journal).

## Non-Goals / Out of Scope

- **Not** replacing or modifying the `obsidian-sync` pipe.
- **Not** mirroring an n8n workflow (recon of the existing ingestion workflows was blocked by MCP scoping; not needed — we hit the Petals proxy directly, the same surface those workflows use).
- **Not** building a real-time feed. Daily consolidation only.
- **Not** fixing Screenpipe audio transcription as part of the distiller (tracked separately — see §9). The distiller degrades gracefully when audio is empty.

## Architecture Overview

Three components:

1. **`screenpipe-distiller`** — new standalone TypeScript/Bun repo. The engine: reads the local Screenpipe API, condenses a day, curates it with an LLM, uploads to Petals. Owns its own scheduling and a health-check.
2. **assistant-memory `observed` extraction mode** — a new ingestion profile so observed data enriches personal memory without minting tasks or self-attributed preferences/decisions/goals.
3. **Recording autostart + health** — a replacement `screenpipe record` LaunchAgent (the old `.app` autostart is now broken), plus a periodic health-check nudge.

### Data flow

```
Screenpipe SQLite (screenpipe record — already capturing)
  │  GET localhost:3030/search   (day window, chunked; all / audio / input)
  ▼
distiller: condense (deterministic) → curate (OpenRouter LLM) → markdown doc
  │  POST https://petals.chat/api/memory/ingest/document   { scope:"personal" }  (x-api-key; mode:"observed" in Phase 2)
  ▼
Petals proxy: inject userId → SDK
  ▼
hosted Assistant Memory: document extractGraph (personal scope) → nodes/claims
  │  (self-attributed preferences/decisions/goals suppressed by the document branch;
  │   new Tasks demoted to candidate band — never reminders)
  ▼
personal memory/search  →  Petals assistant
```

Separate loop:
```
health-check (launchd, ~2×/day): GET /health + last-frame freshness + audio-stall flag
  → macOS notification if recording is down or stale
```

## Component 1 — `screenpipe-distiller`

New repo `~/code/screenpipe-distiller`, **Bun** runtime (Screenpipe is already bun-based on this machine; absolute bun path `/opt/homebrew/bin/bun`), strict TypeScript, Zod-validated config. Named exports throughout.

### Modules

- **`config.ts`** — parse + validate env via Zod once at the boundary. Fields:
  `SCREENPIPE_API_URL` (default `http://localhost:3030`), `SCREENPIPE_LOCAL_API_KEY`, `PETALS_BASE_URL` (default `https://petals.chat`), `PETALS_API_KEY`, `OPENROUTER_API_KEY`, `CURATION_MODEL` (default: a strong-but-cheap OpenRouter slug, trivially swappable), `USER_TIMEZONE` (default `Europe/Brussels` / `+02:00`).

- **`screenpipe.ts`** — local Screenpipe REST client + **deterministic condenser**.
  - `fetchDayActivity(date: DayKey): Promise<DayDigest>` — for the day's window in `USER_TIMEZONE`, query `GET /search` (bearer `SCREENPIPE_LOCAL_API_KEY`) across `content_type=all` (OCR/accessibility, `min_length` filtered), `content_type=audio`, `content_type=input`, paginated/chunked by time so no single response is unbounded.
  - **Condense before the LLM ever sees data**: group by `app_name` / `window_name` / `browser_url`, collapse consecutive duplicate frames, drop sub-threshold noise, attach representative timestamps and URLs. Output `DayDigest` is a compact (few-KB) structured summary — *not* raw frames. This is pure, deterministic, and the most-tested part.
  - Returns a digest that carries enough entity signal (app names, window titles, URLs, speaker labels when audio works) for good downstream graph extraction.

- **`curate.ts`** — `curateDigest(digest: DayDigest): Promise<CuratedDoc>`. One OpenRouter call (OpenAI-compatible client pointed at `https://openrouter.ai/api/v1`, mirroring `assistant-memory/src/lib/ai.ts`). System prompt = the **curation contract** (§7). Returns `{ markdown, isEmptyDay }`.

- **`upload.ts`** — `uploadDocument(date, doc): Promise<void>`. POST `${PETALS_BASE_URL}/api/memory/ingest/document` with headers `Content-Type: application/json`, `x-api-key: ${PETALS_API_KEY}`. Body matches Petals' `ingestDocumentBodySchema` + the new `mode`:
  ```jsonc
  { // v1 sends no `mode`; Phase 2 adds "mode": "observed"
    "document": {
      "id": "screenpipe-activity-<date>",   // stable → idempotent replace
      "content": "<curated markdown>",
      "contentType": "markdown",
      "scope": "personal",
      "title": "Computer activity — <date>",
      "timestamp": "<date>T12:00:00<tz>"
    } }
  ```
  Retry with exponential backoff (internet-bound); treat 2xx as success, surface 4xx loudly (typed error), retry 5xx/network.

- **`main.ts`** — CLI `distill [--date YYYY-MM-DD]` (default: **yesterday** in `USER_TIMEZONE`). Orchestrates fetch → condense → curate → upload. Idempotent and safe to re-run. Sparse/empty day → still uploads a short honest doc (or skips upload if truly nothing; decided in plan, default: upload a one-line "minimal activity" doc so the timeline has continuity).

- **`health.ts`** — CLI `health-check`. `GET /health` + newest-frame age; if recording down, frames stale beyond a threshold, or `audio_db_write_stalled` true, fire a macOS notification (`osascript -e 'display notification …'`). Read-only, no memory writes.

### Why a separate owned repo (not the agentic pipe)
Curation **judgment** is the whole value. It must be deterministic, version-controlled, testable on realistic messy data, and run on a model we choose — not delegated to Screenpipe's agentic Haiku harness writing throwaway scripts. The condenser + upload are pure functions; only the single curation call is non-deterministic.

## Component 2 — assistant-memory `observed` extraction mode (DEFERRED — Phase 2)

**Status (decided 2026-06-10): deferred.** v1 ships on plain `scope:"personal"` documents, which already suppress self-attributed `HAS_PREFERENCE`/`MADE_DECISION`/`HAS_GOAL`/`HAS_PLAN` — the suppression in `extract-graph.ts:246-253` keys on `sourceType === "document"`, **not** on scope, and `/ingest/document` always sets `sourceType:"document"` — and they stay visible in personal memory/search (only *reference* scope is isolated). Residual gaps the observed mode would close: plain personal documents still mint *candidate* Task nodes (graph noise, never reminders) and use document-author framing. Building it is a real cross-repo job: `mode` threaded through **6 function hops** (route → save-document → job schema → ingest-document job → extract-document-graph → chunked-extract → extractGraph); a new `observed` provenance needing an enum change, trust-rank renumber, **a Postgres CHECK-constraint change + DB migration**, and partial-index band decisions; **a new `@marcelsamyn/memory` SDK release + Petals dependency bump** (the installed `1.22.0` silently strips unknown `mode`); and a redeploy of both hosted services. We revisit only after seeing real v1 output. The blueprint below stands as the Phase-2 design.

The attribution problem: observed activity is *about* Marcel but he isn't *asserting* anything — he merely had something on screen. Neither existing scope fits: `personal` lets the extractor mint wrong `HAS_PREFERENCE`/`MADE_DECISION`/`HAS_GOAL` self-claims from passive viewing; `reference` is isolated from personal memory/search (invisible to the assistant — defeats the goal).

**Solution:** a new extraction profile, selected per-ingestion, combined with `scope: "personal"` (so results are visible to personal memory/search).

- **API surface:** add `mode?: "default" | "observed"` (default `"default"`) to `ingestDocumentRequestSchema`. Thread `route → saveMemory → extractGraph`.
- **Behavior in `observed` mode** (`extract-graph.ts`):
  - Inject an alternate instruction block that **forbids** self-attribution predicates (`HAS_PREFERENCE`, `MADE_DECISION`, `HAS_GOAL`, `HAS_PLAN`) with the user as subject, and **forbids Task creation entirely** (drop the `_formatOpenCommitmentsSection` / Task instructions).
  - **Keep** Person/Location/Event/Object/Concept/Media/Temporal nodes and factual relationship claims (`PARTICIPATED_IN`, `OCCURRED_AT`, `WORKS_AT`, `USES`, `CREATED`, `PART_OF`, `RELATED_TO`, factual `HAS_ATTRIBUTE`). So "worked on assistant-memory", "read an article on X", "interacted with José" are recorded as events/entities/relations.
  - **Provenance:** new `assertedByKind: "observed"` on the trust ladder **between** `assistant_inferred (2)` and `document_author (3)` — more reliable than a guess, less than a stated fact. Like `assistant_inferred`, it is **excluded from open commitments**; unlike `reference`, it participates in personal memory/search.
- **Petals passthrough:** add `mode` to `ingestDocumentBodySchema` in `petals/src/lib/api-docs.ts` and forward it. One-line change each side.
- **Deploy sequencing:** the `mode` flag is inert until **both** hosted Petals and hosted Memory ship this change. The distiller can ship in parallel; before deploy it should send `mode:"observed"` anyway (forward-compatible) — confirm hosted Petals ignores unknown fields or gate the rollout (see §10).

## Component 3 — Recording autostart + scheduling

**Current state (verified 2026-06-10):** `~/Library/LaunchAgents/screenpipe.plist` launches the now-deleted `/Applications/screenpipe.app/...` → `launchctl` reports exit status 255. Live recording is a **manual** terminal `screenpipe record` (won't survive reboot). **After next restart, nothing records.**

Deliverables (owned by the distiller repo, installed via a script):
- **`com.marcel.screenpipe.record.plist`** — replaces the dead app plist. Runs `/opt/homebrew/bin/bun x screenpipe@latest record` (absolute paths; launchd has a minimal PATH), `RunAtLoad=true`, `KeepAlive` so it restarts on crash, logs to a file. Unload + remove the old `screenpipe` agent.
- **`com.marcel.screenpipe-distiller.daily.plist`** — `StartCalendarInterval` ~08:00, runs `bun run distill`. Robust to boot timing because it targets *yesterday* and is idempotent; launchd also runs a missed calendar job once on next wake/boot.
- **`com.marcel.screenpipe-distiller.health.plist`** — `StartCalendarInterval` ~2×/day, runs `bun run health-check`.

## 7. The Curation Contract (the core IP)

The `curate.ts` system prompt encodes seven rules:

1. **Durable over ephemeral.** Record what is true beyond today — projects, people, tools, sustained topics. Drop window-focus mechanics, idle gaps, one-off lookups with no follow-through.
2. **Zero action items.** Never emit todos, follow-ups, "should"/"could" items. The document has **no** action-items section. (Belt-and-suspenders with observed mode.)
3. **Evidence-grounded, no intent inference.** Describe what was *done/seen* ("spent ~2h editing `extract-graph.ts`"), never *why*, never *prefers/decided/wants*.
4. **Entity-first.** Surface named people, orgs, repos, tools, article/video titles + URLs. Concrete entities → good graph nodes.
5. **Consolidate.** A synthesized narrative + entity list, not a minute-by-minute log.
6. **Honest about sparsity.** Idle/light day → say so briefly; never pad or invent.
7. **Reading = exposure, not intent.** "Read about X" / "watched a video on Y" — never "wants to do X." (The exact Obsidian-pipe failure.)

**Uploaded document shape:**
```markdown
# Computer activity — <date>

## What I worked on
<narrative: projects, repos, problems, concrete actions>

## People & conversations
<who appeared / was interacted with + context>   (thin until audio is fixed — §9)

## Tools & environment
<tools/tech actively used; notable setup/config work>

## Read & explored
<articles/videos/repos engaged with + topic, as exposure not intent>

## Notes
<sparse-day note / anything notable — never action items>
```

## 8. Configuration

All via env, Zod-validated in `config.ts` (see Component 1). Secrets (`SCREENPIPE_LOCAL_API_KEY`, `PETALS_API_KEY`, `OPENROUTER_API_KEY`) supplied through the launchd plist environment / a gitignored `.env`, never committed. The Petals API key is minted once in Petals → Settings → API Keys (prefix `petals-`, 1-year expiry).

## 9. Tracked follow-up — fix Screenpipe audio (separate workstream)

Audio transcription has been dead since 2026-06-05: `/health` shows `audio_level_rms: 0.0`, `avg_speech_ratio: 0.0`, all chunks VAD-rejected, `db_inserted: 0`, ~900 pending segments. **Lead:** level `0.0` = capturing silence → almost certainly a **device-selection** issue (listening to "Scarlett 2i2 USB" with no live signal), not a model/VAD bug. Until fixed, the distiller's *People & conversations* dimension stays empty; the health-check surfaces the stall. Tracked in memory `screenpipe-audio-transcription-broken`. Fix = a small Screenpipe config task, sequenced after the distiller MVP.

## 10. Testing

- **Condenser (`screenpipe.ts`)** — unit tests on realistic messy frame fixtures (repeated frames, idle gaps, truncated OCR, mixed apps/URLs). The deterministic heart; highest coverage.
- **Upload (`upload.ts`)** — payload conforms to Petals' `ingestDocumentBodySchema` (+ `mode`); retry/backoff on 5xx, loud typed error on 4xx.
- **Curation (`curate.ts`)** — plumbing tests **mock only the LLM** (per house rule: only mock external AI). A separate **opt-in eval** (hits the real OpenRouter model) asserts structural invariants on fixture digests: no action-items section, entities present, bounded length, honest on sparse input.
- **assistant-memory observed mode** — unit: observed prompt omits Task/self-attribution instructions. Integration: an observed ingestion produces **zero Task nodes** and **zero self-attributed `HAS_PREFERENCE`/`MADE_DECISION`/`HAS_GOAL`** claims, while still producing Event/Person/relationship claims. Run against the test DB on its non-default port.

## 11. Sequencing

**v1 (this build) — no backend changes:**
1. **Recording autostart** (urgent — reboot risk): replace the dead `.app` plist with a `screenpipe record` LaunchAgent.
2. **Distiller**: scaffold → config/date-utils → Screenpipe client + condenser → curation → upload (`scope:"personal"`) → orchestrator + CLI → manual run for a recent day; verify the doc lands in memory and reads cleanly.
3. **Scheduling**: distiller daily + health-check plists.

**Follow-ups (separate, after v1 runs):**
4. **Fix audio device selection** (unblocks People & conversations) — see §9.
5. **Phase 2 — `observed` mode** (§2), only if v1 output shows the residual candidate-task noise / framing is worth the cross-repo release.
6. **(Optional) backfill** historical days (~80 requests, within rate limits).

## Resolved decisions

- Capture all four categories (work/projects, people/interactions, tools/stack, reading/interests) — the lever is curation quality, not category selection.
- Owned TS/Bun distiller (not the agentic pipe, not n8n).
- Daily cadence, processes *yesterday*, idempotent.
- **v1:** plain `scope: personal` documents (already suppress self-attributed preferences/decisions/goals; visible in personal memory). **Phase 2 (deferred):** `observed` extraction mode for zero candidate-task noise + observed-fact framing.
- Upload via hosted Petals proxy (`https://petals.chat`), `x-api-key`.
- Curation LLM via OpenRouter, model = swappable env var.
- Health-check replaces "remind me to start it"; recording autostart re-owned via launchd.
