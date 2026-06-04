import { typeid } from "typeid-js";
import { z } from "zod";

const TYPE_ID_LENGTH = 26;

export const ID_TYPE_NAMES = [
  "node",
  "claim",
  "node_metadata",
  "node_embedding",
  "claim_embedding",
  "source",
  "alias",
  "source_link",
  "user_profile",
  "message",
  "scratchpad",
  "metric_definition",
  "metric_observation",
  "metric_definition_embedding",
] as const;

export const ID_TYPE_PREFIXES = {
  node: "node",
  claim: "claim",
  node_metadata: "nmeta",
  node_embedding: "nemb",
  claim_embedding: "cemb",
  source: "src",
  alias: "alias",
  source_link: "sln",
  user_profile: "upf",
  message: "msg",
  scratchpad: "spad",
  metric_definition: "mdef",
  metric_observation: "mobs",
  metric_definition_embedding: "memb",
} as const satisfies Record<(typeof ID_TYPE_NAMES)[number], string>;

export type IdType = (typeof ID_TYPE_NAMES)[number];

export type IdTypePrefix<T extends IdType> = (typeof ID_TYPE_PREFIXES)[T];

export type TypeId<T extends IdType> = `${IdTypePrefix<T>}_${string}`;

// The brand is applied as a type-level assertion on the schema rather than a
// runtime `.transform()`. The transform was a no-op at runtime (an identity
// cast), but Zod 4's `z.toJSONSchema` throws on any transform — which breaks
// OpenAI structured-output schemas that embed typeid fields (e.g. cleanup
// operations). Asserting the output type keeps the runtime a plain validated
// string (representable as JSON Schema) while preserving the `TypeId<T>` brand.
export const typeIdSchema = <T extends IdType>(type: T) =>
  z
    .string()
    .startsWith(ID_TYPE_PREFIXES[type] + "_")
    .length(
      ID_TYPE_PREFIXES[type].length + 1 + TYPE_ID_LENGTH,
    ) as unknown as z.ZodType<TypeId<T>, string>;

export const typeIdFromString = <T extends IdType>(
  type: T,
  val: string,
): TypeId<T> => typeIdSchema(type).parse(val);

export const typeIdToString = <T extends IdType>(
  type: T,
  typeId: TypeId<T>,
): string => typeId;

export const newTypeId = <T extends IdType>(type: T): TypeId<T> => {
  return typeid(ID_TYPE_PREFIXES[type]).toString() as TypeId<T>;
};
