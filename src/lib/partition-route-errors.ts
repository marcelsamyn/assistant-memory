/** Maps structured partition domain failures to stable HTTP responses. */
import { createError } from "h3";
import { PartitionAccessError } from "~/lib/partition-access";
import { PartitionReclassificationError } from "~/lib/partition-errors";

export function throwPartitionRouteError(error: unknown): never {
  if (error instanceof PartitionReclassificationError) {
    throw createError({
      statusCode: error.code === "SOURCE_NOT_FOUND" ? 404 : 409,
      statusMessage: error.message,
      data: { code: error.code, current: error.current },
    });
  }
  if (error instanceof PartitionAccessError) {
    throw createError({
      statusCode: 409,
      statusMessage: error.message,
      data: {
        code: error.code,
        ...(error.currentSourceVersion === undefined
          ? {}
          : { currentSourceVersion: error.currentSourceVersion }),
      },
    });
  }
  throw error;
}
