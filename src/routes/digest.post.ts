/**
 * `POST /digest` — consolidated daily rollup for a "Today"/digest view.
 *
 * One call returns open commitments bucketed by due date (in the caller's
 * `timeZone`), recent metric movers, what's-new since the resolved cursor,
 * and the pinned-context subset. Structured data only.
 */
import { defineEventHandler } from "h3";
import { getDigest } from "~/lib/digest/get-digest";
import {
  getDigestRequestSchema,
  getDigestResponseSchema,
} from "~/lib/schemas/digest";

export default defineEventHandler(async (event) => {
  const params = getDigestRequestSchema.parse(await readBody(event));
  return getDigestResponseSchema.parse(await getDigest(params));
});
