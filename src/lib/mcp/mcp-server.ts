import { SSEServerTransport } from "./sse";
import {
  BOOTSTRAP_MEMORY_DESCRIPTION,
  GET_ENTITY_DESCRIPTION,
  LIST_OPEN_COMMITMENTS_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  SEARCH_REFERENCE_DESCRIPTION,
} from "./tool-descriptions";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConversationBootstrapContext } from "~/lib/context/assemble-bootstrap-context";
import { getNodeCard } from "~/lib/context/node-card";
import { searchMemory, searchReference } from "~/lib/context/search-cards";
import { contextBundleSchema } from "~/lib/context/types";
import { nodeCardSchema } from "~/lib/context/node-card-types";
import { saveMemory } from "~/lib/ingestion/save-document";
import {
  getNodeById,
  getNodeSources,
  updateNode,
  deleteNode,
} from "~/lib/node";
import { queryDayMemories } from "~/lib/query/day";
import { getOpenCommitments } from "~/lib/query/open-commitments";
import {
  bootstrapMemoryRequestSchema,
  getEntityRequestSchema,
} from "~/lib/schemas/context";
import {
  cardSearchToolInputSchema,
  contextSearchResponseSchema,
} from "~/lib/schemas/context-search";
import { ingestDocumentRequestSchema } from "~/lib/schemas/ingest-document-request";
import {
  getNodeRequestSchema,
  getNodeSourcesRequestSchema,
  updateNodeRequestSchema,
  deleteNodeRequestSchema,
} from "~/lib/schemas/node";
import {
  openCommitmentsRequestSchema,
  openCommitmentsResponseSchema,
} from "~/lib/schemas/open-commitments";
import { queryDayRequestSchema } from "~/lib/schemas/query-day";
import {
  scratchpadReadRequestSchema,
  scratchpadWriteRequestSchema,
  scratchpadEditRequestSchema,
} from "~/lib/schemas/scratchpad";
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
  ingestDocumentRequestSchema.shape,
  async ({ userId, document }) => {
    await saveMemory({ userId, document, updateExisting: false });
    return {
      content: [{ type: "text", text: "Memory saved" }],
    };
  },
);

// Card-shaped startup bundle. Emits the design's `ContextBundle`.
server.tool(
  "bootstrap_memory",
  BOOTSTRAP_MEMORY_DESCRIPTION,
  bootstrapMemoryRequestSchema.shape,
  async ({ userId, forceRefresh }) => {
    const bundle = await getConversationBootstrapContext({
      userId,
      ...(forceRefresh !== undefined && { options: { forceRefresh } }),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(contextBundleSchema.parse(bundle), null, 2),
        },
      ],
    };
  },
);

// Personal-scope card search. Replaces the legacy "search memory" tool.
server.tool(
  "search_memory",
  SEARCH_MEMORY_DESCRIPTION,
  cardSearchToolInputSchema.shape,
  async (input) => {
    const result = await searchMemory(input);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            contextSearchResponseSchema.parse(result),
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Reference-scope card search. Surfaces curated ingested documents only.
server.tool(
  "search_reference",
  SEARCH_REFERENCE_DESCRIPTION,
  cardSearchToolInputSchema.shape,
  async (input) => {
    const result = await searchReference(input);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            contextSearchResponseSchema.parse(result),
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Single-entity card lookup.
server.tool(
  "get_entity",
  GET_ENTITY_DESCRIPTION,
  getEntityRequestSchema.shape,
  async ({ userId, nodeId }) => {
    const card = await getNodeCard({ userId, nodeId });
    if (!card) {
      return {
        content: [{ type: "text", text: "Entity not found" }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(nodeCardSchema.parse(card), null, 2),
        },
      ],
    };
  },
);

// Expose day query as "retrieve memories relevant for today"
server.tool(
  "retrieve memories relevant for today",
  queryDayRequestSchema.shape,
  async ({ userId, date }) => {
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

server.tool(
  "list_open_commitments",
  LIST_OPEN_COMMITMENTS_DESCRIPTION,
  openCommitmentsRequestSchema.shape,
  async (params) => {
    const commitments = await getOpenCommitments(params);
    if (commitments.length === 0) {
      return {
        content: [{ type: "text", text: "No open commitments." }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            openCommitmentsResponseSchema.parse({ commitments }),
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Read scratchpad
server.tool(
  "read scratchpad",
  scratchpadReadRequestSchema.shape,
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
  scratchpadWriteRequestSchema.shape,
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
server.tool(
  "edit scratchpad",
  scratchpadEditRequestSchema.shape,
  async (params) => {
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
  },
);

// Get node by ID with edges and source IDs
server.tool(
  "get node",
  getNodeRequestSchema.shape,
  async ({ userId, nodeId }) => {
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
  },
);

// Get raw source content for a node
server.tool(
  "get node sources",
  getNodeSourcesRequestSchema.shape,
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

// Update node label/type
server.tool(
  "update node",
  updateNodeRequestSchema.shape,
  async ({ userId, nodeId, label, nodeType }) => {
    const result = await updateNode(userId, nodeId, {
      ...(label !== undefined && { label }),
      ...(nodeType !== undefined && { nodeType }),
    });
    if (!result) {
      return {
        content: [{ type: "text", text: "Node not found" }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: `Node updated: ${JSON.stringify(result)}` },
      ],
    };
  },
);

// Delete node by ID
server.tool(
  "delete node",
  deleteNodeRequestSchema.shape,
  async ({ userId, nodeId }) => {
    const { deleted, affectedClaims } = await deleteNode(userId, nodeId);
    if (!deleted) {
      return {
        content: [{ type: "text", text: "Node not found" }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Node deleted successfully. ` +
            `Cascaded ${affectedClaims.cascadeDeleted} claim(s); ` +
            `cleared participant attribution on ${affectedClaims.assertedByCleared} claim(s).`,
        },
      ],
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
