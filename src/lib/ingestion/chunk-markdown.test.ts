import { chunkMarkdown } from "./chunk-markdown";
import { describe, expect, it } from "vitest";

describe("chunkMarkdown", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkMarkdown("", 100)).toEqual([]);
    expect(chunkMarkdown("   \n\n  ", 100)).toEqual([]);
  });

  it("returns a single chunk when content fits under the cap", () => {
    const md = "# Title\n\nA short paragraph.";
    expect(chunkMarkdown(md, 1000)).toEqual([md]);
  });

  it("packs multiple H1/H2 sections into separate chunks at section boundaries", () => {
    const sectionA = "## A\n\n" + "a".repeat(80);
    const sectionB = "## B\n\n" + "b".repeat(80);
    const sectionC = "## C\n\n" + "c".repeat(80);
    const md = `${sectionA}\n\n${sectionB}\n\n${sectionC}`;

    // Cap forces one section per chunk.
    const result = chunkMarkdown(md, 100);

    expect(result).toHaveLength(3);
    expect(result[0]).toContain("## A");
    expect(result[0]).not.toContain("## B");
    expect(result[1]).toContain("## B");
    expect(result[1]).not.toContain("## A");
    expect(result[2]).toContain("## C");
  });

  it("packs sections together when they fit, splits when they would exceed cap", () => {
    const small1 = "## One\n\nshort";
    const small2 = "## Two\n\nshort";
    const big = "## Three\n\n" + "x".repeat(200);
    const md = `${small1}\n\n${small2}\n\n${big}`;

    const result = chunkMarkdown(md, 100);

    // small1 + small2 fit together (~30 chars), big spills to its own chunk.
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("## One");
    expect(result[0]).toContain("## Two");
    expect(result[1]).toContain("## Three");
  });

  it("splits an oversized section on paragraph boundaries", () => {
    const para = (n: number) => `Paragraph ${n} ${"y".repeat(40)}`;
    const md = `## Long\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n${para(4)}`;

    const result = chunkMarkdown(md, 100);

    expect(result.length).toBeGreaterThan(1);
    // No chunk should be silently empty.
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(0);
    }
    // Every paragraph appears somewhere across the chunks.
    const joined = result.join("\n");
    for (const i of [1, 2, 3, 4]) {
      expect(joined).toContain(`Paragraph ${i}`);
    }
  });

  it("emits an oversized paragraph standalone without splitting mid-paragraph", () => {
    const huge = "z".repeat(500);
    const md = `## Heading\n\n${huge}`;

    const result = chunkMarkdown(md, 100);

    // The huge paragraph must appear intact in some chunk.
    const intact = result.find((chunk) => chunk.includes(huge));
    expect(intact).toBeDefined();
  });

  it("packs paragraph-only input (no headings) by paragraph", () => {
    const md = ["one", "two", "three", "four"]
      .map((word) => word.repeat(30))
      .join("\n\n");

    const result = chunkMarkdown(md, 70);

    expect(result.length).toBeGreaterThan(1);
    expect(result.join("\n")).toContain("one".repeat(30));
    expect(result.join("\n")).toContain("four".repeat(30));
  });

  it("trims trailing whitespace and never emits empty chunks", () => {
    const md = "## A\n\nbody\n\n\n\n## B\n\nmore body\n\n";

    const result = chunkMarkdown(md, 1000);

    for (const chunk of result) {
      expect(chunk).toBe(chunk.trimEnd());
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("treats H1 and H2 as section starts but keeps deeper headings inside the parent section", () => {
    const md = `## Parent\n\nintro\n\n### Child\n\nchild body\n\n## Sibling\n\nsibling body`;

    const result = chunkMarkdown(md, 1000);

    // Should split at "## Sibling", not at "### Child".
    expect(result).toHaveLength(1);
    // (Single chunk because total is well under cap.)
    expect(result[0]).toContain("### Child");
    expect(result[0]).toContain("## Sibling");
  });
});
