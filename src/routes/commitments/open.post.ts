import { getOpenCommitments } from "~/lib/query/open-commitments";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  openCommitmentsRequestSchema,
  openCommitmentsResponseSchema,
} from "~/lib/schemas/open-commitments";

export default defineEventHandler(async (event) => {
  const params = {
    ...openCommitmentsRequestSchema.parse(await readBody(event)),
    accessScope: getRequestAccessScope(event),
  };
  const commitments = await getOpenCommitments(params);
  return openCommitmentsResponseSchema.parse({ commitments });
});
