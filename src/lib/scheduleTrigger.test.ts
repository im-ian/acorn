import { describe, expect, it } from "vitest";
import {
  dueScheduleSlotMs,
  isScheduleDue,
  nextScheduleRunAt,
  scheduleRunTimeLabel,
} from "./scheduleTrigger";
import type { ProjectSchedule, ScheduleTrigger } from "./types";

function at(iso: string): number {
  return new Date(iso).getTime();
}

function schedule(
  trigger: ScheduleTrigger,
  overrides: Partial<ProjectSchedule> = {},
): ProjectSchedule {
  return {
    id: "s1",
    name: "Nightly",
    prompt: "check things",
    trigger,
    mode: "session",
    background: false,
    created_at: "2026-01-01T00:00:00Z",
    last_run_at: null,
    last_slot_at: null,
    runs: [],
    ...overrides,
  };
}

describe("nextScheduleRunAt", () => {
  it("adds the interval to the anchor", () => {
    const from = at("2026-01-01T10:00:00");
    expect(
      nextScheduleRunAt({ kind: "interval", every_minutes: 90 }, from),
    ).toBe(from + 90 * 60_000);
  });

  it("clamps a nonsense interval to one minute", () => {
    const from = at("2026-01-01T10:00:00");
    expect(nextScheduleRunAt({ kind: "interval", every_minutes: 0 }, from)).toBe(
      from + 60_000,
    );
  });

  it("picks today's time when it is still ahead", () => {
    const next = nextScheduleRunAt(
      { kind: "daily", time: "18:30" },
      at("2026-03-10T09:00:00"),
    );
    expect(next).toBe(at("2026-03-10T18:30:00"));
  });

  it("rolls a daily trigger to tomorrow once the time has passed", () => {
    const next = nextScheduleRunAt(
      { kind: "daily", time: "08:00" },
      at("2026-03-10T08:00:00"),
    );
    expect(next).toBe(at("2026-03-11T08:00:00"));
  });

  it("walks a weekly trigger to the next matching weekday", () => {
    // 2026-03-10 is a Tuesday; weekday 5 is Friday.
    const next = nextScheduleRunAt(
      { kind: "weekly", weekday: 5, time: "07:15" },
      at("2026-03-10T09:00:00"),
    );
    expect(next).toBe(at("2026-03-13T07:15:00"));
  });

  it("skips a full week when the weekly slot just passed", () => {
    const next = nextScheduleRunAt(
      { kind: "weekly", weekday: 2, time: "09:00" },
      at("2026-03-10T09:00:00"),
    );
    expect(next).toBe(at("2026-03-17T09:00:00"));
  });
});

describe("isScheduleDue", () => {
  it("measures from creation until the first run lands", () => {
    const created = "2026-01-01T00:00:00.000Z";
    const item = schedule(
      { kind: "interval", every_minutes: 30 },
      { created_at: created },
    );
    expect(isScheduleDue(item, Date.parse(created) + 29 * 60_000)).toBe(false);
    expect(isScheduleDue(item, Date.parse(created) + 30 * 60_000)).toBe(true);
  });

  it("measures from the last consumed slot once one exists", () => {
    const item = schedule(
      { kind: "interval", every_minutes: 30 },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        last_slot_at: "2026-01-01T05:00:00.000Z",
      },
    );
    expect(isScheduleDue(item, at("2026-01-01T05:20:00.000Z"))).toBe(false);
    expect(isScheduleDue(item, at("2026-01-01T05:30:00.000Z"))).toBe(true);
  });

  it("ignores when a run actually happened", () => {
    // A manual "Run now" stamps `last_run_at` and nothing else. The timer must
    // keep its own cadence, or pressing a button silently reschedules it.
    const item = schedule(
      { kind: "interval", every_minutes: 30 },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        last_slot_at: "2026-01-01T05:00:00.000Z",
        last_run_at: "2026-01-01T05:29:00.000Z",
      },
    );
    expect(isScheduleDue(item, at("2026-01-01T05:30:00.000Z"))).toBe(true);
  });

  it("fires once for a slot missed while the app was closed", () => {
    const item = schedule(
      { kind: "daily", time: "09:00" },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        last_slot_at: new Date(at("2026-03-01T09:00:00")).toISOString(),
      },
    );
    expect(isScheduleDue(item, at("2026-03-10T12:00:00"))).toBe(true);
  });

  it("stays idle when the timestamps cannot be parsed", () => {
    const item = schedule(
      { kind: "daily", time: "09:00" },
      { created_at: "not-a-date" },
    );
    expect(isScheduleDue(item, Date.now())).toBe(false);
  });
});

describe("scheduleRunTimeLabel", () => {
  it("renders the run's local wall-clock time", () => {
    expect(scheduleRunTimeLabel(new Date(2026, 2, 10, 9, 5).toISOString())).toBe(
      "03/10 09:05",
    );
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(scheduleRunTimeLabel("not-a-date")).toBe("");
  });
});

describe("dueScheduleSlotMs", () => {
  it("returns the exact slot, not the moment it was noticed", () => {
    const item = schedule(
      { kind: "interval", every_minutes: 10 },
      { last_slot_at: new Date(at("2026-03-10T09:00:00")).toISOString() },
    );
    // Noticed 40s late by the 60s tick; the slot it consumes is still 09:10.
    expect(dueScheduleSlotMs(item, at("2026-03-10T09:10:40"))).toBe(
      at("2026-03-10T09:10:00"),
    );
  });

  it("does not drift across a run of slots", () => {
    // Feed each consumed slot back as the cursor the way the tick does, but
    // always notice it 40s late. Anchoring on the slot keeps the sequence
    // exact; anchoring on the launch time would slide by 40s every period.
    let cursor = at("2026-03-10T09:00:00");
    const fired: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const item = schedule(
        { kind: "interval", every_minutes: 10 },
        { last_slot_at: new Date(cursor).toISOString() },
      );
      const slot = dueScheduleSlotMs(item, cursor + 10 * 60_000 + 40_000);
      expect(slot).not.toBeNull();
      fired.push(slot!);
      cursor = slot!;
    }
    expect(fired).toEqual([
      at("2026-03-10T09:10:00"),
      at("2026-03-10T09:20:00"),
      at("2026-03-10T09:30:00"),
      at("2026-03-10T09:40:00"),
      at("2026-03-10T09:50:00"),
    ]);
  });

  it("skips to the latest missed slot instead of replaying every one", () => {
    const item = schedule(
      { kind: "interval", every_minutes: 10 },
      { last_slot_at: new Date(at("2026-03-10T09:00:00")).toISOString() },
    );
    // Closed for three hours: resume in step at 12:00, not back at 09:10.
    expect(dueScheduleSlotMs(item, at("2026-03-10T12:05:00"))).toBe(
      at("2026-03-10T12:00:00"),
    );
  });

  it("is null before the slot arrives", () => {
    const item = schedule(
      { kind: "interval", every_minutes: 10 },
      { last_slot_at: new Date(at("2026-03-10T09:00:00")).toISOString() },
    );
    expect(dueScheduleSlotMs(item, at("2026-03-10T09:09:59"))).toBeNull();
  });

  it("keeps daily slots on their wall-clock time after a long gap", () => {
    const item = schedule(
      { kind: "daily", time: "09:00" },
      { last_slot_at: new Date(at("2026-03-01T09:00:00")).toISOString() },
    );
    expect(dueScheduleSlotMs(item, at("2026-03-10T12:00:00"))).toBe(
      at("2026-03-10T09:00:00"),
    );
  });
});
