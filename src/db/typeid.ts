import {
  IdType,
  newTypeId,
  TypeId,
  typeIdFromString,
  typeIdToString,
} from "../types/typeid";
import { customType } from "drizzle-orm/pg-core";

const typeIdConfig = <const T extends IdType>(type: T) => ({
  dataType(): "text" {
    return "text";
  },
  fromDriver(value: string): TypeId<T> {
    return typeIdFromString(type, value);
  },
  toDriver(value: TypeId<T>): string {
    return typeIdToString(type, value);
  },
});

/**
 * Drizzle column helper for TypeID-shaped columns.
 *
 * Accepts an optional `{ name }` to override the SQL column name when
 * the TypeScript property name needs to differ from the database column
 * (e.g., during the claims layer migration where TS keeps legacy edge
 * property names while SQL uses the new claims column names).
 */
export const typeId = <const T extends IdType>(
  type: T,
  options?: { name: string },
) => {
  const builder = customType<{
    data: TypeId<T>;
    default: true;
    driverData: string;
  }>(typeIdConfig(type));
  const column = options ? builder(options.name) : builder();
  return column.$defaultFn(() => newTypeId(type));
};

/**
 * Drizzle column helper for nullable TypeID references without generated IDs.
 */
export const typeIdNoDefault = <const T extends IdType>(
  type: T,
  options?: { name: string },
) => {
  const builder = customType<{
    data: TypeId<T>;
    driverData: string;
  }>(typeIdConfig(type));
  return options ? builder(options.name) : builder();
};
