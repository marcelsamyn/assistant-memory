# Eval Harness Mutation Test — 2026-04-30

Mutation testing of `src/evals/memory/` against 5 targeted production-code mutations to check whether the regression suite catches real invariant violations.

Baseline: all 11 stories pass on `main` (43119f3).

## Results

| # | Mutation | Stories failed | Should-have-failed-but-passed | Severity | Interpretation |
|---|---|---|---|---|---|
| M1 | Trust hierarchy inversion (`trustRuleDemotedClaimId` short-circuited so `assistant_inferred` never demoted) | 01, 06, 07 | 04, 05, 08 | partial | Inverted check happens to flip *which kinds* are demoted (now everything except assistant_inferred), so user-correction stories that genuinely test trust rule (04, 05, 08) still pass — the lifecycle-ordering paths in 01/06/07 break for unrelated reasons. **The exact invariant "user beats later assistant_inferred" is not directly probed.** |
| M2 | Reference scope leak in `searchAsCards` (commented out `card.scope !== filter.keepScope` filter) | none | 09 | missed | Story 09 only counts raw `claims` rows by `scope` column with `db.select()`. It never calls `searchMemory`/`searchReference`, so the actual read-surface scope guard is untested. The story name advertises an invariant the test does not probe. |
| M3 | `allowedClaimIds` bypass in `checkAllowedClaimIds` (early `return null` before kind switch) | none | 01, 02, 05 (any cleanup-ops story) | missed | No story exercises `applyCleanupOperations` with a constrained `allowedClaimIds` set. Story 11 hits the dispatcher but only with a `merge_nodes` op, which is not claim-targeting and not subject to this guard. The whole subgraph-bounding contract for retract/contradict/promote is untested. |
| M4 | `CrossScopeMergeError` throw commented out in `mergeNodes` | 11 | 11 | caught | Story 11 detected the regression — though indirectly: the merge proceeded and then hit a missing `node_embeddings` table in the test schema, which surfaced as `op_failed`. Caught, but the story relies on the throw-and-catch path, not on observing post-merge state. A merge that "succeeded silently" with no embedding side-effects would slip through. |
| M5 | `_resolveTranscriptProvenance` collapses non-user-self speakers to `kind: "user"` (was `"participant"`) | 10 | 10 | caught | Story 10 (multi-party transcript) directly asserts `participant` provenance for Bob and the unresolved speaker. The mutation is detected cleanly. |

Score: **2 caught**, **1 partial**, **2 missed** out of 5.

## Findings

### Caught well
- **Speaker-map provenance** (M5). Story 10 directly inspects `assertedByKind` post-extraction and pins `participant` vs `user`, so any collapse is detected.
- **Cross-scope merge refusal** (M4). Story 11 catches the regression — though only because removing the throw lets the merge proceed into a path that fails on a missing test-schema relation. The detection is incidental, not by inspecting post-merge graph state.

### Blind spots
- **The advertised invariant of story 09 is not actually tested.** The story is named "reference scope isolation" and its docstring describes `searchMemory`/`searchReference` filter contracts — but the assertion only counts raw `claims` rows by `claims.scope`. Neither the SQL filter inside `findSimilarClaims` nor the card-level `keepScope` filter is exercised. M2 (commenting out the entire scope filter) was completely invisible.
- **Cleanup-op subgraph bounding (`allowedClaimIds`)** is unprobed. M3 short-circuited the guard for `retract_claim` / `contradict_claim` / `promote_assertion` and *all 11 stories passed*. No story drives `applyCleanupOperations` with a constrained `allowedClaimIds` set against an out-of-subgraph claim id.
- **Trust-rule semantics (M1) are partially probed.** Stories 04, 05, 08 are nominally about "user beats assistant" but the suite catches the inversion only via collateral lifecycle damage on stories 01/06/07. The exact case "previous user claim, new assistant_inferred claim with later statedAt → assistant claim is forced superseded" is not asserted as such.
- **Story 11 catches M4 by accident.** It relies on the `op_failed` error from a downstream `node_embeddings` table that the test schema doesn't define. If the test schema gained that table, M4 would silently pass — story 11 doesn't actually inspect post-op merge state, only the error log/result.

### Recommended new stories
1. **`12-search-scope-leak-via-cards`.** Seed one personal node and one reference node for the same query string, call `searchMemory({...})`, assert no reference-derived card surfaces; call `searchReference`, assert no personal-derived card surfaces. Closes the M2 blind spot directly.
2. **`13-cleanup-op-subgraph-bounding`.** Render a small subgraph, call `applyCleanupOperations` with an `allowedClaimIds` set that excludes some out-of-subgraph claim id; pass operations whose target claim is not in the set; assert the op is skipped with the expected `out_of_subgraph_claim_ref` error and the targeted claim's status is unchanged. Closes the M3 blind spot.
3. **`14-trust-rule-explicit`.** Seed a `user` claim and a later `assistant_inferred` claim on the same (subject, predicate); run lifecycle; assert the user claim is `active` and the assistant claim is `superseded`. Closes the partial coverage from M1 with a focused, low-flake story that doesn't depend on fixture ordering.

### Surprises
- The biggest surprise: **two of the five mutations were silent**. The suite's coverage is shallower than its eleven story names suggest — particularly story 09, where the docstring promises read-surface scope isolation but the assertion only checks DB-row scope columns. The story name and the assertion tell different stories. Worth tightening the assertion to actually call `searchMemory`.
- M1's failure pattern was unexpected. The trust rule's mutation broke stories 01/06/07 (which look like vanilla supersession stories) but **not** the three "trust rule" stories (04/05/08). That suggests 04/05/08 are testing the trust rule via a path that doesn't depend on `trustRuleDemotedClaimId` firing — possibly because the assistant-inferred claim has an *earlier* `statedAt` rather than later.
- M4's catch is incidental — it relied on a missing test-schema relation, not on the story's assertions. Brittle.

## 2026-04-30 follow-up — gaps closed

After tightening stories 04/05/08 (explicit `user`/`assistant_inferred` HAS_STATUS pairs with `superseded_by_claim_id` cross-checks), adding story 13 (cleanup-op subgraph bounding), and rewriting story 09 to drive `searchMemory`/`searchReference` via the new `semanticSearchSubstringQuery` seam, the three previously-leaky mutations were re-applied against `main`.

| # | Mutation reapplied | Stories that now turn red | Status |
|---|---|---|---|
| M1 | Trust hierarchy inversion (`trustRuleDemotedClaimId` early-returns when latest is `assistant_inferred`) | **04, 05, 08, 17** + collateral 01, 06, 07, 15 | gap closed — the trust-rule stories are now load-bearing on the comparator |
| M2 | Reference scope leak (commented out the `claims.scope = 'personal'` filter in `findSimilarClaims` *and* the substring fallback, plus the `card.scope !== filter.keepScope` post-filter in `searchAsCards`) | **09** (both assertions: `searchMemory.evidence` leaked reference claim ids; `searchReference.cards` leaked the personal-derived node) | gap closed — story 09 now drives the actual read surfaces, not raw row counts |
| M3 | `allowedClaimIds` bypass (`checkAllowedClaimIds` short-circuits to `null` before the kind switch) | **13** (`retract_claim`, `contradict_claim`, and `promote_assertion` all rejected positive expectations; the targeted claim mutated when it shouldn't) | gap closed — the dispatcher's subgraph-bounding contract is now pinned |

### Notes
- M1's blast radius now includes story **17** (the trust-hierarchy matrix added by the orchestrator), which independently pins every adjacent kind-pair plus the non-adjacent skip. 04/05/08 catch the assistant-inferred-vs-user case directly via `superseded_by_claim_id` cross-checks; 17 catches the broader monotone tier ordering.
- The harness flake observed earlier (BullMQ jobs from prior runs colliding with the per-fixture test schema, surfacing as a `claims_asserted_by_node_consistency_ck` violation on story 17) was process-level, not a story-level defect; it disappears once stale workers are reaped.
- The `applyCleanupOperations` step kind in the harness still does not pass `allowedClaimIds`; story 13 deliberately calls the dispatcher directly from a `custom` assertion to keep the step-kind contract minimal.

