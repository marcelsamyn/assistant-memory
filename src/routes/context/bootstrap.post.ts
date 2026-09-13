/**
 * `POST /context/bootstrap` — startup memory bundle.
 *
 * Returns the same `ContextBundle` shape as MCP `bootstrap_memory`: pinned,
 * atlas, open_commitments, recent_supersessions, preferences. Cached 6h per
 * user; pass `forceRefresh: true` to bypass.
 *
 * Common aliases: bootstrap_memory route, getConversationBootstrapContext route.
 */
import { getConversationBootstrapContext } from "~/lib/context/assemble-bootstrap-context";
import { contextBundleSchema } from "~/lib/context/types";
import { getRequestAccessScope } from "~/lib/request-access";
import { bootstrapMemoryRequestSchema } from "~/lib/schemas/context";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, forceRefresh } =
    bootstrapMemoryRequestSchema.parse(await readBody(event));

  const bundle = await getConversationBootstrapContext({
    userId,
    accessScope,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    ...(forceRefresh !== undefined && { options: { forceRefresh } }),
  });

  return contextBundleSchema.parse(bundle);
});
