import { describe, expect, it } from "vitest";
import {
  createWebglBurstController,
  type WebglAddonHandle,
} from "./terminalWebglBurst";

function harness({
  eligible = true,
  failLoad = false,
  quietMs = 1500,
}: { eligible?: boolean; failLoad?: boolean; quietMs?: number } = {}) {
  let time = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  let nextTimer = 1;
  const swaps: boolean[] = [];
  const disposedAddons: number[] = [];
  let created = 0;
  let contextLossListener: (() => void) | null = null;
  const state = { eligible };

  const controller = createWebglBurstController({
    loadAddon: (): WebglAddonHandle | null => {
      if (failLoad) throw new Error("no gl");
      const id = ++created;
      return {
        dispose: () => disposedAddons.push(id),
        onContextLoss: (listener) => {
          contextLossListener = listener;
          return { dispose: () => (contextLossListener = null) };
        },
      };
    },
    isEligible: () => state.eligible,
    afterSwap: (active) => swaps.push(active),
    quietMs,
    now: () => time,
    setTimeoutFn: (cb, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: time + ms, cb });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
  });

  const advance = (ms: number) => {
    time += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= time) {
        timers.delete(id);
        t.cb();
      }
    }
  };

  return {
    controller,
    advance,
    swaps,
    disposedAddons,
    state,
    createdCount: () => created,
    loseContext: () => contextLossListener?.(),
  };
}

describe("createWebglBurstController", () => {
  it("activates on the first eligible wheel and deactivates after quiet", () => {
    const h = harness();
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(true);
    expect(h.swaps).toEqual([true]);
    h.advance(1500);
    expect(h.controller.isActive()).toBe(false);
    expect(h.swaps).toEqual([true, false]);
    expect(h.disposedAddons).toEqual([1]);
  });

  it("keeps the addon alive while wheels keep arriving", () => {
    const h = harness();
    h.controller.noteWheel();
    for (let i = 0; i < 5; i++) {
      h.advance(1000);
      h.controller.noteWheel();
    }
    expect(h.controller.isActive()).toBe(true);
    expect(h.createdCount()).toBe(1);
    h.advance(1500);
    expect(h.controller.isActive()).toBe(false);
  });

  it("does not activate while ineligible, then activates once eligible", () => {
    const h = harness({ eligible: false });
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(false);
    expect(h.swaps).toEqual([]);
    h.state.eligible = true;
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(true);
  });

  it("composition forces the DOM renderer back immediately", () => {
    const h = harness();
    h.controller.noteWheel();
    h.controller.noteComposition();
    expect(h.controller.isActive()).toBe(false);
    expect(h.swaps).toEqual([true, false]);
    // A later wheel re-activates (eligibility gate is the caller's).
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(true);
  });

  it("a failed load disables the feature for good", () => {
    const h = harness({ failLoad: true });
    h.controller.noteWheel();
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(false);
    expect(h.swaps).toEqual([]);
  });

  it("context loss deactivates and never retries", () => {
    const h = harness();
    h.controller.noteWheel();
    h.loseContext();
    expect(h.controller.isActive()).toBe(false);
    expect(h.swaps).toEqual([true, false]);
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(false);
    expect(h.createdCount()).toBe(1);
  });

  it("dispose tears down without a swap callback", () => {
    const h = harness();
    h.controller.noteWheel();
    h.controller.dispose();
    expect(h.disposedAddons).toEqual([1]);
    expect(h.swaps).toEqual([true]);
    h.controller.noteWheel();
    expect(h.controller.isActive()).toBe(false);
  });
});
