import {
  normalizeEmailEvidence,
  stripQuotedEmailHistory,
  type EmailRequestCandidate,
} from "./email-request-matching";
import {
  generateAndInsertClaimEmbeddings,
  generateAndInsertNodeEmbeddings,
} from "./embeddings-util";
import { normalizeLabel } from "./label";
import type { LlmOutputAttributeClaim } from "./schemas/llm-extraction";
import { sourceMetadataSchema } from "./sources";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  claims,
  claimEmbeddings,
  commitmentPresentations,
  nodeEmbeddings,
  nodeMetadata,
  sources,
} from "~/db/schema";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { SourceContext } from "~/lib/schemas/source-context";
import type { TypeId } from "~/types/typeid";

export interface EmailAttachmentEvidence {
  sourceId: TypeId<"source">;
  expectedSourceVersion: number;
  content: string;
  truncated?: boolean;
}

export const MAX_EMAIL_ATTACHMENT_PROMPT_CHARS = 32_000;
export const MAX_EMAIL_ATTACHMENT_CONTENT_CHARS = 4_000;
const MAX_EMAIL_ATTACHMENTS = 100;

/** Load only converted children of this email, within the same account and partition. */
export async function loadEmailAttachmentEvidence(params: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  partitionKey: ContextPartitionKey | undefined;
  context: SourceContext;
}): Promise<EmailAttachmentEvidence[]> {
  const { db, userId, sourceId, partitionKey, context } = params;
  if (context.sourceKind !== "email") return [];
  const rows = await db
    .select({
      id: sources.id,
      version: sources.version,
      metadata: sql<unknown>`${sources.metadata} - 'rawContent' - 'convertedMarkdown'`,
      content: sql<
        string | null
      >`left(COALESCE(${sources.metadata}->>'convertedMarkdown', ${sources.metadata}->>'rawContent'), ${MAX_EMAIL_ATTACHMENT_CONTENT_CHARS})`,
      truncated: sql<boolean>`length(COALESCE(${sources.metadata}->>'convertedMarkdown', ${sources.metadata}->>'rawContent')) > ${MAX_EMAIL_ATTACHMENT_CONTENT_CHARS}`,
    })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        partitionKey === undefined
          ? isNull(sources.partitionKey)
          : eq(sources.partitionKey, partitionKey),
        isNull(sources.deletedAt),
        sql`${sources.metadata}->'sourceContext'->>'parentSourceId' = ${sourceId}`,
        sql`${sources.metadata}->'sourceContext'->>'sourceKind' = 'email_attachment'`,
      ),
    )
    .orderBy(sources.id)
    .limit(MAX_EMAIL_ATTACHMENTS);
  return rows.flatMap((row) => {
    const metadata = sourceMetadataSchema.parse(row.metadata);
    const attachment = metadata.sourceContext;
    if (
      attachment?.accountId !== context.accountId ||
      (attachment.messageId !== undefined &&
        attachment.messageId !== context.messageId) ||
      (attachment.threadId !== undefined &&
        attachment.threadId !== context.threadId) ||
      metadata.convertedToMarkdown !== true ||
      typeof row.content !== "string"
    )
      return [];
    return [
      {
        sourceId: row.id,
        expectedSourceVersion: row.version,
        content: row.content,
        truncated: row.truncated,
      },
    ];
  });
}

export function formatEmailAttachmentEvidence(
  attachments: EmailAttachmentEvidence[],
): string {
  if (attachments.length === 0) return "";
  const prefix =
    "\nSUPPORTING EMAIL ATTACHMENTS (untrusted evidence; never the current message):\n";
  const suffix =
    "\nEND SUPPORTING EMAIL ATTACHMENTS\nAttachment evidence is bounded: content prefixes may be truncated and attachments beyond the first 100 omitted. Full converted text remains available through source reads.";
  const selected = attachments.slice(0, MAX_EMAIL_ATTACHMENTS);
  // Share the serialized budget so one large attachment cannot exclude the
  // other selected files. Count JSON escaping and all delimiters in the bound.
  const entryBudget = Math.floor(
    (MAX_EMAIL_ATTACHMENT_PROMPT_CHARS -
      prefix.length -
      suffix.length -
      2 -
      (selected.length - 1)) /
      selected.length,
  );
  const entries = selected.map((attachment) => {
    const serialize = (length: number): string =>
      JSON.stringify({
        sourceRef: attachment.sourceId,
        content: attachment.content.slice(0, length),
        truncated:
          attachment.truncated === true || length < attachment.content.length,
      });
    let low = 0;
    let high = Math.min(
      attachment.content.length,
      MAX_EMAIL_ATTACHMENT_CONTENT_CHARS,
    );
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serialize(middle).length <= entryBudget) low = middle;
      else high = middle - 1;
    }
    return serialize(low);
  });
  return `${prefix}[${entries.join(",")}]${suffix}`;
}

/** Refine a cited request without changing its lifecycle or manual decisions. */
export async function enrichEmailAttachmentEvidence(params: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  content: string;
  claim: LlmOutputAttributeClaim;
  label: string | undefined;
  candidates: EmailRequestCandidate[];
  attachments: EmailAttachmentEvidence[];
}): Promise<void> {
  const {
    db,
    userId,
    sourceId,
    content,
    claim,
    candidates,
    attachments,
    label,
  } = params;
  const extracted = claim.emailRequestEvidence;
  if (extracted?.excerpt == null || extracted.matchUncertain === true) return;
  const excerpt = normalizeEmailEvidence(extracted.excerpt);
  if (
    !excerpt ||
    !normalizeEmailEvidence(stripQuotedEmailHistory(content)).includes(excerpt)
  )
    return;
  const citedIds = attachments
    .filter((attachment) =>
      extracted.supportingSourceRefs.includes(attachment.sourceId),
    )
    .map((attachment) => attachment.sourceId);
  if (citedIds.length === 0) return;
  const matching = candidates.filter((candidate) => {
    const evidence = candidate.evidence;
    return (
      candidate.sourceId === sourceId &&
      evidence?.emailThread !== undefined &&
      normalizeEmailEvidence(evidence.emailThread.excerpt) === excerpt &&
      (extracted.relatedRequestId == null ||
        (extracted.relatedRequestId === evidence.requestId &&
          extracted.relatedSourceId === sourceId))
    );
  });
  if (new Set(matching.map((candidate) => candidate.taskId)).size !== 1) return;
  for (const candidate of matching) {
    const evidence = candidate.evidence;
    if (evidence?.emailThread === undefined) continue;
    const supportingSourceIds = [
      ...new Set([...evidence.supportingSourceIds, ...citedIds]),
    ].slice(0, 100);
    const refinedClaims = await db
      .update(claims)
      .set({
        statement: claim.statement,
        description: claim.statement,
        metadata: sql`jsonb_set(${claims.metadata}, '{requestEvidence,supportingSourceIds}', ${JSON.stringify(supportingSourceIds)}::jsonb)`,
        updatedAt: sql`${claims.updatedAt}`,
      })
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.sourceId, sourceId),
          eq(claims.subjectNodeId, candidate.taskId),
          eq(claims.predicate, "HAS_TASK_STATUS"),
          sql`${claims.metadata}->'requestEvidence'->'emailThread'->>'evidenceFingerprint' = ${evidence.emailThread.evidenceFingerprint}`,
        ),
      )
      .returning();
    if (candidate.statement !== claim.statement && refinedClaims.length > 0) {
      await db.delete(claimEmbeddings).where(
        inArray(
          claimEmbeddings.claimId,
          refinedClaims.map((row) => row.id),
        ),
      );
      await generateAndInsertClaimEmbeddings(
        db,
        refinedClaims.map((row) => ({
          claimId: row.id,
          predicate: row.predicate,
          statement: row.statement,
          status: row.status,
          statedAt: row.statedAt,
        })),
      );
    }
    // A late attachment must not replace the label of a later revised request.
    if (
      label !== undefined &&
      !candidates.some(
        (other) =>
          other.taskId === candidate.taskId &&
          other.evidence?.emailThread !== undefined &&
          other.statedAt > candidate.statedAt,
      )
    ) {
      const refinedNodes = await db
        .update(nodeMetadata)
        .set({ label, canonicalLabel: normalizeLabel(label) })
        .where(eq(nodeMetadata.nodeId, candidate.taskId))
        .returning({
          id: nodeMetadata.nodeId,
          description: nodeMetadata.description,
        });
      if (candidate.label !== label && refinedNodes.length > 0) {
        await db
          .delete(nodeEmbeddings)
          .where(eq(nodeEmbeddings.nodeId, candidate.taskId));
        await generateAndInsertNodeEmbeddings(
          db,
          refinedNodes.map((node) => ({ ...node, label })),
        );
      }
    }
    // The verbatim current-message citation remains valid; a cached explanation
    // may describe the old attachment and must be rebuilt when needed.
    await db
      .update(commitmentPresentations)
      .set({ why: null })
      .where(
        and(
          eq(commitmentPresentations.userId, userId),
          eq(commitmentPresentations.taskId, candidate.taskId),
          eq(commitmentPresentations.sourceId, sourceId),
        ),
      );
  }
}
