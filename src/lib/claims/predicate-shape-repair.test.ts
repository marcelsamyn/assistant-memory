import { proposeRelationshipPredicateShapeRepair } from "./predicate-shape-repair";
import { describe, expect, it } from "vitest";
import type { NodeType } from "~/types/graph";
import { newTypeId, type TypeId } from "~/types/typeid";

const node = (type: NodeType): { nodeId: TypeId<"node">; type: NodeType } => ({
  nodeId: newTypeId("node"),
  type,
});

describe("proposeRelationshipPredicateShapeRepair", () => {
  it("inverts invalid relationships when the same predicate is valid in the opposite direction", () => {
    const event = node("Event");
    const temporal = node("Temporal");
    const participant = node("Person");

    const occurredOnRepair = proposeRelationshipPredicateShapeRepair({
      claimId: newTypeId("claim"),
      predicate: "OCCURRED_ON",
      statement: "The workshop happened on 2026-06-19.",
      subject: temporal,
      object: event,
    });

    expect(occurredOnRepair?.replacement).toMatchObject({
      predicate: "OCCURRED_ON",
      subjectNodeId: event.nodeId,
      objectNodeId: temporal.nodeId,
    });

    const participatedInRepair = proposeRelationshipPredicateShapeRepair({
      claimId: newTypeId("claim"),
      predicate: "PARTICIPATED_IN",
      statement: "Taylor joined the workshop.",
      subject: event,
      object: participant,
    });

    expect(participatedInRepair?.replacement).toMatchObject({
      predicate: "PARTICIPATED_IN",
      subjectNodeId: participant.nodeId,
      objectNodeId: event.nodeId,
    });
  });

  it("maps legacy OWNED_BY claims through the ownership and assignment split", () => {
    const task = node("Task");
    const person = node("Person");
    const object = node("Object");
    const studio = node("Organization");
    const chapter = node("Organization");
    const emotion = node("Emotion");

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "The task is owned by Taylor.",
        subject: task,
        object: person,
      })?.replacement,
    ).toMatchObject({
      predicate: "ASSIGNED_TO",
      subjectNodeId: task.nodeId,
      objectNodeId: person.nodeId,
    });

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "Taylor owns the task.",
        subject: person,
        object: task,
      })?.replacement,
    ).toMatchObject({
      predicate: "ASSIGNED_TO",
      subjectNodeId: task.nodeId,
      objectNodeId: person.nodeId,
    });

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "The notebook is owned by Taylor.",
        subject: object,
        object: person,
      })?.replacement,
    ).toMatchObject({
      predicate: "OWNS",
      subjectNodeId: person.nodeId,
      objectNodeId: object.nodeId,
    });

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "Taylor owns the notebook.",
        subject: person,
        object,
      })?.replacement,
    ).toMatchObject({
      predicate: "OWNS",
      subjectNodeId: person.nodeId,
        objectNodeId: object.nodeId,
      });

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "The community chapter is owned by the studio.",
        subject: chapter,
        object: studio,
      })?.replacement,
    ).toMatchObject({
      predicate: "OWNS",
      subjectNodeId: studio.nodeId,
      objectNodeId: chapter.nodeId,
    });

    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "OWNED_BY",
        statement: "The task is owned by a mood.",
        subject: task,
        object: emotion,
      })?.replacement,
    ).toMatchObject({
      predicate: "RELATED_TO",
      subjectNodeId: task.nodeId,
      objectNodeId: emotion.nodeId,
    });
  });

  it("returns no proposal when an invalid shape cannot be repaired deterministically", () => {
    expect(
      proposeRelationshipPredicateShapeRepair({
        claimId: newTypeId("claim"),
        predicate: "LOCATED_IN",
        statement: "Taylor likes the notebook.",
        subject: node("Person"),
        object: node("Object"),
      }),
    ).toBeNull();
  });
});
