/**
 * The memory regression stories. Order is significant: the runner and CI
 * artifact iterate this array in declared order so reviewers can scan the
 * report top-down without re-sorting.
 */
import { story01ProjectLifecycle } from "./01-project-lifecycle";
import { story02ProjectRenameViaAlias } from "./02-project-rename-via-alias";
import { story03PersonNickname } from "./03-person-nickname";
import { story04AssistantSuggestionNotConfirmed } from "./04-assistant-suggestion-not-confirmed";
import { story05UserCorrectionSupersedes } from "./05-user-correction-supersedes";
import { story06OldCurrentStateExpires } from "./06-old-current-state-expires";
import { story07PendingTaskAcrossSessions } from "./07-pending-task-across-sessions";
import { story08AssistantFabrication } from "./08-assistant-fabrication";
import { story09ReferenceScopeIsolation } from "./09-reference-scope-isolation";
import { story10MultiPartyTranscript } from "./10-multi-party-transcript";
import { story11CrossScopeMergeRefused } from "./11-cross-scope-merge-refused";
import { story13CleanupOpSubgraphBounding } from "./13-cleanup-op-subgraph-bounding";
import { story14BootstrapBundleShape } from "./14-bootstrap-bundle-shape";
import { story15CommitmentsLifecycle } from "./15-commitments-lifecycle";
import { story16CleanupOpsSurface } from "./16-cleanup-ops-surface";
import { story17TrustHierarchyMatrix } from "./17-trust-hierarchy-matrix";
import { story18DayNodeAttachment } from "./18-day-node-attachment";
import type { EvalFixture } from "../types";

export const ALL_STORIES: readonly EvalFixture[] = [
  story01ProjectLifecycle,
  story02ProjectRenameViaAlias,
  story03PersonNickname,
  story04AssistantSuggestionNotConfirmed,
  story05UserCorrectionSupersedes,
  story06OldCurrentStateExpires,
  story07PendingTaskAcrossSessions,
  story08AssistantFabrication,
  story09ReferenceScopeIsolation,
  story10MultiPartyTranscript,
  story11CrossScopeMergeRefused,
  story13CleanupOpSubgraphBounding,
  story14BootstrapBundleShape,
  story15CommitmentsLifecycle,
  story16CleanupOpsSurface,
  story17TrustHierarchyMatrix,
  story18DayNodeAttachment,
];
