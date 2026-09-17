import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { MOUSE_PASTE_RESET_CSI } from "./terminalRestorePlan";

function writeAll(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    term.write(data, () => resolve());
  });
}

describe("xterm.js mouse mode transitions", () => {
  function makeTerm(): Terminal {
    return new Terminal({ cols: 40, rows: 12, scrollback: 8 });
  }

  it("DECRST 1000 after DECSET 1002 yields none", async () => {
    const term = makeTerm();
    await writeAll(term, "\x1b[?1002h");
    expect(term.modes.mouseTrackingMode).toBe("drag");
    await writeAll(term, "\x1b[?1000l");
    expect(term.modes.mouseTrackingMode).toBe("none");
    term.dispose();
  });

  it("multi-param SET enables vt200", async () => {
    const term = makeTerm();
    await writeAll(term, "\x1b[?1000;1006h");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    term.dispose();
  });

  it("the respawn reset clears any-motion tracking left by a killed TUI", async () => {
    const term = makeTerm();
    await writeAll(term, "\x1b[?1003;1006h");
    expect(term.modes.mouseTrackingMode).toBe("any");
    await writeAll(term, MOUSE_PASTE_RESET_CSI);
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(term.modes.bracketedPasteMode).toBe(false);
    term.dispose();
  });

  it("RIS clears mouse; DECSTR does not", async () => {
    const term = makeTerm();
    await writeAll(term, "\x1b[?1000h");
    await writeAll(term, "\x1b[!p");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    await writeAll(term, "\x1bc");
    expect(term.modes.mouseTrackingMode).toBe("none");
    term.dispose();
  });
});
