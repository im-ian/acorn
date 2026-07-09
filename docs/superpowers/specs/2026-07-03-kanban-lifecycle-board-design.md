# Kanban Lifecycle Board — Design Spec

**Date:** 2026-07-03
**Status:** Approved (design conversation, this session)

## Problem

The current workspace kanban is a *status board*, not a kanban: columns mirror the
instantaneous `SessionStatus` (`idle`/`running`/`needs_input`/`failed`/`completed`),
so cards teleport between columns as the agent flips state. There is no
left-to-right flow, no notion of work leaving the board, and no "what needs me
next" signal. Comparable tools (kanban-code, Vibe Kanban, Nimbalyst) converge on
lifecycle columns driven by agent + PR events.

## Goals

1. Columns represent a work lifecycle, and cards progress left → right.
2. The board surfaces attention: "Waiting" is the single column that means
   *your turn*.
3. Cards carry harness telemetry: diff size, PR + CI state, time in column,
   stall detection.
4. Light control from the board: quick-reply into a waiting session, mark a
   card done.

Non-goals (v1): a task entity separate from sessions, drag-and-drop between
columns, queueing/backlog of unstarted prompts, token/cost metrics.

## Card unit

A card remains **one session**. Acorn already equates session = worktree =
branch, so the session is the natural work item. No backend schema changes.

## Columns (derived, not stored)

| Column | Tone | Membership |
|---|---|---|
| Idle | neutral | live session, no agent activity, nothing to review |
| Working | accent (pulse) | `status === "running"` |
| Waiting | warning (amber highlight) | `status === "needs_input"` or `status === "failed"` (failed cards keep a red accent) |
| Review | success | open PR on the session branch, or turn completed with a dirty worktree |
| Done | neutral | PR merged/closed, or manually pinned done |

Derivation precedence (first match wins):

1. manual done pin → **Done**
2. PR state `MERGED`/`CLOSED` → **Done**
3. `running` → **Working**
4. `needs_input` | `failed` → **Waiting**
5. open PR → **Review**
6. `completed` and worktree has uncommitted diff → **Review**
7. otherwise → **Idle**

The stage is a pure function `deriveKanbanStage(session, {pr, hasDiff,
manualDone})` in `src/lib/kanbanLifecycle.ts`. Column order/count lives there as
the single source of truth (mirrors the existing `kanbanBoard.ts` pattern).

## Data plumbing

- **PRs:** reuse `rightPanelCache.fetchPullRequests(repoPath, "all", 50)`,
  polled every 60 s per distinct `repo_path`, matched to sessions via
  `head_branch === session.branch`. Non-GitHub repos degrade gracefully
  (listing kind `not_github` → no PR context).
- **Diff:** `api.fsGitStatus(worktree_path)` per board-visible session, polled
  every 20 s, paused while `document.hidden`. Produces `hasDiff` and summed
  `+additions/−deletions` for the card chip.
- **Dwell time:** client-side tracker maps sessionId → {stage, since}. Resets
  when the derived stage changes. In-memory only (v1); survives project
  switches within the session, not app restarts.
- **Stall:** Working card with no `updated_at` change for ≥ 5 minutes shows a
  stall badge.

## Card additions

- diff chip `+N −M` (hidden when clean)
- PR chip: `#123` + CI rollup icon (✓/✗/●), click opens the PR detail modal
  (fallback: external URL)
- dwell label: `12m` (time in current column)
- stall badge on Working cards

## Control (harness)

- **Quick-reply** on Waiting cards: inline single-line input; submit sends
  `api.ptyWrite(sessionId, text + "\n")`. Terminal-mode sessions only; chat
  sessions open the chat pane instead.
- **Mark done / Restore:** card context menu toggles a per-project
  `manualDoneSessionIds` pin stored in board prefs. Restoring re-derives the
  natural stage.

## Prefs migration

Board prefs move to storage key `acorn:workspace-kanban:board-prefs:v2`:
column widths keyed by lifecycle stage (old v1 status-keyed widths are
abandoned — defaults apply once), plus `sortMode`, `filterQuery`,
`manualDoneSessionIds`.

## Testing

- `kanbanLifecycle.test.ts`: derivation matrix (each precedence rule + edge
  cases: failed+open PR, completed+clean tree, manual pin overrides), dwell
  tracker transitions.
- `kanbanBoard.test.ts`: prefs v2 read/write/corruption fallbacks.
- `WorkspaceMain.test.tsx`: columns render by stage, waiting badge, chips.

## Phasing

1. Lifecycle lib + prefs v2 (pure logic, tested)
2. Data plumbing (PR/diff/dwell)
3. Board render: columns, tones, chips, attention
4. Quick-reply + manual done
