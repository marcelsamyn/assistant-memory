# Predicate Guardrails Design

## Scope

This slice fixes relation-quality failures without taking on the broader
organization taxonomy migration. It covers date semantics, deterministic
invalid-edge repair, prompt/eval guardrails, and a reusable dry-run audit
surface for imported graph data.

`Organization` is prepared as a follow-up because it affects extraction,
identity resolution, merge rules, visual styling, and historical retyping.

## Date Semantics

`OCCURRED_ON` means the subject actually happened on the Temporal node date.
System bookkeeping edges that mean "this node/source was recorded or ingested
on this date" use a separate predicate, `RECORDED_ON`.

Manual node creation and source-node creation should write `RECORDED_ON` for
bookkeeping day attachment. Event-like source nodes can still use
`OCCURRED_ON` only when the source content itself is the event being modeled.

## Deterministic Repair

Invalid relationship shapes are reported and, where safe, repaired without an
LLM call. Safe repairs are limited to canonical inversions or legacy predicate
mapping where no semantic judgment is required:

- `Temporal OCCURRED_ON X` becomes `X OCCURRED_ON Temporal` when the inverted
  shape is valid.
- `Event PARTICIPATED_IN Person` becomes `Person PARTICIPATED_IN Event`.
- Legacy `OWNED_BY` maps through the migration split: task assignment becomes
  `ASSIGNED_TO`; ordinary ownership becomes owner-to-owned `OWNS`; ambiguous
  cases fall back to `RELATED_TO`.

The repair path first exposes dry-run proposals with before/after counts and
examples. Applying repairs is a separate operation.

## Prompt And Eval Guardrails

Extraction and cleanup prompts include the predicate table plus generic
positive/negative examples for the high-volume failures observed in imported
data:

- interaction moments are events or omitted, not deadlines;
- preferences are scalar preferences, not location edges;
- viewing/reading tone is not a personal emotion unless a person expressed it;
- participants point from person to event;
- dates point from event-like subject to Temporal;
- tasks use `ASSIGNED_TO` and `DUE_ON`;
- `RELATED_TO` is allowed only for durable explicit associations with no better
  predicate.

Regression coverage should pin both the prompt text and the behavior of the
deterministic repair proposals.

## Organization Follow-Up Prep

The next taxonomy slice should decide:

- whether `Organization` is extraction-mintable immediately or migration-only
  first;
- whether projects/products remain `Concept`/`Object` or get a separate type;
- how to retype historical company-like nodes without overfitting user data;
- which predicates should accept `Organization` as subject or object;
- whether automatic label merge rules should treat organizations like durable
  entities.
