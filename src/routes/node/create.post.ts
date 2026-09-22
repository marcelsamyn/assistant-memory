import { defineEventHandler, createError } from "h3";
import { InvalidObjectValueError, NodesNotFoundError } from "~/lib/claim";
import { createNode } from "~/lib/node";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  createNodeRequestSchema,
  createNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, nodeType, label, description, initialClaims } =
    parseRequestBody(createNodeRequestSchema, await readBody(event));
  try {
    const { initialClaimIds, ...node } = await createNode(
      userId,
      nodeType,
      label,
      description,
      initialClaims,
      partitionKey,
      accessScope,
    );
    return createNodeResponseSchema.parse({ node, initialClaimIds });
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
    throw e;
  }
});
