import type {
  NodeSearchResult,
  ClaimSearchResult,
  OneHopNode,
} from "~/lib/graph";
import { safeFormatISO } from "~/lib/safe-date";

interface Message {
  content: string;
  role: string;
  name?: string | undefined;
  timestamp: string | number | Date;
}

/**
 * Converts conversation messages to an XML-like format for LLM processing
 */
export function formatConversationAsXml(messages: Message[]): string {
  return messages
    .map(
      (message, index) =>
        `<message id="${index}" role="${message.role}" ${message.name ? `name="${message.name}"` : ""} timestamp="${safeFormatISO(message.timestamp)}">
      <content>${message.content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</content>
    </message>`,
    )
    .join("\n");
}

/** Escape special characters for XML */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Converts nodes to XML-like format for LLM prompts
 */
export function formatNodesForPrompt(
  existingNodes: Array<{
    id: string;
    type: string;
    label: string | null;
    description?: string | null;
    tempId: string;
    timestamp: string;
  }>,
): string {
  if (existingNodes.length === 0) {
    return "";
  }

  const xmlItems = existingNodes
    .map(
      (node) =>
        `<node id="${escapeXml(node.tempId)}" type="${escapeXml(node.type)}" timestamp="${node.timestamp}">
  <label>${escapeXml(node.label ?? "")}</label>
  <description>${escapeXml(node.description || "")}</description>
</node>`,
    )
    .join("\n");

  return `<nodes>
${xmlItems}
</nodes>`;
}

/**
 * Formats a list of label/description pairs as XML
 */
export function formatLabelDescList(
  items: Array<{ label?: string | null; description?: string | null }>,
): string {
  if (items.length === 0) {
    return "";
  }

  const xmlItems = items
    .map(
      (item) =>
        `<item label="${escapeXml(item.label ?? "Unnamed")}">${escapeXml(item.description ?? "")}</item>`,
    )
    .join("\n");
  return `<items>
${xmlItems}
</items>`;
}

/**
 * Strongly-typed alias for reranked search results.
 * Defined as an explicit union so TypeScript can narrow on `group` in switch statements.
 */
export type SearchResultItem =
  | { group: "similarNodes"; item: NodeSearchResult; relevance_score: number }
  | { group: "similarClaims"; item: ClaimSearchResult; relevance_score: number }
  | { group: "connections"; item: OneHopNode; relevance_score: number };

export type SearchResults = SearchResultItem[];

// Helpers for formatting individual result items
function formatSearchNode(node: NodeSearchResult): string {
  return `<node id="${escapeXml(node.id)}" type="${escapeXml(node.type)}" timestamp="${safeFormatISO(node.timestamp)}">
  <label>${escapeXml(node.label ?? "")}</label>
  <description>${escapeXml(node.description ?? "")}</description>
</node>`;
}

function formatSearchClaim(claim: ClaimSearchResult): string {
  return `<claim id="${escapeXml(claim.id)}" subjectNodeId="${escapeXml(claim.subjectNodeId)}" objectNodeId="${escapeXml(claim.objectNodeId ?? "")}" subject="${escapeXml(claim.subjectLabel ?? "")}" object="${escapeXml(
    claim.objectLabel ?? claim.objectValue ?? "",
  )}" predicate="${escapeXml(claim.predicate)}" sourceId="${escapeXml(claim.sourceId)}" status="${escapeXml(claim.status)}" statedAt="${safeFormatISO(claim.statedAt)}">
  <statement>${escapeXml(claim.statement)}</statement>
</claim>`;
}

function formatSearchConnection(conn: OneHopNode): string {
  return `<connected-node id="${escapeXml(conn.id)}" subjectNodeId="${escapeXml(conn.claimSubjectId)}" objectNodeId="${escapeXml(conn.claimObjectId)}" subject="${escapeXml(conn.subjectLabel ?? "")}" object="${escapeXml(
    conn.objectLabel ?? "",
  )}" predicate="${escapeXml(conn.predicate)}" timestamp="${safeFormatISO(conn.timestamp)}">
  <label>${escapeXml(conn.label ?? "")}</label>
  <statement>${escapeXml(conn.statement)}</statement>
  <description>${escapeXml(conn.description ?? "")}</description>
</connected-node>`;
}

function assertNever(value: never, message: string): never {
  throw new Error(message);
}

/**
 * Formats reranked search results as an XML-like structure for LLM prompts.
 * Items are ordered by descending relevance and tagged by their group.
 */
export function formatSearchResultsAsXml(results: SearchResults): string {
  const body = results.length
    ? results
        .map((r) => {
          switch (r.group) {
            case "similarNodes":
              return formatSearchNode(r.item);
            case "similarClaims":
              return formatSearchClaim(r.item);
            case "connections":
              return formatSearchConnection(r.item);
            default:
              return assertNever(
                r,
                `[formatSearchResultsAsXml] Unhandled search result group`,
              );
          }
        })
        .join("\n")
    : "";
  return body;
}

export type SearchResultWithId = SearchResults[number] & { tempId: string };

/**
 * Format search results with temporary IDs so the LLM can reference them.
 */
export function formatSearchResultsWithIds(
  results: SearchResultWithId[],
): string {
  const body = results.length
    ? results
        .map((r) => {
          const inner = (() => {
            switch (r.group) {
              case "similarNodes":
                return formatSearchNode(r.item);
              case "similarClaims":
                return formatSearchClaim(r.item);
              case "connections":
                return formatSearchConnection(r.item);
              default:
                return assertNever(
                  r,
                  `[formatSearchResultsWithIds] Unhandled search result group`,
                );
            }
          })();
          return `<result id="${escapeXml(r.tempId)}">${inner}</result>`;
        })
        .join("\n")
    : "";
  return body;
}
