import {
  isLabelMergeableNodeType,
  LABEL_MERGEABLE_NODE_TYPES,
  NodeTypeEnum,
} from "./graph";
import { describe, expect, it } from "vitest";

describe("isLabelMergeableNodeType", () => {
  it("treats nominal-entity types as mergeable by label", () => {
    for (const nodeType of LABEL_MERGEABLE_NODE_TYPES) {
      expect(isLabelMergeableNodeType(nodeType)).toBe(true);
    }
  });

  it("protects record/occurrence types from label-based merging", () => {
    const protectedTypes = [
      "Task",
      "Event",
      "Idea",
      "Document",
      "Conversation",
      "AssistantDream",
      "Feedback",
      "Atlas",
    ] as const;
    for (const nodeType of protectedTypes) {
      expect(isLabelMergeableNodeType(nodeType)).toBe(false);
    }
  });

  it("partitions every known node type into exactly mergeable or protected", () => {
    // Guards against a new NodeType silently defaulting into one bucket: every
    // enum member must be a deliberate true/false, with no overlap.
    const mergeable = new Set<string>(LABEL_MERGEABLE_NODE_TYPES);
    for (const nodeType of NodeTypeEnum.options) {
      expect(isLabelMergeableNodeType(nodeType)).toBe(mergeable.has(nodeType));
    }
  });

  it("returns false for unknown types", () => {
    expect(isLabelMergeableNodeType("NotARealType")).toBe(false);
    expect(isLabelMergeableNodeType("")).toBe(false);
  });
});
