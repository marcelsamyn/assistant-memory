/** Fail-closed server-to-server authentication for partition maintenance. */
import { createError, getHeader, type H3Event } from "h3";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "~/utils/env";

export function assertPartitionMaintenanceAuthorized(event: H3Event): void {
  assertPartitionMaintenanceAuthorizedWithToken(
    event,
    env.PARTITION_MAINTENANCE_TOKEN,
  );
}

/** Injectable policy core used by route tests without mutating process env. */
export function assertPartitionMaintenanceAuthorizedWithToken(
  event: H3Event,
  configuredToken: string | undefined,
): void {
  if (configuredToken === undefined) {
    throw createError({
      statusCode: 503,
      statusMessage: "Partition maintenance is unavailable",
      data: { code: "PARTITION_MAINTENANCE_UNAVAILABLE" },
    });
  }
  const authorization = getHeader(event, "authorization");
  const suppliedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (
    suppliedToken === undefined ||
    !tokensEqual(suppliedToken, configuredToken)
  ) {
    throw createError({
      statusCode: 401,
      statusMessage: "Invalid partition maintenance credential",
      data: { code: "PARTITION_MAINTENANCE_UNAUTHORIZED" },
    });
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
