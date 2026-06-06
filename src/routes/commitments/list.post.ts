import { defineEventHandler } from "h3";
import { listCommitments } from "~/lib/query/commitments-list";
import {
  listCommitmentsRequestSchema,
  listCommitmentsResponseSchema,
} from "~/lib/schemas/list-commitments";

export default defineEventHandler(async (event) => {
  const params = listCommitmentsRequestSchema.parse(await readBody(event));
  const result = await listCommitments(params);
  return listCommitmentsResponseSchema.parse(result);
});
