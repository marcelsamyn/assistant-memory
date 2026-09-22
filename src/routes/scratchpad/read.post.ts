import { parseRequestBody } from "~/lib/request-body";
import {
  scratchpadReadRequestSchema,
  scratchpadResponseSchema,
} from "~/lib/schemas/scratchpad";
import { readScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    scratchpadReadRequestSchema,
    await readBody(event),
  );
  return scratchpadResponseSchema.parse(await readScratchpad(params));
});
