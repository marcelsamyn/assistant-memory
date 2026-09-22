import { listMetrics } from "~/lib/metrics/list";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  listMetricsRequestSchema,
  listMetricsResponseSchema,
} from "~/lib/schemas/metric-read";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    listMetricsRequestSchema,
    await readBody(event),
  );
  const metrics = await listMetrics({
    ...params,
    accessScope: getRequestAccessScope(event),
  });
  return listMetricsResponseSchema.parse({ metrics });
});
