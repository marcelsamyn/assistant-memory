import { getMetricSummaries } from "~/lib/metrics/summary";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  getMetricSummariesRequestSchema,
  getMetricSummariesResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = getMetricSummariesRequestSchema.parse(await readBody(event));
  return getMetricSummariesResponseSchema.parse(
    await getMetricSummaries({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
