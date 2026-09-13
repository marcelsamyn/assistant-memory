import { listMetrics } from "~/lib/metrics/list";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  listMetricsRequestSchema,
  listMetricsResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = listMetricsRequestSchema.parse(await readBody(event));
  const metrics = await listMetrics({
    ...params,
    accessScope: getRequestAccessScope(event),
  });
  return listMetricsResponseSchema.parse({ metrics });
});
