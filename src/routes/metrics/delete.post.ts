import {
  MetricDefinitionNotFoundError,
  MetricDefinitionPartitionUnsupportedError,
  deleteMetricDefinition,
} from "~/lib/metrics/definitions";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  deleteMetricDefinitionRequestSchema,
  deleteMetricDefinitionResponseSchema,
} from "~/lib/schemas/metric-write";

export default defineEventHandler(async (event) => {
  const { userId, metricDefinitionId } =
    deleteMetricDefinitionRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  try {
    const { deletedObservationCount } = await deleteMetricDefinition(
      userId,
      metricDefinitionId,
      accessScope,
    );
    return deleteMetricDefinitionResponseSchema.parse({
      deleted: true,
      deletedObservationCount,
    });
  } catch (error) {
    if (error instanceof MetricDefinitionNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message });
    }
    if (error instanceof MetricDefinitionPartitionUnsupportedError) {
      throw createError({ statusCode: 409, statusMessage: error.message });
    }
    throw error;
  }
});
