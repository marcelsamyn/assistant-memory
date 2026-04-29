/**
 * Pinned section assembler.
 *
 * Reads `userProfiles.content` (the manual override the user authored) and
 * renders it as the `pinned` section. Empty content → no section.
 */
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { userProfiles } from "~/db/schema";
import type { ContextSectionPinned } from "../types";

const USAGE =
  "User-pinned manual context. Treat as ground truth and authoritative.";

export async function assemblePinnedSection(
  db: DrizzleDB,
  userId: string,
): Promise<ContextSectionPinned | null> {
  const [row] = await db
    .select({ content: userProfiles.content })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const content = row?.content?.trim() ?? "";
  if (content.length === 0) return null;

  return {
    kind: "pinned",
    content,
    usage: USAGE,
  };
}
