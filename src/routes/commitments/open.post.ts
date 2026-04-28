import { getOpenCommitments } from "~/lib/query/open-commitments";
import {
  openCommitmentsRequestSchema,
  openCommitmentsResponseSchema,
} from "~/lib/schemas/open-commitments";

export default defineEventHandler(async (event) => {
  const params = openCommitmentsRequestSchema.parse(await readBody(event));
  const commitments = await getOpenCommitments(params);
  return openCommitmentsResponseSchema.parse({ commitments });
});
