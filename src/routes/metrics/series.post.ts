import { getMetricSeries } from "~/lib/metrics/series";
import {
  getMetricSeriesRequestSchema,
  getMetricSeriesResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = getMetricSeriesRequestSchema.parse(await readBody(event));
  return getMetricSeriesResponseSchema.parse(await getMetricSeries(params));
});
