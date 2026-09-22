import { parseRequestBody } from "~/lib/request-body";
import {
  scratchpadEditRequestSchema,
  scratchpadEditResponseSchema,
} from "~/lib/schemas/scratchpad";
import { editScratchpad } from "~/lib/scratchpad";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    scratchpadEditRequestSchema,
    await readBody(event),
  );
  return scratchpadEditResponseSchema.parse(await editScratchpad(params));
});
