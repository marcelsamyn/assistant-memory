import { defineEventHandler, createError } from "h3";
import {
  AttributeClaimObjectReattributionError,
  InactiveClaimReattributionError,
  NodesNotFoundError,
  reattributeClaim,
} from "~/lib/claim";
import { CrossScopeMergeError } from "~/lib/node";
import {
  reattributeClaimRequestSchema,
  reattributeClaimResponseSchema,
} from "~/lib/schemas/claim";

export default defineEventHandler(async (event) => {
  const input = reattributeClaimRequestSchema.parse(await readBody(event));
  try {
    const claim = await reattributeClaim(input);
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
    throw e;
  }
});
