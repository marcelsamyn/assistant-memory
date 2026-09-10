import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const commitmentRequestKindSchema = z.enum([
  "direct_request",
  "user_promise",
]);

/** Application-facing evidence for a tentative request extracted from mail. */
export const commitmentRequestEvidenceSchema = z
  .object({
    kind: commitmentRequestKindSchema,
    requester: z.string().min(1).max(320).nullable(),
    intendedResponder: z.string().min(1).max(320),
    supportingSourceIds: z.array(typeIdSchema("source")).min(1).max(100),
    lifecycleEvidence: z.enum([
      "current_message_direct_request",
      "current_message_user_promise",
    ]),
  })
  .strict();

export type CommitmentRequestEvidence = z.infer<
  typeof commitmentRequestEvidenceSchema
>;
