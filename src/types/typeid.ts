import { fromString, typeid } from "typeid-js";
import { z } from "zod";

const TYPE_ID_LENGTH = 26;

export const ID_TYPE_NAMES = [
  "node",
  "edge",
  "node_metadata",
  "node_embedding",
  "edge_embedding",
  "source",
  "alias",
  "source_link",
  "user_profile",
  "message",
  "scratchpad",
] as const;

export const ID_TYPE_PREFIXES: Record<(typeof ID_TYPE_NAMES)[number], string> =
  {
    node: "node",
    edge: "edge",
    node_metadata: "nmeta",
    node_embedding: "nemb",
    edge_embedding: "eemb",
    source: "src",
    alias: "alias",
    source_link: "sln",
    user_profile: "upf",
    message: "msg",
    scratchpad: "spad",
  } as const;

export type IdType = (typeof ID_TYPE_NAMES)[number];

export type IdTypePrefix<T extends IdType> = (typeof ID_TYPE_PREFIXES)[T];

export type TypeId<T extends IdType> = `${IdTypePrefix<T>}_${string}`;

export const typeIdSchema = <T extends IdType>(type: T) =>
  z
    .string()
    .startsWith(ID_TYPE_PREFIXES[type] + "_")
    .length(ID_TYPE_PREFIXES[type].length + 1 + TYPE_ID_LENGTH)
    .transform((input) => input as TypeId<T>);

export const typeIdFromString = <T extends IdType>(
  type: T,
  val: string,
): TypeId<T> => fromString(val, ID_TYPE_PREFIXES[type]) as TypeId<T>;

export const typeIdToString = <T extends IdType>(
  type: T,
  typeId: TypeId<T>,
): string => typeId;

export const newTypeId = <T extends IdType>(type: T): TypeId<T> => {
  return typeid(ID_TYPE_PREFIXES[type]).toString() as TypeId<T>;
};
