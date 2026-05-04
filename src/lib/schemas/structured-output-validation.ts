/**
 * Validation helpers for generated structured-output JSON schemas.
 * Common aliases: response_format validation, structured output schema guard.
 */
import Ajv, { type AnySchema } from "ajv";

const FORBIDDEN_PROVIDER_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "nullable",
]);

export interface StructuredOutputSchemaValidationInput {
  name: string;
  schema: AnySchema | undefined;
}

export function collectForbiddenProviderKeywords(
  value: unknown,
  path = "$",
): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectForbiddenProviderKeywords(item, `${path}[${index}]`),
    );
  }

  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_PROVIDER_KEYWORDS.has(key) ? [`${path}.${key}`] : []),
    ...collectForbiddenProviderKeywords(child, `${path}.${key}`),
  ]);
}

export function validateStructuredOutputJsonSchema({
  name,
  schema,
}: StructuredOutputSchemaValidationInput): void {
  if (schema === undefined) {
    throw new Error(`${name} structured-output response is missing a schema`);
  }

  const ajv = new Ajv({ strict: false, allErrors: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(
      `${name} structured-output schema is invalid JSON Schema: ${JSON.stringify(ajv.errors)}`,
    );
  }

  const forbiddenKeywords = collectForbiddenProviderKeywords(schema);
  if (forbiddenKeywords.length > 0) {
    throw new Error(
      `${name} structured-output schema uses provider-incompatible JSON Schema keywords: ${forbiddenKeywords.join(", ")}`,
    );
  }
}
