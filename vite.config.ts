/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and worktree checkout
      //    directories. Without the worktree excludes, running `claude -w`
      //    (or any tool that calls `git worktree add` under the project
      //    root) checks out hundreds of files at once into
      //    `.claude/worktrees/<name>/...` or `.acorn/worktrees/<name>/...`,
      //    which Vite cannot reconcile via HMR and falls back to a full
      //    page reload — showing as a white-flash "acorn restarted itself"
      //    in dev. Production isn't affected because there's no dev server.
      ignored: [
        "**/src-tauri/**",
        "**/.claude/worktrees/**",
        "**/.acorn/worktrees/**",
      ],
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
}));
