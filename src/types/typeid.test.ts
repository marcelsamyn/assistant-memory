import { newTypeId, typeIdFromString, typeIdSchema } from "./typeid";
import { describe, expect, it } from "vitest";

describe("typeIdFromString", () => {
  it("accepts legacy persisted IDs with valid prefix and length", () => {
    expect(typeIdFromString("source", "src_aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "src_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("accepts newly generated TypeIDs", () => {
    const id = newTypeId("node");

    expect(typeIdFromString("node", id)).toBe(id);
  });

  it("rejects IDs for the wrong type", () => {
    expect(() =>
      typeIdFromString("claim", "src_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toThrow();
  });
});

describe("typeIdSchema", () => {
  it("rejects legacy IDs with invalid length", () => {
    expect(() => typeIdSchema("source").parse("src_short")).toThrow();
  });
});
