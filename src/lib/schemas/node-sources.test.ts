import { describe, expect, it } from "vitest";
import { nodeSourceSchema } from "~/lib/schemas/node";
import { newTypeId } from "~/types/typeid";

describe("nodeSourceSchema", () => {
  it("does not expose source content", () => {
    const parsed = nodeSourceSchema.parse({
      sourceId: newTypeId("source"),
      type: "document",
      content: "large source content",
      timestamp: new Date("2026-06-10T08:00:00.000Z"),
    });

    expect(parsed).not.toHaveProperty("content");
  });
});
