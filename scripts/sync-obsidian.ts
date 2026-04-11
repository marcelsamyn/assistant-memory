/**
 * Syncs an Obsidian vault to Assistant Memory via the document ingestion API.
 *
 * Uses content hashing to detect changes and only re-ingests modified or new notes.
 * Resolves [[wikilinks]] to plain text before sending content.
 *
 * Usage:
 *   pnpm run tsx scripts/sync-obsidian.ts
 *
 * Configuration via environment variables (or .env):
 *   OBSIDIAN_VAULT_PATH  - absolute path to your Obsidian vault
 *   MEMORY_API_URL       - base URL of the Assistant Memory server (default: http://localhost:3000)
 *   MEMORY_API_KEY       - optional API key
 *   MEMORY_USER_ID       - user ID for ingestion
 *   OBSIDIAN_INCLUDE     - comma-separated folder prefixes to include (e.g., "Projects,Journal,People")
 *   OBSIDIAN_EXCLUDE     - comma-separated folder prefixes to exclude (e.g., "Templates,Archive,.obsidian")
 *   OBSIDIAN_MIN_WORDS   - minimum word count to ingest a note (default: 30)
 *   OBSIDIAN_MAX_WORDS   - maximum word count to ingest (default: 5000, skips huge files)
 *   OBSIDIAN_BATCH_SIZE  - max documents to ingest per run (default: 50, 0 = unlimited)
 *   OBSIDIAN_MANIFEST    - path to manifest file (default: scripts/.obsidian-sync-manifest.json)
 *   OBSIDIAN_DRY_RUN     - set to "true" to preview without ingesting
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SyncConfig {
  vaultPath: string;
  apiUrl: string;
  apiKey: string | undefined;
  userId: string | undefined;
  includePrefixes: string[];
  excludePrefixes: string[];
  minWords: number;
  maxWords: number;
  batchSize: number;
  manifestPath: string;
  dryRun: boolean;
}

function loadConfig(): SyncConfig {
  // Load .env from project root if present
  const envPath = join(import.meta.dirname ?? ".", "..", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }

  const vaultPath = process.env["OBSIDIAN_VAULT_PATH"];
  if (!vaultPath) throw new Error("OBSIDIAN_VAULT_PATH is required");

  const userId = process.env["MEMORY_USER_ID"];

  const parseList = (val: string | undefined): string[] =>
    val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];

  return {
    vaultPath,
    apiUrl: process.env["MEMORY_API_URL"] ?? "http://localhost:3000",
    apiKey: process.env["MEMORY_API_KEY"],
    userId,
    includePrefixes: parseList(process.env["OBSIDIAN_INCLUDE"]),
    excludePrefixes: [
      ".obsidian",
      ".trash",
      ...parseList(process.env["OBSIDIAN_EXCLUDE"]),
    ],
    minWords: parseInt(process.env["OBSIDIAN_MIN_WORDS"] ?? "30", 10),
    maxWords: parseInt(process.env["OBSIDIAN_MAX_WORDS"] ?? "5000", 10),
    batchSize: parseInt(process.env["OBSIDIAN_BATCH_SIZE"] ?? "50", 10),
    manifestPath:
      process.env["OBSIDIAN_MANIFEST"] ??
      join(import.meta.dirname ?? ".", ".obsidian-sync-manifest.json"),
    dryRun: process.env["OBSIDIAN_DRY_RUN"] === "true",
  };
}

// ---------------------------------------------------------------------------
// Manifest — tracks what we've already synced
// ---------------------------------------------------------------------------

interface ManifestEntry {
  hash: string;
  lastSynced: string;
}

type Manifest = Record<string, ManifestEntry>;

function loadManifest(path: string): Manifest {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Manifest;
}

function saveManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

// ---------------------------------------------------------------------------
// Vault reading
// ---------------------------------------------------------------------------

function collectMarkdownFiles(dir: string, rootDir: string, config: SyncConfig): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = relative(rootDir, fullPath);

    // Skip excluded prefixes
    if (config.excludePrefixes.some((prefix) => relPath.startsWith(prefix))) {
      continue;
    }

    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath, rootDir, config));
    } else if (stat.isFile() && extname(entry) === ".md") {
      // If include prefixes are set, only include matching files
      if (
        config.includePrefixes.length > 0 &&
        !config.includePrefixes.some((prefix) => relPath.startsWith(prefix))
      ) {
        continue;
      }
      results.push(fullPath);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Wikilink resolution
// ---------------------------------------------------------------------------

/**
 * Resolves Obsidian [[wikilinks]] to plain text.
 * - [[Page Name]] → "Page Name"
 * - [[Page Name|Display Text]] → "Display Text"
 * - [[Page Name#Heading]] → "Page Name > Heading"
 * - ![[Embedded Note]] → removes embeds (images, PDFs, etc.)
 */
function resolveWikilinks(content: string): string {
  // Remove embeds (images, PDFs, other files)
  let resolved = content.replace(/!\[\[([^\]]+)\]\]/g, "");

  // Resolve wikilinks with alias: [[target|alias]] → alias
  resolved = resolved.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");

  // Resolve wikilinks with heading: [[target#heading]] → "target > heading"
  resolved = resolved.replace(/\[\[([^#\]]+)#([^\]]+)\]\]/g, "$1 > $2");

  // Resolve plain wikilinks: [[target]] → target
  resolved = resolved.replace(/\[\[([^\]]+)\]\]/g, "$1");

  return resolved;
}

/**
 * Strips YAML frontmatter from note content but preserves useful metadata
 * as a readable header if tags/aliases are present.
 */
function processFrontmatter(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  const frontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";

  // Extract useful metadata from frontmatter
  const tags: string[] = [];
  const aliases: string[] = [];

  for (const line of frontmatter.split("\n")) {
    const tagMatch = line.match(/^tags:\s*\[(.+)\]$/);
    if (tagMatch) {
      tags.push(...tagMatch[1]!.split(",").map((t) => t.trim().replace(/^#/, "")));
    }
    // Also handle YAML list format for tags
    const tagListMatch = line.match(/^\s*-\s*(.+)$/);
    if (tagListMatch && tags.length > 0) {
      tags.push(tagListMatch[1]!.trim().replace(/^#/, ""));
    }
    const aliasMatch = line.match(/^aliases:\s*\[(.+)\]$/);
    if (aliasMatch) {
      aliases.push(...aliasMatch[1]!.split(",").map((a) => a.trim()));
    }
  }

  const metadataLines: string[] = [];
  if (tags.length > 0) metadataLines.push(`Tags: ${tags.join(", ")}`);
  if (aliases.length > 0) metadataLines.push(`Also known as: ${aliases.join(", ")}`);

  if (metadataLines.length > 0) {
    return `${metadataLines.join("\n")}\n\n${body}`;
  }

  return body;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// API client (minimal, avoids importing the full SDK to keep the script standalone)
// ---------------------------------------------------------------------------

interface IngestDocumentPayload {
  userId?: string;
  updateExisting: boolean;
  document: {
    id: string;
    content: string;
    timestamp: string;
  };
}

async function ingestDocument(
  config: SyncConfig,
  payload: IngestDocumentPayload,
): Promise<{ message: string; jobId: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;

  const res = await fetch(`${config.apiUrl}/ingest/document`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<{ message: string; jobId: string }>;
}

// ---------------------------------------------------------------------------
// Main sync logic
// ---------------------------------------------------------------------------

type ChangeType = "new" | "modified";

interface FileChange {
  relPath: string;
  fullPath: string;
  hash: string;
  type: ChangeType;
}

function detectChanges(
  files: string[],
  vaultPath: string,
  manifest: Manifest,
): { changes: FileChange[]; deleted: string[] } {
  const changes: FileChange[] = [];
  const currentPaths = new Set<string>();

  for (const fullPath of files) {
    const relPath = relative(vaultPath, fullPath);
    currentPaths.add(relPath);

    const content = readFileSync(fullPath, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");

    const existing = manifest[relPath];
    if (!existing) {
      changes.push({ relPath, fullPath, hash, type: "new" });
    } else if (existing.hash !== hash) {
      changes.push({ relPath, fullPath, hash, type: "modified" });
    }
  }

  // Detect deletions (in manifest but no longer on disk)
  const deleted = Object.keys(manifest).filter((p) => !currentPaths.has(p));

  return { changes, deleted };
}

async function main() {
  const config = loadConfig();

  console.log(`\n📂 Vault: ${config.vaultPath}`);
  console.log(`🔗 API:   ${config.apiUrl}`);
  if (config.userId) console.log(`👤 User:  ${config.userId}`);
  if (config.includePrefixes.length > 0) {
    console.log(`📁 Include: ${config.includePrefixes.join(", ")}`);
  }
  console.log(`🚫 Exclude: ${config.excludePrefixes.join(", ")}`);
  console.log(`📏 Min words: ${config.minWords}`);
  if (config.batchSize > 0) console.log(`📦 Batch size: ${config.batchSize}`);
  if (config.dryRun) console.log(`🏜️  DRY RUN — no changes will be made\n`);
  console.log();

  // Collect all markdown files
  const files = collectMarkdownFiles(config.vaultPath, config.vaultPath, config);
  console.log(`Found ${files.length} markdown files in vault`);

  // Load manifest and detect changes
  const manifest = loadManifest(config.manifestPath);
  const { changes, deleted } = detectChanges(files, config.vaultPath, manifest);

  if (changes.length === 0 && deleted.length === 0) {
    console.log("No changes detected. Everything is in sync.");
    return;
  }

  console.log(
    `Detected: ${changes.filter((c) => c.type === "new").length} new, ` +
      `${changes.filter((c) => c.type === "modified").length} modified, ` +
      `${deleted.length} deleted`,
  );

  // Apply batch limit
  const batch =
    config.batchSize > 0 ? changes.slice(0, config.batchSize) : changes;

  if (batch.length < changes.length) {
    console.log(
      `Processing ${batch.length} of ${changes.length} changes (batch limit)`,
    );
  }

  // Process changes
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const change of batch) {
    const raw = readFileSync(change.fullPath, "utf-8");
    const processed = resolveWikilinks(processFrontmatter(raw));

    const wc = wordCount(processed);

    if (wc < config.minWords) {
      console.log(`  skip (too short): ${change.relPath}`);
      skipped++;
      // Still update manifest so we don't re-check every run
      manifest[change.relPath] = { hash: change.hash, lastSynced: new Date().toISOString() };
      continue;
    }

    if (config.maxWords > 0 && wc > config.maxWords) {
      console.log(`  skip (too large: ${wc} words): ${change.relPath}`);
      skipped++;
      continue;
    }

    // Prefix the content with the note title (filename without .md) for context
    const noteTitle = change.relPath.replace(/\.md$/, "");
    const contentWithTitle = `# ${noteTitle}\n\n${processed}`;

    // Use the relative path as the document ID — stable across syncs
    const documentId = `obsidian:${change.relPath}`;

    if (config.dryRun) {
      console.log(`  [dry run] ${change.type}: ${change.relPath} (${wc} words)`);
      ingested++;
      continue;
    }

    try {
      const result = await ingestDocument(config, {
        ...(config.userId ? { userId: config.userId } : {}),
        updateExisting: change.type === "modified",
        document: {
          id: documentId,
          content: contentWithTitle,
          timestamp: new Date().toISOString(),
        },
      });
      console.log(`  ${change.type}: ${change.relPath} → ${result.jobId}`);
      manifest[change.relPath] = { hash: change.hash, lastSynced: new Date().toISOString() };
      ingested++;
    } catch (err) {
      console.error(`  ERROR: ${change.relPath} — ${err}`);
      errors++;
    }

    // Small delay between requests to avoid overwhelming the queue
    if (batch.indexOf(change) < batch.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Handle deletions (log them, but don't auto-delete nodes — too risky)
  if (deleted.length > 0) {
    console.log(`\nDeleted from vault (${deleted.length}):`);
    for (const path of deleted) {
      console.log(`  - ${path}`);
      // Remove from manifest so they don't pollute it
      delete manifest[path];
    }
    console.log(
      "Note: deleted files are removed from the manifest but their graph nodes are preserved.",
    );
    console.log(
      "Use the API to manually delete document nodes if needed.",
    );
  }

  // Save manifest
  if (!config.dryRun) {
    saveManifest(config.manifestPath, manifest);
  }

  console.log(
    `\nDone: ${ingested} ingested, ${skipped} skipped (too short), ${errors} errors`,
  );
  if (batch.length < changes.length) {
    console.log(
      `${changes.length - batch.length} remaining — run again to continue`,
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
