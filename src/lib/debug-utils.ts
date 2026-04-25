import { env } from "~/utils/env";

/**
 * Generic debug logger controlled via DEBUG_LOGS flag.
 */
export function debug(...args: unknown[]) {
  if (!env.DEBUG_LOGS) return;
  console.debug("[DEBUG]", ...args);
}

/**
 * Pretty-print nodes and claims for debugging.
 */
export function debugGraph<
  N extends {
    id: unknown;
    label: string;
    description?: string | undefined;
    nodeType: unknown;
  },
  E extends {
    subjectNodeId: unknown;
    objectNodeId?: unknown;
    predicate: unknown;
    statement: string;
  },
>(nodes: N[], claims: E[]) {
  if (!env.DEBUG_LOGS) return;
  console.group("🪵 Debug Graph 🔍");
  console.group("Nodes");
  nodes.forEach((n) =>
    console.log(
      `• [${n.id}] (${n.nodeType}) "${n.label}" — ${n.description ?? ""}`,
    ),
  );
  console.groupEnd();
  console.group("Claims");
  claims.forEach((claim) =>
    console.log(
      `• ${claim.subjectNodeId} → ${claim.objectNodeId ?? "(value)"} (${claim.predicate}): ${claim.statement}`,
    ),
  );
  console.groupEnd();
  console.groupEnd();
}
