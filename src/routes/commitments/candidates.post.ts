import { getCandidateCommitments } from "~/lib/query/open-commitments";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  openCommitmentsRequestSchema,
  openCommitmentsResponseSchema,
} from "~/lib/schemas/open-commitments";

export default defineEventHandler(async (event) => {
  const params = openCommitmentsRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  const commitments = await getCandidateCommitments({
    ...params,
    accessScope,
  });
  return openCommitmentsResponseSchema.parse({ commitments });
});
