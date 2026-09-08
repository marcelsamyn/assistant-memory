import { createError, defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import {
  sourceLifecycleCommandRequestSchema,
  sourceLifecycleCommandResponseSchema,
} from "~/lib/schemas/source-lifecycle";
import {
  applySourceLifecycleCommand,
  listSourceLifecycleStorageCleanupKeys,
  markSourceTreeStorageCleanupCompleted,
  SourceLifecycleError,
} from "~/lib/source-lifecycle";
import { sourceService } from "~/lib/sources";
import { useDatabase } from "~/utils/db";

/** Server-to-server source erasure; never exposed through user bearer auth. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = sourceLifecycleCommandRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  try {
    const receipt = await applySourceLifecycleCommand(db, request);
    if (receipt.storageCleanupState === "pending") {
      const objectKeys = await listSourceLifecycleStorageCleanupKeys(
        db,
        request.userId,
        request.commandId,
      );
      await Promise.all(
        objectKeys.map((objectKey) =>
          sourceService.deleteRawBlobObjectKeyIfPresent(objectKey),
        ),
      );
      await markSourceTreeStorageCleanupCompleted(
        db,
        request.userId,
        request.sourceId,
      );
      return sourceLifecycleCommandResponseSchema.parse({
        ...receipt,
        storageCleanupState: "completed",
      });
    }
    return sourceLifecycleCommandResponseSchema.parse(receipt);
  } catch (error) {
    if (error instanceof SourceLifecycleError) {
      throw createError({
        statusCode: error.code === "SOURCE_NOT_FOUND" ? 404 : 409,
        statusMessage: error.message,
        data: { code: error.code, current: error.current },
      });
    }
    throw error;
  }
});
