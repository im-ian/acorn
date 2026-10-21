import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_EXCLUDED_AUTHORS,
  CHANGELOG_EXCLUDED_LABELS,
  addReleaseSectionSummaries,
  composeReleaseNotes,
  formatRecoveredReleaseNotes,
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

describe("formatRecoveredReleaseNotes", () => {
  const pulls = [
    {
      title: "feat(panel): keep project tasks in the Workspace tab",
      url: "https://github.com/im-ian/acorn/pull/984",
      author: "im-ian",
      labels: ["feat"],
    },
    {
      title: "fix(terminal): open a clicked link in one browser tab",
      url: "https://github.com/im-ian/acorn/pull/983",
      author: "im-ian",
      labels: ["fix"],
    },
    {
      title: "chore(release): v1.41.0",
      url: "https://github.com/im-ian/acorn/pull/1000",
      author: "im-ian",
      labels: ["skip-changelog"],
    },
    {
      title: "chore(deps): bump rust",
      url: "https://github.com/im-ian/acorn/pull/989",
      author: "app/dependabot",
      labels: ["dependencies"],
    },
    {
      title: "docs(readme): condense the feature guide",
      url: "https://github.com/im-ian/acorn/pull/981",
      author: "im-ian",
      labels: ["docs"],
    },
  ];

  it("groups commit-subject PRs and drops excluded ones", () => {
    const notes = formatRecoveredReleaseNotes({
      tag: "v1.41.0",
      previousTag: "v1.40.0",
      repo: "im-ian/acorn",
      pulls,
    });

    expect(notes).toBe(
      [
        "## What's Changed",
        "### 🚀 Features",
        "* feat(panel): keep project tasks in the Workspace tab by @im-ian in https://github.com/im-ian/acorn/pull/984",
        "### 🐛 Fixes",
        "* fix(terminal): open a clicked link in one browser tab by @im-ian in https://github.com/im-ian/acorn/pull/983",
        "### 📝 Docs",
        "* docs(readme): condense the feature guide by @im-ian in https://github.com/im-ian/acorn/pull/981",
        "",
        "**Full Changelog**: https://github.com/im-ian/acorn/compare/v1.40.0...v1.41.0",
      ].join("\n"),
    );
    expect(addReleaseSectionSummaries(notes)).toContain(
      "> keep project tasks in the Workspace tab 기능 업데이트가 포함되었어요.<br>",
    );
    expect(addReleaseSectionSummaries(notes)).toContain(
      "> Feature updates: keep project tasks in the Workspace tab.",
    );
  });

  it("uses the same categories as .github/release.yml", () => {
    const yml = readFileSync(".github/release.yml", "utf8");
    const titles = [...yml.matchAll(/^ {4}- title: (.+)$/gm)].map((match) => match[1]);
    const labelBlocks = yml
      .split(/^ {4}- title: /m)
      .slice(1)
      .map((block) => [...block.matchAll(/^ {8}- (.+)$/gm)].map((match) => match[1]));
    const exclude = yml.slice(yml.indexOf("exclude:"), yml.indexOf("categories:"));

    expect(CHANGELOG_CATEGORIES.map((category) => category.title)).toEqual(titles);
    expect(CHANGELOG_CATEGORIES.map((category) => category.labels)).toEqual(
      labelBlocks.map((labels) =>
        labels.map((label) => label.replaceAll('"', "")),
      ),
    );
    for (const label of CHANGELOG_EXCLUDED_LABELS) {
      expect(exclude).toContain(`- ${label}`);
    }
    for (const author of CHANGELOG_EXCLUDED_AUTHORS) {
      expect(exclude).toContain(`- ${author}`);
    }
  });
});
