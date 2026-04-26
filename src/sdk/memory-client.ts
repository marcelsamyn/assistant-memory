import {
  CreateAliasRequest,
  CreateAliasResponse,
  createAliasResponseSchema,
  DeleteAliasRequest,
  DeleteAliasResponse,
  deleteAliasResponseSchema,
} from "../lib/schemas/alias.js";
import {
  CreateClaimRequest,
  CreateClaimResponse,
  createClaimResponseSchema,
  DeleteClaimRequest,
  DeleteClaimResponse,
  deleteClaimResponseSchema,
  UpdateClaimRequest,
  UpdateClaimResponse,
  updateClaimResponseSchema,
} from "../lib/schemas/claim.js";
import {
  CleanupRequest,
  CleanupResponse,
  cleanupResponseSchema,
} from "../lib/schemas/cleanup.js";
import {
  DreamRequest,
  DreamResponse,
  dreamResponseSchema,
} from "../lib/schemas/dream.js";
import {
  IngestConversationRequest,
  IngestConversationResponse,
  ingestConversationResponseSchema,
} from "../lib/schemas/ingest-conversation.js";
import {
  IngestDocumentRequest,
  IngestDocumentResponse,
  ingestDocumentResponseSchema,
} from "../lib/schemas/ingest-document-request.js";
import {
  BatchDeleteNodesRequest,
  BatchDeleteNodesResponse,
  batchDeleteNodesResponseSchema,
} from "../lib/schemas/node-batch-delete.js";
import {
  MergeNodesRequest,
  MergeNodesResponse,
  mergeNodesResponseSchema,
} from "../lib/schemas/node-merge.js";
import {
  NodeNeighborhoodRequest,
  NodeNeighborhoodResponse,
  nodeNeighborhoodResponseSchema,
} from "../lib/schemas/node-neighborhood.js";
import {
  GetNodeRequest,
  GetNodeResponse,
  getNodeResponseSchema,
  GetNodeSourcesRequest,
  GetNodeSourcesResponse,
  getNodeSourcesResponseSchema,
  UpdateNodeRequest,
  UpdateNodeResponse,
  updateNodeResponseSchema,
  DeleteNodeRequest,
  DeleteNodeResponse,
  deleteNodeResponseSchema,
  CreateNodeRequest,
  CreateNodeResponse,
  createNodeResponseSchema,
} from "../lib/schemas/node.js";
import {
  QueryAtlasNodesRequest,
  QueryAtlasNodesResponse,
  queryAtlasNodesResponseSchema,
} from "../lib/schemas/query-atlas-nodes.js";
import {
  QueryAtlasRequest,
  QueryAtlasResponse,
  queryAtlasResponseSchema,
} from "../lib/schemas/query-atlas.js";
import {
  QueryDayRequest,
  QueryDayResponse,
  queryDayResponseSchema,
} from "../lib/schemas/query-day.js";
import {
  QueryGraphRequest,
  QueryGraphResponse,
  queryGraphResponseSchema,
} from "../lib/schemas/query-graph.js";
import {
  QueryNodeTypeRequest,
  QueryNodeTypeResponse,
  queryNodeTypeResponseSchema,
} from "../lib/schemas/query-node-type.js";
import {
  QuerySearchRequest,
  QuerySearchResponse,
  querySearchResponseSchema,
} from "../lib/schemas/query-search.js";
import {
  QueryTimelineRequest,
  QueryTimelineResponse,
  queryTimelineResponseSchema,
} from "../lib/schemas/query-timeline.js";
import {
  ScratchpadReadRequest,
  ScratchpadWriteRequest,
  ScratchpadEditRequest,
  ScratchpadResponse,
  ScratchpadEditResponse,
  scratchpadResponseSchema,
  scratchpadEditResponseSchema,
} from "../lib/schemas/scratchpad.js";
import {
  SummarizeRequest,
  SummarizeResponse,
  summarizeResponseSchema,
} from "../lib/schemas/summarize.js";
import { z } from "zod";

export interface MemoryClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export class MemoryClient {
  private options: MemoryClientOptions;

  constructor(options: MemoryClientOptions) {
    this.options = options;
  }

  private async _fetch<
    TRequest,
    S extends z.ZodTypeAny,
    TResponse = z.infer<S>,
  >(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    responseSchema: S,
    body?: TRequest,
  ): Promise<TResponse> {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (this.options.apiKey) {
      headers["Authorization"] = `Bearer ${this.options.apiKey}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(
      `${this.options.baseUrl}${path}`,
      fetchOptions,
    );

    if (!response.ok) {
      // Attempt to parse error response for more details
      const errorBody = await response.json();
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}${errorBody ? ` - ${JSON.stringify(errorBody)}` : ""}`,
      );
    }

    const responseData = await response.json();
    return responseSchema.parse(responseData);
  }

  async ingestDocument(
    payload: IngestDocumentRequest,
  ): Promise<IngestDocumentResponse> {
    return this._fetch(
      "POST",
      "/ingest/document",
      ingestDocumentResponseSchema,
      payload,
    );
  }

  async ingestConversation(
    payload: IngestConversationRequest,
  ): Promise<IngestConversationResponse> {
    return this._fetch(
      "POST",
      "/ingest/conversation",
      ingestConversationResponseSchema,
      payload,
    );
  }

  async querySearch(payload: QuerySearchRequest): Promise<QuerySearchResponse> {
    return this._fetch(
      "POST",
      "/query/search",
      querySearchResponseSchema,
      payload,
    );
  }

  async queryAtlas(payload: QueryAtlasRequest): Promise<QueryAtlasResponse> {
    return this._fetch(
      "POST",
      "/query/atlas",
      queryAtlasResponseSchema,
      payload,
    );
  }

  async queryDay(payload: QueryDayRequest): Promise<QueryDayResponse> {
    return this._fetch("POST", "/query/day", queryDayResponseSchema, payload);
  }

  async queryNodeType(
    payload: QueryNodeTypeRequest,
  ): Promise<QueryNodeTypeResponse> {
    return this._fetch(
      "POST",
      "/query/node-type",
      queryNodeTypeResponseSchema,
      payload,
    );
  }

  async queryGraph(payload: QueryGraphRequest): Promise<QueryGraphResponse> {
    return this._fetch(
      "POST",
      "/query/graph",
      queryGraphResponseSchema,
      payload,
    );
  }

  async queryTimeline(
    payload: QueryTimelineRequest,
  ): Promise<QueryTimelineResponse> {
    return this._fetch(
      "POST",
      "/query/timeline",
      queryTimelineResponseSchema,
      payload,
    );
  }

  async summarize(payload: SummarizeRequest): Promise<SummarizeResponse> {
    return this._fetch("POST", "/summarize", summarizeResponseSchema, payload);
  }

  async cleanup(payload: CleanupRequest): Promise<CleanupResponse> {
    return this._fetch("POST", "/cleanup", cleanupResponseSchema, payload);
  }

  async dream(payload: DreamRequest): Promise<DreamResponse> {
    return this._fetch("POST", "/dream", dreamResponseSchema, payload);
  }

  async readScratchpad(
    payload: ScratchpadReadRequest,
  ): Promise<ScratchpadResponse> {
    return this._fetch(
      "POST",
      "/scratchpad/read",
      scratchpadResponseSchema,
      payload,
    );
  }

  async writeScratchpad(
    payload: ScratchpadWriteRequest,
  ): Promise<ScratchpadResponse> {
    return this._fetch(
      "POST",
      "/scratchpad/write",
      scratchpadResponseSchema,
      payload,
    );
  }

  async editScratchpad(
    payload: ScratchpadEditRequest,
  ): Promise<ScratchpadEditResponse> {
    return this._fetch(
      "POST",
      "/scratchpad/edit",
      scratchpadEditResponseSchema,
      payload,
    );
  }

  async getNode(payload: GetNodeRequest): Promise<GetNodeResponse> {
    return this._fetch("POST", "/node/get", getNodeResponseSchema, payload);
  }

  async getNodeSources(
    payload: GetNodeSourcesRequest,
  ): Promise<GetNodeSourcesResponse> {
    return this._fetch(
      "POST",
      "/node/sources",
      getNodeSourcesResponseSchema,
      payload,
    );
  }

  async updateNode(payload: UpdateNodeRequest): Promise<UpdateNodeResponse> {
    return this._fetch(
      "POST",
      "/node/update",
      updateNodeResponseSchema,
      payload,
    );
  }

  async deleteNode(payload: DeleteNodeRequest): Promise<DeleteNodeResponse> {
    return this._fetch(
      "POST",
      "/node/delete",
      deleteNodeResponseSchema,
      payload,
    );
  }

  async createNode(payload: CreateNodeRequest): Promise<CreateNodeResponse> {
    return this._fetch(
      "POST",
      "/node/create",
      createNodeResponseSchema,
      payload,
    );
  }

  async createClaim(payload: CreateClaimRequest): Promise<CreateClaimResponse> {
    return this._fetch(
      "POST",
      "/claim/create",
      createClaimResponseSchema,
      payload,
    );
  }

  async deleteClaim(payload: DeleteClaimRequest): Promise<DeleteClaimResponse> {
    return this._fetch(
      "POST",
      "/claim/delete",
      deleteClaimResponseSchema,
      payload,
    );
  }

  async updateClaim(payload: UpdateClaimRequest): Promise<UpdateClaimResponse> {
    return this._fetch(
      "POST",
      "/claim/update",
      updateClaimResponseSchema,
      payload,
    );
  }

  async createAlias(payload: CreateAliasRequest): Promise<CreateAliasResponse> {
    return this._fetch(
      "POST",
      "/alias/create",
      createAliasResponseSchema,
      payload,
    );
  }

  async deleteAlias(payload: DeleteAliasRequest): Promise<DeleteAliasResponse> {
    return this._fetch(
      "POST",
      "/alias/delete",
      deleteAliasResponseSchema,
      payload,
    );
  }

  async mergeNodes(payload: MergeNodesRequest): Promise<MergeNodesResponse> {
    return this._fetch(
      "POST",
      "/node/merge",
      mergeNodesResponseSchema,
      payload,
    );
  }

  async batchDeleteNodes(
    payload: BatchDeleteNodesRequest,
  ): Promise<BatchDeleteNodesResponse> {
    return this._fetch(
      "POST",
      "/node/batch-delete",
      batchDeleteNodesResponseSchema,
      payload,
    );
  }

  async getAtlasNodeIds(
    payload: QueryAtlasNodesRequest,
  ): Promise<QueryAtlasNodesResponse> {
    return this._fetch(
      "POST",
      "/query/atlas-nodes",
      queryAtlasNodesResponseSchema,
      payload,
    );
  }

  async getNodeNeighborhood(
    payload: NodeNeighborhoodRequest,
  ): Promise<NodeNeighborhoodResponse> {
    return this._fetch(
      "POST",
      "/node/neighborhood",
      nodeNeighborhoodResponseSchema,
      payload,
    );
  }
}
