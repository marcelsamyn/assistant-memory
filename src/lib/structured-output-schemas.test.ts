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
