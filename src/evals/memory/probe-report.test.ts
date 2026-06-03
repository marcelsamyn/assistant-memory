import {
  computeStats,
  renderFactsForJudge,
  renderReport,
  type ProbeClaim,
  type ProbeNode,
  type RenderReportInput,
} from "./probe-report";
import { describe, expect, it } from "vitest";

const NODES: ProbeNode[] = [
  { id: "n1", type: "Person", label: "Jane Doe", description: "An author" },
  { id: "n2", type: "Concept", label: "Self-Publishing", description: null },
  { id: "n3", type: "Concept", label: "Royalties", description: null },
];

const CLAIMS: ProbeClaim[] = [
  {
    predicate: "AUTHORED",
    statement: "Jane wrote the book",
    assertedByKind: "document_author",
    subjectLabel: "Jane Doe",
    objectLabel: "Self-Publishing",
    objectValue: null,
  },
  {
    predicate: "HAS_ATTRIBUTE",
    statement: "Royalties are 70%",
    assertedByKind: "document_author",
    subjectLabel: "Royalties",
    objectLabel: null,
    objectValue: "70%",
  },
];

describe("computeStats", () => {
  it("counts nodes, claims, and groups by type/predicate/assertion", () => {
    const stats = computeStats({
      nodes: NODES,
      claims: CLAIMS,
      aliasCount: 1,
      contentLength: 2000,
      chunkCount: 1,
    });

    expect(stats.nodeCount).toBe(3);
    expect(stats.claimCount).toBe(2);
    expect(stats.aliasCount).toBe(1);
    // Concept (2) sorts before Person (1) — count desc.
    expect(stats.nodesByType).toEqual([
      ["Concept", 2],
      ["Person", 1],
    ]);
    // 2 claims over 2000 chars => 1.0 per 1k.
    expect(stats.claimsPer1kChars).toBe(1);
    expect(stats.nodesPer1kChars).toBe(1.5);
  });

  it("does not divide by zero on empty content", () => {
    const stats = computeStats({
      nodes: [],
      claims: [],
      aliasCount: 0,
      contentLength: 0,
      chunkCount: 0,
    });
    expect(stats.claimsPer1kChars).toBe(0);
    expect(stats.nodesPer1kChars).toBe(0);
  });
});

describe("renderFactsForJudge", () => {
  it("serializes nodes, relationship and attribute claims distinctly", () => {
    const text = renderFactsForJudge(NODES, CLAIMS, [
      { aliasText: "JD", canonicalLabel: "Jane Doe" },
    ]);
    expect(text).toContain("[Person] Jane Doe — An author");
    expect(text).toContain("Jane Doe —AUTHORED→ Self-Publishing");
    // Attribute claims render the scalar value in quotes, not a node label.
    expect(text).toContain('Royalties —HAS_ATTRIBUTE→ "70%"');
    expect(text).toContain('"JD" → Jane Doe');
  });
});

describe("renderReport", () => {
  const input: RenderReportInput = {
    config: {
      file: "sample.md",
      model: "google/gemini-3.1-flash-lite-preview",
      judgeModel: "anthropic/claude-sonnet-4",
      judgeMode: "per-chunk",
      title: "A Book",
      author: "Jane Doe",
      chunkMaxChars: 6000,
      userId: "probe_user",
      generatedAt: "2026-06-03T00:00:00.000Z",
    },
    stats: computeStats({
      nodes: NODES,
      claims: CLAIMS,
      aliasCount: 0,
      contentLength: 2000,
      chunkCount: 1,
    }),
    spineConcepts: ["Self-Publishing"],
    nodes: NODES,
    claims: CLAIMS,
    aliases: [],
    coverage: {
      coverageScore: 80,
      capturedCount: 4,
      salientCount: 5,
      missedFacts: ["The book was published in 2024"],
      summary: "Most facts captured; one date missed.",
    },
    durationMs: 12_300,
  };

  it("includes config, stats, coverage score, missed facts, and grouped claims", () => {
    const md = renderReport(input);
    expect(md).toContain("# Ingestion Probe — sample.md");
    expect(md).toContain("**Score: 80/100**");
    expect(md).toContain("4/5 salient facts captured");
    expect(md).toContain("- The book was published in 2024");
    expect(md).toContain("## Spine concepts");
    expect(md).toContain("- Self-Publishing");
    // Claims grouped under their subject.
    expect(md).toContain("### Jane Doe");
    expect(md).toContain("AUTHORED → Self-Publishing");
  });

  it("renders a disabled-judge report without a coverage section", () => {
    const md = renderReport({
      ...input,
      config: { ...input.config, judgeModel: null, judgeMode: "off" },
      coverage: null,
    });
    expect(md).toContain("**Coverage judge:** disabled");
    expect(md).not.toContain("## Coverage");
  });
});
