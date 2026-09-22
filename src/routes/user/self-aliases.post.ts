import { defineEventHandler } from "h3";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  setUserSelfAliasesRequestSchema,
  setUserSelfAliasesResponseSchema,
} from "~/lib/schemas/user-self-aliases";
import { setUserSelfAliases } from "~/lib/user-profile";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, aliases } = parseRequestBody(
    setUserSelfAliasesRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await setUserSelfAliases(
    db,
    userId,
    aliases,
    partitionKey,
    getRequestAccessScope(event),
  );
  return setUserSelfAliasesResponseSchema.parse(result);
});
