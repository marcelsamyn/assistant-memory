import { isActionableEmailStatusClaim } from "./email-request-extraction";
import {
  emailRequestId,
  formatEmailRequestCandidates,
  MAX_EMAIL_REQUEST_HISTORY_PROMPT_CHARS,
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
  it("bounds serialized history and keeps current and dismissed evidence ahead of old rows", () => {
    const original = initialRequest();
    const history = Array.from({ length: 600 }, (_, index) => ({
      ...original,
      sourceId: newTypeId("source"),
      claimStatus: "superseded" as const,
      statedAt: new Date(original.statedAt.getTime() + index * 60_000),
      evidence: original.evidence?.emailThread
        ? {
            ...original.evidence,
            emailThread: {
              ...original.evidence.emailThread,
              excerpt: 'Quoted "detail"\\\n'.repeat(200),
            },
          }
        : null,
    }));
    const latest = history.at(-1);
    if (!latest) throw new Error("Expected newest history");
    const dismissed = {
      ...original,
      taskId: newTypeId("node"),
      sourceId: newTypeId("source"),
      claimStatus: "retracted" as const,
    };
    const prompt = formatEmailRequestCandidates([
      ...history,
      original,
      dismissed,
    ]);
    expect(prompt.length).toBeLessThanOrEqual(
      MAX_EMAIL_REQUEST_HISTORY_PROMPT_CHARS,
    );
    const serialized = prompt.split("\n")[1];
    if (!serialized) throw new Error("Expected serialized history");
    const data = JSON.parse(serialized);
    expect(data.omittedRecords).toBe(602 - data.requests.length);
    expect(data.omittedRecords).toBeGreaterThan(0);
    expect(
      data.requests.map((row: { sourceId: string }) => row.sourceId),
    ).toEqual(
      expect.arrayContaining([
        original.sourceId,
        dismissed.sourceId,
        latest.sourceId,
      ]),
    );
    expect(prompt).toContain(
      "absence from this window does not prove a request is new",
    );
    expect(history[0]?.claimStatus).toBe("superseded");
  });

  it("keeps normal request citations intact and reports no omitted history", () => {
    const original = initialRequest();
    const prompt = formatEmailRequestCandidates([original]);
    expect(prompt).toContain('"omittedRecords":0');
    expect(prompt).toContain(emailRequestId(original));
    expect(prompt).toContain(initialText);
    expect(formatEmailRequestCandidates([])).toBe("");
    expect(
      resolveUpdate("I have finished the review.", "completion", [original]),
    ).toMatchObject({
      taskId: original.taskId,
      status: "done",
    });
  });

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

  it.each(["clarification", "completion", "revision"] as const)(
    "allows only the authenticated author to apply a promise %s",
    (lifecycle) => {
      const text = "I will review the contract and send my comments.";
      const outgoing = {
        direction: "outgoing",
        sender: { email: "owner@example.com" },
        recipients: [{ email: "lena@example.com", recipientRole: "to" }],
      } satisfies Partial<SourceContext>;
      const initialClaim = claim(text);
      const resolution = resolveEmailRequest({
        context: { ...context, ...outgoing },
        claim: {
          ...initialClaim,
          emailRequestEvidence: {
            ...initialClaim.emailRequestEvidence!,
            kind: "user_promise",
          },
        },
        sourceId,
        content: text,
        candidates: [],
      });
      if (!resolution) throw new Error("Expected promise");
      const promise = {
        ...candidate(resolution),
        assertedByKind: "user_confirmed" as const,
      };
      const laterHistory = {
        ...promise,
        sourceId: newTypeId("source"),
        statedAt: new Date("2026-09-10T09:00:00.000Z"),
        evidence: { ...promise.evidence!, kind: "direct_request" as const },
      };
      const update = "The revised contract review is complete.";
      for (const sender of ["lena@example.com", "stranger@example.com"]) {
        expect(
          resolveUpdate(update, lifecycle, [promise], {
            sender: { email: sender },
          }),
        ).toBeNull();
      }
      expect(
        resolveUpdate(update, lifecycle, [laterHistory, promise]),
      ).toBeNull();
      expect(
        resolveUpdate(update, lifecycle, [promise], {
          ...outgoing,
          sender: { email: "stranger@example.com" },
        }),
      ).toBeNull();
      expect(
        resolveUpdate(update, lifecycle, [promise], outgoing),
      ).toMatchObject({
        taskId,
        status: lifecycle === "completion" ? "done" : "pending",
        evidence: { kind: "user_promise" },
      });
    },
  );

  it.each(["clarification", "completion", "revision"] as const)(
    "rejects incoming %s when the original requester is unknown",
    (lifecycle) => {
      const initial = initialRequest();
      const unknownRequester = {
        ...initial,
        evidence: { ...initial.evidence!, requester: null },
      };
      const text = "The revised contract review is complete.";
      for (const sender of ["lena@example.com", "stranger@example.com"]) {
        expect(
          resolveUpdate(text, lifecycle, [unknownRequester], {
            sender: { email: sender },
          }),
        ).toBeNull();
      }
      expect(
        resolveUpdate(text, lifecycle, [unknownRequester], {
          direction: "outgoing",
          sender: { email: "stranger@example.com" },
        }),
      ).toBeNull();
      expect(
        resolveUpdate(text, lifecycle, [unknownRequester], {
          direction: "outgoing",
          sender: { email: "owner@example.com" },
          recipients: [{ email: "lena@example.com", recipientRole: "to" }],
        }),
      ).toMatchObject({
        taskId,
        status: lifecycle === "completion" ? "done" : "pending",
        evidence: { requester: null, kind: "direct_request" },
      });
    },
  );

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
