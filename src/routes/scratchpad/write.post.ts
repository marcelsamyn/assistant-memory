import { parseRequestBody } from "~/lib/request-body";
import {
  scratchpadWriteRequestSchema,
  scratchpadResponseSchema,
} from "~/lib/schemas/scratchpad";
import { writeScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    scratchpadWriteRequestSchema,
    await readBody(event),
  );
  return scratchpadResponseSchema.parse(await writeScratchpad(params));
});
