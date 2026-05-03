import { eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { metricObservations } from "~/db/schema";
import {
  getMetricDefinitionBySlug,
  resolveMetricDefinition,
  type MetricDefinitionResolution,
} from "~/lib/metrics/definitions";
import { ensureMetricEventNode } from "~/lib/metrics/event-nodes";
import {
  upsertMetricManualSource,
  upsertMetricPushSource,
} from "~/lib/metrics/sources";
import type {
  MetricDefinition,
  ProposedMetricDefinition,
} from "~/lib/schemas/metric-definition";
import type { MetricObservationErrorCode } from "~/lib/schemas/metric-observation";
import { newTypeId, type TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export type MetricDefinitionInput = {
  slug: string;
  label: string;
  description: string;
  unit: string;
  aggregationHint: "avg" | "sum" | "min" | "max";
  validRange?:
    | { min?: number | undefined; max?: number | undefined }
    | undefined;
};

export interface MetricObservationInput {
  metric?: MetricDefinitionInput | ProposedMetricDefinition | undefined;
  metricSlug?: string | undefined;
  value: number;
  occurredAt: Date;
  note?: string | null | undefined;
  eventNodeId?: TypeId<"node"> | null | undefined;
}

export interface MetricEventInput {
  eventKey: string;
  label: string;
  occurredAt: Date;
  observations: ReadonlyArray<
    Omit<MetricObservationInput, "occurredAt" | "eventNodeId">
  >;
}

export interface MetricObservationRowResult {
  index: number;
  observationId: TypeId<"metric_observation">;
  metricDefinitionId: TypeId<"metric_definition">;
  definitionCreated: boolean;
  needsReview: boolean;
  reviewTaskNodeId: TypeId<"node"> | null;
}

export interface MetricObservationRowError {
  index: number;
  code: MetricObservationErrorCode;
  message: string;
}

export interface RecordMetricObservationsInput {
  userId: string;
  sourceId?: TypeId<"source"> | undefined;
  source?:
    | { sourceId: TypeId<"source"> }
    | {
        type: "metric_push";
        externalId: string;
        metadata?: Record<string, unknown> | undefined;
      }
    | {
        type: "metric_manual";
        externalId?: string | undefined;
        metadata?: Record<string, unknown> | undefined;
      }
    | undefined;
  createDefinitions?: boolean | undefined;
  events?: ReadonlyArray<MetricEventInput> | undefined;
  observations: ReadonlyArray<MetricObservationInput>;
  deleteExistingForSource?: boolean | undefined;
  replaceSourceObservations?: boolean | undefined;
}

export interface RecordMetricObservationsResult {
  inserted: number;
  observations: MetricObservationRowResult[];
  errors: MetricObservationRowError[];
}

export class MetricObservationOutOfRangeError extends Error {
  readonly metricDefinitionId: TypeId<"metric_definition">;
  readonly value: number;
  readonly min: number | null;
  readonly max: number | null;

  constructor(definition: MetricDefinition, value: number) {
    const range = [
      definition.validRangeMin === null
        ? null
        : `min ${definition.validRangeMin}`,
      definition.validRangeMax === null
        ? null
        : `max ${definition.validRangeMax}`,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
    super(
      `Metric value ${value} is outside the valid range for ${definition.slug}: ${range}`,
    );
    this.name = "MetricObservationOutOfRangeError";
    this.metricDefinitionId = definition.id;
    this.value = value;
    this.min = definition.validRangeMin;
    this.max = definition.validRangeMax;
  }
}

export function assertMetricObservationInRange(
  definition: MetricDefinition,
  value: number,
): void {
  if (
    (definition.validRangeMin !== null && value < definition.validRangeMin) ||
    (definition.validRangeMax !== null && value > definition.validRangeMax)
  ) {
    throw new MetricObservationOutOfRangeError(definition, value);
  }
}

function toProposedMetricDefinition(
  metric: MetricDefinitionInput | ProposedMetricDefinition,
): ProposedMetricDefinition {
  if ("validRange" in metric) {
    return {
      slug: metric.slug,
      label: metric.label,
      description: metric.description,
      unit: metric.unit,
      aggregationHint: metric.aggregationHint,
      validRangeMin: metric.validRange?.min,
      validRangeMax: metric.validRange?.max,
    };
  }
  return metric;
}

function missingMetricError(index: number): MetricObservationRowError {
  return {
    index,
    code: "INVALID_INPUT",
    message: "Observation must include either metric or metricSlug",
  };
}

async function resolveObservationDefinition(
  db: DrizzleDB,
  userId: string,
  createDefinitions: boolean,
  observation: MetricObservationInput,
): Promise<MetricDefinitionResolution | MetricObservationRowError> {
  if (observation.metric !== undefined) {
    if (!createDefinitions) {
      return {
        index: -1,
        code: "INVALID_INPUT",
        message: "Metric definitions cannot be created for this source",
      };
    }
    return resolveMetricDefinition(
      db,
      userId,
      toProposedMetricDefinition(observation.metric),
    );
  }

  if (observation.metricSlug === undefined) {
    return missingMetricError(-1);
  }

  const definition = await getMetricDefinitionBySlug(
    db,
    userId,
    observation.metricSlug,
  );
  if (!definition) {
    return {
      index: -1,
      code: "DEFINITION_NOT_FOUND",
      message: `Metric definition not found for slug '${observation.metricSlug}'`,
    };
  }

  return {
    definition,
    created: false,
    reusedBy: "slug",
    similarity: null,
  };
}

function withIndex(
  error: MetricObservationRowError,
  index: number,
): MetricObservationRowError {
  return { ...error, index };
}

function errorFromUnknown(
  index: number,
  code: MetricObservationErrorCode,
  error: unknown,
): MetricObservationRowError {
  return {
    index,
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function resolveMetricSourceId(
  db: DrizzleDB,
  input: RecordMetricObservationsInput,
): Promise<TypeId<"source">> {
  if (input.sourceId !== undefined) return input.sourceId;
  if (input.source !== undefined && "sourceId" in input.source) {
    return input.source.sourceId;
  }

  if (input.source?.type === "metric_push") {
    return upsertMetricPushSource(db, {
      userId: input.userId,
      externalId: input.source.externalId,
      metadata: input.source.metadata,
    });
  }

  if (input.source?.type === "metric_manual") {
    return upsertMetricManualSource(db, {
      userId: input.userId,
      externalId:
        input.source.externalId ?? `metric_manual:${newTypeId("source")}`,
      metadata: input.source.metadata,
    });
  }

  throw new Error("Metric source or sourceId is required");
}

/** Record metric observations with per-row errors and optional source replay cleanup. */
export async function recordMetricObservations(
  input: RecordMetricObservationsInput,
  dbOverride?: DrizzleDB,
): Promise<RecordMetricObservationsResult> {
  const db = dbOverride ?? (await useDatabase());
  const sourceId = await resolveMetricSourceId(db, input);
  const observations: MetricObservationRowResult[] = [];
  const errors: MetricObservationRowError[] = [];

  if (
    input.deleteExistingForSource ??
    input.replaceSourceObservations ??
    true
  ) {
    await db
      .delete(metricObservations)
      .where(eq(metricObservations.sourceId, sourceId));
  }

  const observationsToInsert: Array<{
    index: number;
    observation: MetricObservationInput;
  }> = [];
  let nextObservationIndex = 0;
  for (const event of input.events ?? []) {
    try {
      const eventNodeId = await ensureMetricEventNode(db, {
        userId: input.userId,
        sourceId,
        metricEventKey: `${sourceId}:${event.eventKey}`,
        label: event.label,
        occurredAt: event.occurredAt,
      });
      observationsToInsert.push(
        ...event.observations.map((observation) => ({
          index: nextObservationIndex++,
          observation: {
            ...observation,
            occurredAt: event.occurredAt,
            eventNodeId,
          },
        })),
      );
    } catch (error: unknown) {
      errors.push(
        ...event.observations.map((_, offset) =>
          errorFromUnknown(
            nextObservationIndex + offset,
            "INVALID_INPUT",
            error,
          ),
        ),
      );
      nextObservationIndex += event.observations.length;
    }
  }
  observationsToInsert.push(
    ...input.observations.map((observation) => ({
      index: nextObservationIndex++,
      observation,
    })),
  );

  for (const entry of observationsToInsert) {
    const { index, observation } = entry;

    let resolution: MetricDefinitionResolution;
    try {
      const resolved = await resolveObservationDefinition(
        db,
        input.userId,
        input.createDefinitions ?? true,
        observation,
      );
      if ("code" in resolved) {
        errors.push(withIndex(resolved, index));
        continue;
      }
      resolution = resolved;
    } catch (error: unknown) {
      errors.push(errorFromUnknown(index, "RESOLVE_FAILED", error));
      continue;
    }

    try {
      assertMetricObservationInRange(resolution.definition, observation.value);
    } catch (error: unknown) {
      errors.push(errorFromUnknown(index, "RANGE_VIOLATION", error));
      continue;
    }

    try {
      const [inserted] = await db
        .insert(metricObservations)
        .values({
          userId: input.userId,
          metricDefinitionId: resolution.definition.id,
          value: observation.value.toString(),
          occurredAt: observation.occurredAt,
          note: observation.note ?? undefined,
          eventNodeId: observation.eventNodeId ?? undefined,
          sourceId,
        })
        .returning({
          id: metricObservations.id,
          metricDefinitionId: metricObservations.metricDefinitionId,
        });

      if (!inserted) throw new Error("Failed to insert metric observation");

      observations.push({
        index,
        observationId: inserted.id,
        metricDefinitionId: inserted.metricDefinitionId,
        definitionCreated: resolution.created,
        needsReview: resolution.definition.needsReview,
        reviewTaskNodeId: resolution.definition.reviewTaskNodeId,
      });
    } catch (error: unknown) {
      errors.push(errorFromUnknown(index, "INVALID_INPUT", error));
    }
  }

  return {
    inserted: observations.length,
    observations,
    errors,
  };
}
