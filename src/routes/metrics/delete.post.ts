import {
  MetricDefinitionNotFoundError,
  deleteMetricDefinition,
} from "~/lib/metrics/definitions";
import {
  deleteMetricDefinitionRequestSchema,
  deleteMetricDefinitionResponseSchema,
} from "~/lib/schemas/metric-write";

export default defineEventHandler(async (event) => {
  const { userId, metricDefinitionId } =
    deleteMetricDefinitionRequestSchema.parse(await readBody(event));
  try {
    const { deletedObservationCount } = await deleteMetricDefinition(
      userId,
      metricDefinitionId,
    );
    return deleteMetricDefinitionResponseSchema.parse({
      deleted: true,
      deletedObservationCount,
    });
  } catch (error) {
    if (error instanceof MetricDefinitionNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message });
    }
    throw error;
  }
});
