import type {
  ScratchpadReadRequest,
  ScratchpadWriteRequest,
  ScratchpadEditRequest,
  ScratchpadResponse,
  ScratchpadEditResponse,
} from "./schemas/scratchpad";
import db from "~/db";
import { scratchpads } from "~/db/schema";

export async function readScratchpad(
  params: ScratchpadReadRequest,
): Promise<ScratchpadResponse> {
  const existing = await db.query.scratchpads.findFirst({
    where: (s, { eq }) => eq(s.userId, params.userId),
  });

  if (!existing) {
    return { content: "", updatedAt: new Date() };
  }

  return { content: existing.content, updatedAt: existing.updatedAt };
}

export async function writeScratchpad(
  params: ScratchpadWriteRequest,
): Promise<ScratchpadResponse> {
  const { userId, content, mode } = params;

  if (mode === "append") {
    const existing = await readScratchpad({ userId });
    const newContent = existing.content
      ? existing.content + "\n" + content
      : content;
    return upsertScratchpad(userId, newContent);
  }

  return upsertScratchpad(userId, content);
}

export async function editScratchpad(
  params: ScratchpadEditRequest,
): Promise<ScratchpadEditResponse> {
  const { userId, oldText, newText } = params;
  const existing = await readScratchpad({ userId });

  if (!existing.content.includes(oldText)) {
    return {
      ...existing,
      applied: false,
      message: `The text to replace was not found in the scratchpad. The scratchpad content is:\n${existing.content}`,
    };
  }

  const occurrences = existing.content.split(oldText).length - 1;
  if (occurrences > 1) {
    return {
      ...existing,
      applied: false,
      message: `The text to replace appears ${occurrences} times in the scratchpad. Please provide a longer, more specific text snippet that appears exactly once.`,
    };
  }

  const newContent = existing.content.replace(oldText, newText);
  const result = await upsertScratchpad(userId, newContent);

  return { ...result, applied: true };
}

async function upsertScratchpad(
  userId: string,
  content: string,
): Promise<ScratchpadResponse> {
  const now = new Date();
  const rows = await db
    .insert(scratchpads)
    .values({ userId, content, updatedAt: now })
    .onConflictDoUpdate({
      target: [scratchpads.userId],
      set: { content, updatedAt: now },
    })
    .returning();

  const row = rows[0]!;
  return { content: row.content, updatedAt: row.updatedAt };
}
