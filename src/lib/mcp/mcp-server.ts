import { SSEServerTransport } from "./sse";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { saveMemory } from "~/lib/ingestion/save-document";
import { queryDayMemories } from "~/lib/query/day";
import { searchMemory } from "~/lib/query/search";
import {
  ingestDocumentRequestSchema,
  type IngestDocumentRequest,
} from "~/lib/schemas/ingest-document-request";
import {
  queryDayRequestSchema,
  type QueryDayRequest,
} from "~/lib/schemas/query-day";
import {
  querySearchRequestSchema,
  type QuerySearchRequest,
} from "~/lib/schemas/query-search";
import {
  getNodeRequestSchema,
  getNodeSourcesRequestSchema,
  updateNodeRequestSchema,
  deleteNodeRequestSchema,
} from "~/lib/schemas/node";
import {
  scratchpadReadRequestSchema,
  scratchpadWriteRequestSchema,
  scratchpadEditRequestSchema,
} from "~/lib/schemas/scratchpad";
import {
  getNodeById,
  getNodeSources,
  updateNode,
  deleteNode,
} from "~/lib/node";
import {
  readScratchpad,
  writeScratchpad,
  editScratchpad,
} from "~/lib/scratchpad";

const transports: { [sessionId: string]: SSEServerTransport } = {};

// Create an MCP server
export const server = new McpServer({
  name: "Demo",
  version: "1.0.0",
});

// Add an addition tool
server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

// Add a dynamic greeting resource
server.resource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello, ${name}!`,
      },
    ],
  }),
);

// Expose ingest document functionality as "save memory"
server.tool(
  "save memory",
  ingestDocumentRequestSchema,
  async ({ userId, document }: IngestDocumentRequest) => {
    await saveMemory({ userId, document });
    return {
      content: [{ type: "text", text: "Memory saved" }],
    };
  },
);

// Expose search as "search memory"
server.tool(
  "search memory",
  querySearchRequestSchema,
  async ({ userId, query, limit, excludeNodeTypes }: QuerySearchRequest) => {
    const { formattedResult } = await searchMemory({
      userId,
      query,
      limit,
      excludeNodeTypes,
    });

    return {
      content: [{ type: "text", text: formattedResult }],
    };
  },
);

// Expose day query as "retrieve memories relevant for today"
server.tool(
  "retrieve memories relevant for today",
  queryDayRequestSchema,
  async ({ userId, date }: QueryDayRequest) => {
    const { formattedResult } = await queryDayMemories({
      userId,
      date,
      includeFormattedResult: true,
    });
    return {
      content: [{ type: "text", text: formattedResult ?? "" }],
    };
  },
);

// Read scratchpad
server.tool(
  "read scratchpad",
  scratchpadReadRequestSchema,
  async ({ userId }) => {
    const result = await readScratchpad({ userId });
    return {
      content: [{ type: "text", text: result.content || "(empty scratchpad)" }],
    };
  },
);

// Write scratchpad (overwrite or append)
server.tool(
  "write scratchpad",
  scratchpadWriteRequestSchema,
  async (params) => {
    const result = await writeScratchpad(params);
    return {
      content: [
        { type: "text", text: `Scratchpad updated.\n\n${result.content}` },
      ],
    };
  },
);

// Edit scratchpad (replace text with safeguards)
server.tool("edit scratchpad", scratchpadEditRequestSchema, async (params) => {
  const result = await editScratchpad(params);
  if (!result.applied) {
    return {
      content: [{ type: "text", text: `Edit failed: ${result.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `Edit applied.\n\n${result.content}` }],
  };
});

// Get node by ID with edges and source IDs
server.tool("get node", getNodeRequestSchema, async ({ userId, nodeId }) => {
  const result = await getNodeById(userId, nodeId);
  if (!result) {
    return {
      content: [{ type: "text", text: "Node not found" }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// Get raw source content for a node
server.tool(
  "get node sources",
  getNodeSourcesRequestSchema,
  async ({ userId, nodeId }) => {
    const result = await getNodeSources(userId, nodeId);
    if (result.sources.length === 0) {
      return {
        content: [
          { type: "text", text: "No source content linked to this node" },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// Update node label/description
server.tool(
  "update node",
  updateNodeRequestSchema,
  async ({ userId, nodeId, label, description }) => {
    const result = await updateNode(userId, nodeId, { label, description });
    if (!result) {
      return {
        content: [{ type: "text", text: "Node not found" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Node updated: ${JSON.stringify(result)}` }],
    };
  },
);

// Delete node by ID
server.tool(
  "delete node",
  deleteNodeRequestSchema,
  async ({ userId, nodeId }) => {
    const deleted = await deleteNode(userId, nodeId);
    if (!deleted) {
      return {
        content: [{ type: "text", text: "Node not found" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "Node deleted successfully" }],
    };
  },
);

export const addTransport = (transport: SSEServerTransport) => {
  transports[transport.sessionId] = transport;
};

export const removeTransport = (transport: SSEServerTransport) => {
  delete transports[transport.sessionId];
};

export const getTransport = (sessionId: string) => {
  return transports[sessionId];
};

export default server;
