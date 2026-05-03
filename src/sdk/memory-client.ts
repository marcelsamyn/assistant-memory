import { ContextBundle, contextBundleSchema } from "../lib/context/types.js";
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
  CleanupPlaceholdersRequest,
  CleanupPlaceholdersResponse,
  cleanupPlaceholdersResponseSchema,
} from "../lib/schemas/cleanup-placeholders.js";
import {
  CleanupRequest,
  CleanupResponse,
  cleanupResponseSchema,
  DedupSweepRequest,
  DedupSweepResponse,
  dedupSweepResponseSchema,
} from "../lib/schemas/cleanup.js";
import {
  ContextSearchRequest,
  ContextSearchResponse,
  contextSearchResponseSchema,
} from "../lib/schemas/context-search.js";
import {
  BootstrapMemoryRequest,
  bootstrapMemoryRequestSchema,
} from "../lib/schemas/context.js";
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
  IngestTranscriptRequest,
  IngestTranscriptResponse,
  ingestTranscriptResponseSchema,
} from "../lib/schemas/ingest-transcript.js";
import {
  GetMetricSeriesRequest,
  GetMetricSeriesResponse,
  GetMetricSummaryRequest,
  GetMetricSummaryResponse,
  ListMetricsRequest,
  ListMetricsResponse,
  getMetricSeriesResponseSchema,
  getMetricSummaryResponseSchema,
  listMetricsResponseSchema,
} from "../lib/schemas/metric-read.js";
import {
  BulkRecordMetricsRequest,
  BulkRecordMetricsResponse,
  RecordMetricRequest,
  RecordMetricResponse,
  bulkRecordMetricsResponseSchema,
  recordMetricResponseSchema,
} from "../lib/schemas/metric-write.js";
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
  OpenCommitmentsRequest,
  OpenCommitmentsResponse,
  openCommitmentsResponseSchema,
} from "../lib/schemas/open-commitments.js";
import {
  PruneOrphanNodesRequest,
  PruneOrphanNodesResponse,
  pruneOrphanNodesResponseSchema,
} from "../lib/schemas/prune-orphan-nodes.js";
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
  SetCommitmentDueRequest,
  SetCommitmentDueResponse,
  setCommitmentDueResponseSchema,
} from "../lib/schemas/set-commitment-due.js";
import {
  SummarizeRequest,
  SummarizeResponse,
  summarizeResponseSchema,
} from "../lib/schemas/summarize.js";
import {
  SetUserSelfAliasesRequest,
  SetUserSelfAliasesResponse,
  setUserSelfAliasesResponseSchema,
} from "../lib/schemas/user-self-aliases.js";
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

  /**
   * Ingest a multi-party transcript with speaker provenance. Pass either
   * raw text (segmented server-side) or a pre-segmented utterance array.
   * `userSelfAliasesOverride` substitutes for the stored user-self aliases
   * for this single ingestion only.
   */
  async ingestTranscript(
    payload: IngestTranscriptRequest,
  ): Promise<IngestTranscriptResponse> {
    return this._fetch(
      "POST",
      "/transcript/ingest",
      ingestTranscriptResponseSchema,
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

  /**
   * Startup memory bundle: pinned facts, atlas summary, open commitments,
   * recent supersessions, preferences. Mirrors the MCP `bootstrap_memory`
   * tool. Cached 6h per user; pass `forceRefresh: true` to bypass. Empty
   * sections are omitted from the response.
   */
  async bootstrapMemory(
    payload: BootstrapMemoryRequest,
  ): Promise<ContextBundle> {
    // Validate request shape locally so SDK callers get a clear error before
    // a network round-trip when forceRefresh is misshapen.
    bootstrapMemoryRequestSchema.parse(payload);
    return this._fetch(
      "POST",
      "/context/bootstrap",
      contextBundleSchema,
      payload,
    );
  }

  /**
   * Card-shaped search. Set `scope: "reference"` to surface curated reference
   * material (the default `personal` is the right choice for most callers).
   * Reference results never blend with personal results in a single response.
   */
  async contextSearch(
    payload: ContextSearchRequest,
  ): Promise<ContextSearchResponse> {
    return this._fetch(
      "POST",
      "/context/search",
      contextSearchResponseSchema,
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

  async recordMetric(
    payload: RecordMetricRequest,
  ): Promise<RecordMetricResponse> {
    return this._fetch(
      "POST",
      "/metrics/observations",
      recordMetricResponseSchema,
      payload,
    );
  }

  async recordMetricsBulk(
    payload: BulkRecordMetricsRequest,
  ): Promise<BulkRecordMetricsResponse> {
    return this._fetch(
      "POST",
      "/metrics/observations/bulk",
      bulkRecordMetricsResponseSchema,
      payload,
    );
  }

  async listMetrics(payload: ListMetricsRequest): Promise<ListMetricsResponse> {
    return this._fetch(
      "POST",
      "/metrics/list",
      listMetricsResponseSchema,
      payload,
    );
  }

  async getMetricSeries(
    payload: GetMetricSeriesRequest,
  ): Promise<GetMetricSeriesResponse> {
    return this._fetch(
      "POST",
      "/metrics/series",
      getMetricSeriesResponseSchema,
      payload,
    );
  }

  async getMetricSummary(
    payload: GetMetricSummaryRequest,
  ): Promise<GetMetricSummaryResponse> {
    return this._fetch(
      "POST",
      "/metrics/summary",
      getMetricSummaryResponseSchema,
      payload,
    );
  }

  async summarize(payload: SummarizeRequest): Promise<SummarizeResponse> {
    return this._fetch("POST", "/summarize", summarizeResponseSchema, payload);
  }

  async cleanup(payload: CleanupRequest): Promise<CleanupResponse> {
    return this._fetch("POST", "/cleanup", cleanupResponseSchema, payload);
  }

  /**
   * Run the deterministic exact-label dedup sweep without the LLM cleanup
   * pass. `cleanup()` already invokes this before iterative cleanup; call
   * this directly only for cheap/admin-only graph hygiene.
   */
  async dedupSweep(payload: DedupSweepRequest): Promise<DedupSweepResponse> {
    return this._fetch(
      "POST",
      "/cleanup/dedup-sweep",
      dedupSweepResponseSchema,
      payload,
    );
  }

  /**
   * Surface aged placeholder `Person` nodes (created when a transcript
   * speaker could not be resolved) for cleanup-pipeline review. Surfacing
   * is read-only by default; pass `triggerCleanup: true` to also enqueue
   * an iterative cleanup job seeded with the surfaced ids.
   */
  async cleanupPlaceholders(
    payload: CleanupPlaceholdersRequest,
  ): Promise<CleanupPlaceholdersResponse> {
    return this._fetch(
      "POST",
      "/maintenance/cleanup-placeholders",
      cleanupPlaceholdersResponseSchema,
      payload,
    );
  }

  /**
   * Deterministically prune legacy/entity nodes that have no evidence: no
   * claims, no source links, and no aliases. Dry-run defaults to true at the
   * API boundary; pass `dryRun: false` for scheduled pruning.
   */
  async pruneOrphanNodes(
    payload: PruneOrphanNodesRequest,
  ): Promise<PruneOrphanNodesResponse> {
    return this._fetch(
      "POST",
      "/maintenance/prune-orphan-nodes",
      pruneOrphanNodesResponseSchema,
      payload,
    );
  }

  async dream(payload: DreamRequest): Promise<DreamResponse> {
    return this._fetch("POST", "/dream", dreamResponseSchema, payload);
  }

  /**
   * Lifecycle-aware open commitments view. Returns only Task nodes whose
   * latest trusted personal `HAS_TASK_STATUS` is `pending` or `in_progress`.
   * Use this instead of semantic search when answering about outstanding,
   * next, pending, follow-up, completed, or abandoned work.
   */
  async getOpenCommitments(
    payload: OpenCommitmentsRequest,
  ): Promise<OpenCommitmentsResponse> {
    return this._fetch(
      "POST",
      "/commitments/open",
      openCommitmentsResponseSchema,
      payload,
    );
  }

  /**
   * Set or clear a Task's due date. Pass `dueOn: "YYYY-MM-DD"` to assert a
   * new `DUE_ON` claim (the predicate lifecycle supersedes any prior date),
   * or `dueOn: null` to retract every active `DUE_ON` claim on the task.
   * The server resolves/creates the canonical Temporal node internally.
   */
  async setCommitmentDue(
    payload: SetCommitmentDueRequest,
  ): Promise<SetCommitmentDueResponse> {
    return this._fetch(
      "POST",
      "/commitments/due",
      setCommitmentDueResponseSchema,
      payload,
    );
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

  /**
   * Replace the user's self-aliases (labels they appear under in
   * transcripts, e.g. "Marcel", "MS", "marcel@samyn.co"). Used by Phase 4
   * transcript ingestion to attribute claims to the user-self speaker.
   * Replaces the full list — there is no per-alias add/remove.
   */
  async setUserSelfAliases(
    payload: SetUserSelfAliasesRequest,
  ): Promise<SetUserSelfAliasesResponse> {
    return this._fetch(
      "POST",
      "/user/self-aliases",
      setUserSelfAliasesResponseSchema,
      payload,
    );
  }
}
