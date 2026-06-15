import { defineEventHandler, readBody } from "h3";
import { recoverStatuslessCommitments } from "~/lib/jobs/recover-statusless-commitments";
import {
  recoverStatuslessCommitmentsRequestSchema,
  recoverStatuslessCommitmentsResponseSchema,
} from "~/lib/schemas/recover-statusless-commitments";

export default defineEventHandler(async (event) => {
  const params = recoverStatuslessCommitmentsRequestSchema.parse(
    await readBody(event),
  );
  const result = await recoverStatuslessCommitments(params);
  return recoverStatuslessCommitmentsResponseSchema.parse(result);
});
