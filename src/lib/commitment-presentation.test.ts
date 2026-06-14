import { generateCommitmentPresentation } from "./commitment-presentation";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pass uses the createCompletionClient + parseStructuredCompletion seam
// (mirroring extractGraph). Mock both so no real LLM client is constructed.
vi.mock("./ai", () => ({
  createCompletionClient: vi.fn(async () => ({})),
  parseStructuredCompletion: vi.fn(),
}));
const { parseStructuredCompletion } = await import("./ai");
const mockParse = vi.mocked(parseStructuredCompletion);

const CONTENT = "Sure — I'll send the investor update by Thursday, promise.";

/** Minimal parsed-completion envelope matching what the pass reads. */
function completion(parsed: unknown) {
  return { choices: [{ message: { parsed } }] } as unknown as Awaited<
    ReturnType<typeof parseStructuredCompletion>
  >;
}

describe("generateCommitmentPresentation", () => {
  beforeEach(() => mockParse.mockReset());

  it("stores a real quote verbatim and passes the why through", async () => {
    mockParse.mockResolvedValue(
      completion({
        excerpt: "send the investor update by Thursday",
        why: "You named a concrete deliverable and deadline.",
      }),
    );
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "Send investor update",
    });
    expect(out.excerpt).toBe("send the investor update by Thursday");
    expect(out.why).toBe("You named a concrete deliverable and deadline.");
  });

  it("nulls a hallucinated excerpt that is not in the source", async () => {
    mockParse.mockResolvedValue(
      completion({
        excerpt: "I promise to climb Everest next week",
        why: "Ambitious.",
      }),
    );
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "Send investor update",
    });
    expect(out.excerpt).toBeNull();
    expect(out.why).toBe("Ambitious.");
  });

  it("caps an over-long why", async () => {
    mockParse.mockResolvedValue(
      completion({ excerpt: null, why: "x".repeat(300) }),
    );
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "t",
    });
    expect(out.why?.length).toBe(140);
  });

  it("is fail-soft: a malformed completion yields a fully-null presentation", async () => {
    // A null completion makes the `.choices` access throw inside the try; the
    // catch returns the degraded shape — same observable behaviour as a failed
    // LLM call, without the unhandledRejection the nitro-test-utils global
    // server traps.
    mockParse.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof parseStructuredCompletion>>,
    );
    const out = await generateCommitmentPresentation({
      userId: "user_1",
      content: CONTENT,
      taskLabel: "t",
    });
    expect(out).toEqual({ excerpt: null, why: null });
  });
});
