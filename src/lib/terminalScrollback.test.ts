import { describe, expect, it } from "vitest";
import {
  prepareScrollbackForSave,
  shouldRestoreScrollback,
} from "./terminalScrollback";

describe("terminal scrollback restore hygiene", () => {
  const legacyRestoreMarkerText = "— restored from previous session —";

  it("does not restore whitespace-only scrollback", () => {
    expect(shouldRestoreScrollback("\r\n\n   \x1b[0m\r\n")).toBe(false);
  });

  it("does not restore terminal control-only snapshots", () => {
    expect(
      shouldRestoreScrollback(
        "\x1b]0;⠴ acorn • Working\x1b\\\x1b]9;4;3;Working\x1b\\\x1b[2 q\x1b[?25h\x1b7\x1b8",
      ),
    ).toBe(false);
  });

  it("does not restore a shell prompt with no session content", () => {
    expect(
      shouldRestoreScrollback(
        "developer@workstation acorn %     \r\n",
      ),
    ).toBe(false);
  });

  it("removes legacy Acorn restore markers before saving", () => {
    const saved = prepareScrollbackForSave(
      `build ok\r\n\x1b[2m${legacyRestoreMarkerText}\x1b[0m\r\nnext prompt % `,
    );

    expect(saved).not.toContain(legacyRestoreMarkerText);
    expect(saved).toContain("build ok");
  });

  it("drops control-only snapshots before saving", () => {
    expect(prepareScrollbackForSave("\x1b]0;title\x1b\\\x1b[?25h")).toBe("");
  });

  it("keeps styled real output when saving", () => {
    const saved = prepareScrollbackForSave("\x1b[32mDone\x1b[0m\r\n");

    expect(saved).toBe("\x1b[32mDone\x1b[0m\r\n");
  });

  it("keeps real command output restorable", () => {
    const saved = prepareScrollbackForSave(
      "developer@host acorn % npm test\r\nPASS src/lib/foo.test.ts\r\ndeveloper@host acorn % ",
    );

    expect(saved).toContain("PASS src/lib/foo.test.ts");
    expect(shouldRestoreScrollback(saved)).toBe(true);
  });
});
