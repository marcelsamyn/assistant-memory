import { defineEventHandler } from "h3";
import { findDayNode, findOneHopNodes, type OneHopNode } from "~/lib/graph";
import {
  type QueryNodeTypeResponse,
  queryNodeTypeRequestSchema,
  queryNodeTypeResponseSchema,
} from "~/lib/schemas/query-node-type";
import { useDatabase } from "~/utils/db";

type LabeledOneHopNode = OneHopNode & { label: string };

export default defineEventHandler(async (event) => {
  const { userId, types, date, includeFormattedResult } =
    queryNodeTypeRequestSchema.parse(await readBody(event));
  const db = await useDatabase();

  // Get the day node ID
  const dayNodeId = await findDayNode(db, userId, date);
  if (!dayNodeId) {
    return queryNodeTypeResponseSchema.parse({
      date,
      types,
      error: `No day node found for ${date}`,
      nodes: [],
    });
  }

  // Fetch one-hop connections (only nodes with labels)
  const connections = await findOneHopNodes(db, userId, [dayNodeId]);

  // Filter by requested types
  const filtered = connections.filter(
    (rec): rec is LabeledOneHopNode =>
      rec.label !== null && types.includes(rec.type),
  );

  // Deduplicate by nodeId
  const uniqueMap = new Map<string, (typeof filtered)[0]>();
  filtered.forEach((rec) => uniqueMap.set(rec.id, rec));
  const uniqueRecords: QueryNodeTypeResponse["nodes"] = Array.from(
    uniqueMap.values(),
  ).map((rec) => ({
    id: rec.id,
    nodeType: rec.type,
    metadata: {
      label: rec.label,
      ...(rec.description !== null && { description: rec.description }),
    },
  }));

  // Optional markdown formatting
  let formattedResult: string | undefined;
  if (includeFormattedResult && uniqueRecords.length) {
    formattedResult = `# Nodes of types ${types.join(", ")} on ${date}\n\n`;
    const byType = uniqueRecords.reduce(
      (acc, n) => {
        (acc[n.nodeType] = acc[n.nodeType] || []).push(n);
        return acc;
      },
      {} as Record<string, typeof uniqueRecords>,
    );
    for (const [type, group] of Object.entries(byType)) {
      formattedResult += `## ${type}\n`;
      group.forEach((n) => {
        formattedResult += `- ${n.metadata.label} (id: ${n.id})\n`;
      });
      formattedResult += `\n`;
    }
  }

  return queryNodeTypeResponseSchema.parse({
    date,
    types,
    nodeCount: uniqueRecords.length,
    ...(formattedResult && { formattedResult }),
    nodes: uniqueRecords,
  });
});
