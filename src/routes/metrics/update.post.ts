import {
  MetricDefinitionNotFoundError,
  MetricDefinitionSlugConflictError,
  MetricDefinitionValidationError,
  updateMetricDefinition,
} from "~/lib/metrics/definitions";
import {
  updateMetricDefinitionRequestSchema,
  updateMetricDefinitionResponseSchema,
} from "~/lib/schemas/metric-write";

export default defineEventHandler(async (event) => {
  const body = updateMetricDefinitionRequestSchema.parse(await readBody(event));
  const { userId, metricDefinitionId, ...patch } = body;
  try {
    const definition = await updateMetricDefinition(
      userId,
      metricDefinitionId,
      patch,
    );
    return updateMetricDefinitionResponseSchema.parse({ definition });
  } catch (error) {
    if (error instanceof MetricDefinitionNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message });
    }
    if (error instanceof MetricDefinitionSlugConflictError) {
      throw createError({ statusCode: 409, statusMessage: error.message });
    }
    if (error instanceof MetricDefinitionValidationError) {
      throw createError({ statusCode: 400, statusMessage: error.message });
    }
    throw error;
  }
});
