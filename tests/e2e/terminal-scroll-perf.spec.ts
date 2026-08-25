import { expect, test, type Page } from "./support";
import type { TauriMock } from "./support";

// Diagnostic probe for the TUI scroll pipeline (#851/#857/#859 follow-up).
// Not a pass/fail regression gate: it drives the real Terminal component in
// Chromium with a mocked PTY and reports numbers for the two halves of a
// scroll tick so we can see which half is slow:
//
//   input  — wheel event → SGR mouse reports → coalesced pty_write count
//   output — full-frame TUI redraw stream → main-thread cost (rAF gaps,
//            long tasks) while xterm's DOM renderer consumes it
//
// Chromium is not WKWebView, so absolute numbers are optimistic; the shape
// (per-frame render cost vs. frame budget) is what we are after.

async function seed(tauri: TauriMock): Promise<void> {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => [
    {
      id: "s-scroll",
      name: "shell",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
  await tauri.handle("pty_spawn", () => null);
  await tauri.handle("pty_subscribe_output", (args: unknown) => {
    const { channel } = args as { channel: { id: number } };
    const w = window as unknown as { __scrollOutputChannelId?: number };
    w.__scrollOutputChannelId = channel.id;
    return 1;
  });
  await tauri.handle("pty_write", (args: unknown) => {
    const w = window as unknown as {
      __ptyWrites?: { t: number; data: string }[];
    };
    w.__ptyWrites = w.__ptyWrites ?? [];
    const { data } = args as { data: string };
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    w.__ptyWrites.push({
      t: performance.now(),
      data: new TextDecoder().decode(bytes),
    });
    return null;
  });
}

async function activateTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /^shell main · Ready$/ }).click();
  await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    (
      window as unknown as { __ptyWrites?: unknown[]; __ptyIndex?: number }
    ).__ptyWrites = [];
  });
}

/** Feed bytes to the app through the mocked pty output Channel. */
async function emitPtyOutput(page: Page, output: string): Promise<void> {
  await page.evaluate((text) => {
    const w = window as unknown as {
      __scrollOutputChannelId?: number;
      __ptyIndex?: number;
      [key: string]: unknown;
    };
    const id = w.__scrollOutputChannelId;
    if (typeof id !== "number") throw new Error("output channel missing");
    const callback = w[`_${id}`] as
      | ((payload: { index: number; message: number[] }) => void)
      | undefined;
    if (!callback) throw new Error("output callback missing");
    w.__ptyIndex = w.__ptyIndex ?? 0;
    callback({
      index: w.__ptyIndex++,
      message: Array.from(new TextEncoder().encode(text)),
    });
  }, output);
}

/** Alt screen + SGR any-motion mouse tracking — Claude Code's REPL modes. */
async function enterTuiMode(page: Page): Promise<void> {
  await emitPtyOutput(page, "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H");
  await page.waitForTimeout(100);
}

test.describe("terminal: TUI scroll perf probe", () => {
  test("input half: wheel burst → mouse reports → pty_write", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await enterTuiMode(page);

    const result = await page.evaluate(async () => {
      const screen = document.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) throw new Error("xterm screen missing");
      const w = window as unknown as {
        __ptyWrites: { t: number; data: string }[];
      };
      w.__ptyWrites = [];
      const dispatchCost: number[] = [];
      const t0 = performance.now();
      // 12 wheel notches over ~180ms, like a fast mouse-wheel run.
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        screen.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 100,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            bubbles: true,
            cancelable: true,
          }),
        );
        dispatchCost.push(performance.now() - start);
        await new Promise((r) => setTimeout(r, 15));
      }
      // Let the microtask coalescer flush.
      await new Promise((r) => setTimeout(r, 100));
      const writes = w.__ptyWrites;
      const reports = writes
        .map((x) => (x.data.match(/\x1b\[<6[45];/g) ?? []).length)
        .reduce((a, b) => a + b, 0);
      return {
        wheelEvents: 12,
        elapsedMs: Math.round(performance.now() - t0),
        ptyWriteInvokes: writes.length,
        mouseReports: reports,
        maxDispatchMs: Math.max(...dispatchCost).toFixed(1),
        avgDispatchMs: (
          dispatchCost.reduce((a, b) => a + b, 0) / dispatchCost.length
        ).toFixed(2),
      };
    });
    console.log("[scroll-perf][input]", JSON.stringify(result));
  });

  test("output half: full-frame redraw stream render cost", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await enterTuiMode(page);

    const result = await page.evaluate(async () => {
      const rows =
        document.querySelectorAll(".xterm-rows > div").length || 24;
      const cols = 120;
      // A Claude-like frame: cursor home, then every row rewritten with
      // color changes. Content shifts per frame so every cell is dirty,
      // matching what scrolling a transcript actually does.
      // Truecolor span every 8 cells plus CJK every few rows, like a
      // syntax-highlighted Claude transcript.
      const frame = (n: number): string => {
        let out = "\x1b[H";
        for (let r = 1; r <= rows; r++) {
          out += `\x1b[${r};1H`;
          let col = 0;
          while (col < cols - 12) {
            // Fixed 12-color truecolor palette: real transcripts reuse a
            // small style set, which is what glyph-atlas caches key on.
            const v = ((r * 31 + col * 7 + n * 13) % 12) * 16;
            out += `\x1b[38;2;${55 + v};${255 - v};${(v * 3) % 255}m`;
            if (r % 4 === 0 && col % 24 === 0) {
              out += "한글텍스트감지"; // 7 wide chars = 14 cells
              col += 14;
            } else {
              let span = "";
              for (let c = 0; c < 8; c++) {
                span += String.fromCharCode(33 + ((col + c + r + n * 7) % 90));
              }
              out += span;
              col += 8;
            }
          }
          out += "\x1b[0m\x1b[K";
        }
        return out;
      };
      const frameBytes = new TextEncoder().encode(frame(0)).length;

      const w = window as unknown as {
        __scrollOutputChannelId?: number;
        __ptyIndex?: number;
        [key: string]: unknown;
      };
      const id = w.__scrollOutputChannelId!;
      const callback = w[`_${id}`] as (payload: {
        index: number;
        message: number[];
      }) => void;

      // Main-thread health while frames stream in.
      const rafGaps: number[] = [];
      let last = performance.now();
      let watching = true;
      const tick = () => {
        const now = performance.now();
        rafGaps.push(now - last);
        last = now;
        if (watching) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const longTasks: number[] = [];
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration);
      });
      obs.observe({ entryTypes: ["longtask"] });

      // 40 frames at 8ms cadence — the Rust flush window under a
      // continuous wheel-driven redraw burst.
      const t0 = performance.now();
      for (let n = 0; n < 40; n++) {
        callback({
          index: w.__ptyIndex!++,
          message: Array.from(new TextEncoder().encode(frame(n))),
        });
        await new Promise((r) => setTimeout(r, 8));
      }
      // Settle: wait for writer + renderer to go quiet.
      await new Promise((r) => setTimeout(r, 400));
      watching = false;
      obs.disconnect();

      const sorted = [...rafGaps].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        rows,
        frameBytes,
        frames: 40,
        streamMs: Math.round(performance.now() - t0 - 400),
        rafGapP50: pct(0.5).toFixed(1),
        rafGapP95: pct(0.95).toFixed(1),
        rafGapMax: Math.max(...rafGaps).toFixed(1),
        longTaskCount: longTasks.length,
        longTaskTotalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
      };
    });
    console.log("[scroll-perf][output]", JSON.stringify(result));
  });

  // Control group: a vim/htop-style TUI that repaints only the few rows
  // that changed. If this stays smooth where the full-frame stream chokes,
  // the bottleneck is per-frame render volume, not the pipeline.
  test("output half: delta redraw stream (vim-like) render cost", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await enterTuiMode(page);

    const result = await page.evaluate(async () => {
      const rows =
        document.querySelectorAll(".xterm-rows > div").length || 24;
      const cols = 120;
      // 3 rows rewritten per frame, plain 16-color spans.
      const frame = (n: number): string => {
        let out = "";
        for (let i = 0; i < 3; i++) {
          const r = 1 + ((n * 3 + i) % rows);
          out += `\x1b[${r};1H\x1b[${31 + ((r + n) % 7)}m`;
          let line = "";
          for (let c = 0; c < cols - 10; c++) {
            line += String.fromCharCode(33 + ((c + r + n * 7) % 90));
          }
          out += line + "\x1b[0m\x1b[K";
        }
        return out;
      };
      const frameBytes = new TextEncoder().encode(frame(0)).length;

      const w = window as unknown as {
        __scrollOutputChannelId?: number;
        __ptyIndex?: number;
        [key: string]: unknown;
      };
      const id = w.__scrollOutputChannelId!;
      const callback = w[`_${id}`] as (payload: {
        index: number;
        message: number[];
      }) => void;

      const rafGaps: number[] = [];
      let last = performance.now();
      let watching = true;
      const tick = () => {
        const now = performance.now();
        rafGaps.push(now - last);
        last = now;
        if (watching) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const t0 = performance.now();
      for (let n = 0; n < 40; n++) {
        callback({
          index: w.__ptyIndex!++,
          message: Array.from(new TextEncoder().encode(frame(n))),
        });
        await new Promise((r) => setTimeout(r, 8));
      }
      await new Promise((r) => setTimeout(r, 400));
      watching = false;

      const sorted = [...rafGaps].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        rows,
        frameBytes,
        frames: 40,
        streamMs: Math.round(performance.now() - t0 - 400),
        rafGapP50: pct(0.5).toFixed(1),
        rafGapP95: pct(0.95).toFixed(1),
        rafGapMax: Math.max(...rafGaps).toFixed(1),
      };
    });
    console.log("[scroll-perf][delta]", JSON.stringify(result));
  });

  test("output half: full-frame stream after a wheel stays on the DOM renderer", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await enterTuiMode(page);

    const result = await page.evaluate(async () => {
      const rows =
        document.querySelectorAll(".xterm-rows > div").length || 24;
      const cols = 120;
      const frame = (n: number): string => {
        let out = "\x1b[H";
        for (let r = 1; r <= rows; r++) {
          out += `\x1b[${r};1H`;
          let col = 0;
          while (col < cols - 12) {
            // Fixed 12-color truecolor palette: real transcripts reuse a
            // small style set, which is what glyph-atlas caches key on.
            const v = ((r * 31 + col * 7 + n * 13) % 12) * 16;
            out += `\x1b[38;2;${55 + v};${255 - v};${(v * 3) % 255}m`;
            if (r % 4 === 0 && col % 24 === 0) {
              out += "한글텍스트감지";
              col += 14;
            } else {
              let span = "";
              for (let c = 0; c < 8; c++) {
                span += String.fromCharCode(33 + ((col + c + r + n * 7) % 90));
              }
              out += span;
              col += 8;
            }
          }
          out += "\x1b[0m\x1b[K";
        }
        return out;
      };

      const w = window as unknown as {
        __scrollOutputChannelId?: number;
        __ptyIndex?: number;
        [key: string]: unknown;
      };
      const id = w.__scrollOutputChannelId!;
      const callback = w[`_${id}`] as (payload: {
        index: number;
        message: number[];
      }) => void;

      const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 100,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      const webglEngaged = !!document.querySelector(".xterm-screen canvas");

      const rafGaps: number[] = [];
      let last = performance.now();
      let watching = true;
      const tick = () => {
        const now = performance.now();
        rafGaps.push(now - last);
        last = now;
        if (watching) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const t0 = performance.now();
      for (let n = 0; n < 40; n++) {
        callback({
          index: w.__ptyIndex!++,
          message: Array.from(new TextEncoder().encode(frame(n))),
        });
        await new Promise((r) => setTimeout(r, 8));
      }
      await new Promise((r) => setTimeout(r, 400));
      watching = false;

      const sorted = [...rafGaps].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        rows,
        webglEngaged,
        frames: 40,
        streamMs: Math.round(performance.now() - t0 - 400),
        rafGapP50: pct(0.5).toFixed(1),
        rafGapP95: pct(0.95).toFixed(1),
        rafGapMax: Math.max(...rafGaps).toFixed(1),
      };
    });
    console.log("[scroll-perf][dom-wheel]", JSON.stringify(result));
    expect(result.webglEngaged).toBe(false);
  });

  test("letter-spacing is unchanged after an alt-screen wheel", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { letterSpacing: 0.5 } }),
      );
    });
    await seed(tauri);
    await activateTerminal(page);
    await enterTuiMode(page);
    await emitPtyOutput(page, "\x1b[1;1Hhello letter spacing");
    await page.waitForTimeout(200);

    const readState = () =>
      page.evaluate(() => {
        const rows = document.querySelector<HTMLElement>(".xterm-rows");
        return {
          letterSpacing: rows ? rows.style.letterSpacing : null,
          canvas: !!document.querySelector(".xterm-screen canvas"),
        };
      });
    const before = await readState();
    expect(before.letterSpacing).not.toBeNull();
    expect(before.letterSpacing).not.toBe("");
    expect(before.canvas).toBe(false);

    await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 100,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await emitPtyOutput(page, "\x1b[H\x1b[2Khello letter spacing");
    await page.waitForTimeout(200);
    const after = await readState();
    expect(after.canvas).toBe(false);
    expect(after.letterSpacing).toBe(before.letterSpacing);
  });

  test("normal-buffer TUI (grok-like) keeps a single DOM copy while scrolling", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    // Mouse tracking only — the buffer stays normal.
    await emitPtyOutput(page, "\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H");
    await page.waitForTimeout(100);

    const frame = (n: number) => {
      let out = "\x1b[H";
      for (let r = 1; r <= 20; r++) {
        out += `\x1b[${r};1H\x1b[3${(r + n) % 8}mgrok row ${r} tick ${n}\x1b[0m\x1b[K`;
      }
      return out;
    };
    await emitPtyOutput(page, frame(0));
    await page.waitForTimeout(100);

    const readState = () =>
      page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(".xterm-viewport");
        const rows = document.querySelector<HTMLElement>(".xterm-rows");
        const rowTexts = Array.from(
          document.querySelectorAll(".xterm-rows > div"),
        )
          .map((el) => (el.textContent ?? "").trim())
          .filter((t) => t.length > 0);
        return {
          scrollHeight: viewport?.scrollHeight ?? 0,
          scrollTop: viewport?.scrollTop ?? 0,
          canvas: !!document.querySelector(".xterm-screen canvas"),
          domRowsVisible: rows
            ? getComputedStyle(rows).display !== "none" &&
              getComputedStyle(rows).visibility !== "hidden"
            : false,
          nonEmptyDomRows: rowTexts.length,
          dupTicks: rowTexts.filter((t) => t.includes("grok row 1 tick"))
            .length,
        };
      });

    const before = await readState();
    expect(before.canvas).toBe(false);

    await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 100,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    for (let n = 1; n <= 10; n++) {
      await emitPtyOutput(page, frame(n));
      await page.waitForTimeout(16);
    }
    const during = await readState();
    await page.waitForTimeout(300);
    const after = await readState();

    console.log(
      "[scroll-perf][grok]",
      JSON.stringify({ before, during, after }),
    );
    expect(during.canvas).toBe(false);
    expect(after.canvas).toBe(false);
    // No redraw frame may leak into scrollback: the viewport must not grow.
    expect(during.scrollHeight).toBe(before.scrollHeight);
    expect(after.scrollHeight).toBe(before.scrollHeight);
    // Exactly one copy of the frame, live in the DOM rows throughout.
    expect(during.domRowsVisible).toBe(true);
    expect(after.dupTicks).toBeLessThanOrEqual(1);
  });
});
