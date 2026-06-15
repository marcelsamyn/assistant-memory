/**
 * Host abstraction for the AI Studio importer. The two supported ingest targets
 * differ on exactly three axes — endpoint path, auth header, and whether the
 * user id travels in the body:
 *
 *   memory → POST {url}/transcript/ingest           | Authorization: Bearer | userId required
 *   petals → POST {url}/api/memory/ingest/transcript | x-api-key            | userId derived from key
 *
 * Pure + testable; the CLI just picks a target and POSTs each batch's body.
 *
 * Common aliases: ingest target, host resolver, transcript body builder.
 */
import type { Utterance } from "./parse.js";

export type Host = "memory" | "petals";

export type IngestTarget = {
  endpoint: string;
  authHeaders: (apiKey: string) => Record<string, string>;
  /** Direct Memory ingest needs an explicit userId; the Petals proxy derives it. */
  requiresUserId: boolean;
};

export function targetFor(host: Host, apiUrl: string): IngestTarget {
  const base = apiUrl.replace(/\/+$/, "");
  if (host === "petals") {
    return {
      endpoint: `${base}/api/memory/ingest/transcript`,
      authHeaders: (apiKey) => ({ "x-api-key": apiKey }),
      requiresUserId: false,
    };
  }
  return {
    endpoint: `${base}/transcript/ingest`,
    authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    requiresUserId: true,
  };
}

export type IngestBody = {
  transcriptId: string;
  occurredAt: string;
  scope: "personal" | "reference";
  content: { kind: "segmented"; utterances: Utterance[] };
  userSelfAliasesOverride: string[];
  userId?: string;
};

/**
 * Assemble the request body for one batch. Includes `userId` only when the
 * target requires it (direct Memory host); throws if required but missing.
 */
export function buildIngestBody(params: {
  target: IngestTarget;
  transcriptId: string;
  occurredAt: string;
  scope: "personal" | "reference";
  utterances: Utterance[];
  selfAliases: string[];
  userId: string | undefined;
}): IngestBody {
  const { target, userId } = params;
  if (target.requiresUserId && !userId) {
    throw new Error(
      "This host requires a user id — set MEMORY_USER_ID or pass --user-id.",
    );
  }
  return {
    transcriptId: params.transcriptId,
    occurredAt: params.occurredAt,
    scope: params.scope,
    content: { kind: "segmented", utterances: params.utterances },
    userSelfAliasesOverride: params.selfAliases,
    ...(target.requiresUserId && userId ? { userId } : {}),
  };
}
