# Screenpipe Distiller (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily, owned tool that distills a day of Screenpipe screen/audio/input capture into one durable `scope:"personal"` activity document and uploads it to Assistant Memory via the hosted Petals proxy — plus a re-owned `screenpipe record` autostart and a health-check.

**Architecture:** New standalone Bun + TypeScript repo `~/code/screenpipe-distiller`. Deterministic pipeline `fetch → condense → curate (OpenRouter) → upload`. The condenser (pure, heavily tested) collapses thousands of frames into a few-KB digest before the LLM sees anything; the curation prompt enforces "exposure ≠ intent, zero action items." Scheduling + recording autostart via launchd plists committed to the repo. No backend changes in v1 (the `observed` extraction mode is deferred — see spec §2).

**Tech Stack:** Bun (runtime + native test runner `bun:test`), TypeScript (strict), Zod (boundary validation), `openai` SDK (pointed at OpenRouter), macOS `launchd`, Screenpipe local REST API (`http://localhost:3030`).

**Reference spec:** `~/code/assistant-memory/docs/superpowers/specs/2026-06-10-screenpipe-memory-distiller-design.md`

**Ground-truth facts (verified 2026-06-10):**

- Screenpipe `/search` requires `Authorization: Bearer <token>`; token via `screenpipe auth token`. Response envelope: `{ "data": [ { "type": "OCR"|"Audio"|"Input", "content": {...} } ], "pagination": {...} }`. Valid `content_type` values: `ocr | audio | input | accessibility | all`.
- OCR `content`: `app_name, window_name, browser_url, text, timestamp, focused, frame_id, …`. Audio `content`: `transcription, text, speaker_label, timestamp, …`. Input `content`: `app_name, window_title, browser_url, text_content, event_type, timestamp, …`.
- Petals proxy: `POST https://petals.chat/api/memory/ingest/document`, header `x-api-key: petals-…`, body `{ document: { id, content, contentType, scope, title, timestamp } }` (no `userId` — Petals injects it). Response `{ message, jobId }`. Idempotent on `document.id`.
- `bun` is at `/opt/homebrew/bin/bun`. The old autostart `~/Library/LaunchAgents/screenpipe.plist` points at the now-deleted `.app` and exits 255.

---

## Part A — Repo scaffold

### Task 1: Initialize the repo

**Files:**

- Create: `~/code/screenpipe-distiller/package.json`
- Create: `~/code/screenpipe-distiller/tsconfig.json`
- Create: `~/code/screenpipe-distiller/.gitignore`
- Create: `~/code/screenpipe-distiller/.env.example`
- Create: `~/code/screenpipe-distiller/README.md`

- [ ] **Step 1: Create the repo directory and init git + bun**

```bash
mkdir -p ~/code/screenpipe-distiller && cd ~/code/screenpipe-distiller
git init -q
bun init -y >/dev/null 2>&1 || true
rm -f index.ts   # remove bun init scaffold; we use src/
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "screenpipe-distiller",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "distill": "bun run src/main.ts",
    "health-check": "bun run src/health.ts",
    "test": "bun test",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "openai": "^4.77.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
.env
*.log
bun.lockb
```

(Keep `bun.lockb` out per the user's preference to avoid lockfile churn in a personal tool; if you prefer reproducible installs, remove that line and commit it instead.)

- [ ] **Step 5: Write `.env.example`**

```bash
# Screenpipe local API (token via: screenpipe auth token)
SCREENPIPE_API_URL=http://localhost:3030
SCREENPIPE_API_KEY=

# Petals proxy (mint a key in Petals → Settings → API Keys, prefix petals-)
PETALS_BASE_URL=https://petals.chat
PETALS_API_KEY=

# OpenRouter (curation LLM) — model is swappable
OPENROUTER_API_KEY=
CURATION_MODEL=anthropic/claude-sonnet-4.6

USER_TIMEZONE=Europe/Brussels
```

- [ ] **Step 6: Write `README.md`**

```markdown
# screenpipe-distiller

Daily tool that distills Screenpipe computer-use capture into one durable
activity document and ingests it into Assistant Memory via the hosted Petals
proxy. See the design spec in `assistant-memory/docs/superpowers/specs/`.

## Usage

- `bun run distill [--date YYYY-MM-DD]` — distill a day (default: yesterday).
- `bun run health-check` — check Screenpipe recording health; notify if down.

Config via `.env` (see `.env.example`). Get the Screenpipe token with
`screenpipe auth token`.
```

- [ ] **Step 7: Install dependencies**

Run: `cd ~/code/screenpipe-distiller && bun install`
Expected: installs `openai`, `zod`, `@types/bun`, `typescript`. No errors.

- [ ] **Step 8: Commit**

```bash
cd ~/code/screenpipe-distiller
git add package.json tsconfig.json .gitignore .env.example README.md
git commit -m "🔧 chore: scaffold screenpipe-distiller (bun + ts)"
```

---

## Part B — Recording autostart (urgent: reboot currently = no recording)

### Task 2: Re-own `screenpipe record` via launchd

**Files:**

- Create: `~/code/screenpipe-distiller/launchd/com.marcel.screenpipe.record.plist`
- Create: `~/code/screenpipe-distiller/scripts/install-record-autostart.sh`

- [ ] **Step 1: Install a stable Screenpipe CLI binary**

The running recorder uses an ephemeral `bunx` temp path. For a durable autostart, install the CLI globally so it lives at a stable path.

Run: `bun add -g @screenpipe/cli && ls -l ~/.bun/bin/screenpipe && ~/.bun/bin/screenpipe --version`
Expected: a `screenpipe` binary at `/Users/marcel/.bun/bin/screenpipe`, prints a version. If the global bin name differs, note the real path and use it in the plist below.

- [ ] **Step 2: Write the record LaunchAgent**

`~/code/screenpipe-distiller/launchd/com.marcel.screenpipe.record.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marcel.screenpipe.record</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/marcel/.bun/bin/screenpipe</string>
    <string>record</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/marcel/.screenpipe/record.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/marcel/.screenpipe/record.launchd.err.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Write the install script**

`~/code/screenpipe-distiller/scripts/install-record-autostart.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Remove the dead .app autostart (points at the uninstalled desktop app).
if [ -f "$AGENTS/screenpipe.plist" ]; then
  launchctl unload "$AGENTS/screenpipe.plist" 2>/dev/null || true
  rm -f "$AGENTS/screenpipe.plist"
  echo "removed dead screenpipe.plist"
fi

# 2. Stop any manually-started recorder so we don't run two on one sqlite db.
pkill -f "screenpipe record" 2>/dev/null || true
sleep 2

# 3. Install + load the new record agent.
cp "$REPO/launchd/com.marcel.screenpipe.record.plist" "$AGENTS/"
launchctl unload "$AGENTS/com.marcel.screenpipe.record.plist" 2>/dev/null || true
launchctl load "$AGENTS/com.marcel.screenpipe.record.plist"
echo "loaded com.marcel.screenpipe.record"
```

- [ ] **Step 4: Run the install script**

Run: `chmod +x ~/code/screenpipe-distiller/scripts/install-record-autostart.sh && ~/code/screenpipe-distiller/scripts/install-record-autostart.sh`
Expected: "removed dead screenpipe.plist", "loaded com.marcel.screenpipe.record".

- [ ] **Step 5: Verify exactly one healthy recorder is running**

Run: `sleep 5 && launchctl list | grep screenpipe.record && ps aux | grep "[s]creenpipe record" && curl -s http://localhost:3030/health | head -c 120`
Expected: the launchd job listed with exit code 0 (a PID in column 1), exactly one `screenpipe record` process, and `/health` responding. (Audio may still report `degraded` — that's the separate audio-device follow-up, not this task.)

- [ ] **Step 6: Commit**

```bash
cd ~/code/screenpipe-distiller
git add launchd/com.marcel.screenpipe.record.plist scripts/install-record-autostart.sh
git commit -m "✨ feat: re-own screenpipe record autostart via launchd"
```

---

## Part C — Foundations

### Task 3: `config.ts` — validated env at the boundary

**Files:**

- Create: `~/code/screenpipe-distiller/src/config.ts`
- Test: `~/code/screenpipe-distiller/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:

```ts
import { loadConfig } from "./config";
import { describe, expect, test } from "bun:test";

const base = {
  SCREENPIPE_API_KEY: "sp-key",
  PETALS_API_KEY: "petals-key",
  OPENROUTER_API_KEY: "or-key",
};

describe("loadConfig", () => {
  test("applies defaults for optional fields", () => {
    const cfg = loadConfig(base);
    expect(cfg.SCREENPIPE_API_URL).toBe("http://localhost:3030");
    expect(cfg.PETALS_BASE_URL).toBe("https://petals.chat");
    expect(cfg.CURATION_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(cfg.USER_TIMEZONE).toBe("Europe/Brussels");
  });

  test("throws when a required secret is missing", () => {
    expect(() =>
      loadConfig({ SCREENPIPE_API_KEY: "x", PETALS_API_KEY: "y" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
/**
 * Loads + validates all runtime configuration from the environment.
 * Boundary parse: call once, then trust the typed Config everywhere.
 */
import { z } from "zod";

const configSchema = z.object({
  SCREENPIPE_API_URL: z.string().url().default("http://localhost:3030"),
  SCREENPIPE_API_KEY: z.string().min(1),
  PETALS_BASE_URL: z.string().url().default("https://petals.chat"),
  PETALS_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  CURATION_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4.6"),
  USER_TIMEZONE: z.string().min(1).default("Europe/Brussels"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return configSchema.parse(env);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/config.ts src/config.test.ts
git commit -m "✨ feat: config loader with zod-validated env"
```

### Task 4: `date-utils.ts` — day keys + UTC day windows

**Files:**

- Create: `~/code/screenpipe-distiller/src/date-utils.ts`
- Test: `~/code/screenpipe-distiller/src/date-utils.test.ts`

- [ ] **Step 1: Write the failing test**

`src/date-utils.test.ts`:

```ts
import { dayKeyFor, yesterdayKey, dayWindowUtc } from "./date-utils";
import { describe, expect, test } from "bun:test";

describe("date-utils", () => {
  test("dayKeyFor formats local day in tz", () => {
    // 2026-06-09T23:30:00Z is 2026-06-10 01:30 in Brussels (+02:00)
    expect(dayKeyFor(new Date("2026-06-09T23:30:00Z"), "Europe/Brussels")).toBe(
      "2026-06-10",
    );
  });

  test("yesterdayKey is the local day before now", () => {
    expect(
      yesterdayKey(new Date("2026-06-10T08:00:00Z"), "Europe/Brussels"),
    ).toBe("2026-06-09");
  });

  test("dayWindowUtc returns local-midnight bounds in UTC", () => {
    // Brussels is +02:00 in June → local midnight 2026-06-09 == 2026-06-08T22:00Z
    const { startIso, endIso } = dayWindowUtc("2026-06-09", "Europe/Brussels");
    expect(startIso).toBe("2026-06-08T22:00:00.000Z");
    expect(endIso).toBe("2026-06-09T22:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/date-utils.test.ts`
Expected: FAIL — cannot find module `./date-utils`.

- [ ] **Step 3: Write `src/date-utils.ts`**

```ts
/**
 * Timezone-aware day keys ("YYYY-MM-DD") and UTC bounds for a local day.
 * Aliases: day window, local midnight, tz offset.
 */
export type DayKey = string;

export function dayKeyFor(date: Date, timeZone: string): DayKey {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function yesterdayKey(now: Date, timeZone: string): DayKey {
  return dayKeyFor(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

/** Milliseconds to add to a UTC instant to get the same wall-clock in `timeZone`. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

function localMidnightUtcIso(dayKey: DayKey, timeZone: string): string {
  const naive = new Date(`${dayKey}T00:00:00Z`);
  const offset = tzOffsetMs(naive, timeZone);
  return new Date(naive.getTime() - offset).toISOString();
}

function nextDayKey(dayKey: DayKey): DayKey {
  const next = new Date(`${dayKey}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function dayWindowUtc(
  dayKey: DayKey,
  timeZone: string,
): { startIso: string; endIso: string } {
  return {
    startIso: localMidnightUtcIso(dayKey, timeZone),
    endIso: localMidnightUtcIso(nextDayKey(dayKey), timeZone),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/date-utils.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/date-utils.ts src/date-utils.test.ts
git commit -m "✨ feat: tz-aware day keys and utc day windows"
```

### Task 5: `types.ts` — shared digest/doc types

**Files:**

- Create: `~/code/screenpipe-distiller/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`** (no test — pure type declarations)

```ts
/** The condensed, LLM-ready summary of one day of activity. */
export interface AppActivity {
  app: string;
  windows: string[];
  urls: string[];
  sampleText: string[];
  firstSeen: string;
  lastSeen: string;
  frames: number;
}

export interface AudioSnippet {
  speaker: string | null;
  text: string;
  timestamp: string;
}

export interface DayDigest {
  dayKey: string;
  apps: AppActivity[];
  audio: AudioSnippet[];
  totalFrames: number;
  isEmpty: boolean;
}

export interface CuratedDoc {
  markdown: string;
  isEmptyDay: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/types.ts
git commit -m "✨ feat: shared digest and document types"
```

---

## Part D — Screenpipe client + condenser

### Task 6: `screenpipe.ts` — REST client (search + pagination)

**Files:**

- Create: `~/code/screenpipe-distiller/src/screenpipe.ts`
- Test: `~/code/screenpipe-distiller/src/screenpipe.client.test.ts`

- [ ] **Step 1: Write the failing test** (client only; condenser lands in Task 7)

`src/screenpipe.client.test.ts`:

```ts
import { ScreenpipeClient, ScreenpipeError } from "./screenpipe";
import { describe, expect, test } from "bun:test";

function fakeFetch(pages: unknown[][]): typeof fetch {
  let i = 0;
  return (async () => {
    const data = pages[i++] ?? [];
    return new Response(JSON.stringify({ data, pagination: { total: 0 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

describe("ScreenpipeClient", () => {
  test("parses items and stops when a page is short", async () => {
    const item = {
      type: "OCR",
      content: {
        text: "hello",
        app_name: "Chrome",
        timestamp: "2026-06-09T10:00:00Z",
      },
    };
    const client = new ScreenpipeClient(
      "http://localhost:3030",
      "tok",
      fakeFetch([[item]]),
    );
    const items = await client.searchAll({
      contentType: "ocr",
      startIso: "a",
      endIso: "b",
    });
    expect(items.length).toBe(1);
    expect(items[0]?.type).toBe("OCR");
    expect(items[0]?.content.app_name).toBe("Chrome");
  });

  test("throws ScreenpipeError on non-200", async () => {
    const f = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new ScreenpipeClient("http://localhost:3030", "tok", f);
    await expect(
      client.search({
        contentType: "ocr",
        startIso: "a",
        endIso: "b",
        limit: 10,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(ScreenpipeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.client.test.ts`
Expected: FAIL — cannot find module `./screenpipe`.

- [ ] **Step 3: Write the client portion of `src/screenpipe.ts`**

```ts
/**
 * Screenpipe local REST client + day condenser.
 * Aliases: screenpipe search, activity digest, /search client.
 */
import { dayWindowUtc } from "./date-utils";
import type { DayDigest } from "./types";
import { z } from "zod";

export class ScreenpipeError extends Error {}

const contentSchema = z
  .object({
    text: z.string().nullish(),
    transcription: z.string().nullish(),
    app_name: z.string().nullish(),
    window_name: z.string().nullish(),
    window_title: z.string().nullish(),
    browser_url: z.string().nullish(),
    speaker_label: z.string().nullish(),
    text_content: z.string().nullish(),
    event_type: z.string().nullish(),
    timestamp: z.string(),
  })
  .passthrough();

const searchItemSchema = z.object({ type: z.string(), content: contentSchema });
const searchResponseSchema = z.object({
  data: z.array(searchItemSchema),
  pagination: z.unknown().nullish(),
});

export type SearchItem = z.infer<typeof searchItemSchema>;

export type ContentType = "ocr" | "audio" | "input" | "accessibility" | "all";

interface SearchParams {
  contentType: ContentType;
  startIso: string;
  endIso: string;
  limit: number;
  offset: number;
  minLength?: number;
}

export class ScreenpipeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(params: SearchParams): Promise<SearchItem[]> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("content_type", params.contentType);
    url.searchParams.set("start_time", params.startIso);
    url.searchParams.set("end_time", params.endIso);
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("offset", String(params.offset));
    if (params.minLength != null)
      url.searchParams.set("min_length", String(params.minLength));

    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new ScreenpipeError(
        `screenpipe /search ${params.contentType} failed: ${res.status} ${await res.text()}`,
      );
    }
    return searchResponseSchema.parse(await res.json()).data;
  }

  async searchAll(
    params: Omit<SearchParams, "limit" | "offset">,
  ): Promise<SearchItem[]> {
    const limit = 500;
    const out: SearchItem[] = [];
    for (let offset = 0; offset <= 20_000; offset += limit) {
      const batch = await this.search({ ...params, limit, offset });
      out.push(...batch);
      if (batch.length < limit) break;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/screenpipe.ts src/screenpipe.client.test.ts
git commit -m "✨ feat: screenpipe search client with pagination"
```

### Task 7: condenser — `condenseItems()` (the deterministic heart)

**Files:**

- Modify: `~/code/screenpipe-distiller/src/screenpipe.ts` (append)
- Test: `~/code/screenpipe-distiller/src/screenpipe.condense.test.ts`

- [ ] **Step 1: Write the failing test**

`src/screenpipe.condense.test.ts`:

```ts
import { condenseItems, type SearchItem } from "./screenpipe";
import { describe, expect, test } from "bun:test";

const ocr = (
  app: string,
  text: string,
  ts: string,
  url?: string,
  window?: string,
): SearchItem => ({
  type: "OCR",
  content: {
    app_name: app,
    text,
    timestamp: ts,
    browser_url: url,
    window_name: window,
  },
});

describe("condenseItems", () => {
  test("groups by app, dedupes windows/urls/text, counts frames", () => {
    const items: SearchItem[] = [
      ocr(
        "Chrome",
        "GitHub - foo/bar",
        "2026-06-09T09:00:00Z",
        "https://github.com/foo/bar",
        "foo/bar",
      ),
      ocr(
        "Chrome",
        "GitHub - foo/bar",
        "2026-06-09T09:01:00Z",
        "https://github.com/foo/bar",
        "foo/bar",
      ),
      ocr(
        "Chrome",
        "Pull requests",
        "2026-06-09T09:05:00Z",
        "https://github.com/foo/bar/pulls",
        "foo/bar",
      ),
      ocr(
        "Ghostty",
        "$ bun test",
        "2026-06-09T10:00:00Z",
        undefined,
        "marcel — zsh",
      ),
    ];
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.isEmpty).toBe(false);
    expect(digest.totalFrames).toBe(4);
    const chrome = digest.apps.find((a) => a.app === "Chrome");
    expect(chrome?.frames).toBe(3);
    expect(chrome?.urls).toEqual([
      "https://github.com/foo/bar",
      "https://github.com/foo/bar/pulls",
    ]);
    expect(chrome?.windows).toEqual(["foo/bar"]);
    expect(chrome?.sampleText).toContain("GitHub - foo/bar");
    expect(chrome?.firstSeen).toBe("2026-06-09T09:00:00Z");
    expect(chrome?.lastSeen).toBe("2026-06-09T09:05:00Z");
    // apps sorted by frames desc → Chrome before Ghostty
    expect(digest.apps[0]?.app).toBe("Chrome");
  });

  test("maps audio to snippets and ignores empty transcriptions", () => {
    const items: SearchItem[] = [
      {
        type: "Audio",
        content: {
          transcription: "let's ship it",
          speaker_label: "Marcel",
          timestamp: "2026-06-09T11:00:00Z",
        },
      },
      {
        type: "Audio",
        content: {
          transcription: "",
          speaker_label: "Marcel",
          timestamp: "2026-06-09T11:01:00Z",
        },
      },
    ];
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.audio.length).toBe(1);
    expect(digest.audio[0]).toEqual({
      speaker: "Marcel",
      text: "let's ship it",
      timestamp: "2026-06-09T11:00:00Z",
    });
  });

  test("empty input yields isEmpty digest", () => {
    const digest = condenseItems([], "2026-06-09");
    expect(digest.isEmpty).toBe(true);
    expect(digest.apps).toEqual([]);
    expect(digest.audio).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.condense.test.ts`
Expected: FAIL — `condenseItems` is not exported.

- [ ] **Step 3: Append the condenser to `src/screenpipe.ts`**

```ts
const MAX_APPS = 20;
const MAX_SAMPLE_TEXT_PER_APP = 8;
const MAX_TEXT_LEN = 200;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pushDistinct(arr: string[], value: string | null | undefined): void {
  if (value && value.trim() && !arr.includes(value)) arr.push(value);
}

const SCREEN_TYPES = new Set(["OCR", "UI", "Accessibility"]);

export function condenseItems(items: SearchItem[], dayKey: string): DayDigest {
  const byApp = new Map<string, AppActivityAcc>();
  const audio: DayDigest["audio"] = [];
  let totalFrames = 0;

  for (const item of items) {
    const c = item.content;
    if (item.type === "Audio") {
      const text = (c.transcription ?? c.text ?? "").trim();
      if (text)
        audio.push({
          speaker: c.speaker_label ?? null,
          text,
          timestamp: c.timestamp,
        });
      continue;
    }
    const app = (c.app_name ?? "Unknown").trim() || "Unknown";
    const acc = byApp.get(app) ?? newAcc();
    byApp.set(app, acc);
    if (SCREEN_TYPES.has(item.type)) totalFrames += 1;
    acc.frames += 1;
    pushDistinct(acc.windows, c.window_name ?? c.window_title);
    pushDistinct(acc.urls, c.browser_url);
    const text = c.text ?? c.text_content;
    if (text && text.trim()) {
      const snippet = truncate(text, MAX_TEXT_LEN);
      if (
        snippet &&
        acc.sampleText.length < MAX_SAMPLE_TEXT_PER_APP &&
        !acc.sampleText.includes(snippet)
      ) {
        acc.sampleText.push(snippet);
      }
    }
    if (!acc.firstSeen || c.timestamp < acc.firstSeen)
      acc.firstSeen = c.timestamp;
    if (!acc.lastSeen || c.timestamp > acc.lastSeen) acc.lastSeen = c.timestamp;
  }

  const apps: AppActivity[] = [...byApp.entries()]
    .map(([app, a]) => ({
      app,
      windows: a.windows,
      urls: a.urls,
      sampleText: a.sampleText,
      firstSeen: a.firstSeen ?? "",
      lastSeen: a.lastSeen ?? "",
      frames: a.frames,
    }))
    .sort((x, y) => y.frames - x.frames)
    .slice(0, MAX_APPS);

  return {
    dayKey,
    apps,
    audio,
    totalFrames,
    isEmpty: apps.length === 0 && audio.length === 0,
  };
}

interface AppActivityAcc {
  windows: string[];
  urls: string[];
  sampleText: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  frames: number;
}

function newAcc(): AppActivityAcc {
  return {
    windows: [],
    urls: [],
    sampleText: [],
    firstSeen: null,
    lastSeen: null,
    frames: 0,
  };
}
```

Also add the type imports at the top of `screenpipe.ts` — change the existing import line `import type { DayDigest } from "./types";` to:

```ts
import type { AppActivity, DayDigest } from "./types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.condense.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/screenpipe.ts src/screenpipe.condense.test.ts
git commit -m "✨ feat: deterministic day condenser"
```

### Task 8: `fetchDayActivity()` — wire client + condenser

**Files:**

- Modify: `~/code/screenpipe-distiller/src/screenpipe.ts` (append)
- Test: `~/code/screenpipe-distiller/src/screenpipe.fetch.test.ts`

- [ ] **Step 1: Write the failing test**

`src/screenpipe.fetch.test.ts`:

```ts
import { fetchDayActivity, ScreenpipeClient } from "./screenpipe";
import { describe, expect, test } from "bun:test";

describe("fetchDayActivity", () => {
  test("queries the three content types over the day window and condenses", async () => {
    const seen: string[] = [];
    const f = (async (input: URL) => {
      const ct = new URL(input).searchParams.get("content_type")!;
      seen.push(ct);
      const data =
        ct === "ocr"
          ? [
              {
                type: "OCR",
                content: {
                  app_name: "Chrome",
                  text: "hi",
                  timestamp: "2026-06-09T10:00:00Z",
                },
              },
            ]
          : [];
      return new Response(JSON.stringify({ data, pagination: {} }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new ScreenpipeClient("http://localhost:3030", "tok", f);
    const digest = await fetchDayActivity(
      client,
      "2026-06-09",
      "Europe/Brussels",
    );
    expect(seen.sort()).toEqual(["audio", "input", "ocr"]);
    expect(digest.apps[0]?.app).toBe("Chrome");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.fetch.test.ts`
Expected: FAIL — `fetchDayActivity` not exported.

- [ ] **Step 3: Append `fetchDayActivity` to `src/screenpipe.ts`**

```ts
export async function fetchDayActivity(
  client: ScreenpipeClient,
  dayKey: string,
  timeZone: string,
): Promise<DayDigest> {
  const { startIso, endIso } = dayWindowUtc(dayKey, timeZone);
  const [ocr, audio, input] = await Promise.all([
    client.searchAll({ contentType: "ocr", startIso, endIso, minLength: 50 }),
    client.searchAll({ contentType: "audio", startIso, endIso }),
    client.searchAll({ contentType: "input", startIso, endIso }),
  ]);
  return condenseItems([...ocr, ...audio, ...input], dayKey);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.fetch.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/screenpipe.ts src/screenpipe.fetch.test.ts
git commit -m "✨ feat: fetchDayActivity orchestration"
```

---

## Part E — Curation

### Task 9: `curation-prompt.ts` — the contract + user-prompt renderer

**Files:**

- Create: `~/code/screenpipe-distiller/src/curation-prompt.ts`
- Test: `~/code/screenpipe-distiller/src/curation-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

`src/curation-prompt.test.ts`:

```ts
import { CURATION_SYSTEM_PROMPT, buildUserPrompt } from "./curation-prompt";
import type { DayDigest } from "./types";
import { describe, expect, test } from "bun:test";

const digest: DayDigest = {
  dayKey: "2026-06-09",
  apps: [
    {
      app: "Ghostty",
      windows: ["zsh"],
      urls: [],
      sampleText: ["$ bun test"],
      firstSeen: "2026-06-09T10:00:00Z",
      lastSeen: "2026-06-09T11:00:00Z",
      frames: 12,
    },
  ],
  audio: [
    {
      speaker: "Marcel",
      text: "let's ship it",
      timestamp: "2026-06-09T11:00:00Z",
    },
  ],
  totalFrames: 12,
  isEmpty: false,
};

describe("curation prompt", () => {
  test("system prompt forbids action items and intent inference", () => {
    expect(CURATION_SYSTEM_PROMPT).toContain("No action items");
    expect(CURATION_SYSTEM_PROMPT.toLowerCase()).toContain("exposure");
  });

  test("user prompt renders apps, urls, and audio for the day", () => {
    const p = buildUserPrompt(digest);
    expect(p).toContain("2026-06-09");
    expect(p).toContain("Ghostty");
    expect(p).toContain("$ bun test");
    expect(p).toContain("let's ship it");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/curation-prompt.test.ts`
Expected: FAIL — cannot find module `./curation-prompt`.

- [ ] **Step 3: Write `src/curation-prompt.ts`**

```ts
/**
 * The curation contract (system prompt) + the digest→text renderer.
 * This is the core IP: it decides what becomes durable memory.
 */
import type { DayDigest } from "./types";

export const CURATION_SYSTEM_PROMPT = `You are a careful biographer condensing one day of a person's computer activity (Marcel's) into a short, durable record for a personal memory system. You receive a structured digest of apps used, windows, URLs, on-screen text snippets, and any spoken-audio transcripts.

Write a concise Markdown document capturing only what is worth remembering beyond today. Follow these rules strictly:

1. Durable over ephemeral. Record projects, people, organizations, tools, and sustained topics. Drop window-focus mechanics, idle gaps, and one-off lookups that led nowhere.
2. No action items. Never write todos, follow-ups, "should"/"could"/"next steps", or checkboxes. There is NO action-items section.
3. Evidence-grounded, no intent inference. Describe what was done or seen ("spent time editing extract-graph.ts in the assistant-memory repo"). Never infer why, and never assert preferences, decisions, goals, or plans from mere viewing.
4. Entity-first. Name concrete people, orgs, repos, tools, and the titles/URLs of articles or videos. Concrete entities matter most.
5. Consolidate. Write a synthesized narrative, not a minute-by-minute log.
6. Honest about sparsity. If the day was light or idle, say so in one line. Never pad or invent.
7. Exposure is not intent. "Read about X" / "watched a video on Y" — never "wants to do X" or "is planning Y".

Output ONLY the Markdown document, using exactly these section headers (omit a section if it has nothing real to say):

# Computer activity — <date>

## What I worked on
## People & conversations
## Tools & environment
## Read & explored
## Notes`;

export function buildUserPrompt(digest: DayDigest): string {
  const lines: string[] = [
    `Date: ${digest.dayKey}`,
    `Total screen frames: ${digest.totalFrames}`,
    "",
    "## Apps",
  ];
  for (const a of digest.apps) {
    lines.push(
      `### ${a.app} (${a.frames} frames, ${a.firstSeen.slice(11, 16)}–${a.lastSeen.slice(11, 16)} UTC)`,
    );
    if (a.windows.length)
      lines.push(`- windows: ${a.windows.slice(0, 6).join(" | ")}`);
    if (a.urls.length) lines.push(`- urls: ${a.urls.slice(0, 10).join(" , ")}`);
    for (const t of a.sampleText) lines.push(`- text: ${t}`);
  }
  if (digest.audio.length) {
    lines.push("", "## Audio");
    for (const s of digest.audio)
      lines.push(`- ${s.speaker ?? "?"}: ${s.text}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/curation-prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/curation-prompt.ts src/curation-prompt.test.ts
git commit -m "✨ feat: curation contract prompt + digest renderer"
```

### Task 10: `curate.ts` — OpenRouter call (LLM mocked in tests)

**Files:**

- Create: `~/code/screenpipe-distiller/src/curate.ts`
- Test: `~/code/screenpipe-distiller/src/curate.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake OpenAI-shaped client; per house rule we only ever mock the external AI)

`src/curate.test.ts`:

```ts
import type { Config } from "./config";
import { curateDigest, type ChatClient } from "./curate";
import type { DayDigest } from "./types";
import { describe, expect, test } from "bun:test";

const config = {
  CURATION_MODEL: "test/model",
  OPENROUTER_API_KEY: "k",
} as Config;

const nonEmpty: DayDigest = {
  dayKey: "2026-06-09",
  apps: [
    {
      app: "Ghostty",
      windows: [],
      urls: [],
      sampleText: ["x"],
      firstSeen: "2026-06-09T10:00:00Z",
      lastSeen: "2026-06-09T11:00:00Z",
      frames: 3,
    },
  ],
  audio: [],
  totalFrames: 3,
  isEmpty: false,
};

describe("curateDigest", () => {
  test("short-circuits an empty day without calling the LLM", async () => {
    let called = false;
    const client: ChatClient = {
      create: async () => {
        called = true;
        return { content: "x" };
      },
    };
    const empty: DayDigest = {
      dayKey: "2026-06-09",
      apps: [],
      audio: [],
      totalFrames: 0,
      isEmpty: true,
    };
    const doc = await curateDigest(empty, config, client);
    expect(called).toBe(false);
    expect(doc.isEmptyDay).toBe(true);
    expect(doc.markdown).toContain("2026-06-09");
  });

  test("sends system + user messages and returns the model markdown", async () => {
    let captured: { model: string; system: string; user: string } | null = null;
    const client: ChatClient = {
      create: async ({ model, messages }) => {
        captured = {
          model,
          system: messages[0]!.content,
          user: messages[1]!.content,
        };
        return {
          content:
            "# Computer activity — 2026-06-09\n\n## What I worked on\n- stuff",
        };
      },
    };
    const doc = await curateDigest(nonEmpty, config, client);
    expect(captured!.model).toBe("test/model");
    expect(captured!.system).toContain("No action items");
    expect(captured!.user).toContain("Ghostty");
    expect(doc.isEmptyDay).toBe(false);
    expect(doc.markdown).toContain("What I worked on");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/curate.test.ts`
Expected: FAIL — cannot find module `./curate`.

- [ ] **Step 3: Write `src/curate.ts`**

```ts
/**
 * Curates a day digest into a Markdown activity document via OpenRouter.
 * The OpenAI client is injectable so tests mock only the external AI.
 */
import type { Config } from "./config";
import { CURATION_SYSTEM_PROMPT, buildUserPrompt } from "./curation-prompt";
import type { CuratedDoc, DayDigest } from "./types";
import OpenAI from "openai";

export class CurationError extends Error {}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Minimal seam over the OpenAI chat API so tests can inject a fake. */
export interface ChatClient {
  create(args: {
    model: string;
    messages: ChatMessage[];
  }): Promise<{ content: string | null }>;
}

function openRouterClient(config: Config): ChatClient {
  const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.OPENROUTER_API_KEY,
  });
  return {
    create: async ({ model, messages }) => {
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.2,
      });
      return { content: completion.choices[0]?.message?.content ?? null };
    },
  };
}

function emptyDayMarkdown(dayKey: string): string {
  return `# Computer activity — ${dayKey}\n\n## Notes\nMinimal or no recorded computer activity for this day.`;
}

export async function curateDigest(
  digest: DayDigest,
  config: Config,
  client?: ChatClient,
): Promise<CuratedDoc> {
  if (digest.isEmpty)
    return { markdown: emptyDayMarkdown(digest.dayKey), isEmptyDay: true };
  const chat = client ?? openRouterClient(config);
  const { content } = await chat.create({
    model: config.CURATION_MODEL,
    messages: [
      { role: "system", content: CURATION_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(digest) },
    ],
  });
  const markdown = content?.trim();
  if (!markdown) throw new CurationError("curation returned empty content");
  return { markdown, isEmptyDay: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/curate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/curate.ts src/curate.test.ts
git commit -m "✨ feat: curate day digest via openrouter (injectable client)"
```

---

## Part F — Upload

### Task 11: `upload.ts` — Petals document ingest with retry

**Files:**

- Create: `~/code/screenpipe-distiller/src/upload.ts`
- Test: `~/code/screenpipe-distiller/src/upload.test.ts`

- [ ] **Step 1: Write the failing test**

`src/upload.test.ts`:

```ts
import type { Config } from "./config";
import { buildDocumentBody, uploadDocument, UploadError } from "./upload";
import { describe, expect, test } from "bun:test";

const config = {
  PETALS_BASE_URL: "https://petals.chat",
  PETALS_API_KEY: "petals-k",
} as Config;
const doc = {
  id: "screenpipe-activity-2026-06-09",
  content: "# x",
  title: "Computer activity — 2026-06-09",
  timestampIso: "2026-06-09T12:00:00Z",
};

describe("upload", () => {
  test("buildDocumentBody produces a personal-scope markdown document", () => {
    const body = buildDocumentBody(doc);
    expect(body.document.scope).toBe("personal");
    expect(body.document.contentType).toBe("markdown");
    expect(body.document.id).toBe("screenpipe-activity-2026-06-09");
    expect(body).not.toHaveProperty("mode"); // v1 sends no mode
  });

  test("returns jobId on 2xx and sends x-api-key", async () => {
    let headerSeen = "";
    const f = (async (_url: string, init: RequestInit) => {
      headerSeen = new Headers(init.headers).get("x-api-key") ?? "";
      return new Response(JSON.stringify({ message: "ok", jobId: "job_1" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, config, {
      fetchImpl: f,
      sleep: async () => {},
    });
    expect(res.jobId).toBe("job_1");
    expect(headerSeen).toBe("petals-k");
  });

  test("throws UploadError on 4xx without retrying", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      uploadDocument(doc, config, { fetchImpl: f, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(calls).toBe(1);
  });

  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 2
        ? new Response("err", { status: 503 })
        : new Response(JSON.stringify({ message: "ok", jobId: "job_2" }), {
            status: 200,
          });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, config, {
      fetchImpl: f,
      sleep: async () => {},
    });
    expect(res.jobId).toBe("job_2");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/upload.test.ts`
Expected: FAIL — cannot find module `./upload`.

- [ ] **Step 3: Write `src/upload.ts`**

```ts
/**
 * Uploads a curated activity document to Assistant Memory via the hosted
 * Petals proxy. Idempotent on document.id; retries network/5xx with backoff.
 */
import type { Config } from "./config";
import { z } from "zod";

export class UploadError extends Error {}

export interface DocPayload {
  id: string;
  content: string;
  title: string;
  timestampIso: string;
}

const uploadResponseSchema = z
  .object({ message: z.string(), jobId: z.string() })
  .passthrough();

export function buildDocumentBody(p: DocPayload) {
  return {
    document: {
      id: p.id,
      content: p.content,
      contentType: "markdown",
      scope: "personal",
      title: p.title,
      timestamp: p.timestampIso,
    },
  } as const;
}

interface UploadDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function uploadDocument(
  p: DocPayload,
  config: Config,
  deps: UploadDeps = {},
): Promise<{ jobId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = `${config.PETALS_BASE_URL}/api/memory/ingest/document`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.PETALS_API_KEY,
    },
    body: JSON.stringify(buildDocumentBody(p)),
  };

  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastErr = e; // network error → retry
    }
    if (res) {
      if (res.ok)
        return { jobId: uploadResponseSchema.parse(await res.json()).jobId };
      const text = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new UploadError(`Petals rejected upload ${res.status}: ${text}`);
      }
      lastErr = new UploadError(`Petals upload failed ${res.status}: ${text}`); // 5xx → retry
    }
    if (attempt < maxAttempts) await sleep(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error
    ? lastErr
    : new UploadError("upload failed after retries");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/upload.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/upload.ts src/upload.test.ts
git commit -m "✨ feat: petals document upload with retry/backoff"
```

---

## Part G — Orchestrator + CLI

### Task 12: `distill.ts` — `runDistill()` wiring

**Files:**

- Create: `~/code/screenpipe-distiller/src/distill.ts`
- Test: `~/code/screenpipe-distiller/src/distill.test.ts`

- [ ] **Step 1: Write the failing test** (inject all three seams so no network/LLM is hit)

`src/distill.test.ts`:

```ts
import type { Config } from "./config";
import { runDistill, type DistillDeps } from "./distill";
import type { DayDigest } from "./types";
import { describe, expect, test } from "bun:test";

const config = { USER_TIMEZONE: "Europe/Brussels" } as Config;

describe("runDistill", () => {
  test("fetch → curate → upload, returning the jobId", async () => {
    const digest: DayDigest = {
      dayKey: "2026-06-09",
      apps: [
        {
          app: "Ghostty",
          windows: [],
          urls: [],
          sampleText: [],
          firstSeen: "",
          lastSeen: "",
          frames: 1,
        },
      ],
      audio: [],
      totalFrames: 1,
      isEmpty: false,
    };
    let uploadedId = "";
    const deps: DistillDeps = {
      fetchDay: async () => digest,
      curate: async () => ({ markdown: "# doc", isEmptyDay: false }),
      upload: async (p) => {
        uploadedId = p.id;
        return { jobId: "job_9" };
      },
    };
    const res = await runDistill("2026-06-09", config, deps);
    expect(res.jobId).toBe("job_9");
    expect(uploadedId).toBe("screenpipe-activity-2026-06-09");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/distill.test.ts`
Expected: FAIL — cannot find module `./distill`.

- [ ] **Step 3: Write `src/distill.ts`**

```ts
/**
 * Orchestrates one day's distillation: fetch → curate → upload.
 * Seams are injectable for testing; defaults wire the real implementations.
 */
import type { Config } from "./config";
import { curateDigest } from "./curate";
import { ScreenpipeClient, fetchDayActivity } from "./screenpipe";
import type { CuratedDoc, DayDigest } from "./types";
import { uploadDocument, type DocPayload } from "./upload";

export interface DistillDeps {
  fetchDay: (dayKey: string) => Promise<DayDigest>;
  curate: (digest: DayDigest) => Promise<CuratedDoc>;
  upload: (p: DocPayload) => Promise<{ jobId: string }>;
}

function defaultDeps(config: Config): DistillDeps {
  const client = new ScreenpipeClient(
    config.SCREENPIPE_API_URL,
    config.SCREENPIPE_API_KEY,
  );
  return {
    fetchDay: (dayKey) =>
      fetchDayActivity(client, dayKey, config.USER_TIMEZONE),
    curate: (digest) => curateDigest(digest, config),
    upload: (p) => uploadDocument(p, config),
  };
}

export async function runDistill(
  dayKey: string,
  config: Config,
  deps: DistillDeps = defaultDeps(config),
): Promise<{ jobId: string; isEmptyDay: boolean }> {
  const digest = await deps.fetchDay(dayKey);
  const doc = await deps.curate(digest);
  const { jobId } = await deps.upload({
    id: `screenpipe-activity-${dayKey}`,
    content: doc.markdown,
    title: `Computer activity — ${dayKey}`,
    timestampIso: `${dayKey}T12:00:00Z`,
  });
  return { jobId, isEmptyDay: doc.isEmptyDay };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/distill.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/distill.ts src/distill.test.ts
git commit -m "✨ feat: runDistill orchestrator"
```

### Task 13: `main.ts` — CLI entry

**Files:**

- Create: `~/code/screenpipe-distiller/src/main.ts`

- [ ] **Step 1: Write `src/main.ts`** (thin entry; logic is tested in distill.test.ts)

```ts
/** CLI: `bun run distill [--date YYYY-MM-DD]` (default: yesterday). */
import { loadConfig } from "./config";
import { yesterdayKey } from "./date-utils";
import { runDistill } from "./distill";

function parseDateArg(argv: string[], timeZone: string): string {
  const idx = argv.indexOf("--date");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error("--date must be YYYY-MM-DD");
    return value;
  }
  return yesterdayKey(new Date(), timeZone);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dayKey = parseDateArg(process.argv.slice(2), config.USER_TIMEZONE);
  console.log(`[distill] day=${dayKey} tz=${config.USER_TIMEZONE}`);
  const { jobId, isEmptyDay } = await runDistill(dayKey, config);
  console.log(
    `[distill] uploaded day=${dayKey} jobId=${jobId} emptyDay=${isEmptyDay}`,
  );
}

main().catch((err) => {
  console.error("[distill] failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the whole project**

Run: `cd ~/code/screenpipe-distiller && bun run type-check`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `cd ~/code/screenpipe-distiller && bun test`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/main.ts
git commit -m "✨ feat: distill CLI entry"
```

---

## Part H — Health check

### Task 14: `health.ts` — recording-health nudge

**Files:**

- Create: `~/code/screenpipe-distiller/src/health.ts`
- Test: `~/code/screenpipe-distiller/src/health.test.ts`

- [ ] **Step 1: Write the failing test**

`src/health.test.ts`:

```ts
import { evaluateHealth } from "./health";
import { describe, expect, test } from "bun:test";

describe("evaluateHealth", () => {
  test("flags audio stall and frame staleness", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const r = evaluateHealth(
      { status: "degraded", audio_db_write_stalled: true },
      "2026-06-10T09:00:00Z", // newest frame 3h old
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("audio"))).toBe(true);
    expect(r.problems.some((p) => p.includes("stale"))).toBe(true);
  });

  test("healthy when recording fresh and audio fine", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const r = evaluateHealth(
      { status: "healthy", audio_db_write_stalled: false },
      "2026-06-10T11:58:00Z",
      now,
    );
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/screenpipe-distiller && bun test src/health.test.ts`
Expected: FAIL — cannot find module `./health`.

- [ ] **Step 3: Write `src/health.ts`**

```ts
/**
 * Checks Screenpipe recording health and notifies (macOS) when it is down,
 * stale, or audio transcription has stalled. Read-only; no memory writes.
 */
import { loadConfig, type Config } from "./config";
import { ScreenpipeClient } from "./screenpipe";
import { z } from "zod";

const STALE_FRAMES_MINUTES = 30;

const healthSchema = z
  .object({
    status: z.string().nullish(),
    audio_db_write_stalled: z.boolean().nullish(),
  })
  .passthrough();

export interface HealthResult {
  ok: boolean;
  problems: string[];
}

export function evaluateHealth(
  health: z.infer<typeof healthSchema>,
  newestFrameIso: string | null,
  now: Date,
): HealthResult {
  const problems: string[] = [];
  if (health.status && health.status !== "healthy")
    problems.push(`recording status: ${health.status}`);
  if (health.audio_db_write_stalled)
    problems.push("audio transcription stalled");
  if (!newestFrameIso) {
    problems.push("no recent frames found");
  } else {
    const ageMin =
      (now.getTime() - new Date(newestFrameIso).getTime()) / 60_000;
    if (ageMin > STALE_FRAMES_MINUTES)
      problems.push(`screen capture stale (${Math.round(ageMin)}m old)`);
  }
  return { ok: problems.length === 0, problems };
}

async function newestFrameIso(
  client: ScreenpipeClient,
  now: Date,
): Promise<string | null> {
  const since = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const items = await client.search({
    contentType: "ocr",
    startIso: since,
    endIso: now.toISOString(),
    limit: 1,
    offset: 0,
  });
  return items[0]?.content.timestamp ?? null;
}

async function notify(title: string, message: string): Promise<void> {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await Bun.spawn(["osascript", "-e", script]).exited;
}

async function main(): Promise<void> {
  const config: Config = loadConfig();
  const now = new Date();
  const res = await fetch(`${config.SCREENPIPE_API_URL}/health`);
  const health = healthSchema.parse(await res.json());
  const client = new ScreenpipeClient(
    config.SCREENPIPE_API_URL,
    config.SCREENPIPE_API_KEY,
  );
  const newest = await newestFrameIso(client, now).catch(() => null);
  const result = evaluateHealth(health, newest, now);
  if (!result.ok) {
    console.warn("[health] problems:", result.problems);
    await notify("Screenpipe needs attention", result.problems.join("; "));
  } else {
    console.log("[health] ok");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[health] check failed:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/screenpipe-distiller && bun test src/health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/health.ts src/health.test.ts
git commit -m "✨ feat: screenpipe recording health-check + macos notify"
```

---

## Part I — Scheduling + live verification

### Task 15: launchd plists, install script, and a real distill run

**Files:**

- Create: `~/code/screenpipe-distiller/launchd/com.marcel.screenpipe-distiller.daily.plist`
- Create: `~/code/screenpipe-distiller/launchd/com.marcel.screenpipe-distiller.health.plist`
- Create: `~/code/screenpipe-distiller/scripts/install-schedules.sh`

- [ ] **Step 1: Write the daily distiller plist**

`launchd/com.marcel.screenpipe-distiller.daily.plist` (runs yesterday's distill at 08:00; `bun run distill` reads `.env` from the repo working dir):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marcel.screenpipe-distiller.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>distill</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/marcel/code/screenpipe-distiller</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/marcel/code/screenpipe-distiller/distill.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/marcel/code/screenpipe-distiller/distill.err.log</string>
</dict>
</plist>
```

Note: Bun auto-loads `.env` from `WorkingDirectory`, so secrets stay in the gitignored `.env`, not the plist. Targeting _yesterday_ + idempotent `document.id` makes the exact fire time irrelevant; launchd also runs a missed 08:00 job once on the next wake/boot.

- [ ] **Step 2: Write the health-check plist** (twice daily: 12:00 and 20:00)

`launchd/com.marcel.screenpipe-distiller.health.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marcel.screenpipe-distiller.health</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>health-check</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/marcel/code/screenpipe-distiller</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/marcel/code/screenpipe-distiller/health.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/marcel/code/screenpipe-distiller/health.err.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Write the schedule install script**

`scripts/install-schedules.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
for plist in com.marcel.screenpipe-distiller.daily com.marcel.screenpipe-distiller.health; do
  cp "$REPO/launchd/$plist.plist" "$AGENTS/"
  launchctl unload "$AGENTS/$plist.plist" 2>/dev/null || true
  launchctl load "$AGENTS/$plist.plist"
  echo "loaded $plist"
done
```

- [ ] **Step 4: Set up `.env` and do a REAL distill run (the integration gate)**

This is the one place we hit real services. The user must supply secrets first.

```bash
cd ~/code/screenpipe-distiller
cp -n .env.example .env
# Fill in .env:
#   SCREENPIPE_API_KEY  -> output of: screenpipe auth token
#   PETALS_API_KEY      -> mint in Petals → Settings → API Keys (prefix petals-)
#   OPENROUTER_API_KEY  -> your OpenRouter key
# Then run a recent, data-rich day (2026-06-05 had ~2700 frames):
bun run distill --date 2026-06-05
```

Expected: logs `[distill] uploaded day=2026-06-05 jobId=… emptyDay=false`. If the day is empty, try `2026-06-05`/`2026-06-06`.

- [ ] **Step 5: Verify the document landed in memory and reads cleanly**

Wait ~30s for async extraction, then confirm in Petals (open the app and check the source list / memory explorer for "Computer activity — 2026-06-05") OR re-run and confirm idempotency (same `document.id`, no duplicate). **Manually read the produced Markdown** (`bun run distill --date 2026-06-05 2>/dev/null` prints the jobId; to inspect the doc itself, temporarily log `doc.markdown` in `main.ts`, or fetch the source from Petals). Confirm: no "Action Items" section, entities are concrete, no invented intent. This is the judgment gate before trusting the schedule.

- [ ] **Step 6: Install the schedules**

Run: `chmod +x ~/code/screenpipe-distiller/scripts/install-schedules.sh && ~/code/screenpipe-distiller/scripts/install-schedules.sh`
Expected: "loaded com.marcel.screenpipe-distiller.daily", "loaded com.marcel.screenpipe-distiller.health".

- [ ] **Step 7: Smoke-test the health-check end to end**

Run: `cd ~/code/screenpipe-distiller && bun run health-check`
Expected: prints `[health] problems: …` including the known audio stall (and fires a macOS notification), or `[health] ok`. Either confirms the path works.

- [ ] **Step 8: Commit**

```bash
cd ~/code/screenpipe-distiller
git add launchd/com.marcel.screenpipe-distiller.daily.plist launchd/com.marcel.screenpipe-distiller.health.plist scripts/install-schedules.sh
git commit -m "✨ feat: daily distill + health-check launchd schedules"
```

---

## Phase 2 — DEFERRED (do not build in v1)

The `observed` extraction mode (spec §2) is intentionally **not** in this plan. Build it only if v1 output shows the residual candidate-task noise or document-author framing is worth the cross-repo release (6-hop `mode` threading + `observed` provenance + DB migration + `@marcelsamyn/memory` SDK release + Petals dep bump + redeploy). When that decision is made, write a separate plan from spec §2; the verbatim edit points are catalogued in the recon (`assistant-memory` edit table + Petals SDK-bump requirement).

## Follow-up — fix Screenpipe audio (separate, tracked)

Memory: `screenpipe-audio-transcription-broken`. Lead: `audio_level_rms: 0.0` = capturing silence → check input-device selection (`screenpipe audio list-devices`, `record --audio-device`) before suspecting the transcription model. Unblocks the "People & conversations" dimension. Not part of v1.
