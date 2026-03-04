import {
  scratchpadReadRequestSchema,
  scratchpadResponseSchema,
} from "~/lib/schemas/scratchpad";
import { readScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = scratchpadReadRequestSchema.parse(await readBody(event));
  return scratchpadResponseSchema.parse(await readScratchpad(params));
});
