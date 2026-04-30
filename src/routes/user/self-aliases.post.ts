import { defineEventHandler } from "h3";
import {
  setUserSelfAliasesRequestSchema,
  setUserSelfAliasesResponseSchema,
} from "~/lib/schemas/user-self-aliases";
import { setUserSelfAliases } from "~/lib/user-profile";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, aliases } = setUserSelfAliasesRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await setUserSelfAliases(db, userId, aliases);
  return setUserSelfAliasesResponseSchema.parse(result);
});
