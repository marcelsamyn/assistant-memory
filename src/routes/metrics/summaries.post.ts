import { getMetricSummaries } from "~/lib/metrics/summary";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  getMetricSummariesRequestSchema,
  getMetricSummariesResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    getMetricSummariesRequestSchema,
    await readBody(event),
  );
  return getMetricSummariesResponseSchema.parse(
    await getMetricSummaries({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
