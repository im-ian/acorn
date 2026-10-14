import { describe, expect, it } from "vitest";
import {
  PREVIOUS_STANDARD_START_WORK_PROMPT,
  STANDARD_START_WORK_PROMPT,
} from "./project-settings";
import {
  TASK_START_WORK_PROMPT,
  planTaskStartWork,
  taskStartWorkTemplate,
} from "./taskStartWork";

describe("planTaskStartWork", () => {
  it("names the branch and session from the task", () => {
    expect(planTaskStartWork({ number: 4, title: "Fix the panel!" })).toMatchObject({
      branch: "task-4-fix-the-panel",
      nameHint: "task-4-fix-the-panel",
      sessionName: "#4 Fix the panel!",
      createIfMissing: true,
      fetchRef: null,
    });
  });
});

describe("taskStartWorkTemplate", () => {
  it("uses the task prompt unless the project customized start work", () => {
    expect(taskStartWorkTemplate(null)).toBe(TASK_START_WORK_PROMPT);
    expect(taskStartWorkTemplate(STANDARD_START_WORK_PROMPT)).toBe(
      TASK_START_WORK_PROMPT,
    );
    expect(taskStartWorkTemplate(PREVIOUS_STANDARD_START_WORK_PROMPT)).toBe(
      TASK_START_WORK_PROMPT,
    );
    expect(TASK_START_WORK_PROMPT).not.toContain("Open that GitHub URL");
    expect(taskStartWorkTemplate("Custom {title}\n\n{body}")).toBe(
      "Custom {title}\n\n{body}",
    );
    expect(TASK_START_WORK_PROMPT).toContain("task #{number}");
    expect(TASK_START_WORK_PROMPT).toContain("{body}");
  });
});
