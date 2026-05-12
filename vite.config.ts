/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const projectRoot: string = process.cwd();

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
      // Anchor worktree ignores to the Vite root (cwd of the running dev
      // server) instead of globbing anywhere. The dev server protects its
      // own root from the `git worktree add` file burst (which would
      // otherwise force a full reload), but when the dev server IS itself
      // running inside a worktree, the unrooted `**/.claude/worktrees/**`
      // also matched the worktree's own `src/` and killed HMR.
      ignored: [
        "**/src-tauri/**",
        resolve(projectRoot, ".claude/worktrees") + "/**",
        resolve(projectRoot, ".acorn/worktrees") + "/**",
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
