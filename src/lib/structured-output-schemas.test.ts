import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { describe, expect, it } from "vitest";
import { llmExtractionSchema } from "~/lib/schemas/llm-extraction";
import { validateStructuredOutputJsonSchema } from "~/lib/schemas/structured-output-validation";

describe("structured output JSON schemas", () => {
  it("emits provider-compatible JSON Schema for graph extraction", () => {
    const responseFormat = zodResponseFormat(llmExtractionSchema, "subgraph");
    expect(() =>
      validateStructuredOutputJsonSchema({
        name: "subgraph",
        schema: responseFormat.json_schema.schema,
      }),
    ).not.toThrow();
  });
});

describe("llmExtractionSchema leniency", () => {
  const validNode = { id: "temp_person_1", type: "Person", label: "Ada" };

  it("parses a response that omits empty top-level collections", () => {
    // A non-strict provider drops collections it has nothing for — most often
    // `aliases`. This is the exact shape that previously threw
    // `ZodError: expected array, received undefined` at path `aliases`.
    const parsed = llmExtractionSchema.parse({
      nodes: [validNode],
      relationshipClaims: [],
      attributeClaims: [],
    });
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.aliases ?? []).toEqual([]);
  });

  it("parses when a collection arrives as null", () => {
    const parsed = llmExtractionSchema.parse({
      nodes: null,
      relationshipClaims: null,
      attributeClaims: null,
      aliases: null,
    });
    expect(parsed.nodes ?? []).toEqual([]);
    expect(parsed.aliases ?? []).toEqual([]);
  });

  it("still rejects a structurally malformed item (lax about empty, not broken)", () => {
    expect(() =>
      llmExtractionSchema.parse({
        nodes: [{ id: "temp_1", type: "NotARealNodeType", label: "x" }],
      }),
    ).toThrow();
  });
});
