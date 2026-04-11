import { formatISO } from "date-fns";
import type {
  NodeSearchResult,
  EdgeSearchResult,
  OneHopNode,
} from "~/lib/graph";
import type { RerankResult } from "~/lib/rerank";

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
        `<message id="${index}" role="${message.role}" ${message.name ? `name="${message.name}"` : ""} timestamp="${formatISO(message.timestamp)}">
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

// Group definitions for reranked search results
type SearchGroups = {
  similarNodes: NodeSearchResult;
  similarEdges: EdgeSearchResult;
  connections: OneHopNode;
};

/**
 * Strongly-typed alias for reranked search results.
 */
export type SearchResults = RerankResult<SearchGroups>;

// Helpers for formatting individual result items
function formatSearchNode(node: NodeSearchResult): string {
  return `<node id="${escapeXml(node.id)}" type="${escapeXml(node.type)}" timestamp="${formatISO(node.timestamp)}">
  <label>${escapeXml(node.label ?? "")}</label>
  <description>${escapeXml(node.description ?? "")}</description>
</node>`;
}

function formatSearchEdge(edge: EdgeSearchResult): string {
  return `<edge id="${escapeXml(edge.id)}" sourceNodeId="${escapeXml(edge.sourceNodeId)}" targetNodeId="${escapeXml(edge.targetNodeId)}" from="${escapeXml(edge.sourceLabel ?? "")}" to="${escapeXml(
    edge.targetLabel ?? "",
  )}" type="${escapeXml(edge.edgeType)}" timestamp="${formatISO(edge.timestamp)}">
  <description>${escapeXml(edge.description ?? "")}</description>
</edge>`;
}

function formatSearchConnection(conn: OneHopNode): string {
  return `<connected-node id="${escapeXml(conn.id)}" sourceNodeId="${escapeXml(conn.edgeSourceId)}" targetNodeId="${escapeXml(conn.edgeTargetId)}" from="${escapeXml(conn.sourceLabel ?? "")}" to="${escapeXml(
    conn.targetLabel ?? "",
  )}" type="${escapeXml(conn.edgeType)}" timestamp="${formatISO(conn.timestamp)}">
  <label>${escapeXml(conn.label ?? "")}</label>
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
            case "similarEdges":
              return formatSearchEdge(r.item);
            case "connections":
              return formatSearchConnection(r.item);
            default:
              return assertNever(
                r.group,
                `[formatSearchResultsAsXml] Unhandled search result group: ${String(
                  r.group,
                )}`,
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
              case "similarEdges":
                return formatSearchEdge(r.item);
              case "connections":
                return formatSearchConnection(r.item);
              default:
                return assertNever(
                  r.group,
                  `[formatSearchResultsWithIds] Unhandled search result group: ${String(
                    r.group,
                  )}`,
                );
            }
          })();
          return `<result id="${escapeXml(r.tempId)}">${inner}</result>`;
        })
        .join("\n")
    : "";
  return body;
}
