import { defineEventHandler, readValidatedBody } from "h3";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import {
  sourceIdentityLifecycleRequestSchema,
  sourceIdentityLifecycleResponseSchema,
} from "~/lib/schemas/sources";
import { applySourceIdentityLifecycle } from "~/lib/source-identity-lifecycle";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(
    event,
    sourceIdentityLifecycleRequestSchema.parse,
  );
  const db = await useDatabase();
  await ensureUser(db, input.userId);
  try {
    await assertPartitionReadAllowed(db, input.userId, input.partitionKey);
    return sourceIdentityLifecycleResponseSchema.parse(
      await applySourceIdentityLifecycle(db, input),
    );
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
