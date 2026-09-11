import { defineEventHandler } from "h3";
import { getSource } from "~/lib/get-source";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getSourceRequestSchema } from "~/lib/schemas/sources";

export default defineEventHandler(async (event) => {
  const input = getSourceRequestSchema.parse(await readBody(event));
  try {
    return await getSource(input);
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
