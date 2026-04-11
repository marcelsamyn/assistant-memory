/** Normalize a node label for dedup comparison: lowercase, trim, collapse whitespace. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
