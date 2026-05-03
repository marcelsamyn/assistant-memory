# Numerical Metrics Tracking

## Goal

Add first-class support for numerical tracking data (running pace, heart rate, Oura readiness, body weight, etc.) to Assistant Memory. Today, claims handle facts and relationships; they are not the right substrate for thousands of timestamped numeric readings with units, range queries, and aggregations.

This design introduces a metrics subsystem that:

- Stores readings in a dedicated time-series shape, separate from `claims`.
- Maintains a per-user **schema registry** (metric definitions) so the same concept doesn't get re-invented under different names across conversations.
- Accepts data through three paths — bulk push (from upstream like n8n + Oura), explicit single writes (REST/MCP), and implicit extraction during normal conversation/document ingestion — sharing one writer.
- Bridges into the existing graph: a metric reading can hang off an *event node* (a Run, a Sleep, etc.) so the existing search/atlas/timeline machinery surfaces metric-bearing moments naturally.
- Surfaces uncertain new schema decisions as `Task` commitments so they appear in the next conversation's bootstrap bundle.
- Exposes a small, focused read API for charts (Petals) and conversational queries (the agent via MCP).

Non-goals for v1:

- Pulling from external APIs. Memory is push-only; integrations live upstream (n8n).
- Non-numeric metrics (boolean "took meds today", enum "mood: tired"). Those are claims, not metrics.
- Cross-user aggregation. Definitions are per-user.
- Tags / arbitrary metadata on observations. Free-form `note` only.
- Metric deletion / merging tooling beyond what falls out of normal node operations on the review Task.

## Data Model

Three new tables, all per-user, all keyed by typeid.

### `metric_definitions`

The schema registry. One row per distinct trackable quantity for a user.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `typeid('metric_def')` | PK. |
| `userId` | `text` | FK → `users.id`. |
| `slug` | `text` | Stable, immutable identifier (e.g. `running_pace_min_per_km`). Unique per `(userId, slug)`. |
| `label` | `text` | Human display name. Mutable. |
| `description` | `text` | Used both for embedding-based dedup and to help the extractor disambiguate. |
| `unit` | `text` | Canonical unit string (e.g. `min/km`, `bpm`, `seconds`, `kg`). All observations are stored in this unit. |
| `aggregationHint` | `varchar` | One of `avg | sum | min | max`. Default aggregation when callers don't override. Set at definition time (steps→sum, HR→avg). |
| `validRangeMin` | `numeric` (nullable) | Optional sanity bound. Observations outside the range are rejected with a typed error. |
| `validRangeMax` | `numeric` (nullable) | Same. |
| `needsReview` | `boolean` | True when the definition was created in the medium-confidence dedup band (see below). Cleared when the linked Task is closed. |
| `reviewTaskNodeId` | `typeid('node')` (nullable) | When `needsReview = true`, points at the open `Task` node so the API and Petals can surface and resolve it. Nullable; no FK in the reverse direction. |
| `createdAt`, `updatedAt` | `timestamptz` | |

Indexes:

- `unique(userId, slug)`
- `index(userId)`
- `index(userId, needsReview) where needsReview = true` — partial, for review surfacing.

Embeddings:

- A `metric_definition_embeddings` row per definition (`{label}\n{description}` concatenation), mirroring the `node_embeddings` / `claim_embeddings` pattern. Used solely for dedup at definition-creation time.

### `metric_observations`

The fact rows. Append-only in normal operation.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `typeid('metric_obs')` | PK. |
| `userId` | `text` | FK → `users.id`. Denormalized for index efficiency. |
| `metricDefinitionId` | `typeid('metric_def')` | FK, cascade delete. |
| `value` | `numeric` | In the metric's canonical unit. For durations, canonical is seconds. |
| `occurredAt` | `timestamptz` | The real-world time of the reading, not the ingest time. |
| `note` | `text` (nullable) | Free-form text preserved alongside the reading (e.g. "felt sluggish"). No semantic meaning to the system. |
| `eventNodeId` | `typeid('node')` (nullable) | Optional bridge to the graph: the event node this reading belongs to (a `Run`, `Sleep`, `Workout`, etc.). Set by the implicit extractor; null for bulk push and ad-hoc single writes. |
| `sourceId` | `typeid('source')` | FK → `sources.id`. Same source-tracking model as claims; cascade delete with the source. |
| `createdAt` | `timestamptz` | Ingest time. |

Indexes:

- `index(userId, metricDefinitionId, occurredAt desc)` — primary read path for series queries.
- `index(userId, occurredAt desc)` — for cross-metric dashboards in time order.
- `index(eventNodeId) where eventNodeId is not null` — for "show me this run's metrics" reverse lookups.
- `index(sourceId)` — for source-cascade queries.

No tags column. No unit column (canonical-unit-only is enforced at write time).

### Relationship to existing tables

- `sources` — every observation has a source, exactly like a claim. New `SourceType` value: `metric_push` (for bulk wearable data) and `metric_manual` (for ad-hoc agent / REST writes). The implicit extraction path reuses the conversation/document source the claims came from.
- `nodes` — `eventNodeId` references nodes the extractor creates (typically `Event` nodeType, possibly a new `Activity` later if useful — out of scope for v1).
- `claims` — untouched. The "felt sluggish" half of "ran 5k, felt sluggish" remains a claim on the Run event node, exactly as today.

## Schema Dedup (Definition Creation)

The hardest correctness problem: multiple ingestion paths inventing slightly different definitions for the same concept (`running_pace` vs `run_pace`).

When the writer is asked to create or use a definition, it goes through this resolver:

1. **Exact slug match** on `(userId, slug)` → reuse.
2. **Embedding similarity** against existing per-user definitions, using `{label}\n{description}` as the embedding text:
   - **Cosine ≥ 0.85** → return the existing definition. The proposal is silently merged.
   - **0.70 ≤ cosine < 0.85** → create the new definition with `needsReview = true`. Atomically:
     - Insert the new `metric_definitions` row.
     - Create a `Task` node ("Review proposed metric: '<label>' — possible duplicate of '<existingLabel>'") with `HAS_TASK_STATUS = pending`.
     - Store the task node id on the definition row as `reviewTaskNodeId`.
     - The Task carries a claim back to both the proposed and the candidate-duplicate definition node, so the agent can resolve by merging or accepting via existing claim/node operations.
   - **Cosine < 0.70** → create the definition outright. `needsReview = false`.

3. **Range guard** on every observation write: if `validRangeMin/Max` is set and the value falls outside, reject the write with a typed error. Bulk push gets a per-row error array; single writes get a 4xx.

The Task surfacing piggybacks on the existing `open_commitments` machinery: no new bootstrap section, no new MCP tool. The agent already pulls open commitments and will see "review metric" tasks alongside everything else.

Threshold values (0.85, 0.70) are configurable constants in the metrics module; tuning happens in code review of evals, not at runtime.

## Ingestion Paths

All three paths funnel into one internal `recordMetricObservations` writer that handles definition resolution, range validation, and observation insert in a single transaction per call.

### 1. Bulk push (REST)

`POST /metrics/observations/bulk` — for n8n / wearable forwarders.

```json
{
  "userId": "user_123",
  "sourceExternalId": "oura_2026-05-03",
  "observations": [
    { "metricSlug": "oura_readiness", "value": 87, "occurredAt": "2026-05-03T07:14:00Z" },
    { "metricSlug": "resting_hr",     "value": 54, "occurredAt": "2026-05-03T07:14:00Z" }
  ]
}
```

- One source row per call (created if `sourceExternalId` is new; type = `metric_push`).
- Definitions referenced by `slug` only — bulk push does **not** invent new definitions. If the slug doesn't exist, the response includes a per-row error and the row is skipped. (Rationale: bulk pipelines should fail loudly when the user hasn't yet authorized a new metric, rather than silently accreting schema.)
- Returns `{ inserted: number, errors: [{ index, code, message }] }`.

### 2. Single explicit write (REST + MCP)

`POST /metrics/observations` and the MCP tool `record_metric`:

```json
{
  "userId": "user_123",
  "metric": { "slug": "body_weight", "label": "Body weight", "unit": "kg",
              "aggregationHint": "avg", "description": "Morning weight on bathroom scale" },
  "value": 78.2,
  "occurredAt": "2026-05-03T07:30:00Z",
  "note": "post-run"
}
```

- The `metric` block describes the definition. The resolver runs (slug → embedding → create). On a fresh definition, the response includes `definitionCreated: true` and `needsReview` + `reviewTaskNodeId`.
- One source row per call (`type = metric_manual`).

### 3. Implicit extraction (during conversation/document ingestion)

The existing claim-extraction prompt in `lib/jobs/ingest-conversation.ts` and `lib/jobs/ingest-document.ts` gains an *optional* `metrics` array in its return schema. The extractor is told:

- Extract numeric quantities the user is tracking about themselves.
- Group readings that belong to one event (a single run, a single sleep) — emit one event with multiple observations rather than free-floating readings.
- For each metric, propose `slug`, `label`, `unit`, `aggregationHint`, and `description` exactly as you would for a single explicit write. The dedup resolver will normalize.

Returned shape:

```json
{
  "claims": [...],          // existing
  "metrics": {
    "events": [
      {
        "label": "Morning run",
        "occurredAt": "2026-05-03T06:30:00Z",
        "observations": [
          { "metric": { "slug": "running_distance_km", ... }, "value": 5.0,   "note": null },
          { "metric": { "slug": "running_pace_min_per_km", ... }, "value": 5.5, "note": null },
          { "metric": { "slug": "running_avg_hr", ... }, "value": 158, "note": "felt sluggish" }
        ]
      }
    ],
    "standalone": [
      { "metric": { "slug": "body_weight", ... }, "value": 78.2, "occurredAt": "...", "note": null }
    ]
  }
}
```

Writer behavior:

- For each event: create a `Node` of nodeType `Event` (with metadata label = event label) **atomically with** writing observations carrying `eventNodeId`.
- For standalone: write observations with `eventNodeId = null`.
- All writes share the conversation/document `sourceId` from the parent ingestion job.
- The same dedup resolver runs per definition.

If the model returns an empty `metrics` object (the common case), the path is a no-op and adds essentially zero cost.

## Read API

All routes follow the existing POST-with-JSON convention. Each REST route has a parallel MCP tool with the same shape and a curated tool description (mirroring the pattern in `lib/mcp/tool-descriptions.ts`).

### `POST /metrics/list` — `list_metrics`

Returns metric definitions for a user.

Body: `{ userId, filter?: { active?: boolean, needsReview?: boolean, search?: string } }`

Response per item:

```json
{
  "id": "metric_def_...",
  "slug": "running_pace_min_per_km",
  "label": "Running pace",
  "unit": "min/km",
  "aggregationHint": "avg",
  "validRange": { "min": 2, "max": 12 },
  "needsReview": false,
  "reviewTaskNodeId": null,
  "stats": {
    "observationCount": 42,
    "firstAt": "2026-01-04T...",
    "latestAt": "2026-05-03T...",
    "latestValue": 5.5
  }
}
```

`stats` are computed from `metric_observations`; for a heavy-write user this becomes the only expensive part of the query. Implementation can lean on a simple per-definition stats cache invalidated on observation insert if it becomes hot — out of scope for v1 unless evals show it.

### `POST /metrics/series` — `get_metric_series`

The workhorse. Bucketed multi-metric time series.

Body:

```json
{
  "userId": "user_123",
  "metricIds": ["metric_def_...", "metric_def_..."],
  "from": "2026-04-01T00:00:00Z",
  "to":   "2026-05-03T23:59:59Z",
  "bucket": "day",                         // "none" | "hour" | "day" | "week" | "month"
  "agg": "avg"                              // "avg" | "sum" | "min" | "max" | "p50" | "p90"
}
```

- `agg` is optional; if omitted, each metric uses its own `aggregationHint`.
- `bucket: "none"` returns raw observations (use case: small ranges, raw scatter plots). Server caps row count and returns a `truncated: true` flag if exceeded.
- Response is one series per requested `metricId`, each `{ metricId, points: [{ t, value }] }`. Bucket boundaries are aligned to UTC; client-side timezone handling is the caller's job.

Backed by Postgres `date_trunc` for bucketing and standard aggregates / `percentile_cont` for `p50` / `p90`. No TimescaleDB dependency in v1; revisit only if observation counts make this slow in real use.

### `POST /metrics/summary` — `get_metric_summary`

For "what's my resting HR been doing" chat questions where a series is overkill.

Body: `{ userId, metricId }`

Response:

```json
{
  "metricId": "metric_def_...",
  "latest": { "value": 54, "occurredAt": "..." },
  "windows": {
    "7d":  { "avg": 55.1, "min": 52, "max": 58, "count": 7 },
    "30d": { "avg": 56.0, "min": 50, "max": 61, "count": 28 },
    "90d": { "avg": 57.2, "min": 50, "max": 64, "count": 84 }
  },
  "trend": "down"   // "up" | "down" | "flat" — derived from 30d vs 90d window comparison
}
```

`trend` uses the metric's `aggregationHint` to pick the comparison statistic.

### No raw `get_observations` endpoint

`get_metric_series` with `bucket: "none"` covers raw access. Less surface area to evolve.

## Source Linking and Lifecycle

- Observations follow source cascade: deleting a source deletes its observations (mirrors claim behavior).
- Definitions are *not* deleted by source operations. A definition outlives any single ingestion source.
- An observation is never updated in place. Re-ingestion of the same conversation reuses the same `sourceId` (existing source-upsert behavior in `insert-new-sources.ts`); the writer first deletes existing observations for that source, then re-inserts. This matches how claims handle re-ingestion.

## SDK and MCP

New SDK schemas under `src/lib/schemas/`:

- `metric-definition.ts` — definition shape + zod schemas.
- `metric-observation.ts` — observation shape + zod schemas.
- `metric-write-bulk.ts`, `metric-write-single.ts` — write request/response.
- `metric-list.ts`, `metric-series.ts`, `metric-summary.ts` — read request/response.

New MCP tools registered in `lib/mcp/mcp-server.ts`:

- `record_metric` — single explicit write.
- `list_metrics` — definitions + stats.
- `get_metric_series` — bucketed series.
- `get_metric_summary` — single-metric summary.

Tool descriptions live in `lib/mcp/tool-descriptions.ts` alongside the existing ones, with snapshot tests pinning them.

No bulk-push MCP tool — bulk push is a server-to-server REST concern, not an LLM concern.

## Testing

- **Unit**: definition resolver (exact / high-sim / mid-sim / low-sim), range guard, bucket math.
- **Integration**: bulk POST happy path + per-row errors; single write creating a fresh definition with mid-sim review Task; `get_metric_series` across all bucket sizes against seeded fixtures.
- **Eval**: extend the existing eval harness with a metrics story — feed a journal entry mentioning a run, assert the resulting events + observations + Task surfacing if a near-duplicate definition pre-exists.
- Real Postgres for all DB-touching tests (existing project convention).

## Open Questions / Deferred

- **Metric merge tooling**: when the user resolves a "needs review" Task, what's the operation? Easiest path: agent calls `update_node` on the duplicate definition's node and a follow-up endpoint moves observations from one definition to another. This can wait until the first review actually happens in real use.
- **Backfill of historical chat data**: do we re-process old conversations to extract metrics retroactively? Out of scope; the new extraction path applies forward only. A one-shot reprocess job can be added later if desired.
- **Event-node idempotency on re-ingestion**: deleting and re-inserting observations by `sourceId` is straightforward. Event nodes created by the implicit extractor have no natural alias, so naive re-extraction would orphan the prior event nodes (and the existing `prune-orphan-nodes` job would later sweep them). Implementation should give the event node a deterministic identity tied to source + position (e.g. a content-hash key on `nodeMetadata.additionalData`) and dedupe at insert. Pinned in the implementation plan, not the data model.
- **Display direction (`higher_is_better`)**: omitted from the definition schema; can live in Petals UI config or be derived from metric name conventions.
- **TimescaleDB / hypertables**: not used in v1. Revisit if real-world wearable volumes (HRV every 5 min × multiple users) make plain Postgres queries slow.
