import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkedExtractionParams } from "~/lib/ingestion/chunked-extract";
import { newTypeId } from "~/types/typeid";

// Heading per section keeps each chunk distinct so chunkMarkdown emits three
// chunks at the small INGEST_CHUNK_MAX_CHARS the tests stub in.
const threeSectionContent = `## Section A

${"x".repeat(60)}

## Section B

${"y".repeat(60)}

## Section C

${"z".repeat(60)}`;

function makeBaseParams(): Omit<ChunkedExtractionParams, "content"> {
  const sourceId = newTypeId("source");
  const linkedNodeId = newTypeId("node");
  return {
    userId: "user_test",
    sourceType: "document",
    sourceId,
    statedAt: new Date("2026-05-07T00:00:00.000Z"),
    linkedNodeId,
    sourceRefs: [{ externalId: "ext_test", sourceId }],
    logLabel: "test.pdf",
  };
}

describe("runChunkedExtraction", () => {
  beforeEach(() => {
    // Reset the module registry FIRST so any previous test file's
    // imports don't bleed cached modules into the current test's
    // vi.doMock setup.
    vi.resetModules();

    // Quiet the structured logs the helper emits so test output stays
    // readable; assertions don't care about console contents here.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Default: stub the spine pre-pass so tests don't hit the real LLM
    // path. The chunked-extract helper swallows spine failures and
    // continues without spine, which is the behavior most non-spine tests
    // assume. Tests that exercise the spine path override this mock with
    // their own vi.doMock(...) before importing chunked-extract.
    vi.doMock("~/lib/ingestion/extract-document-spine", () => ({
      extractDocumentSpine: vi.fn(async () => {
        throw new Error("spine disabled in test (default mock)");
      }),
    }));
    vi.doMock("~/lib/ingestion/ensure-spine-nodes", () => ({
      ensureSpineNodes: vi.fn(async () => []),
      linkSpineToDocument: vi.fn(async () => undefined),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("~/utils/env");
    vi.doUnmock("~/lib/extract-graph");
    vi.doUnmock("~/lib/ingestion/extract-document-spine");
    vi.doUnmock("~/lib/ingestion/ensure-spine-nodes");
    vi.restoreAllMocks();
  });

  it("continues past a failed chunk and resolves so the caller marks the source completed", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    const calls: Array<{ replaceFlag: boolean | undefined }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(
        async (params: { replaceClaimsForSources?: boolean }) => {
          const idx = calls.length;
          calls.push({ replaceFlag: params.replaceClaimsForSources });
          if (idx === 1) {
            throw new SyntaxError(
              "Unterminated string in JSON at position 683",
            );
          }
          return { newNodesCreated: 1, claimsCreated: 1 };
        },
      ),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: threeSectionContent,
    });

    expect(calls).toHaveLength(3);
    // Chunk 0 succeeded → it carried the source-scoped claim replacement.
    // Chunk 1 (failed) and chunk 2 (succeeded after) must NOT replace again,
    // otherwise chunk 0's claims would be wiped.
    expect(calls[0]?.replaceFlag).toBe(true);
    expect(calls[1]?.replaceFlag).toBe(false);
    expect(calls[2]?.replaceFlag).toBe(false);
  });

  it("transfers source-scoped replacement to the first chunk that actually succeeds", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    const calls: Array<{ replaceFlag: boolean | undefined }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(
        async (params: { replaceClaimsForSources?: boolean }) => {
          const idx = calls.length;
          calls.push({ replaceFlag: params.replaceClaimsForSources });
          if (idx === 0) {
            throw new SyntaxError("malformed json");
          }
          return { newNodesCreated: 0, claimsCreated: 0 };
        },
      ),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: threeSectionContent,
    });

    expect(calls).toHaveLength(3);
    // Chunk 0 attempted with replace=true but threw, so no wipe happened.
    expect(calls[0]?.replaceFlag).toBe(true);
    // Chunk 1 must therefore still ask for replace=true so prior-run claims
    // for this source get cleaned up exactly once.
    expect(calls[1]?.replaceFlag).toBe(true);
    expect(calls[2]?.replaceFlag).toBe(false);
  });

  it("throws when every chunk fails so BullMQ can retry the job", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async () => {
        throw new Error("boom");
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await expect(
      runChunkedExtraction({
        ...makeBaseParams(),
        content: threeSectionContent,
      }),
    ).rejects.toThrow(/all 3 chunk\(s\) failed/);
  });

  it("surfaces document title and author into the contentNote so the LLM doesn't attribute author claims to the user", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 6000, INGEST_DEBUG_DIR: undefined },
    }));

    const captured: Array<{ contentNote: string | undefined }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async (params: { contentNote?: string }) => {
        captured.push({ contentNote: params.contentNote });
        return { newNodesCreated: 0, claimsCreated: 0 };
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: "Short doc body that fits in one chunk.",
      documentMetadata: {
        title: "Self Publishing Strategy Guide",
        author: "Jay Allyson",
      },
    });

    expect(captured).toHaveLength(1);
    const note = captured[0]?.contentNote ?? "";
    expect(note).toContain("Title: Self Publishing Strategy Guide");
    expect(note).toContain("Author: Jay Allyson");
    expect(note.toLowerCase()).toContain("not attribute");
  });

  it("appends the section-of-N hint when multiple chunks AND keeps document context for every chunk", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    const captured: string[] = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async (params: { contentNote?: string }) => {
        captured.push(params.contentNote ?? "");
        return { newNodesCreated: 0, claimsCreated: 0 };
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: threeSectionContent,
      documentMetadata: { title: "My Book" },
    });

    expect(captured).toHaveLength(3);
    for (const [idx, note] of captured.entries()) {
      expect(note).toContain("Title: My Book");
      expect(note).toContain(`section ${idx + 1} of 3`);
    }
  });

  it("omits the contentNote entirely for a single-chunk document with no metadata (back-compat)", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 6000, INGEST_DEBUG_DIR: undefined },
    }));

    const captured: Array<{ contentNote: string | undefined }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async (params: { contentNote?: string }) => {
        captured.push({ contentNote: params.contentNote });
        return { newNodesCreated: 0, claimsCreated: 0 };
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: "Short doc body.",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.contentNote).toBeUndefined();
  });

  it("runs the spine pre-pass and threads spine nodes into every chunk's extractGraph call", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    const spineNode = {
      nodeId: newTypeId("node"),
      label: "Self-Publishing on Amazon",
      description: "How authors get books onto Amazon and grow sales.",
    };
    vi.doMock("~/lib/ingestion/extract-document-spine", () => ({
      extractDocumentSpine: vi.fn(async () => ({
        thesis:
          "Authors can self-publish on Amazon to reach bestseller status.",
        spineConcepts: [
          { label: spineNode.label, description: spineNode.description },
        ],
      })),
    }));
    const linkSpineToDocument = vi.fn(async () => undefined);
    vi.doMock("~/lib/ingestion/ensure-spine-nodes", () => ({
      ensureSpineNodes: vi.fn(async () => [spineNode]),
      linkSpineToDocument,
    }));

    const captured: Array<{
      documentSpine: unknown;
      contentNote: string | undefined;
    }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(
        async (p: { documentSpine?: unknown; contentNote?: string }) => {
          captured.push({
            documentSpine: p.documentSpine,
            contentNote: p.contentNote,
          });
          return { newNodesCreated: 0, claimsCreated: 0 };
        },
      ),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    const base = makeBaseParams();
    await runChunkedExtraction({ ...base, content: threeSectionContent });

    expect(captured).toHaveLength(3);
    for (const call of captured) {
      expect(call.documentSpine).toEqual([spineNode]);
      expect(call.contentNote).toContain(
        "Document thesis: Authors can self-publish on Amazon",
      );
    }
    // After the chunk loop, spine→document link must run since at least one
    // chunk succeeded.
    expect(linkSpineToDocument).toHaveBeenCalledTimes(1);
    expect(linkSpineToDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentNodeId: base.linkedNodeId,
        spineNodes: [spineNode],
      }),
    );
  });

  it("skips spine→document linking when every chunk fails", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 80, INGEST_DEBUG_DIR: undefined },
    }));

    const spineNode = {
      nodeId: newTypeId("node"),
      label: "X",
      description: null,
    };
    vi.doMock("~/lib/ingestion/extract-document-spine", () => ({
      extractDocumentSpine: vi.fn(async () => ({
        thesis: "t",
        spineConcepts: [{ label: "X", description: "x" }],
      })),
    }));
    const linkSpineToDocument = vi.fn(async () => undefined);
    vi.doMock("~/lib/ingestion/ensure-spine-nodes", () => ({
      ensureSpineNodes: vi.fn(async () => [spineNode]),
      linkSpineToDocument,
    }));
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async () => {
        throw new Error("boom");
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await expect(
      runChunkedExtraction({
        ...makeBaseParams(),
        content: threeSectionContent,
      }),
    ).rejects.toThrow();

    expect(linkSpineToDocument).not.toHaveBeenCalled();
  });

  it("continues without spine when extractDocumentSpine throws", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 6000, INGEST_DEBUG_DIR: undefined },
    }));

    vi.doMock("~/lib/ingestion/extract-document-spine", () => ({
      extractDocumentSpine: vi.fn(async () => {
        throw new Error("LLM down");
      }),
    }));
    const ensureSpineNodes = vi.fn();
    const linkSpineToDocument = vi.fn();
    vi.doMock("~/lib/ingestion/ensure-spine-nodes", () => ({
      ensureSpineNodes,
      linkSpineToDocument,
    }));

    const captured: Array<{ documentSpine: unknown }> = [];
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async (p: { documentSpine?: unknown }) => {
        captured.push({ documentSpine: p.documentSpine });
        return { newNodesCreated: 0, claimsCreated: 0 };
      }),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      content: "Short doc body.",
    });

    expect(captured).toHaveLength(1);
    // Spine threw → extractGraph receives no documentSpine.
    expect(captured[0]?.documentSpine).toBeUndefined();
    expect(ensureSpineNodes).not.toHaveBeenCalled();
    expect(linkSpineToDocument).not.toHaveBeenCalled();
  });

  it("does not run spine pre-pass for non-document source types", async () => {
    vi.doMock("~/utils/env", () => ({
      env: { INGEST_CHUNK_MAX_CHARS: 6000, INGEST_DEBUG_DIR: undefined },
    }));

    const extractDocumentSpine = vi.fn();
    vi.doMock("~/lib/ingestion/extract-document-spine", () => ({
      extractDocumentSpine,
    }));
    vi.doMock("~/lib/ingestion/ensure-spine-nodes", () => ({
      ensureSpineNodes: vi.fn(),
      linkSpineToDocument: vi.fn(),
    }));
    vi.doMock("~/lib/extract-graph", () => ({
      extractGraph: vi.fn(async () => ({
        newNodesCreated: 0,
        claimsCreated: 0,
      })),
    }));

    const { runChunkedExtraction } = await import(
      "~/lib/ingestion/chunked-extract"
    );

    await runChunkedExtraction({
      ...makeBaseParams(),
      sourceType: "conversation",
      content: "Hi there.",
    });

    expect(extractDocumentSpine).not.toHaveBeenCalled();
  });
});
