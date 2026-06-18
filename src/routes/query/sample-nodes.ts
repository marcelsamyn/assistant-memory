import { defineEventHandler } from "h3";
import { sampleInterestingNodes } from "~/lib/query/sample-nodes";
import {
  sampleNodesRequestSchema,
  sampleNodesResponseSchema,
} from "~/lib/schemas/sample-nodes";

export default defineEventHandler(async (event) => {
  const params = sampleNodesRequestSchema.parse(await readBody(event));
  const result = await sampleInterestingNodes(params);
  return sampleNodesResponseSchema.parse(result);
});
