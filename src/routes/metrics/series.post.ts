import { getMetricSeries } from "~/lib/metrics/series";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  getMetricSeriesRequestSchema,
  getMetricSeriesResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    getMetricSeriesRequestSchema,
    await readBody(event),
  );
  return getMetricSeriesResponseSchema.parse(
    await getMetricSeries({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
