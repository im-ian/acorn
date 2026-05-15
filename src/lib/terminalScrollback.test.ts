import { describe, expect, it } from "vitest";
import {
  prepareScrollbackForSave,
  RESTORE_MARKER_TEXT,
  shouldRestoreScrollback,
} from "./terminalScrollback";

describe("terminal scrollback restore hygiene", () => {
  it("does not restore whitespace-only scrollback", () => {
    expect(shouldRestoreScrollback("\r\n\n   \x1b[0m\r\n")).toBe(false);
  });

  it("does not restore a shell prompt with no session content", () => {
    expect(
      shouldRestoreScrollback(
        "jthefloor@jthefloorui-MacBookPro acorn %     \r\n",
      ),
    ).toBe(false);
  });

  it("removes Acorn restore markers before saving", () => {
    const saved = prepareScrollbackForSave(
      `build ok\r\n\x1b[2m${RESTORE_MARKER_TEXT}\x1b[0m\r\nnext prompt % `,
    );

    expect(saved).not.toContain(RESTORE_MARKER_TEXT);
    expect(saved).toContain("build ok");
  });

  it("keeps real command output restorable", () => {
    const saved = prepareScrollbackForSave(
      "jthefloor@host acorn % npm test\r\nPASS src/lib/foo.test.ts\r\njthefloor@host acorn % ",
    );

    expect(saved).toContain("PASS src/lib/foo.test.ts");
    expect(shouldRestoreScrollback(saved)).toBe(true);
  });
});
