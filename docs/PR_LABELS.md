# PR labels

Acorn's release pipeline reuses GitHub's auto-generated changelog as the body of `latest.json`'s `notes` field. The Tauri updater plugin then surfaces that text inside the app's About tab and the "What's new" banner.

To keep both the GitHub release page and the in-app changelog tidy, attach **one** of the labels below to every PR you open. The categorisation rules live in [`.github/release.yml`](../.github/release.yml).

## Labels and how they map to the changelog

| Label | Use for | Section in changelog |
| --- | --- | --- |
| `feat` / `feature` | New user-visible feature | 🚀 Features |
| `enhancement` | Improvement to an existing feature | 🚀 Features |
| `fix` / `bugfix` / `bug` | Bug fix | 🐛 Fixes |
| `perf` / `performance` | Performance work with no behaviour change | ⚡ Performance |
| `security` | Security fix or hardening | 🔒 Security |
| `docs` / `documentation` | Docs / README / comments only | 📝 Docs |
| `refactor` / `chore` / `cleanup` | Code restructure or housekeeping with no user-facing change | 🧹 Refactor & chore |
| `branding` | Icon / visual identity / asset swaps | 🧹 Refactor & chore |
| `ci` / `build` / `dependencies` / `deps` | Workflow, build system, or dependency bumps | 🛠️ Build & CI |
| `skip-changelog` | Hide the PR from the changelog entirely | (excluded) |

## How matching works

GitHub scans PRs against the `categories` list in `.github/release.yml` from top to bottom. **First matching label wins**, so a PR labelled both `feat` and `docs` lands under "🚀 Features".

A trailing `*` bucket catches PRs with no recognised label so nothing silently disappears — but unlabelled PRs end up in "🔧 Other changes". Label deliberately.

PRs authored by `dependabot` or `github-actions` are excluded entirely, regardless of label.

## How to apply a label

After opening the PR:

```sh
gh pr edit <pr-number> --add-label feat
```

Or pick the label from the right-hand sidebar on the PR page.

If a PR clearly fits multiple buckets, pick the one that best matches the **user-visible** impact. A bug fix that also tweaks docs is `fix`, not `docs`.

## What about purely internal PRs?

Use `skip-changelog` for repo plumbing that has no user-facing impact (generated files, internal tooling tweaks, label additions, and so on). Excluded PRs still appear on the GitHub release page as a footer link to the auto-generated full diff, but they are kept out of the in-app "What's new" panel.
