import { defineEventHandler, createError } from "h3";
import {
  createClaim,
  InvalidObjectValueError,
  NodesNotFoundError,
} from "~/lib/claim";
import { resolveNodePartition } from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  createClaimRequestSchema,
  createClaimResponseSchema,
} from "~/lib/schemas/claim";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const claimInput = createClaimRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  try {
    const partitionKey = await resolveNodePartition(
      await useDatabase(),
      claimInput.userId,
      claimInput.subjectNodeId,
      claimInput.partitionKey,
      accessScope,
    );
    const claim = await createClaim({ ...claimInput, partitionKey });
    return createClaimResponseSchema.parse({ claim });
  } catch (e) {
    if (e instanceof InvalidObjectValueError) {
      throw createError({
        statusCode: 400,
        statusMessage: e.message,
        data: {
          name: e.name,
          predicate: e.predicate,
          objectValue: e.objectValue,
          allowedValues: e.allowedValues,
        },
      });
    }
    if (e instanceof NodesNotFoundError) {
      throw createError({
        statusCode: 422,
        statusMessage: e.message,
        data: {
          name: e.name,
          userId: e.userId,
          missingNodeIds: e.missingNodeIds,
        },
      });
    }
    throwPartitionRouteError(e);
  }
});
