import { defineEventHandler } from "h3";
import { getSource } from "~/lib/get-source";
import { getSourceRequestSchema } from "~/lib/schemas/sources";

export default defineEventHandler(async (event) =>
  getSource(getSourceRequestSchema.parse(await readBody(event))),
);
