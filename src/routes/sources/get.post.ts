import { defineEventHandler } from "h3";
import { getSource } from "~/lib/get-source";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import { getSourceRequestSchema } from "~/lib/schemas/sources";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const input = {
    ...getSourceRequestSchema.parse(await readBody(event)),
    accessScope,
  };
  try {
    return await getSource(input);
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
