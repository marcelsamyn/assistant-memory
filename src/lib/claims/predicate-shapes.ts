/** Relationship predicate domain/range rules. Common aliases: edge taxonomy, relation ontology, predicate prompt guide. */
import {
  NodeTypeEnum,
  RelationshipPredicateEnum,
  type NodeType,
  type Predicate,
  type RelationshipPredicate,
} from "~/types/graph";

type NodeTypeConstraint = readonly NodeType[] | "any";

interface RelationshipPredicateShape<P extends RelationshipPredicate> {
  predicate: P;
  subjectTypes: NodeTypeConstraint;
  objectTypes: NodeTypeConstraint;
  meaning: string;
  useWhen: string;
}

type RelationshipPredicateShapeMap = {
  [P in RelationshipPredicate]: RelationshipPredicateShape<P>;
};

const EVENT_TYPES = [
  "Event",
  "Conversation",
  "Document",
  "AssistantDream",
] as const satisfies readonly NodeType[];

const ENTITY_TYPES = [
  "Person",
  "Organization",
  "Location",
  "Event",
  "Object",
  "Concept",
  "Media",
  "Feedback",
  "Idea",
  "Task",
] as const satisfies readonly NodeType[];

const OWNER_TYPES = [
  "Person",
  "Organization",
  "Concept",
  "Object",
] as const satisfies readonly NodeType[];

const OWNABLE_TYPES = [
  "Organization",
  "Location",
  "Object",
  "Concept",
  "Media",
  "Atlas",
] as const satisfies readonly NodeType[];

const WORK_OR_PRODUCT_TYPES = [
  "Object",
  "Concept",
  "Media",
  "Document",
  "Task",
] as const satisfies readonly NodeType[];

const SEQUENCE_TYPES = [
  "Event",
  "Task",
  "Temporal",
] as const satisfies readonly NodeType[];

const RECORDABLE_TYPES = [
  "Person",
  "Organization",
  "Location",
  "Event",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Conversation",
  "Atlas",
  "AssistantDream",
  "Document",
  "Feedback",
  "Idea",
  "Task",
] as const satisfies readonly NodeType[];

export const RELATIONSHIP_PREDICATE_SHAPES: RelationshipPredicateShapeMap = {
  PARTICIPATED_IN: {
    predicate: "PARTICIPATED_IN",
    subjectTypes: ["Person"],
    objectTypes: ["Event", "Conversation"],
    meaning: "a person took part in an event or conversation",
    useWhen: "Use for attendance, calls, meetings, trips, classes, and other event participation.",
  },
  OCCURRED_AT: {
    predicate: "OCCURRED_AT",
    subjectTypes: EVENT_TYPES,
    objectTypes: ["Location"],
    meaning: "an event happened at a place",
    useWhen: "Use only for event location, not for where a person lives or where an object belongs.",
  },
  OCCURRED_ON: {
    predicate: "OCCURRED_ON",
    subjectTypes: [...EVENT_TYPES, "Task", "Media", "Object"],
    objectTypes: ["Temporal"],
    meaning: "an event, content item, task, or time-anchored thing happened on a date",
    useWhen: "Use for calendar dates. The object must be a Temporal node such as a day.",
  },
  RECORDED_ON: {
    predicate: "RECORDED_ON",
    subjectTypes: RECORDABLE_TYPES,
    objectTypes: ["Temporal"],
    meaning: "a node or source was recorded, ingested, observed, or created on a date",
    useWhen:
      "Use for graph bookkeeping dates. Do not use when the source text says an event happened; use OCCURRED_ON for real-world occurrence dates.",
  },
  INVOLVED_ITEM: {
    predicate: "INVOLVED_ITEM",
    subjectTypes: EVENT_TYPES,
    objectTypes: ["Object", "Concept", "Media", "Location"],
    meaning: "an event involved a notable non-person item",
    useWhen: "Use for objects, media, tools, places, or concepts that mattered in an event.",
  },
  EXHIBITED_EMOTION: {
    predicate: "EXHIBITED_EMOTION",
    subjectTypes: ["Person"],
    objectTypes: ["Emotion"],
    meaning: "a person expressed or displayed an emotion",
    useWhen: "Use only when the object is an Emotion node such as excitement, frustration, joy, or concern.",
  },
  TAGGED_WITH: {
    predicate: "TAGGED_WITH",
    subjectTypes: "any",
    objectTypes: ["Concept"],
    meaning: "a node has a reusable conceptual tag",
    useWhen: "Use for durable labels or categories, not for arbitrary entities.",
  },
  ASSIGNED_TO: {
    predicate: "ASSIGNED_TO",
    subjectTypes: ["Task"],
    objectTypes: ["Person"],
    meaning: "a task is assigned to a responsible person",
    useWhen:
      "Use for commitments and tasks only. If source text says a person owns a task, model it as Task ASSIGNED_TO Person. Reassignment supersedes the prior assignee.",
  },
  DUE_ON: {
    predicate: "DUE_ON",
    subjectTypes: ["Task"],
    objectTypes: ["Temporal"],
    meaning: "a task is due on a date",
    useWhen: "Use only for task deadlines. The object must be a Temporal date node.",
  },
  PRECEDES: {
    predicate: "PRECEDES",
    subjectTypes: SEQUENCE_TYPES,
    objectTypes: SEQUENCE_TYPES,
    meaning: "one event, task, or time node comes before another",
    useWhen: "Use for explicit ordering or sequence claims.",
  },
  FOLLOWS: {
    predicate: "FOLLOWS",
    subjectTypes: SEQUENCE_TYPES,
    objectTypes: SEQUENCE_TYPES,
    meaning: "one event, task, or time node comes after another",
    useWhen: "Use for explicit ordering or sequence claims.",
  },
  WORKS_AT: {
    predicate: "WORKS_AT",
    subjectTypes: ["Person"],
    objectTypes: ["Organization"],
    meaning: "a person works at an organization",
    useWhen: "Use for employment. Model the employer as an Organization node.",
  },
  FOUNDED: {
    predicate: "FOUNDED",
    subjectTypes: ["Person"],
    objectTypes: ["Organization", "Concept", "Object"],
    meaning: "a person founded an organization, project, or product",
    useWhen: "Use for founder relationships, not ordinary authorship or ownership.",
  },
  CREATED: {
    predicate: "CREATED",
    subjectTypes: ["Person", "Organization", "Concept", "Object"],
    objectTypes: WORK_OR_PRODUCT_TYPES,
    meaning: "an entity created a work, product, document, or artifact",
    useWhen: "Use for authorship, building, producing, or making something.",
  },
  LOCATED_IN: {
    predicate: "LOCATED_IN",
    subjectTypes: ENTITY_TYPES,
    objectTypes: ["Location"],
    meaning: "an entity is located in a place",
    useWhen: "Use only when the object is a Location node.",
  },
  PART_OF: {
    predicate: "PART_OF",
    subjectTypes: "any",
    objectTypes: "any",
    meaning: "one thing is a component, member, section, or period inside another",
    useWhen: "Use for containment or composition, including time rollups such as day to week.",
  },
  USES: {
    predicate: "USES",
    subjectTypes: ENTITY_TYPES,
    objectTypes: ["Object", "Concept", "Media"],
    meaning: "an entity uses a tool, product, service, method, or medium",
    useWhen: "Use for actual usage, not mere mention or viewing.",
  },
  OWNS: {
    predicate: "OWNS",
    subjectTypes: OWNER_TYPES,
    objectTypes: OWNABLE_TYPES,
    meaning: "an owner entity owns or possesses another thing",
    useWhen: "Use owner-to-owned direction. Do not use for task assignment; use ASSIGNED_TO.",
  },
  AFFILIATED_WITH: {
    predicate: "AFFILIATED_WITH",
    subjectTypes: ["Person", "Organization", "Concept", "Object"],
    objectTypes: ["Person", "Organization", "Concept", "Object"],
    meaning: "a loose or former affiliation between entities",
    useWhen: "Use when a more specific predicate such as WORKS_AT, FOUNDED, CREATED, or OWNS does not fit.",
  },
  RELATED_TO: {
    predicate: "RELATED_TO",
    subjectTypes: "any",
    objectTypes: "any",
    meaning: "a durable explicit association with no more specific predicate",
    useWhen: "Use sparingly for meaningful associations that are not events, preferences, ownership, location, dates, employment, creation, usage, or task metadata.",
  },
};

export class InvalidRelationshipPredicateShapeError extends Error {
  readonly predicate: RelationshipPredicate;
  readonly subjectType: NodeType;
  readonly objectType: NodeType;

  constructor(input: {
    predicate: RelationshipPredicate;
    subjectType: NodeType;
    objectType: NodeType;
  }) {
    const shape = RELATIONSHIP_PREDICATE_SHAPES[input.predicate];
    super(
      `Invalid ${input.predicate} relationship shape: ${input.subjectType} -> ${input.objectType}; expected ${formatConstraint(shape.subjectTypes)} -> ${formatConstraint(shape.objectTypes)}`,
    );
    this.name = "InvalidRelationshipPredicateShapeError";
    this.predicate = input.predicate;
    this.subjectType = input.subjectType;
    this.objectType = input.objectType;
  }
}

function formatConstraint(constraint: NodeTypeConstraint): string {
  return constraint === "any" ? "any" : constraint.join(" | ");
}

function allowsNodeType(
  constraint: NodeTypeConstraint,
  nodeType: NodeType,
): boolean {
  return constraint === "any" || constraint.includes(nodeType);
}

export function isRelationshipPredicateShapeAllowed(input: {
  predicate: RelationshipPredicate;
  subjectType: NodeType;
  objectType: NodeType;
}): boolean {
  const shape = RELATIONSHIP_PREDICATE_SHAPES[input.predicate];
  return (
    allowsNodeType(shape.subjectTypes, input.subjectType) &&
    allowsNodeType(shape.objectTypes, input.objectType)
  );
}

export function relationshipPredicateFrom(
  predicate: Predicate,
): RelationshipPredicate | null {
  const parsed = RelationshipPredicateEnum.safeParse(predicate);
  return parsed.success ? parsed.data : null;
}

export function isInvalidRelationshipPredicateClaimShape(input: {
  predicate: Predicate;
  subjectType: NodeType;
  objectType: NodeType | null;
}): boolean {
  const predicate = relationshipPredicateFrom(input.predicate);
  if (predicate === null) return false;
  if (input.objectType === null) return true;
  return !isRelationshipPredicateShapeAllowed({
    predicate,
    subjectType: input.subjectType,
    objectType: input.objectType,
  });
}

export function assertRelationshipPredicateShape(input: {
  predicate: RelationshipPredicate;
  subjectType: NodeType;
  objectType: NodeType;
}): void {
  if (!isRelationshipPredicateShapeAllowed(input)) {
    throw new InvalidRelationshipPredicateShapeError(input);
  }
}

export function formatRelationshipPredicateGuide(): string {
  const rows = RelationshipPredicateEnum.options.map((predicate) => {
    const shape = RELATIONSHIP_PREDICATE_SHAPES[predicate];
    return `- ${predicate}: ${formatConstraint(shape.subjectTypes)} -> ${formatConstraint(shape.objectTypes)}. ${shape.meaning}. ${shape.useWhen}`;
  });

  return `Relationship predicate shape rules:
${rows.join("\n")}

Selection examples:
- Bad: use DUE_ON for a person thanking another person. Good: create a concise Event for the interaction and connect participants with PARTICIPATED_IN, or omit the interaction if it is not durable.
- Bad: use LOCATED_IN for a person liking an object. Good: use HAS_PREFERENCE with a scalar value describing the preference.
- Bad: use EXHIBITED_EMOTION for viewing, reading, browsing, or messaging another account/person. Good: omit incidental activity, or create an Event when the activity is durable enough to remember.
- Bad: use EXHIBITED_EMOTION for an article, document, or media item having a tone. Good: use HAS_ATTRIBUTE with a scalar tone value unless a person expressed the emotion.
- Bad: use OCCURRED_ON to mean a person/object/concept node was created in the graph today. Good: use RECORDED_ON for bookkeeping dates, and OCCURRED_ON only for real-world events or content dates.
- Bad: use Temporal "2026-07-01" OCCURRED_ON Event "product launch". Good: Event "product launch" OCCURRED_ON Temporal "2026-07-01".
- Bad: Event "workshop" PARTICIPATED_IN Person "Alex". Good: Person "Alex" PARTICIPATED_IN Event "workshop".
- Bad: Object "prototype" INVOLVED_ITEM Event "demo". Good: Event "demo" INVOLVED_ITEM Object "prototype".
- Good: Task "send the invoice" ASSIGNED_TO Person "Alex"; Task "send the invoice" DUE_ON Temporal "2026-07-01".
- Good: Person "Alex" OWNS Object "blue bicycle".
- Good: Person "Alex" WORKS_AT Organization "Orchard Labs"; Organization "Orchard Labs" LOCATED_IN Location "Stockholm".
- Good: Person "Alex" AFFILIATED_WITH Organization "Saturday Supper Club" when it is a named informal group.
- Bad: model a company, school, client, club, or named friend group as Person, Concept, or Object. Good: use Organization.
- Bad: model a product, app, project, document, event, or loose topic as Organization. Good: use Object, Concept, Document, Event, or Media unless the source clearly refers to the organization operating it.
- Good RELATED_TO: an article explicitly references a comparable product, and no specific predicate above fits. Do not use RELATED_TO to avoid modeling an event, preference, ownership, date, location, or task assignment.`;
}

export function assertRelationshipPredicateShapeCoverage(): void {
  const shapePredicates = new Set(Object.keys(RELATIONSHIP_PREDICATE_SHAPES));
  for (const predicate of RelationshipPredicateEnum.options) {
    if (!shapePredicates.has(predicate)) {
      throw new Error(`Missing relationship predicate shape for ${predicate}`);
    }
  }
  for (const nodeType of NodeTypeEnum.options) {
    if (nodeType.length === 0) {
      throw new Error("Unexpected empty node type");
    }
  }
}
