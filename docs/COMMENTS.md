# Comment policy

This doc spells out how comments are written in this repo. The short version: **no history, no WHAT restatement, no task/PR references — only non-obvious WHY, in the present tense, current state only.**

## Why a policy

Comments rot. Without a policy they accumulate, each PR adding another "previously did X" or "changed Y to support Z" line, until the comment block reads like a changelog and tells a new reader almost nothing about what the code does *now*.

Git already tracks history. `git log` and `git blame` are authoritative. A comment that duplicates them is dead weight; a comment that contradicts them is actively misleading.

The rule of thumb for every comment in `src/` and `src-tauri/`:

> If a reader who has never seen this codebase landed on this file today, would this comment help them understand what the code does and why? If not, delete it.

## Keep

A comment is worth keeping when **all** of these hold:

- It explains a non-obvious **WHY** — a hidden constraint, a subtle invariant, a workaround for a specific bug in a dependency, a browser/OS quirk, a security reason, a performance reason.
- It is written in the **present tense** and describes **current behavior** as if the code has always been this way.
- It is still accurate. If it drifts out of sync with the code it gates, it must be updated or removed in the same change.

Examples of comments worth keeping:

```rust
// Resolve outside the lock — shell startup can take 50–200ms and
// holding the mutex would serialize concurrent first-time lookups for
// unrelated CLIs.
```

```ts
// On WKWebView the `input` event sometimes arrives BEFORE its keydown,
// so we still treat IME-driven `insertText` as a composition signal.
```

```rust
// SAFETY: `ptr` is non-null, aligned, points to an initialized Widget,
// and no mutable references or mutations exist for its lifetime.
```

These are load-bearing: deleting them would lose information that a future reader cannot reconstruct from the code or the type system alone.

## Drop or rewrite

A comment should be deleted (or rewritten as a clean present-tense WHY) when it matches **any** of these patterns:

### 1. History accumulation

References to past changes, removed code, prior behavior, PR/issue numbers, or dates.

```ts
// BAD
// Previously we used X but switched to Y in PR #51.
// Added in v2.3.
// Removed while the app was offline, or pre-feature debris.
// `--yes` was added in a recent gh release; older installs reject it.

// GOOD
// Older `gh` releases reject `--yes` — pipe the confirmation through
// stdin instead so any "Continue with merge?" prompt is answered without
// depending on a flag the local CLI may not have.
```

### 2. WHAT restatement

The comment paraphrases code that already reads clearly.

```ts
// BAD
// loop over items
for (const item of items) { ... }

// BAD
// returns the user id
function getUserId(...) { ... }
```

If the code is unclear, **rename the variable, function, or type** before reaching for a comment.

### 3. Task or PR context

References to the current task, ticket, caller, or owner.

```ts
// BAD
// used by ChatPanel
// added for the auth flow
// part of refactor X
// kept for backwards-compat with the old chat flow
```

The PR description is the right place for "why this change happened in this PR". The comment is the wrong place — it'll outlive the PR and confuse readers years later.

### 4. "Legacy" / "v1" / "migration" framing

Past-tense framing for code that still runs in production today.

```ts
// BAD
// Commit-message migration: legacy `commitMessage.provider` was
// renamed to `agents.selected` in the multi-provider refactor.

// GOOD
// Older storage stored the agent under `commitMessage.provider`; lift
// it into `agents.selected` so a single selection drives every AI feature.
```

If the migration code is live, describe what it does **now**, not the history it came from.

### 5. "Why we removed X" leftovers

Comments documenting code that no longer exists.

```ts
// BAD
// We removed the retry loop here because it was masking real errors.
```

If the code is gone, the comment goes with it. If a reader needs the rationale, `git log -S "retry"` is the right tool.

### 6. Stale TODO / FIXME / XXX

Unowned, undated TODOs with no ticket and no clear trigger for resolution.

A TODO is acceptable only when:
- It is gated to specific, observable code (e.g. `it.skip(...)` with a TODO above it explaining the platform-specific failure).
- It names a concrete next step ("file an issue", "re-enable once root-caused").
- Its existence is verifiable from the code itself (a skipped test, a feature flag, a fallback branch).

Unfocused `// TODO: clean this up later` lines should be deleted on sight.

## Replacing a rotting comment

When you notice a comment that violates this policy while doing other work, **fix it in the same commit**. Two-line rewrites don't need their own PR. The cost of leaving rotten comments in place is much higher than the cost of a one-line drive-by cleanup.

When rewriting, ask:

1. Is this comment load-bearing? (If no → delete.)
2. Can I rewrite it in the present tense, describing what is true today? (If yes → rewrite.)
3. Is the WHY actually non-obvious? (If no → delete.)

## Doc comments (`///`, JSDoc)

Same rules apply, with one addition: doc comments on exported public surface (types, functions, components) should describe **what callers need to know to use it correctly** — invariants, gotchas, fallback behavior. They should not describe internal implementation.

```ts
// GOOD — caller-facing invariant
/**
 * Distinguishes ordinary terminal sessions from "control" sessions, which
 * (via the `acorn-ipc` CLI) can drive other sessions in the same project.
 * Defaults to `Regular` so existing persisted sessions without this field
 * load cleanly.
 */
export type SessionKind = ...

// BAD — implementation narrative
/**
 * Used to be a boolean before we added the third variant. The check inside
 * Terminal.tsx still falls back to the old behavior for sessions created
 * before v0.4.
 */
```

## What about commit messages and PR descriptions?

Commit messages and PR descriptions are the **right place** for the things that don't belong in code comments:

- "Why this change exists" → commit body.
- "What this PR accomplishes" → PR description.
- "What it replaces" → PR description / commit body.
- "Ticket / issue link" → PR description.

Keep the diff between commit history and code comments sharp. Code answers "what is true right now"; git answers "how did we get here".

## Enforcement

There is no automated gate today; this is a convention. Reviewers should flag comments that violate the policy on every PR, and authors are expected to do drive-by cleanups when they touch nearby code.

If a recurring pattern shows up in review (e.g. PRs keep adding `// previously...` lines), we will revisit and add a `hookify` rule or lint check.
