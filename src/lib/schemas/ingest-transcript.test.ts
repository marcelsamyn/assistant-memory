import { ingestTranscriptRequestSchema } from "./ingest-transcript";
import { describe, expect, it } from "vitest";

describe("transcript origin", () => {
  it("accepts a host-supplied source kind without changing the transcript content", () => {
    const request = ingestTranscriptRequestSchema.parse({
      userId: "user-1",
      transcriptId: "meet-1",
      sourceKind: "google_meet",
      occurredAt: "2026-09-19T09:00:00.000Z",
      content: { kind: "raw", text: "Lena: Please send the notes." },
    });
    expect(request.sourceKind).toBe("google_meet");
    expect(request.content).toEqual({
      kind: "raw",
      text: "Lena: Please send the notes.",
    });
  });
});
