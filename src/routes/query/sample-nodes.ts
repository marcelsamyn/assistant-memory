import { defineEventHandler } from "h3";
import { sampleInterestingNodes } from "~/lib/query/sample-nodes";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  sampleNodesRequestSchema,
  sampleNodesResponseSchema,
} from "~/lib/schemas/sample-nodes";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    sampleNodesRequestSchema,
    await readBody(event),
  );
  const result = await sampleInterestingNodes({
    ...params,
    accessScope: getRequestAccessScope(event),
  });
  return sampleNodesResponseSchema.parse(result);
});
