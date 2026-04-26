import { describe, expect, it } from "vitest";
import { hasNodeDescriptionUpdate } from "~/lib/node-update";

describe("hasNodeDescriptionUpdate", () => {
  it("detects public description update attempts", () => {
    expect(hasNodeDescriptionUpdate({ description: "manual text" })).toBe(true);
    expect(hasNodeDescriptionUpdate({ label: "Alice" })).toBe(false);
    expect(hasNodeDescriptionUpdate(null)).toBe(false);
  });
});
