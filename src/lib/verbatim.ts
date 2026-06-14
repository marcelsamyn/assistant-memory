/**
 * Verbatim-or-null source-quote location.
 *
 * Common aliases: locate quote, verbatim excerpt, honest highlight, substring
 * provenance. The model proposes a quote; we only ever return text that
 * genuinely appears in `content` (the ACTUAL source characters), or null.
 */

/** A card quote is a sentence or two; reject runaway spans. */
const MAX_EXCERPT_CHARS = 240;

/**
 * Locate `candidate` as a verbatim span within `content`, returning the actual
 * source characters for the matched range, or `null` if it is not present.
 *
 * 1. Trim the candidate; reject null / empty / over-long → `null`.
 * 2. Exact substring → return `content.slice(...)` of the hit.
 * 3. Whitespace-tolerant: collapse runs of whitespace in both (LLMs flatten
 *    newlines/indentation), find the candidate, and map the hit back to the
 *    original offsets so the returned text is byte-for-byte from the source.
 * 4. Not found → `null`.
 *
 * Case is never normalized — verbatim means verbatim.
 */
export function locateVerbatim(
  content: string,
  candidate: string | null,
): string | null {
  if (!candidate) return null;
  const needle = candidate.trim();
  if (needle.length === 0 || needle.length > MAX_EXCERPT_CHARS) return null;

  const exact = content.indexOf(needle);
  if (exact !== -1) return content.slice(exact, exact + needle.length);

  const { normalized, map } = collapseWhitespace(content);
  const normNeedle = needle.replace(/\s+/g, " ");
  const at = normalized.indexOf(normNeedle);
  if (at === -1) return null;

  const start = map[at];
  const end = map[at + normNeedle.length - 1];
  if (start === undefined || end === undefined) return null;
  return content.slice(start, end + 1);
}

/**
 * Collapse each run of whitespace to a single space. Returns the normalized
 * string and `map[i]` = the index in the ORIGINAL string of normalized char i.
 */
function collapseWhitespace(s: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        normalized += " ";
        map.push(i);
        inWhitespace = true;
      }
    } else {
      normalized += ch;
      map.push(i);
      inWhitespace = false;
    }
  }
  return { normalized, map };
}
