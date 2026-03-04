import {
  scratchpadEditRequestSchema,
  scratchpadEditResponseSchema,
} from "~/lib/schemas/scratchpad";
import { editScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = scratchpadEditRequestSchema.parse(await readBody(event));
  return scratchpadEditResponseSchema.parse(await editScratchpad(params));
});
