import { listMetrics } from "~/lib/metrics/list";
import {
  listMetricsRequestSchema,
  listMetricsResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = listMetricsRequestSchema.parse(await readBody(event));
  const metrics = await listMetrics(params);
  return listMetricsResponseSchema.parse({ metrics });
});
