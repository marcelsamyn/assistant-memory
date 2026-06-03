/**
 * Pure rendering + stats helpers for the ingestion probe
 * (`probe-ingestion.ts`). Kept free of DB/LLM/IO so the report shape can be
 * unit-tested with synthetic rows and so the orchestration script stays a
 * thin adapter.
 *
 * Three responsibilities:
 *   1. `computeStats` — roll a flat node/claim list into the headline numbers
 *      (counts by type/predicate/assertion, density per 1k chars).
 *   2. `renderFactsForJudge` — serialize the extracted graph into the compact
 *      fact list handed to the coverage judge.
 *   3. `renderReport` — assemble the full Markdown report (config, stats,
 *      coverage, spine, nodes, claims, aliases).
 *
 * Common aliases: probe report, ingestion probe rendering, coverage report,
 * extraction probe stats, graph dump.
 */

export interface ProbeNode {
  id: string;
  type: string;
  label: string | null;
  description: string | null;
}

/**
 * A read-back claim with subject/object already resolved to labels. Exactly
 * one of `objectLabel` (relationship claim) or `objectValue` (attribute
 * claim) is non-null, mirroring the `claims_object_shape_xor_ck` constraint.
 */
export interface ProbeClaim {
  predicate: string;
  statement: string;
  assertedByKind: string;
  subjectLabel: string | null;
  objectLabel: string | null;
  objectValue: string | null;
}

export interface ProbeAlias {
  aliasText: string;
  canonicalLabel: string | null;
}

export interface ProbeStats {
  nodeCount: number;
  claimCount: number;
  aliasCount: number;
  nodesByType: Array<[type: string, count: number]>;
  claimsByPredicate: Array<[predicate: string, count: number]>;
  claimsByAssertion: Array<[assertedByKind: string, count: number]>;
  contentLength: number;
  chunkCount: number;
  /** Extraction density: how many claims/nodes per 1,000 source characters. */
  claimsPer1kChars: number;
  nodesPer1kChars: number;
}

export interface CoverageResult {
  /** 0–100, fraction of salient source facts represented in the graph. */
  coverageScore: number;
  capturedCount: number;
  salientCount: number;
  missedFacts: string[];
  summary: string;
}

export interface ProbeReportConfig {
  file: string;
  model: string;
  /** null when coverage judging is disabled (`--no-judge`). */
  judgeModel: string | null;
  judgeMode: "per-chunk" | "whole" | "off";
  title: string | undefined;
  author: string | undefined;
  chunkMaxChars: number;
  userId: string;
  generatedAt: string;
}

export interface RenderReportInput {
  config: ProbeReportConfig;
  stats: ProbeStats;
  /** Labels of the spine concepts the document pre-pass surfaced. */
  spineConcepts: string[];
  nodes: ProbeNode[];
  claims: ProbeClaim[];
  aliases: ProbeAlias[];
  coverage: CoverageResult | null;
  durationMs: number;
}

function countBy<T>(
  items: T[],
  key: (item: T) => string,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Sort by count desc, then key asc for stable output.
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

function per1k(count: number, contentLength: number): number {
  if (contentLength === 0) return 0;
  return Math.round((count / (contentLength / 1000)) * 10) / 10;
}

export function computeStats(params: {
  nodes: ProbeNode[];
  claims: ProbeClaim[];
  aliasCount: number;
  contentLength: number;
  chunkCount: number;
}): ProbeStats {
  const { nodes, claims, aliasCount, contentLength, chunkCount } = params;
  return {
    nodeCount: nodes.length,
    claimCount: claims.length,
    aliasCount,
    nodesByType: countBy(nodes, (n) => n.type),
    claimsByPredicate: countBy(claims, (c) => c.predicate),
    claimsByAssertion: countBy(claims, (c) => c.assertedByKind),
    contentLength,
    chunkCount,
    claimsPer1kChars: per1k(claims.length, contentLength),
    nodesPer1kChars: per1k(nodes.length, contentLength),
  };
}

function claimObject(claim: ProbeClaim): string {
  if (claim.objectLabel !== null) return claim.objectLabel;
  if (claim.objectValue !== null) return `"${claim.objectValue}"`;
  return "(?)";
}

/**
 * Compact, LLM-friendly serialization of the extracted graph for the coverage
 * judge. Intentionally terse: the judge only needs to recognize which source
 * facts are present, not reconstruct the graph.
 */
export function renderFactsForJudge(
  nodes: ProbeNode[],
  claims: ProbeClaim[],
  aliases: ProbeAlias[],
): string {
  const lines: string[] = [];

  lines.push("NODES:");
  for (const n of nodes) {
    const desc = n.description ? ` — ${n.description}` : "";
    lines.push(`- [${n.type}] ${n.label ?? "(no label)"}${desc}`);
  }

  lines.push("", "CLAIMS:");
  for (const c of claims) {
    lines.push(
      `- ${c.subjectLabel ?? "(?)"} —${c.predicate}→ ${claimObject(c)} ("${c.statement}")`,
    );
  }

  if (aliases.length > 0) {
    lines.push("", "ALIASES:");
    for (const a of aliases) {
      lines.push(`- "${a.aliasText}" → ${a.canonicalLabel ?? "(?)"}`);
    }
  }

  return lines.join("\n");
}

function renderCountTable(
  header: [string, string],
  rows: Array<[string, number]>,
): string[] {
  if (rows.length === 0) return ["_(none)_"];
  const lines = [`| ${header[0]} | ${header[1]} |`, "|---|---|"];
  for (const [key, count] of rows) lines.push(`| \`${key}\` | ${count} |`);
  return lines;
}

export function renderReport(input: RenderReportInput): string {
  const { config, stats, spineConcepts, nodes, claims, aliases, coverage } =
    input;

  const lines: string[] = [
    `# Ingestion Probe — ${config.file}`,
    "",
    `Generated: \`${config.generatedAt}\` · Duration: ${(input.durationMs / 1000).toFixed(1)}s`,
    "",
    "## Config",
    "",
    `- **Source:** \`${config.file}\``,
    ...(config.title ? [`- **Title:** ${config.title}`] : []),
    ...(config.author ? [`- **Author:** ${config.author}`] : []),
    `- **Extraction model:** \`${config.model}\``,
    `- **Coverage judge:** ${
      config.judgeModel
        ? `\`${config.judgeModel}\` (${config.judgeMode})`
        : "disabled"
    }`,
    `- **Chunk size:** ${config.chunkMaxChars} chars`,
    `- **User:** \`${config.userId}\``,
    "",
    "## Stats",
    "",
    `- **Source length:** ${stats.contentLength.toLocaleString()} chars across ${stats.chunkCount} chunk(s)`,
    `- **Nodes:** ${stats.nodeCount} (${stats.nodesPer1kChars}/1k chars)`,
    `- **Claims:** ${stats.claimCount} (${stats.claimsPer1kChars}/1k chars)`,
    `- **Aliases:** ${stats.aliasCount}`,
    "",
    "### Nodes by type",
    "",
    ...renderCountTable(["type", "count"], stats.nodesByType),
    "",
    "### Claims by predicate",
    "",
    ...renderCountTable(["predicate", "count"], stats.claimsByPredicate),
    "",
    "### Claims by assertion kind",
    "",
    ...renderCountTable(["assertedByKind", "count"], stats.claimsByAssertion),
    "",
  ];

  if (coverage) {
    lines.push(
      "## Coverage",
      "",
      `**Score: ${coverage.coverageScore}/100** — ${coverage.capturedCount}/${coverage.salientCount} salient facts captured`,
      "",
      coverage.summary,
      "",
      `### Missed facts (${coverage.missedFacts.length})`,
      "",
      ...(coverage.missedFacts.length === 0
        ? ["_(none — full coverage)_"]
        : coverage.missedFacts.map((f) => `- ${f}`)),
      "",
    );
  }

  lines.push(
    "## Spine concepts",
    "",
    ...(spineConcepts.length === 0
      ? ["_(none surfaced)_"]
      : spineConcepts.map((c) => `- ${c}`)),
    "",
    `## Nodes (${nodes.length})`,
    "",
  );

  // Group nodes by type for readability.
  const nodesByType = new Map<string, ProbeNode[]>();
  for (const n of nodes) {
    const bucket = nodesByType.get(n.type) ?? [];
    bucket.push(n);
    nodesByType.set(n.type, bucket);
  }
  for (const [type, bucket] of [...nodesByType.entries()].sort()) {
    lines.push(`### ${type} (${bucket.length})`, "");
    for (const n of bucket) {
      const desc = n.description ? ` — ${n.description}` : "";
      lines.push(`- **${n.label ?? "(no label)"}**${desc}`);
    }
    lines.push("");
  }

  lines.push(`## Claims (${claims.length})`, "");
  // Group claims by subject so the graph reads as a set of facts per entity.
  const claimsBySubject = new Map<string, ProbeClaim[]>();
  for (const c of claims) {
    const key = c.subjectLabel ?? "(unlabeled)";
    const bucket = claimsBySubject.get(key) ?? [];
    bucket.push(c);
    claimsBySubject.set(key, bucket);
  }
  for (const [subject, bucket] of [...claimsBySubject.entries()].sort()) {
    lines.push(`### ${subject}`, "");
    for (const c of bucket) {
      lines.push(
        `- ${c.predicate} → ${claimObject(c)} · _${c.statement}_ \`[${c.assertedByKind}]\``,
      );
    }
    lines.push("");
  }

  if (aliases.length > 0) {
    lines.push(`## Aliases (${aliases.length})`, "");
    for (const a of aliases) {
      lines.push(`- "${a.aliasText}" → ${a.canonicalLabel ?? "(?)"}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
