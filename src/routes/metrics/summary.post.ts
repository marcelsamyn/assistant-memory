import { getMetricSummary } from "~/lib/metrics/summary";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  getMetricSummaryRequestSchema,
  getMetricSummaryResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    getMetricSummaryRequestSchema,
    await readBody(event),
  );
  return getMetricSummaryResponseSchema.parse(
    await getMetricSummary({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
