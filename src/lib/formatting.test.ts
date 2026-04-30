import { formatConversationAsXml, formatLabelWithAliases } from "./formatting";
import { describe, expect, it } from "vitest";

describe("formatConversationAsXml", () => {
  it("uses external message ids when present", () => {
    const xml = formatConversationAsXml([
      {
        id: "msg_1",
        role: "user",
        content: "I like sourdough",
        timestamp: "2026-04-25T07:00:00.000Z",
      },
    ]);

    expect(xml).toContain('id="msg_1"');
    expect(xml).not.toContain('id="0"');
  });

  it("falls back to numeric ids and escapes XML-sensitive values", () => {
    const xml = formatConversationAsXml([
      {
        role: "user",
        name: 'A&B "User"',
        content: "<tag>&value</tag>",
        timestamp: "2026-04-25T07:00:00.000Z",
      },
    ]);

    expect(xml).toContain('id="0"');
    expect(xml).toContain('name="A&amp;B &quot;User&quot;"');
    expect(xml).toContain("&lt;tag&gt;&amp;value&lt;/tag&gt;");
  });
});

describe("formatLabelWithAliases", () => {
  it("returns the label alone when no aliases provided", () => {
    expect(formatLabelWithAliases("Marcel")).toBe("Marcel");
    expect(formatLabelWithAliases("Marcel", [])).toBe("Marcel");
  });

  it("appends deduplicated aliases in order", () => {
    expect(formatLabelWithAliases("Marcel Samyn", ["Marcel", "Mars"])).toBe(
      "Marcel Samyn (also: Marcel, Mars)",
    );
  });

  it("drops aliases that match the canonical label case-insensitively", () => {
    expect(formatLabelWithAliases("Marcel", ["marcel", "Mars"])).toBe(
      "Marcel (also: Mars)",
    );
  });

  it("drops blank aliases and dedupes among aliases", () => {
    expect(
      formatLabelWithAliases("Marcel", [" ", "Mars", "MARS", "  "]),
    ).toBe("Marcel (also: Mars)");
  });

  it("falls back to the first alias when label is empty", () => {
    expect(formatLabelWithAliases("", ["Mars", "Marcel"])).toBe("Mars");
    expect(formatLabelWithAliases("")).toBe("");
  });
});
