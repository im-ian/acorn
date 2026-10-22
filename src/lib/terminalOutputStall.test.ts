import { describe, expect, it } from "vitest";
import {
  createOutputStallDetector,
  takeTerminalRecoveryBudget,
} from "./terminalOutputStall";

describe("createOutputStallDetector", () => {
  it("flags a write that stays in flight for the threshold", () => {
    const detector = createOutputStallDetector(3);
    const stuck = { writing: true, completed: 7, visible: true };

    expect(detector.tick(stuck)).toBe(false); // first sight of write 7
    expect(detector.tick(stuck)).toBe(false);
    expect(detector.tick(stuck)).toBe(false);
    expect(detector.tick(stuck)).toBe(true);
    // Reported once; a skipped recovery must not retry every second.
    expect(detector.tick(stuck)).toBe(false);
    expect(detector.tick(stuck)).toBe(false);
    // The next stuck write is reported again.
    detector.tick({ writing: true, completed: 8, visible: true });
    for (let i = 0; i < 2; i++) detector.tick({ writing: true, completed: 8, visible: true });
    expect(detector.tick({ writing: true, completed: 8, visible: true })).toBe(true);
  });

  it("resets when writes keep completing or the writer goes idle", () => {
    const detector = createOutputStallDetector(2);

    for (let completed = 0; completed < 10; completed++) {
      expect(detector.tick({ writing: true, completed, visible: true })).toBe(
        false,
      );
    }
    detector.tick({ writing: true, completed: 10, visible: true });
    detector.tick({ writing: true, completed: 10, visible: true });
    expect(detector.tick({ writing: false, completed: 10, visible: true })).toBe(
      false,
    );
    expect(detector.tick({ writing: true, completed: 10, visible: true })).toBe(
      false,
    );
  });

  it("does not count ticks while the window is hidden", () => {
    const detector = createOutputStallDetector(2);
    detector.tick({ writing: true, completed: 1, visible: true });

    for (let i = 0; i < 20; i++) {
      expect(detector.tick({ writing: true, completed: 1, visible: false })).toBe(
        false,
      );
    }
    expect(detector.tick({ writing: true, completed: 1, visible: true })).toBe(
      false,
    );
    expect(detector.tick({ writing: true, completed: 1, visible: true })).toBe(
      true,
    );
  });
});

describe("takeTerminalRecoveryBudget", () => {
  it("allows three recoveries per session in five minutes", () => {
    const t0 = 1_000_000;
    expect(takeTerminalRecoveryBudget("budget-a", t0)).toBe(true);
    expect(takeTerminalRecoveryBudget("budget-a", t0 + 1)).toBe(true);
    expect(takeTerminalRecoveryBudget("budget-a", t0 + 2)).toBe(true);
    expect(takeTerminalRecoveryBudget("budget-a", t0 + 3)).toBe(false);
    expect(takeTerminalRecoveryBudget("budget-b", t0 + 3)).toBe(true);
    expect(takeTerminalRecoveryBudget("budget-a", t0 + 5 * 60_000 + 1)).toBe(
      true,
    );
  });
});
