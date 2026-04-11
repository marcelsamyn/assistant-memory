import { defineEventHandler, readBody } from "h3";
import { runDedupSweep } from "~/lib/jobs/dedup-sweep";
import {
  dedupSweepRequestSchema,
  dedupSweepResponseSchema,
} from "~/lib/schemas/cleanup";

export default defineEventHandler(async (event) => {
  const { userId } = dedupSweepRequestSchema.parse(await readBody(event));
  const result = await runDedupSweep(userId);
  return dedupSweepResponseSchema.parse(result);
});
