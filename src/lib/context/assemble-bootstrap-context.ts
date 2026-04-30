/**
 * Bootstrap context assembler — the public read-model entry point.
 *
 * Composes section assemblers in design-doc order
 * (`pinned`, `atlas`, `open_commitments`, `recent_supersessions`,
 * `preferences`), drops null sections, and caches the result in Redis.
 *
 * Common aliases: getConversationBootstrapContext, bootstrap_memory,
 * context bundle entry point.
 */
import { logEvent } from "~/lib/observability/log";
import { useDatabase } from "~/utils/db";
import {
  getCachedBundle,
  setCachedBundle,
} from "./cache";
import { assembleAtlasSection } from "./sections/atlas";
import { assembleOpenCommitmentsSection } from "./sections/open-commitments";
import { assemblePinnedSection } from "./sections/pinned";
import { assemblePreferencesSection } from "./sections/preferences";
import { assembleRecentSupersessionsSection } from "./sections/recent-supersessions";
import type { ContextBundle, ContextSection } from "./types";

export interface BootstrapContextOptions {
  /** Skip cache lookup; always rebuild. Default: false. */
  forceRefresh?: boolean;
  /** Override the assembled-at clock (testing / asOf queries). */
  asOf?: Date;
}

export interface BootstrapContextParams {
  userId: string;
  options?: BootstrapContextOptions;
}

export async function getConversationBootstrapContext(
  params: BootstrapContextParams,
): Promise<ContextBundle> {
  const { userId, options } = params;
  const forceRefresh = options?.forceRefresh ?? false;
  const asOf = options?.asOf ?? new Date();

  if (!forceRefresh) {
    const cached = await getCachedBundle(userId);
    if (cached !== null) return cached;
  }

  const db = await useDatabase();

  // Run independent reads in parallel; each assembler returns null when its
  // section is empty, so the order below is purely the render order.
  const [pinned, atlas, openCommitments, recent, preferences] =
    await Promise.all([
      assemblePinnedSection(db, userId),
      assembleAtlasSection(db, userId),
      assembleOpenCommitmentsSection(userId),
      assembleRecentSupersessionsSection(db, userId, asOf),
      assemblePreferencesSection(db, userId),
    ]);

  const sections: ContextSection[] = [
    pinned,
    atlas,
    openCommitments,
    recent,
    preferences,
  ].filter((section): section is ContextSection => section !== null);

  const bundle: ContextBundle = {
    sections,
    assembledAt: asOf,
  };

  await setCachedBundle(userId, bundle);

  logEvent("bootstrap_context.assembled", {
    userId,
    sectionKinds: sections.map((section) => section.kind),
    totalChars: sections.reduce(
      (sum, section) => sum + section.content.length,
      0,
    ),
  });

  return bundle;
}
