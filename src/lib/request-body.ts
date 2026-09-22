import { createError } from "h3";
import { z } from "zod";

/**
 * Validate a request body at the HTTP boundary. Invalid input is the caller's
 * mistake, so it becomes a 400 whose message names each bad field; a bare
 * `schema.parse` would surface as an opaque 500.
 */
export function parseRequestBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw createError({
    statusCode: 400,
    statusMessage: "Invalid request body",
    message: z.prettifyError(result.error),
    data: { issues: result.error.issues },
  });
}
