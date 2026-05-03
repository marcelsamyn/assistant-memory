import { defineEventHandler, createError } from "h3";
import { InvalidObjectValueError } from "~/lib/claim";
import { createNode } from "~/lib/node";
import {
  createNodeRequestSchema,
  createNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeType, label, description, initialClaims } =
    createNodeRequestSchema.parse(await readBody(event));
  try {
    const { initialClaimIds, ...node } = await createNode(
      userId,
      nodeType,
      label,
      description,
      initialClaims,
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
    throw e;
  }
});
