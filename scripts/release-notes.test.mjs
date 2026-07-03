import { describe, expect, it } from "vitest";
import {
  addReleaseSectionSummaries,
  composeReleaseNotes,
} from "./release-notes.mjs";

describe("addReleaseSectionSummaries", () => {
  it("adds a callout summary above each generated PR list", () => {
    const body = [
      "## What's Changed",
      "### 🚀 Features",
      "* feat(workspace): add kanban workspace mode by @im-ian in https://github.com/im-ian/acorn/pull/507",
      "* feat(settings): macOS permission reset controls by @im-ian in https://github.com/im-ian/acorn/pull/503",
      "### 🐛 Fixes",
      "* fix(status): stop agent sessions getting stuck on Running by @im-ian in https://github.com/im-ian/acorn/pull/516",
      "",
      "**Full Changelog**: https://github.com/im-ian/acorn/compare/v1.20.0...v1.21.0",
    ].join("\n");

    expect(addReleaseSectionSummaries(body)).toBe(
      [
        "## What's Changed",
        "### 🚀 Features",
        "",
        "> add kanban workspace mode, macOS permission reset controls 기능 업데이트가 포함되었어요.<br>",
        "> Feature updates: add kanban workspace mode, macOS permission reset controls.",
        "",
        "* feat(workspace): add kanban workspace mode by @im-ian in https://github.com/im-ian/acorn/pull/507",
        "* feat(settings): macOS permission reset controls by @im-ian in https://github.com/im-ian/acorn/pull/503",
        "### 🐛 Fixes",
        "",
        "> stop agent sessions getting stuck on Running 문제가 수정되었어요.<br>",
        "> Fixes: stop agent sessions getting stuck on Running.",
        "",
        "* fix(status): stop agent sessions getting stuck on Running by @im-ian in https://github.com/im-ian/acorn/pull/516",
        "",
        "**Full Changelog**: https://github.com/im-ian/acorn/compare/v1.20.0...v1.21.0",
      ].join("\n"),
    );
  });

  it("keeps long sections compact with an overflow count", () => {
    const body = [
      "### ⚡ Performance",
      "* perf(one): first update by @im-ian in #1",
      "* perf(two): second update by @im-ian in #2",
      "* perf(three): third update by @im-ian in #3",
      "* perf(four): fourth update by @im-ian in #4",
      "* perf(five): fifth update by @im-ian in #5",
    ].join("\n");

    expect(addReleaseSectionSummaries(body)).toContain(
      "> first update, second update, third update, fourth update 외 1개 성능 개선이 포함되었어요.<br>",
    );
    expect(addReleaseSectionSummaries(body)).toContain(
      "> Performance improvements: first update, second update, third update, fourth update, and 1 more.",
    );
  });
});

describe("composeReleaseNotes", () => {
  it("adds summaries inside each cumulative tag section", () => {
    const notes = composeReleaseNotes([
      {
        tag: "v1.8.2",
        body: "### 🐛 Fixes\n* fix(ui): repair modal spacing by @im-ian in #2",
      },
      {
        tag: "v1.8.1",
        body: "### 🚀 Features\n* feat(ui): add settings shortcut by @im-ian in #1",
      },
    ]);

    expect(notes).toBe(
      [
        "## v1.8.2",
        "",
        "### 🐛 Fixes",
        "",
        "> repair modal spacing 문제가 수정되었어요.<br>",
        "> Fixes: repair modal spacing.",
        "",
        "* fix(ui): repair modal spacing by @im-ian in #2",
        "",
        "## v1.8.1",
        "",
        "### 🚀 Features",
        "",
        "> add settings shortcut 기능 업데이트가 포함되었어요.<br>",
        "> Feature updates: add settings shortcut.",
        "",
        "* feat(ui): add settings shortcut by @im-ian in #1",
      ].join("\n"),
    );
  });
});
