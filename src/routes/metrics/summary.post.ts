import { getMetricSummary } from "~/lib/metrics/summary";
import {
  getMetricSummaryRequestSchema,
  getMetricSummaryResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = getMetricSummaryRequestSchema.parse(await readBody(event));
  return getMetricSummaryResponseSchema.parse(await getMetricSummary(params));
});
