/** Deterministic relationship-shape repair proposals. Common aliases: invalid edge repair, predicate inversion, ownership split dry-run. */
import {
  isRelationshipPredicateShapeAllowed,
  relationshipPredicateFrom,
} from "./predicate-shapes";
import type { NodeType, Predicate, RelationshipPredicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

export interface PredicateShapeRepairEndpoint {
  nodeId: TypeId<"node">;
  type: NodeType;
}

export interface PredicateShapeRepairInput {
  claimId: TypeId<"claim">;
  predicate: Predicate | "OWNED_BY";
  statement: string;
  subject: PredicateShapeRepairEndpoint;
  object: PredicateShapeRepairEndpoint | null;
}

export interface PredicateShapeRepairReplacement {
  predicate: RelationshipPredicate;
  subjectNodeId: TypeId<"node">;
  objectNodeId: TypeId<"node">;
  statement: string;
}

export interface PredicateShapeRepairProposal {
  claimId: TypeId<"claim">;
  reason: string;
  replacement: PredicateShapeRepairReplacement;
}

const OWNER_TYPES: ReadonlySet<NodeType> = new Set([
  "Person",
  "Organization",
  "Concept",
  "Object",
]);

const OWNABLE_TYPES: ReadonlySet<NodeType> = new Set([
  "Organization",
  "Location",
  "Object",
  "Concept",
  "Media",
  "Atlas",
]);

function replacementFor(input: {
  predicate: RelationshipPredicate;
  subject: PredicateShapeRepairEndpoint;
  object: PredicateShapeRepairEndpoint;
  statement: string;
}): PredicateShapeRepairReplacement {
  return {
    predicate: input.predicate,
    subjectNodeId: input.subject.nodeId,
    objectNodeId: input.object.nodeId,
    statement: input.statement,
  };
}

function proposeOwnedByRepair(
  input: PredicateShapeRepairInput & {
    object: PredicateShapeRepairEndpoint;
  },
): PredicateShapeRepairProposal {
  if (input.subject.type === "Task" && input.object.type === "Person") {
    return {
      claimId: input.claimId,
      reason: "legacy_task_assignment",
      replacement: replacementFor({
        predicate: "ASSIGNED_TO",
        subject: input.subject,
        object: input.object,
        statement: input.statement,
      }),
    };
  }

  if (input.subject.type === "Person" && input.object.type === "Task") {
    return {
      claimId: input.claimId,
      reason: "legacy_task_assignment_inverted",
      replacement: replacementFor({
        predicate: "ASSIGNED_TO",
        subject: input.object,
        object: input.subject,
        statement: input.statement,
      }),
    };
  }

  if (OWNABLE_TYPES.has(input.subject.type) && OWNER_TYPES.has(input.object.type)) {
    return {
      claimId: input.claimId,
      reason: "legacy_passive_ownership",
      replacement: replacementFor({
        predicate: "OWNS",
        subject: input.object,
        object: input.subject,
        statement: input.statement,
      }),
    };
  }

  if (OWNER_TYPES.has(input.subject.type) && OWNABLE_TYPES.has(input.object.type)) {
    return {
      claimId: input.claimId,
      reason: "legacy_active_ownership",
      replacement: replacementFor({
        predicate: "OWNS",
        subject: input.subject,
        object: input.object,
        statement: input.statement,
      }),
    };
  }

  return {
    claimId: input.claimId,
    reason: "legacy_ambiguous_ownership",
    replacement: replacementFor({
      predicate: "RELATED_TO",
      subject: input.subject,
      object: input.object,
      statement: input.statement,
    }),
  };
}

export function proposeRelationshipPredicateShapeRepair(
  input: PredicateShapeRepairInput,
): PredicateShapeRepairProposal | null {
  if (input.object === null) return null;

  if (input.predicate === "OWNED_BY") {
    return proposeOwnedByRepair({ ...input, object: input.object });
  }

  const predicate = relationshipPredicateFrom(input.predicate);
  if (predicate === null) return null;

  const currentShapeIsValid = isRelationshipPredicateShapeAllowed({
    predicate,
    subjectType: input.subject.type,
    objectType: input.object.type,
  });
  if (currentShapeIsValid) return null;

  const invertedShapeIsValid = isRelationshipPredicateShapeAllowed({
    predicate,
    subjectType: input.object.type,
    objectType: input.subject.type,
  });
  if (!invertedShapeIsValid) return null;

  return {
    claimId: input.claimId,
    reason: "valid_when_inverted",
    replacement: replacementFor({
      predicate,
      subject: input.object,
      object: input.subject,
      statement: input.statement,
    }),
  };
}
