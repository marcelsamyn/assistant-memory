import { defineEventHandler } from "h3";
import { createNode } from "~/lib/node";
import {
  createNodeRequestSchema,
  createNodeResponseSchema,
} from "~/lib/schemas/node";

export default defineEventHandler(async (event) => {
  const { userId, nodeType, label, description } =
    createNodeRequestSchema.parse(await readBody(event));
  const node = await createNode(userId, nodeType, label, description);
  return createNodeResponseSchema.parse({ node });
});
