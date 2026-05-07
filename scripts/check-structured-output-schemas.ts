import { documentSpineSchema } from "../src/lib/schemas/document-spine";
import { llmExtractionSchema } from "../src/lib/schemas/llm-extraction";
import {
  type StructuredOutputSchemaValidationInput,
  validateStructuredOutputJsonSchema,
} from "../src/lib/schemas/structured-output-validation";
import { zodResponseFormat } from "openai/helpers/zod.mjs";

const structuredOutputSchemas = [
  {
    name: "subgraph",
    schema: zodResponseFormat(llmExtractionSchema, "subgraph").json_schema
      .schema,
  },
  {
    name: "document_spine",
    schema: zodResponseFormat(documentSpineSchema, "document_spine").json_schema
      .schema,
  },
] satisfies ReadonlyArray<StructuredOutputSchemaValidationInput>;

for (const schema of structuredOutputSchemas) {
  validateStructuredOutputJsonSchema(schema);
}

console.log(
  `Validated ${structuredOutputSchemas.length.toString()} structured-output JSON schema.`,
);
