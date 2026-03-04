import {
  scratchpadWriteRequestSchema,
  scratchpadResponseSchema,
} from "~/lib/schemas/scratchpad";
import { writeScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = scratchpadWriteRequestSchema.parse(await readBody(event));
  return scratchpadResponseSchema.parse(await writeScratchpad(params));
});
