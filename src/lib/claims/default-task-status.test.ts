import {
  DEFAULT_TASK_STATUS,
  DEFAULT_TASK_STATUS_KIND,
  defaultTaskStatusStatement,
} from "./default-task-status";
import { describe, expect, it } from "vitest";
import { TaskStatusEnum } from "~/types/graph";

describe("default-task-status", () => {
  it("defaults to a canonical open status in the candidate band", () => {
    // `pending` must be a real TaskStatusEnum value (the open-commitments read
    // model and createClaim both validate against it) and an *open* one so the
    // recovered task actually surfaces.
    expect(TaskStatusEnum.options).toContain(DEFAULT_TASK_STATUS);
    expect(DEFAULT_TASK_STATUS).toBe("pending");
    // `assistant_inferred` is what routes a recovered task into the candidate
    // band rather than asserting it as a firm commitment.
    expect(DEFAULT_TASK_STATUS_KIND).toBe("assistant_inferred");
  });

  it("builds a readable statement, falling back when the label is null", () => {
    expect(defaultTaskStatusStatement("Send the spec")).toBe(
      "Send the spec is pending.",
    );
    expect(defaultTaskStatusStatement(null)).toBe("Task is pending.");
  });
});
