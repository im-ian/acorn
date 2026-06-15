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

  it("keeps real command output restorable", () => {
    const saved = prepareScrollbackForSave(
      "developer@host acorn % npm test\r\nPASS src/lib/foo.test.ts\r\ndeveloper@host acorn % ",
    );

    expect(saved).toContain("PASS src/lib/foo.test.ts");
    expect(shouldRestoreScrollback(saved)).toBe(true);
  });
});
