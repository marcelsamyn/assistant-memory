# Ingestion

Memory accepts inline documents and uploaded files from any client. Both paths return a source immediately and process its content in the background. Conversation and transcript ingestion keep their existing speaker-aware contracts.

## Source content and derived memory

Memory owns stored source content, file conversion, extraction, citations, and recall. Clients supply material they are authorized to access, stable source IDs, and known provenance. Clients decide whether a remembered request should become a notification, preparation, or external action; these decisions do not belong in Memory's ingestion contract.

A source can contain useful information without containing any commitment. Its text remains available independently of extracted tasks. Search returns derived memory and source references; use `getSource({ userId, partitionKey, sourceId, includeContent: true })` or MCP `get_source` to inspect the stored text. For converted files and HTML documents, this returns Markdown. Memory retains the original source payload separately from conversion output.

Email-aware extraction in this release is limited to tentative requests/promises, their supported deadlines, and subsequent clarification, completion, or revision. It does not promote other email statements into personal facts, aliases, or numeric measurements. Deadline references can introduce date nodes, not unrelated tasks or people. The full email and attachment content remain stored. Broader structured fact extraction from correspondence is a future Memory capability, not a task for each consuming application to reimplement.

An email deadline must quote an explicit deadline in the current request's verified evidence and match the stored date. The validator supports absolute ISO dates, unambiguous numeric dates, and month names in English, Dutch, French, and German, with a year and a supported deadline phrase. Relative dates, missing years, ambiguous numeric dates, and negated deadlines remain undated; the task is still retained. Dates from quoted history or incidental document dates do not establish a deadline.

A matched revision can remove an earlier inferred email deadline when its verified excerpt contains an unconditional removal sentence, such as “The deadline has been removed,” “There is no deadline now,” or “Er is geen deadline meer.” Removal currently recognizes bounded English and Dutch phrases. Missing dates, questions, conditional text, and unsupported replacement deadlines preserve the previous date. A removal applies only to an earlier deadline from the same email thread and never clears a date set by the user. Source-authored time governs delayed delivery; a later supported deadline can date the task again.

Commitment presentation excerpts cite the source that supplied the excerpt. A later status update can therefore have a different `sourceId` from `presentation.source.sourceId`. When no presentation exists, the presentation source falls back to the active status source.

## Ordinary documents

Use the same API for notes, articles, project files, and imported documents. Set `scope: "reference"` for material to recall as a reference rather than as the user's personal assertions. Context is optional; supply it when the host knows the origin and relationship.

```ts
await client.ingestDocument({
  userId,
  partitionKey: "project:workshop",
  updateExisting: true,
  document: {
    id: "notes/materials.md",
    content: "The workshop walls use lime plaster.",
    contentType: "markdown",
    title: "Workshop materials",
    sourceContext: {
      version: 1,
      sourceKind: "document",
      purpose: "Remember the owner's workshop notes.",
      accountId: "notes-vault",
      relationship: "owner",
      currentMessageRole: "primary",
      completeness: "complete",
    },
  },
});
```

`accountId` is a stable origin namespace within the user, such as a notes vault or connected mailbox. It is not a Petals account ID requirement. `purpose` describes why the source was supplied; it is not an instruction override or permission grant. Version 1 supports `document`, `file`, `email`, and `email_attachment`; conversation and transcript endpoints already carry roles and speakers.

## Contextual sources

Pass `sourceContext` when the calling application knows facts that Memory cannot safely infer from the content. For email, these facts can include the authenticated mailbox owner, To and CC roles, direction, message and thread identifiers, chronology, and an attachment's parent source.

Memory treats this context as application-owned data. It treats the document body and converted attachment text as evidence. Content cannot change the extraction rules, grant permission, or confirm a tentative task.

```ts
const accepted = await client.ingestDocument({
  userId,
  partitionKey: "global",
  updateExisting: true,
  document: {
    id: `gmail:${accountId}:${messageId}`,
    content: messageText,
    contentType: "text",
    sourceContext: {
      version: 1,
      sourceKind: "email",
      purpose: "Find requests and promises relevant to this mailbox.",
      accountId,
      authenticatedUser: { email: "owner@example.com" },
      relationship: "authenticated_mailbox_message",
      sender: { email: "sender@example.com" },
      recipients: [{ email: "owner@example.com", recipientRole: "to" }],
      direction: "incoming",
      deliveryKind: "person_message",
      messageId,
      threadId,
      authoredAt: authoredAt.toISOString(),
      currentMessageRole: "current_message",
      completeness: "complete",
    },
  },
});
```

`sourceContext` is optional. Calls that omit it keep the existing document and file behavior.

## Files and attachments

`ingestFile` sends bytes as multipart form data. Memory stores the bytes before conversion, then uses its MarkItDown service for supported PDF, Word, RTF, plain-text, Markdown, and HTML files. Use a stable `externalId` for retry-safe attachment identity and link the file to its parent source in `sourceContext`.

```ts
await client.ingestFile({
  userId,
  partitionKey: "global",
  file: attachmentBytes,
  filename: "request.pdf",
  mimeType: "application/pdf",
  externalId: `gmail:${accountId}:${messageId}:${attachmentId}`,
  sourceContext: {
    version: 1,
    sourceKind: "email_attachment",
    purpose: "Use this file as supporting evidence for its parent email.",
    accountId,
    relationship: "email_attachment",
    messageId,
    threadId,
    currentMessageRole: "attachment",
    parentSourceId: accepted.sourceId,
    parentPartitionKey: "global",
    sourceReferences: [
      { sourceId: accepted.sourceId, relationship: "attached_to_email" },
    ],
    completeness: "complete",
  },
});
```

## Follow one accepted revision

`sourceId` identifies the logical source. `ingestionOperationId` identifies the accepted revision of its content and extraction inputs. Poll the operation ID when a caller must distinguish accepted work from completed conversion and extraction.

For contextual documents and uploaded files, correcting meaningful source context reprocesses even identical bytes. For example, changing a direct recipient to CC or classifying a message as a newsletter removes stale inferred requests; correcting it back can extract the request again. Explicit confirmations and dismissals remain effective. Returning to an earlier content/context combination creates a new operation; historical receipts remain readable by ID. Legacy document calls without context retain their existing update behavior.

Scope, content type, author, timestamp, and source context participate in revision matching. Display-only title/URL changes and the compatibility `parentPartitionKey` hint do not require re-extraction. Omitted author and timestamp retain the stored values on retries. Concurrent first requests resolve these defaults under the source identity lock, so identical requests share one revision. Keep these inputs stable unless correcting them is intended.

```ts
if (!accepted.ingestionOperationId) {
  // A legacy duplicate response can omit the operation ID. Use the source read
  // path for that source instead of claiming that this revision completed.
  return;
}

const { processing } = await client.getSourceProcessing({
  userId,
  partitionKey: "global",
  operationId: accepted.ingestionOperationId,
});

switch (processing?.status) {
  case "queued":
  case "processing":
    break;
  case "completed":
    break;
  case "failed":
  case "purged":
  case undefined:
    // Keep the caller's coverage incomplete and offer recovery.
    break;
}
```

Do not use the source version as the acceptance-to-completion identity. Memory can update that version for other source metadata and lifecycle changes.

Before disconnecting an external account, retire each stable source identity whose ingestion result is unknown:

```ts
import { contextualSourceExternalId } from "@marcelsamyn/memory/sdk";

const { sources } = await client.sourceIdentityLifecycle({
  userId,
  partitionKey: "global",
  identities: [
    {
      type: "document",
      externalId: contextualSourceExternalId({
        externalId: `gmail:${accountId}:${messageId}`,
        accountId,
        partitionKey: "global",
      }),
    },
  ],
  action: "retire",
});
```

Ingestion accepts raw provider IDs and applies `contextualSourceExternalId` when `sourceContext` is present. Lifecycle requests accept canonical IDs. Call the helper once with the source's `accountId` and current `partitionKey`. A partition move updates the canonical ID and processing receipts atomically; use the destination partition for later ingestion and lifecycle commands. Sources ingested without `sourceContext` retain their raw ID; pass that unchanged to lifecycle requests.

If a retired contextual source moves, both its old and destination identities remain retired. Restoring the destination permits ingestion there without reopening the old identity to delayed deliveries. Restore the old identity separately only if ingestion in that partition is intended again.

This call closes a durable ingestion gate and waits for concurrent source creation. It returns matching sources, or an empty array when none exist. The caller can then erase each returned source without a later request recreating it. Use `action: "restore"` when the external account is restored.

An identical contextual document retry keeps the stored content and processing receipt. Caller-supplied metadata fields can still be revised. Omitted metadata fields and timestamps retain their stored values.

When only a document title changes, Memory updates the linked `Document` node as well as the source metadata and reuses the completed receipt. A failed replacement upload preserves the last committed blob until a replacement has committed; callers can retry the same source safely. A retry request returns a conflict while the retained queue job is still active, because reopening its receipt before that job finishes could leave the new work unscheduled.

For email sources, Memory removes common reply and forward boundaries before chunking and extraction. Forwarded headers, `Original Message`, `Forwarded message`, `Begin forwarded message`, `On … wrote:`, and Dutch `Op … schreef:` sections are treated as history. The complete original source remains available through `getSource`; only current-message text can establish a new request or deadline.

When a readable `email_attachment` finishes conversion, Memory re-runs the parent email extraction with the converted attachment as supporting evidence. The attachment never creates a task by itself: the parent email must contain the actionable request and deadline citation, while the extracted evidence can retain the attachment source reference. Late or corrected attachments can refine an existing request's label, statement, and supporting evidence. They preserve its current-message citation, lifecycle status, and manual confirmation or dismissal. Incoming lifecycle updates require a known original requester who matches the sender; authenticated outgoing owner messages can update the owner's work. This lets a message such as “please review the attached instructions” use those instructions without treating attachment text as a new instruction.

Each parent extraction prompt includes at most 100 attachment sources in source-ID order. It reads at most the first 4,000 characters of converted text per attachment and shares a 32,000-character limit across the complete serialized attachment section, including JSON escaping and delimiters. When the section would exceed that limit, Memory shortens each attachment prefix and marks truncated entries. Larger attachment sets omit sources beyond the first 100. This limit applies to each parent email chunk; extraction does not scan the omitted text. Complete converted Markdown and original bytes remain stored and available through source reads. A completed receipt confirms that this bounded extraction ran, not that it examined every attachment passage.

Attachment refinements refresh the task's canonical label and search embeddings together with its display label and statement. Replaying identical file bytes and extraction context reuses the existing receipt. A supplied title updates the linked Document label; without a supplied or stored title, an updated filename updates that label through the filename fallback. These display changes do not trigger extraction.

If file conversion produces no readable text, the receipt ends with `status: "failed"`, `stage: "content"`, and `errorCode: "UNREADABLE_CONTENT"`. Memory retains the original attachment bytes and skips extraction. Callers should retain the parent message body and show the attachment limitation instead of reporting complete coverage.

## HTTP, SDK, and MCP

| Operation                    | HTTP                             | SDK                     | MCP                                    |
| ---------------------------- | -------------------------------- | ----------------------- | -------------------------------------- |
| Store or revise text         | `POST /ingest/document`          | `ingestDocument`        | `save_memory`                          |
| Upload a file                | `POST /ingest/file` (multipart)  | `ingestFile`            | Use the host's HTTP/SDK upload support |
| Read exact processing status | `POST /sources/processing`       | `getSourceProcessing`   | `get_source_processing`                |
| Retry a failed operation     | `POST /sources/processing/retry` | `retrySourceProcessing` | `retry_source_processing`              |
| Read stored source text      | `POST /sources/get`              | `getSource`             | `get_source`                           |

MCP tools take the same request fields as their HTTP counterparts. `save_memory` now returns the JSON acceptance response in a text content block instead of the literal `Memory saved`. Preserve `sourceId` and `ingestionOperationId`; do not tell the user that extraction completed until the operation reports `completed`. A simple note can still omit `sourceContext` and `updateExisting`.

Use `updateExisting: true` only when a stable document ID represents a revision of the same source. Do not generate a new ID on each retry. The server namespaces contextual IDs by origin and partition; callers provide raw IDs when ingesting and canonical IDs only for identity lifecycle commands.

A failed receipt can be retried while its queue job is retained, including a job completed after an unreadable conversion. Retry after fixing the converter or file problem; repeating the same unreadable bytes does not make them readable. A queued receipt whose job was never saved can be recovered by resubmitting the same ingestion request with source-preserving defaults. `retrySourceProcessing` can also restore that job from retained conversion settings. For older document sources without those settings, resubmit the original request with `updateExisting: false`; legacy `updateExisting: true` replacements intentionally tombstone and recreate the source. Missing jobs for receipts in other states return a conflict. Purged sources and unauthorized partitions cannot be revived by retry.

If file upload fails before an operation is accepted, resubmit with the same stable file ID after the failure is known. Cleanup and replacement coordinate so an older cleanup cannot delete the retry's bytes. An upload with an unknown outcome remains blocked; an existing object alone does not prove that a timed-out replacement finished. Report that state for operational investigation rather than repeatedly retrying or claiming completion.
