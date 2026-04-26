import { formatConversationAsXml } from "./formatting";
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
