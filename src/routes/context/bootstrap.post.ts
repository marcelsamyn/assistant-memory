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
import { bootstrapMemoryRequestSchema } from "~/lib/schemas/context";

export default defineEventHandler(async (event) => {
  const { userId, forceRefresh } = bootstrapMemoryRequestSchema.parse(
    await readBody(event),
  );

  const bundle = await getConversationBootstrapContext({
    userId,
    ...(forceRefresh !== undefined && { options: { forceRefresh } }),
  });

  return contextBundleSchema.parse(bundle);
});
