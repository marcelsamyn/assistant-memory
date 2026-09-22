import { defineEventHandler } from "h3";
import { listCommitments } from "~/lib/query/commitments-list";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  listCommitmentsRequestSchema,
  listCommitmentsResponseSchema,
} from "~/lib/schemas/list-commitments";

export default defineEventHandler(async (event) => {
  const params = {
    ...parseRequestBody(listCommitmentsRequestSchema, await readBody(event)),
    accessScope: getRequestAccessScope(event),
  };
  const result = await listCommitments(params);
  return listCommitmentsResponseSchema.parse(result);
});
