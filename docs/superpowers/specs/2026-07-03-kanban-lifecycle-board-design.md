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

A card remains **one session**. Regular sessions can share a worktree and
branch, so repository telemetry describes card context but does not establish
that a particular session performed the work.

## Columns (derived, not stored)

| Column | Tone | Membership |
|---|---|---|
| Idle | neutral | live session, no agent lifecycle activity |
| Working | accent (pulse) | a known agent or chat run is working |
| Waiting | warning (amber highlight) | `status === "needs_input"` or `status === "failed"` (failed cards keep a red accent) |
| Review | success | an agent turn completed and still needs acknowledgement |
| Done | neutral | a matching PR completed after the latest user request, or manually pinned done |

Derivation precedence (first match wins):

1. `needs_input` | `failed` → **Waiting**
2. known agent/chat `running` → **Working**
3. manual done pin → **Done**
4. PR completion timestamp ≥ latest user request → **Done**
5. completed agent turn → **Review**
6. otherwise → **Idle**

The stage is a pure function `deriveKanbanStage(session, {pr, manualDone})` in
`src/lib/kanbanLifecycle.ts`. Column order/count lives there as
the single source of truth (mirrors the existing `kanbanBoard.ts` pattern).

## Data plumbing

- **PRs:** reuse `rightPanelCache.fetchPullRequests(repoPath, "all", 50)`,
  polled every 60 s per distinct `repo_path`. Direct matches use
  `head_branch === session.branch`; once observed, the PR branch is retained
  per session so checking out the base branch after merge does not sever the
  card's PR identity. PR observation stays mounted at the workspace level in
  both Panes and Kanban modes; only diff polling is Kanban-only. `closedAt` /
  `mergedAt` must not predate the latest real user request. Provider cleanup
  and final output from the same turn may land after merge without reopening
  the card, while a later user request returns it to Review. Non-GitHub repos
  degrade gracefully (listing kind `not_github` → no PR context).
- **Diff:** `api.fsGitStatus(worktree_path)` per board-visible session, polled
  every 20 s, paused while `document.hidden`. Produces `hasDiff` and summed
  `+additions/−deletions` for the card chip without moving the card between
  lifecycle columns.
- **Dwell time:** client-side tracker maps sessionId → {stage, since}. Resets
  when the derived stage changes. In-memory only (v1); survives project
  switches within the session, not app restarts.
- **Stall:** terminal Working cards with no live process for ≥ 5 minutes show a
  stall badge. Chat runs do not expose their provider process through the PTY
  process list and are excluded.

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
