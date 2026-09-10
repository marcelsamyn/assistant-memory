import { isActionableEmailStatusClaim } from "./email-request-extraction";
import {
  emailRequestId,
  normalizeEmailEvidence,
  resolveEmailRequest,
  stripQuotedEmailHistory,
  type EmailRequestCandidate,
  type EmailRequestResolution,
} from "./email-request-matching";
import type { LlmOutputAttributeClaim } from "./schemas/llm-extraction";
import type { SourceContext } from "./schemas/source-context";
import { describe, expect, it } from "vitest";
import { newTypeId } from "~/types/typeid";

const sourceId = newTypeId("source");
const taskId = newTypeId("node");
const initialText =
  "Please review the revised contract and send your comments.";
const context: SourceContext = {
  version: 1,
  sourceKind: "email",
  purpose: "Track requests in opted-in mail",
  accountId: "mail-account-1",
  threadId: "thread-1",
  messageId: "message-1",
  authoredAt: "2026-09-10T08:00:00.000Z",
  authenticatedUser: { email: "owner@example.com" },
  sender: { email: "lena@example.com" },
  recipients: [{ email: "owner@example.com", recipientRole: "to" }],
  relationship: "recipient",
  direction: "incoming",
  currentMessageRole: "current_message",
  completeness: "complete",
};

function claim(
  excerpt: string,
  lifecycle:
    | "request"
    | "clarification"
    | "completion"
    | "revision" = "request",
  previous?: EmailRequestCandidate,
): LlmOutputAttributeClaim {
  return {
    subjectId: previous?.taskId ?? "temp_task_1",
    sourceRef: sourceId,
    assertionKind: "user_confirmed",
    predicate: "HAS_TASK_STATUS",
    objectValue: lifecycle === "completion" ? "done" : "pending",
    statement: excerpt,
    emailRequestEvidence: {
      kind: "direct_request",
      lifecycle,
      excerpt,
      supportingSourceRefs: [sourceId],
      ...(previous
        ? {
            relatedRequestId: emailRequestId(previous),
            relatedSourceId: previous.sourceId,
          }
        : {}),
    },
  };
}

function candidate(
  resolution: EmailRequestResolution,
  source = sourceId,
): EmailRequestCandidate {
  return {
    taskId,
    sourceId: source,
    label: "Review contract",
    statement: resolution.evidence.emailThread?.excerpt ?? initialText,
    status: resolution.status,
    claimStatus: "active",
    assertedByKind: "assistant_inferred",
    statedAt: resolution.statedAt,
    updatedAt: resolution.statedAt,
    evidence: resolution.evidence,
  };
}

function initialRequest(): EmailRequestCandidate {
  const resolved = resolveEmailRequest({
    context,
    claim: claim(initialText),
    sourceId,
    content: initialText,
    candidates: [],
    sourceOperationId: "operation-initial",
  });
  if (!resolved) throw new Error("Expected initial request");
  return candidate(resolved);
}

function resolveUpdate(
  excerpt: string,
  lifecycle: "request" | "clarification" | "completion" | "revision",
  candidates: EmailRequestCandidate[],
  overrides: Partial<SourceContext> = {},
): EmailRequestResolution | null {
  return resolveEmailRequest({
    context: {
      ...context,
      messageId: "message-2",
      authoredAt: "2026-09-10T10:00:00.000Z",
      ...overrides,
    },
    claim: claim(excerpt, lifecycle, candidates[0]),
    sourceId: newTypeId("source"),
    content: excerpt,
    candidates,
  });
}

describe("email request matching and evolution", () => {
  it("keeps a clarification open, preserves the original requester, and records the cited message", () => {
    const initial = initialRequest();
    const outgoing = {
      direction: "outgoing",
      sender: { email: "owner@example.com" },
      recipients: [{ email: "lena@example.com", recipientRole: "to" }],
    } satisfies Partial<SourceContext>;
    const question = "Which contract section needs my comments?";
    expect(
      isActionableEmailStatusClaim(
        { ...context, ...outgoing },
        claim(question, "clarification", initial),
      ),
    ).toBe(true);
    const resolved = resolveUpdate(
      question,
      "clarification",
      [initial],
      outgoing,
    );
    expect(resolved).toMatchObject({
      taskId,
      status: "pending",
      evidence: {
        kind: "direct_request",
        requester: "lena@example.com",
        intendedResponder: "owner@example.com",
        lifecycleEvidence: "current_message_clarification",
        requestId: initial.evidence?.requestId,
      },
    });
    expect(resolved?.evidence.supportingSourceIds).toContain(sourceId);
  });

  it("closes only the explicitly cited request in a thread with two tasks", () => {
    const first = initialRequest();
    const second = {
      ...initialRequest(),
      taskId: newTypeId("node"),
      sourceId: newTypeId("source"),
      evidence: { ...initialRequest().evidence!, requestId: "another-request" },
    };
    const resolved = resolveUpdate(
      "I reviewed the contract and sent all comments.",
      "completion",
      [first, second],
    );
    expect(resolved).toMatchObject({ taskId: first.taskId, status: "done" });
    expect(resolved?.evidence.supportingSourceIds).not.toContain(
      second.sourceId,
    );
  });

  it("keeps a new request separate when subject matter cannot be matched with a citation", () => {
    const text = "Please review the invoice and approve the amount.";
    const resolved = resolveEmailRequest({
      context,
      claim: {
        ...claim(text),
        emailRequestEvidence: {
          kind: "direct_request",
          supportingSourceRefs: [sourceId],
          excerpt: text,
          matchUncertain: true,
        },
      },
      sourceId,
      content: text,
      candidates: [initialRequest()],
    });
    expect(resolved?.taskId).toBeUndefined();
    expect(resolved?.evidence.matchStatus).toBe("uncertain");
    expect(resolved?.evidence.requestId).not.toEqual(
      initialRequest().evidence?.requestId,
    );
  });

  it("does not accept an invented citation, foreign participant, account, or thread", () => {
    const initial = initialRequest();
    const text =
      "The revised contract includes new terms; please review it again.";
    const badClaim = claim(text, "revision", {
      ...initial,
      sourceId: newTypeId("source"),
    });
    expect(
      resolveEmailRequest({
        context,
        claim: badClaim,
        sourceId,
        content: text,
        candidates: [initial],
      }),
    ).toBeNull();
    for (const overrides of [
      { sender: { email: "stranger@example.com" } },
      { accountId: "other-account" },
      { threadId: "other-thread" },
    ]) {
      expect(resolveUpdate(text, "revision", [initial], overrides)).toBeNull();
    }
  });

  it("rejects unsupported and quoted-only passages", () => {
    const initial = initialRequest();
    const completion = "I reviewed the contract and sent all comments.";
    for (const content of [
      "Thanks for your message.",
      `Thanks.\n> ${completion}`,
      `Thanks.\nOn Monday Lena wrote:\n${completion}`,
    ]) {
      expect(
        resolveEmailRequest({
          context,
          claim: claim(completion, "completion", initial),
          sourceId,
          content,
          candidates: [initial],
        }),
      ).toBeNull();
    }
  });

  it("deduplicates changed evidence spans on the same message without merging separate requests", () => {
    const initial = initialRequest();
    const expanded = `${initialText} Focus on the liability clause.`;
    expect(
      resolveEmailRequest({
        context,
        claim: claim(expanded),
        sourceId,
        content: expanded,
        candidates: [initial],
      }),
    ).toBeNull();
    const separate = "Please approve the attached invoice.";
    expect(
      resolveEmailRequest({
        context,
        claim: claim(separate),
        sourceId,
        content: `${expanded}\n${separate}`,
        candidates: [initial],
      }),
    ).not.toBeNull();
    const withGreeting = `Hi Marcel. ${initialText}`;
    const focus = `${initialText} Focus on the liability clause.`;
    const greetingResolution = resolveEmailRequest({
      context,
      claim: claim(withGreeting),
      sourceId,
      content: `${withGreeting} Focus on the liability clause.`,
      candidates: [],
    });
    if (!greetingResolution) throw new Error("Expected greeting request");
    expect(
      resolveEmailRequest({
        context,
        claim: claim(focus),
        sourceId,
        content: `${withGreeting} Focus on the liability clause.`,
        candidates: [candidate(greetingResolution)],
      }),
    ).toBeNull();
    const firstInvoice = "Please review invoice 12";
    const secondInvoice = "Please review invoice 123.";
    const firstInvoiceResolution = resolveEmailRequest({
      context,
      claim: claim(firstInvoice),
      sourceId,
      content: `${firstInvoice}.\n${secondInvoice}`,
      candidates: [],
    });
    if (!firstInvoiceResolution) throw new Error("Expected invoice request");
    expect(
      resolveEmailRequest({
        context,
        claim: claim(secondInvoice),
        sourceId,
        content: `${firstInvoice}.\n${secondInvoice}`,
        candidates: [candidate(firstInvoiceResolution)],
      }),
    ).not.toBeNull();
  });

  it("does not reopen dismissed work on duplicate or format-only evidence", () => {
    const initial = { ...initialRequest(), claimStatus: "retracted" as const };
    expect(resolveUpdate(initialText, "request", [initial])).toBeNull();
    const formatted =
      "Please **review** the revised contract\n and send your comments.";
    expect(normalizeEmailEvidence(formatted)).toEqual(
      normalizeEmailEvidence(initialText),
    );
    expect(resolveUpdate(formatted, "revision", [initial])).toBeNull();
    expect(
      resolveUpdate("Which section needs comments?", "clarification", [
        initial,
      ]),
    ).toBeNull();
  });

  it("requires a material revision after the dismissal to reopen", () => {
    const initial = {
      ...initialRequest(),
      claimStatus: "retracted" as const,
      updatedAt: new Date("2026-09-10T09:00:00.000Z"),
    };
    const text = "Please review the new liability terms in contract v2.";
    expect(resolveUpdate(text, "revision", [initial])).toMatchObject({
      taskId,
      status: "pending",
      evidence: { lifecycleEvidence: "current_message_revision" },
    });
    expect(
      resolveUpdate(text, "revision", [initial], {
        authoredAt: "2026-09-10T08:30:00.000Z",
      }),
    ).toBeNull();
  });

  it("keeps a dismissal authoritative across later inferred clarifications", () => {
    const initial = initialRequest();
    const dismissal = {
      ...initial,
      claimStatus: "retracted" as const,
      assertedByKind: "user_confirmed" as const,
      updatedAt: new Date("2026-09-10T09:00:00.000Z"),
    };
    const clarificationResolution = resolveUpdate(
      "Which contract section needs my comments?",
      "clarification",
      [initial],
      { authoredAt: "2026-09-10T09:30:00.000Z" },
    );
    if (!clarificationResolution) throw new Error("Expected clarification");
    const clarification = candidate(
      clarificationResolution,
      newTypeId("source"),
    );
    expect(
      resolveUpdate(
        "Should I include comments on the annex?",
        "clarification",
        [dismissal, clarification],
        { authoredAt: "2026-09-10T10:30:00.000Z" },
      ),
    ).toBeNull();
  });

  it("uses application chronology and retains older supported evidence without making it current", () => {
    const initial = initialRequest();
    const done = resolveUpdate(
      "I reviewed the contract and sent all comments.",
      "completion",
      [initial],
    );
    if (!done) throw new Error("Expected completion");
    const completed = candidate(done, newTypeId("source"));
    const earlier = resolveUpdate(
      "Which section needs comments?",
      "clarification",
      [initial, completed],
      { authoredAt: "2026-09-10T09:00:00.000Z" },
    );
    expect(earlier?.statedAt.toISOString()).toBe("2026-09-10T09:00:00.000Z");
    expect(
      resolveUpdate(
        "Thanks, understood.",
        "clarification",
        [initial, completed],
        { authoredAt: "2026-09-10T11:00:00.000Z" },
      ),
    ).toMatchObject({ taskId, status: "done" });
    expect(
      resolveUpdate(
        "Please review the new liability terms in contract v2.",
        "revision",
        [initial, completed],
        { authoredAt: "2026-09-10T12:00:00.000Z" },
      ),
    ).toMatchObject({ taskId, status: "pending" });
  });

  it.each([
    "Thanks.\n---------- Forwarded message ---------\nFrom: lena@example.com\nPlease review the old contract.",
    "Thanks.\nBegin forwarded message:\nFrom: lena@example.com\nPlease review the old contract.",
    "Thanks.\nOn Monday Lena wrote:\nPlease review the old contract.",
    "On Monday Lena wrote:\nPlease review the old contract.",
  ])(
    "removes forwarded and reply history even at a chunk boundary",
    (content) => {
      expect(stripQuotedEmailHistory(content)).toBe(
        content.startsWith("On Monday") ? "" : "Thanks.",
      );
    },
  );
});
