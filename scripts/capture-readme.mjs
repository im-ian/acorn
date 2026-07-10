#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const SCENES = [
  "workspace",
  "kanban",
  "pr-modal",
  "chat-session",
  "control-session",
  "staged-diff",
  "agent-history",
  "work-summary",
  "command-palette",
];

function usage() {
  console.log(`Usage:
  pnpm run capture:readme [-- all|scene...] [options]

Scenes:
  ${SCENES.join(", ")}

Options:
  --list             Print available scenes.
  --out <dir>        Output directory. Default: assets/screenshots
  --headed           Show the browser while capturing.
  --port <port>      Vite port. Default: 1421
  --help             Print this help.

Examples:
  pnpm run capture:readme
  pnpm run capture:readme -- workspace kanban pr-modal chat-session staged-diff
  pnpm run capture:readme -- --out /tmp/acorn-captures --headed
  pnpm run capture:readme -- --port 1425
`);
}

const requestedScenes = [];
let outDir = "assets/screenshots";
let headed = false;
let port = "";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--") {
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--list") {
    console.log(SCENES.join("\n"));
    process.exit(0);
  }
  if (arg === "--out") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("--out requires a directory");
      process.exit(2);
    }
    outDir = value;
    i += 1;
    continue;
  }
  if (arg === "--headed") {
    headed = true;
    continue;
  }
  if (arg === "--port") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("--port requires a numeric port");
      process.exit(2);
    }
    port = value;
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) {
    console.error(`Unknown option: ${arg}`);
    usage();
    process.exit(2);
  }
  requestedScenes.push(arg);
}

if (!outDir) {
  console.error("--out requires a directory");
  process.exit(2);
}
if (port && !/^\d+$/.test(port)) {
  console.error("--port requires a numeric port");
  process.exit(2);
}

const scenes =
  requestedScenes.length === 0 || requestedScenes.includes("all")
    ? SCENES
    : requestedScenes;
const invalidScenes = scenes.filter((scene) => !SCENES.includes(scene));
if (invalidScenes.length > 0) {
  console.error(`Unknown scene(s): ${invalidScenes.join(", ")}`);
  console.error(`Available scenes: ${SCENES.join(", ")}`);
  process.exit(2);
}

const playwrightArgs = [
  "exec",
  "playwright",
  "test",
  "--config",
  "playwright.capture.config.ts",
];
if (headed) playwrightArgs.push("--headed");

const child = spawnSync("pnpm", playwrightArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    ACORN_CAPTURE_SCENES: scenes.join(","),
    ACORN_CAPTURE_DIR: outDir,
    ...(port ? { ACORN_CAPTURE_PORT: port } : {}),
  },
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}
process.exit(child.status ?? 1);
