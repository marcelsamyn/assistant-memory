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

describe("typeIdSchema errors", () => {
  it("names the ID kind a caller passed by mistake", () => {
    const result = typeIdSchema("node").safeParse(
      "src_01m34wpw4fesks6rketcme5875",
    );

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Expected a node ID starting with "node_", but received a source ID. Use a source operation for this ID instead.',
    ]);
  });

  it("states the expected prefix for unknown IDs", () => {
    const result = typeIdSchema("node").safeParse("Ada Lovelace");

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Expected a node ID starting with "node_".',
    ]);
  });
});
