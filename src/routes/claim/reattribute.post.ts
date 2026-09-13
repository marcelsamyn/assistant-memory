import { defineEventHandler, createError } from "h3";
import {
  AttributeClaimObjectReattributionError,
  InactiveClaimReattributionError,
  NodesNotFoundError,
  reattributeClaim,
  resolveClaimPartition,
} from "~/lib/claim";
import { CrossScopeMergeError } from "~/lib/node";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  reattributeClaimRequestSchema,
  reattributeClaimResponseSchema,
} from "~/lib/schemas/claim";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const input = reattributeClaimRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  try {
    const resolution = await resolveClaimPartition(
      await useDatabase(),
      input.userId,
      input.claimId,
      input.partitionKey,
      accessScope,
    );
    if (!resolution.found) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    const claim = await reattributeClaim({
      ...input,
      partitionKey: resolution.partitionKey,
    });
    if (!claim) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    return reattributeClaimResponseSchema.parse({ claim });
  } catch (e) {
    if (e instanceof AttributeClaimObjectReattributionError) {
      throw createError({
        statusCode: 400,
        statusMessage: e.message,
        data: { name: e.name, claimId: e.claimId, predicate: e.predicate },
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
    if (e instanceof InactiveClaimReattributionError) {
      throw createError({
        statusCode: 409,
        statusMessage: e.message,
        data: { name: e.name, claimId: e.claimId, status: e.status },
      });
    }
    if (e instanceof CrossScopeMergeError) {
      throw createError({
        statusCode: 409,
        statusMessage: "Cross-scope reattribution refused",
        data: { name: e.name, nodeIds: e.nodeIds, scopes: e.scopes },
      });
    }
    throwPartitionRouteError(e);
  }
});
