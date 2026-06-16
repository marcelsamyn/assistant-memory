import { buildSourceTitlePrompt } from "./source-title";
import { describe, expect, it } from "vitest";

describe("buildSourceTitlePrompt", () => {
  it("includes the source type and content preview", () => {
    const prompt = buildSourceTitlePrompt({
      type: "conversation",
      contentPreview: "Let's plan the Q3 offsite in Lisbon",
    });
    expect(prompt).toContain("conversation");
    expect(prompt).toContain("Q3 offsite in Lisbon");
  });
});
