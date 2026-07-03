#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_SECTION_SUMMARIES = [
  {
    titleRe: /\bFeatures\b/i,
    koSuffix: "기능 업데이트가 포함되었어요.",
    enPrefix: "Feature updates:",
  },
  {
    titleRe: /\bFixes\b/i,
    koSuffix: "문제가 수정되었어요.",
    enPrefix: "Fixes:",
  },
  {
    titleRe: /\bPerformance\b/i,
    koSuffix: "성능 개선이 포함되었어요.",
    enPrefix: "Performance improvements:",
  },
  {
    titleRe: /\bSecurity\b/i,
    koSuffix: "보안 업데이트가 포함되었어요.",
    enPrefix: "Security updates:",
  },
  {
    titleRe: /\bDocs\b/i,
    koSuffix: "문서 업데이트가 포함되었어요.",
    enPrefix: "Documentation updates:",
  },
  {
    titleRe: /\bRefactor\b|\bchore\b/i,
    koSuffix: "내부 정리가 포함되었어요.",
    enPrefix: "Internal cleanup:",
  },
  {
    titleRe: /\bBuild\b|\bCI\b/i,
    koSuffix: "빌드와 CI 업데이트가 포함되었어요.",
    enPrefix: "Build and CI updates:",
  },
  {
    titleRe: /\bOther changes\b/i,
    koSuffix: "기타 변경사항이 포함되었어요.",
    enPrefix: "Other changes:",
  },
];
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const ENTRY_RE = /^\s*[-*]\s+(.+?)\s*$/;
const MAX_SUMMARY_ITEMS = 4;

export function parseStableSemverTag(tag) {
  const match = STABLE_TAG_RE.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableTags(a, b) {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch
  );
}

export function selectCumulativeReleaseTags(tags, currentTag) {
  const current = parseStableSemverTag(currentTag);
  if (!current) return [currentTag];

  const byTag = new Map();
  for (const tag of tags) {
    const parsed = parseStableSemverTag(tag);
    if (parsed) byTag.set(parsed.tag, parsed);
  }
  byTag.set(current.tag, current);

  return [...byTag.values()]
    .filter(
      (tag) =>
        tag.major === current.major &&
        tag.minor === current.minor &&
        tag.patch <= current.patch,
    )
    .sort(compareStableTags)
    .map((tag) => tag.tag);
}

export function previousStableTag(tags, currentTag) {
  const current = parseStableSemverTag(currentTag);
  if (!current) return null;

  const sorted = tags
    .map(parseStableSemverTag)
    .filter((tag) => tag !== null)
    .sort(compareStableTags);
  const index = sorted.findIndex((tag) => tag.tag === current.tag);
  return index > 0 ? sorted[index - 1].tag : null;
}

export function stripGithubGeneratedComments(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*<!--.*-->\s*$/.test(line))
    .join("\n")
    .trim();
}

function releaseSectionSummaryForHeading(line) {
  const match = HEADING_RE.exec(line);
  if (!match) return null;

  const title = match[2];
  return (
    RELEASE_SECTION_SUMMARIES.find((summary) =>
      summary.titleRe.test(title),
    ) ?? null
  );
}

function extractReleaseEntryTitle(line) {
  const match = ENTRY_RE.exec(line);
  if (!match) return null;

  return match[1]
    .replace(/\s+by\s+@\S+\s+in\s+(?:https?:\/\/\S+|#\d+)\s*$/i, "")
    .replace(/\s+\(#\d+\)\s*$/, "")
    .replace(/\s+#\d+\s*$/, "")
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
}

function summarizeReleaseEntries(entries, locale = "ko") {
  const visibleEntries = entries.slice(0, MAX_SUMMARY_ITEMS);
  const hiddenCount = entries.length - visibleEntries.length;
  const visibleSummary = visibleEntries.join(", ");
  if (hiddenCount === 0) return visibleSummary;
  return locale === "en"
    ? `${visibleSummary}, and ${hiddenCount} more`
    : `${visibleSummary} 외 ${hiddenCount}개`;
}

function formatReleaseSectionSummary(entries, summary) {
  return [
    `> ${summarizeReleaseEntries(entries)} ${summary.koSuffix}<br>`,
    `> ${summary.enPrefix} ${summarizeReleaseEntries(entries, "en")}.`,
  ];
}

export function addReleaseSectionSummaries(body) {
  const lines = body.split(/\r?\n/);
  const output = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const summary = releaseSectionSummaryForHeading(line);
    if (!summary) {
      output.push(line);
      i += 1;
      continue;
    }

    let nextHeadingIndex = i + 1;
    while (
      nextHeadingIndex < lines.length &&
      !HEADING_RE.test(lines[nextHeadingIndex])
    ) {
      nextHeadingIndex += 1;
    }

    const contentStart = (() => {
      let index = i + 1;
      while (index < nextHeadingIndex && lines[index].trim().length === 0) {
        index += 1;
      }
      return index;
    })();
    const contentLines = lines.slice(contentStart, nextHeadingIndex);
    const entries = contentLines
      .map(extractReleaseEntryTitle)
      .filter((entry) => entry !== null && entry.length > 0);

    output.push(line);
    if (entries.length > 0) {
      output.push(
        "",
        ...formatReleaseSectionSummary(entries, summary),
      );
      if (contentLines.length > 0) output.push("");
    }
    output.push(...contentLines);
    i = nextHeadingIndex;
  }

  return output.join("\n").trim();
}

function readGitTags() {
  const stdout = execFileSync("git", ["tag", "-l", "v*.*.*"], {
    encoding: "utf8",
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

function generateNotes(repo, tag, previousTag) {
  const args = [
    "api",
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${repo}/releases/generate-notes`,
    "-f",
    `tag_name=${tag}`,
    "--jq",
    ".body",
  ];
  if (previousTag) {
    args.splice(
      args.indexOf("--jq"),
      0,
      "-f",
      `previous_tag_name=${previousTag}`,
    );
  }
  return stripGithubGeneratedComments(
    execFileSync("gh", args, { encoding: "utf8" }),
  );
}

export function composeReleaseNotes(parts) {
  const usableParts = parts
    .map((part) => ({
      tag: part.tag,
      body: addReleaseSectionSummaries(part.body.trim()),
    }))
    .filter((part) => part.body.trim().length > 0);
  if (usableParts.length === 0) return "";
  if (usableParts.length === 1) return usableParts[0].body.trim();

  return usableParts
    .map((part) => `## ${part.tag}\n\n${part.body.trim()}`)
    .join("\n\n");
}

export function buildReleaseNotes({ repo, currentTag, allTags }) {
  const selectedTags = selectCumulativeReleaseTags(allTags, currentTag);
  const allStableTags = [...new Set([...allTags, currentTag])]
    .filter((tag) => parseStableSemverTag(tag) !== null)
    .map(parseStableSemverTag)
    .sort(compareStableTags)
    .map((tag) => tag.tag);

  const parts = [];
  for (const tag of selectedTags) {
    const previousTag = previousStableTag(allStableTags, tag);
    parts.push({ tag, body: generateNotes(repo, tag, previousTag) });
  }

  return composeReleaseNotes(parts.reverse());
}

function main() {
  const repo = process.env.REPO;
  const currentTag = process.env.TAG;
  const output = process.env.OUTPUT ?? "release_notes.md";
  if (!repo || !currentTag) {
    throw new Error("REPO and TAG environment variables are required");
  }

  const notes = buildReleaseNotes({
    repo,
    currentTag,
    allTags: readGitTags(),
  });
  writeFileSync(output, notes, "utf8");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
