# README screenshots

Generate README/GitHub screenshots from an isolated Playwright browser session:

```sh
pnpm run capture:readme
```

The capture run starts Vite, injects the existing Tauri mock, seeds deterministic
project/session/GitHub data, and writes PNGs to `assets/screenshots` by default.
It does not use OS-level screen capture, a real Tauri app profile, a live shell,
or the user's browser profile.

Useful variants:

```sh
pnpm run capture:readme -- --list
pnpm run capture:readme -- workspace pr-modal chat-session staged-diff
pnpm run capture:readme -- --out /tmp/acorn-captures --headed
pnpm run capture:readme -- --port 1425
```

Available scenes:

- `workspace` -> `workspace.png`
- `pr-modal` -> `pr-modal.png`
- `chat-session` -> `chat-session.png`
- `control-session` -> `control-session.png`
- `staged-diff` -> `staged-diff.png`
- `agent-history` -> `agent-history.png`
- `work-summary` -> `work-summary.png`
- `command-palette` -> `command-palette.png`

Use `--out` for review runs when you do not want to overwrite tracked README
assets.
