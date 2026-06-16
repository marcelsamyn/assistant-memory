import { z } from "zod";

// Allow any string here (no `.min(1)`): an empty `title: ""` must not fail the
// whole parse, or we'd discard valid fallbacks like `filename`. Trimming and
// non-empty checks live in the resolver below.
const labelMetaSchema = z
  .object({
    title: z.string().optional(),
    filename: z.string().optional(),
    rawContent: z.string().optional(),
    role: z.string().optional(),
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

  const title = parsed.data.title?.trim();
  if (title) return title;

  const filename = parsed.data.filename?.trim();
  if (filename) return filename;

  if (type === "conversation_message") {
    const raw = parsed.data.rawContent;
    if (typeof raw !== "string") return null;
    const line = firstNonEmptyLine(raw);
    if (!line) return null;
    const snippet = line.slice(0, MAX_SNIPPET);
    const role = parsed.data.role?.trim();
    return role
      ? `${role[0]!.toUpperCase()}${role.slice(1)}: ${snippet}`
      : snippet;
  }
  return null;
}
