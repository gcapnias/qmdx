# Issue tracker: beads_rust

Issues and PRDs for this repo live in the local beads_rust tracker, managed with the `br` CLI.

## Rules

- **Never edit `.beads/` files directly** - always use the `br` CLI; direct edits corrupt the SQLite database.
- **Never run bare `bv`** - it opens an interactive TUI and blocks the session; always use `--robot-*` flags (`bv --robot-next`, `bv --robot-triage`, etc.).
- **Always use well-formed markdown** for descriptions.

## Setup

```bash
br version
br init
```

## Conventions

- Resolve the actor at runtime with `ACTOR="${BR_ACTOR:-assistant}"` and pass `--actor "$ACTOR"` to mutating commands.
- Prefer `--json` for structured reads and automation; use `--format toon` when token budget is tight.
- Create issues with `br create`; use `br q` for quick capture.
- Read with `br show {issue-id} --json`; list with `br list --json`, `br ready --json`, or `br blocked --json`.
- Add multiline comments from a file with `br comments add --actor "$ACTOR" {issue-id} --file {path} --json`.
- Update with `br update`; manage labels with `br label add` and `br label remove`.
- Manage dependencies with `br dep add` and verify with `br dep cycles --json`.
- Sync explicitly with `br sync --flush-only` before committing bead state.
- Triage label vocabulary is defined in `triage-labels.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a bead with `br create --actor "$ACTOR" --title "$title" --description "$description"`, including the appropriate type, priority, labels, and dependencies.

## When a skill says "fetch the relevant ticket"

Run `br show {issue-id} --json` and, if discussion matters, `br comments list {issue-id} --json`.
