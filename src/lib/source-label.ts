import { z } from "zod";

const labelMetaSchema = z
  .object({
    title: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    rawContent: z.string().optional(),
    role: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

const MAX_SNIPPET = 80;

function firstNonEmptyLine(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

/**
 * Display label for a source. Mirrors `deriveTitle` (title ?? filename) and,
 * for individual chat messages (which never carry a title), falls back to
 * "Role: first line" of the message body. Returns null when nothing usable
 * exists. Populates the summary `title` field so lists never show a bare id.
 */
export function deriveSourceLabel({
  type,
  metadata,
}: {
  type: string;
  metadata: unknown;
}): string | null {
  const parsed = labelMetaSchema.safeParse(metadata ?? {});
  if (!parsed.success) return null;
  if (parsed.data.title) return parsed.data.title;
  if (parsed.data.filename) return parsed.data.filename;

  if (type === "conversation_message") {
    const raw = parsed.data.rawContent;
    if (typeof raw !== "string") return null;
    const line = firstNonEmptyLine(raw);
    if (!line) return null;
    const snippet = line.slice(0, MAX_SNIPPET);
    const role = parsed.data.role;
    return role
      ? `${role[0]!.toUpperCase()}${role.slice(1)}: ${snippet}`
      : snippet;
  }
  return null;
}
