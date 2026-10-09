# roadmap

A lightweight Jira for Claude Code. Milestones, epics and tasks live in your project. Claude plans them with you, claims tasks before working on them, leaves comments as it goes and marks tasks done. You follow along, and steer, from a board inside Claude Code.

```
◐ T16 Band above the prompt showing the current task @claude ☑1/4 · M2 3/5
```

## Install

In a Claude Code session in your terminal:

```
/plugin install roadmap --marketplace astrosteveo/unclaude
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

**Requires** the `sqlite3` command line tool (`pacman -S sqlite`, `apt install sqlite3`, `dnf install sqlite`, `brew install sqlite`). If `git` and `gh` are available, they're used to link commits and pull requests to tasks.

## Use it

Ask Claude to plan something, for example *"plan the v2 release as milestones, epics and tasks, with a checklist on each task"*, and then:

- **`/roadmap`** opens the board. Columns are Todo, In progress, Blocked and Done, and a Tree tab shows the full hierarchy.
- **Keys:** `t` `p` `b` `d` jump to a column, Enter opens a card, `1`–`4` set its status, `h` hands it to Claude, `m`/`u` assign it to you or unassign it, `x` closes it, and `v` switches between board and tree.
- **Comments** you post on a card reach Claude with your next prompt. A `● N` badge marks cards with comments you haven't read yet.
- **The band** above the prompt shows what an agent is working on. Press it to open that task.

What Claude does with it:

- Gets a short brief at the start of each session (open milestones, its own tasks, anything blocked, and your recent changes), plus a reminder if it has been working without updating its tasks.
- Claims a task before starting it. A claim is refused if someone else holds the task or the task is still waiting on unfinished work, so parallel agents don't collide. Subagents show up by name, such as `explore:find-auth-handlers`.
- Can't mark a task done until every item on its checklist is checked.
- Uses `next` to pick up the next task that's ready to start.
- Puts task ids in commit messages (`T12: ...`). Commits and PRs that name a task show up on it.

## How it's stored

Everything lives in `.claude/roadmap.db` (SQLite) in your project, shared by every Claude Code session and agent working there. Writes are transactions, so concurrent agents don't lose each other's changes. The file is binary, so it belongs in `.gitignore`. If it isn't ignored, the board offers to add it once (press `g`), or you can turn the offer down. The schema is versioned: a newer build of the mod migrates older databases on first use, and an older build refuses a newer database instead of corrupting it.

## Development

```
claude --plugin-dir .                  # run a session with this checkout loaded (hot-reloads on save)
claude plugin validate .               # what the engine sees and would refuse
claude plugin test .                   # unit and UI tests (hooks/*.test.ts)
node --test tests/sql.integration.mjs  # the generated SQL against a real sqlite3
```

CI runs all three on every push to `main` and on pull requests (`.github/workflows/test.yml`).

This roadmap was built by working from itself: its own milestones are in this repo's `.claude/roadmap.db` (not committed).

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
