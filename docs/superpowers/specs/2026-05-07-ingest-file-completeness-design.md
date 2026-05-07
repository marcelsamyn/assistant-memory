# File Ingest Completeness + Debug Visibility

## Problem

A 19-page PDF run through `ingest-file` produced 3 nodes and 3 claims — a
title-and-author summary, not a knowledge graph of the document. The current
pipeline converts the PDF to markdown via the markitdown sidecar, then sends
the entire markdown as one prompt to `extractGraph`. For long documents the
model treats the call as a "summarize" task and returns a few headline
entities.

Two failures need to be addressed together:

1. **Sparse extraction on long inputs.** Single-call extraction has a real
   ceiling regardless of model strength. The prompt also explicitly tells the
   model "Quality and accuracy are more important than quantity," which biases
   it toward sparseness.
2. **No debug surface.** `debugGraph` only logs nodes/claims that survived
   identity resolution and dedup. From the outside there's no way to tell
   whether markitdown produced a 200-char string or a 50K-char one, or whether
   the LLM saw the full text and still returned three nodes.

## Goal

Process uploaded files completely while keeping context windows manageable,
and provide enough diagnostic output to localize future regressions to the
specific stage that's misbehaving (converter, chunker, LLM, or
identity-resolution).

## Non-goals

- Parallelizing chunk extraction. Sequential gives chunk N visibility into
  entities created by chunks 0…N-1 via `findSimilarNodes`, which is what
  prevents duplicate person/place nodes across chunks.
- Map-reduce / two-pass extraction (outline → per-item materialization).
  Revisit if chunked single-pass remains insufficient.
- Re-running extraction over already-ingested files. A reprocess feature is a
  separate effort.
- Changing the markitdown sidecar.

## Design

### Chunker

New module `src/lib/ingestion/chunk-markdown.ts` exporting:

```ts
export function chunkMarkdown(markdown: string, maxChars: number): string[];
```

Behavior:

- Walk the markdown. Each `#` or `##` heading starts a new logical section.
  (Sub-headings stay inside their parent section.)
- Pack consecutive sections into a chunk until adding the next section would
  exceed `maxChars`.
- If a single section is itself larger than `maxChars`, split that section on
  blank-line paragraph boundaries using the same packing rule.
- Paragraphs larger than `maxChars` are emitted standalone — we never split
  mid-paragraph.
- Empty input → `[]`. Input with no headings → packed by paragraph only.
- Trim trailing whitespace from each emitted chunk; never emit `""`.

Default `maxChars`: **6000** (~1.5K tokens). Configurable via env var
`INGEST_CHUNK_MAX_CHARS` (validated as a positive integer in `~/utils/env`).

### `extractGraph` change

Add three optional parameters:

```ts
interface ExtractGraphParams {
  // ...existing fields
  replaceClaimsForSources?: boolean; // default true
  contentNote?: string;              // optional preamble injected above <document>
  onLlmIO?: (info: { prompt: string; response: unknown }) => Promise<void> | void;
}
```

- `replaceClaimsForSources: false` skips `_deleteExistingClaimsForSources` at
  the top of the function so chunk N+1 doesn't wipe the claims chunk N just
  inserted. The caller passes `true` for the first chunk (matches today's
  source-scoped replacement semantics) and `false` for every subsequent
  chunk.
- `contentNote` is injected verbatim above the `<document>` block — used by
  the chunked caller to tell the model "this is one section of N."
- `onLlmIO` is described in the Debug visibility section below.

The prompt's document-mode block is also updated:

- Drop the trailing `"Quality and accuracy are more important than quantity."`
  line for `sourceType === "document"`.
- Replace it with: `"For documents, exhaustively extract every concrete fact,
  claim, person, organization, place, concept, decision, and recommendation
  the text asserts. Do not summarize."`

The non-document prompts (conversation, transcript) are untouched.

### `ingest-file.ts` changes

After `convertToMarkdown` returns and the markdown is persisted to
`metadata.rawContent`:

```ts
const chunks = chunkMarkdown(converted.markdown, env.INGEST_CHUNK_MAX_CHARS);

if (chunks.length <= 1) {
  // existing single-call path, unchanged
  await extractGraph({ /* ...as today, content: converted.markdown */ });
} else {
  for (const [index, chunk] of chunks.entries()) {
    await extractGraph({
      // ...same userId / sourceType / sourceId / statedAt / linkedNodeId / sourceRefs
      content: chunk,
      replaceClaimsForSources: index === 0,
      contentNote: `This is section ${index + 1} of ${chunks.length} of a longer document; extract every fact in this section.`,
    });
  }
}
```

Sequential, never parallel.

### Debug visibility

Two layers, both touched only from `ingest-file.ts`:

**Always-on structured log.** One log line per ingest summarizing the run:

```
ingest-file: src=<sourceId> file=<filename> markdownLen=<n> chunks=<n>
ingest-file:   chunk=0/N len=<n> newNodes=<n> claims=<n>
ingest-file:   chunk=1/N len=<n> newNodes=<n> claims=<n>
...
```

`extractGraph` already returns `{ newNodesCreated, claimsCreated }`, so this
is plumbing only.

**Opt-in deep dump.** When `INGEST_DEBUG_DIR` is set, the prompt and parsed
response from each chunk's `extractGraph` call are written to:

- `<INGEST_DEBUG_DIR>/<sourceId>-chunk-<idx>-prompt.txt` — the exact prompt
  string sent to the LLM.
- `<INGEST_DEBUG_DIR>/<sourceId>-chunk-<idx>-response.json` — the parsed LLM
  output (`parsedLlmOutput`) before dedup/identity-resolution.

Because the prompt is constructed inside `extractGraph`, the caller cannot
intercept it directly. `extractGraph` is augmented with an optional
`onLlmIO?: (info: { prompt: string; response: unknown }) => Promise<void> |
void` hook that fires once per call immediately after
`client.beta.chat.completions.parse` and before the dedup/insert pipeline.
The `ingest-file` job provides the hook only when `INGEST_DEBUG_DIR` is set;
otherwise the hook is absent and `extractGraph` runs identically to today.

The directory must exist (operator responsibility — this is a debug aid, not
a feature). Failures to write are logged and swallowed; they never break the
ingest.

The existing `debugGraph(...)` log inside `extractGraph` stays as-is — it
shows the post-identity-resolution survivors. Combined with the per-chunk
counts and the deep dump, the three layers (raw markdown on
`metadata.rawContent`, per-chunk LLM I/O, post-resolution survivors) make
each pipeline stage independently inspectable.

### Configuration

New entries in `~/utils/env` (Zod-validated):

- `INGEST_CHUNK_MAX_CHARS`: positive integer, default `6000`.
- `INGEST_DEBUG_DIR`: optional string. Empty/unset disables the deep dump.

## Tests

- `chunk-markdown.test.ts`:
  - empty input → `[]`
  - input ≤ cap → single chunk equal to input (trimmed)
  - input with multiple `##` sections that fit individually but together
    exceed cap → packed into multiple chunks at section boundaries
  - input with one `##` section larger than cap → that section split on
    paragraph boundaries
  - input with no headings, multiple paragraphs → packed by paragraph only
  - paragraph itself larger than cap → emitted standalone (asserts no
    mid-paragraph split)
- `extract-graph.test.ts` (extension):
  - new test asserts `replaceClaimsForSources: false` skips the existing-claim
    delete (claim from a prior call survives a second call against the same
    source).
- No new integration test for `ingest-file`. The existing single-call path is
  unchanged; the multi-chunk path is exercised end-to-end by the chunker and
  `extractGraph` unit tests.

## Risks

- **Cost.** N chunks = N LLM calls per file. For typical 1–3 page documents
  this is unchanged (one chunk). For long documents cost grows linearly,
  which is the expected trade for completeness.
- **Identity drift across chunks.** Sequential execution lets later chunks
  see earlier nodes via `findSimilarNodes`, but that's a similarity search,
  not a guarantee. Two chunks may still produce nodes the resolver later
  collapses. The existing `identity-reeval` background job already handles
  this.
- **Source-scoped claim replacement semantics.** First chunk wipes prior
  claims for the source as today; subsequent chunks must not. The
  `replaceClaimsForSources` flag is the only thing protecting against
  accidental wipe, so the call site must pass it correctly. Mitigated by
  keeping the loop in `ingest-file.ts` small and obvious, plus the
  `extractGraph` unit test on the flag's behavior.
