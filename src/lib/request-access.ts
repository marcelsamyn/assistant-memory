/** Request-bound access scope for HTTP routes. */
import { createError, getHeader, type H3Event } from "h3";
import {
  MEMORY_ACCESS_SCOPE_HEADER,
  memoryAccessScopeSchema,
  type MemoryAccessScope,
} from "~/lib/schemas/partition";

/**
 * Reads the explicit SDK access header. Missing means the existing strict
 * partition behavior. Unknown values fail at the HTTP boundary.
 */
export function getRequestAccessScope(event: H3Event): MemoryAccessScope {
  const value = getHeader(event, MEMORY_ACCESS_SCOPE_HEADER);
  if (value === undefined) return "partition";
  const parsed = memoryAccessScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid ${MEMORY_ACCESS_SCOPE_HEADER} header`,
      data: { code: "INVALID_ACCESS_SCOPE" },
    });
  }
  return parsed.data;
}
