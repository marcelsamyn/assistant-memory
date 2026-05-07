/**
 * Splits markdown into chunks of at most `maxChars` characters, preferring to
 * cut at H1/H2 section boundaries and falling back to paragraph boundaries
 * inside sections that are themselves too large. Used by file ingest so the
 * graph extractor sees focused passages instead of one wall of text.
 *
 * Packing rule: greedily fill the current chunk with whole sections (or
 * paragraphs, when sub-splitting) until adding the next unit would exceed
 * `maxChars`. A unit larger than `maxChars` is emitted as its own chunk
 * intact — we never split mid-paragraph.
 *
 * Heading-only paragraphs (e.g. "## Section") are glued to the next
 * paragraph during sub-splitting so a heading never gets separated from the
 * body it introduces.
 */

const SEPARATOR = "\n\n";

export function chunkMarkdown(markdown: string, maxChars: number): string[] {
  if (!markdown.trim()) return [];

  const sections = splitIntoSections(markdown);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(SEPARATOR).trimEnd();
    if (joined.length > 0) chunks.push(joined);
    buffer = [];
    bufferLen = 0;
  };

  for (const section of sections) {
    if (section.length > maxChars) {
      flush();
      for (const piece of subSplitOversizedSection(section, maxChars)) {
        chunks.push(piece);
      }
      continue;
    }

    const projected =
      bufferLen === 0
        ? section.length
        : bufferLen + SEPARATOR.length + section.length;

    if (projected > maxChars && buffer.length > 0) {
      flush();
      buffer = [section];
      bufferLen = section.length;
    } else {
      buffer.push(section);
      bufferLen = projected;
    }
  }

  flush();
  return chunks;
}

function splitIntoSections(markdown: string): string[] {
  const lines = markdown.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  const pushCurrent = () => {
    const text = current.join("\n").trim();
    if (text.length > 0) sections.push(text);
    current = [];
  };

  for (const line of lines) {
    if (isTopLevelHeading(line) && current.length > 0) {
      pushCurrent();
    }
    current.push(line);
  }
  pushCurrent();

  return sections;
}

function isTopLevelHeading(line: string): boolean {
  return /^#{1,2}\s/.test(line);
}

function subSplitOversizedSection(section: string, maxChars: number): string[] {
  const paragraphs = mergeHeadingsIntoNext(splitIntoParagraphs(section));
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(SEPARATOR).trimEnd();
    if (joined.length > 0) out.push(joined);
    buffer = [];
    bufferLen = 0;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      out.push(paragraph.trimEnd());
      continue;
    }

    const projected =
      bufferLen === 0
        ? paragraph.length
        : bufferLen + SEPARATOR.length + paragraph.length;

    if (projected > maxChars && buffer.length > 0) {
      flush();
      buffer = [paragraph];
      bufferLen = paragraph.length;
    } else {
      buffer.push(paragraph);
      bufferLen = projected;
    }
  }

  flush();
  return out;
}

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function mergeHeadingsIntoNext(paragraphs: string[]): string[] {
  const merged: string[] = [];
  let index = 0;
  while (index < paragraphs.length) {
    const current = paragraphs[index]!;
    const next = paragraphs[index + 1];
    if (next !== undefined && isHeadingOnlyParagraph(current)) {
      merged.push(`${current}${SEPARATOR}${next}`);
      index += 2;
    } else {
      merged.push(current);
      index += 1;
    }
  }
  return merged;
}

function isHeadingOnlyParagraph(paragraph: string): boolean {
  return !paragraph.includes("\n") && /^#{1,6}\s/.test(paragraph);
}
