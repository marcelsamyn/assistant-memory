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
      "current_message_clarification",
      "current_message_completion",
      "current_message_revision",
    ]),
    requestId: z.string().min(1).max(200).optional(),
    matchStatus: z.enum(["new", "matched", "uncertain"]).optional(),
    emailThread: z
      .object({
        accountId: z.string().min(1).max(200),
        threadId: z.string().min(1).max(500),
        messageId: z.string().min(1).max(500),
        authoredAt: z.string().datetime(),
        excerpt: z.string().min(1).max(4_000),
        evidenceFingerprint: z.string().length(64),
        sourceOperationId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CommitmentRequestEvidence = z.infer<
  typeof commitmentRequestEvidenceSchema
>;

export function readCommitmentRequestEvidence(
  metadata: unknown,
): CommitmentRequestEvidence | null {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("requestEvidence" in metadata)
  )
    return null;
  return (
    commitmentRequestEvidenceSchema.safeParse(metadata.requestEvidence).data ??
    null
  );
}
