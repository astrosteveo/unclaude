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

- **`/roadmap`** opens the board. Columns are Todo, In progress, Blocked, Review and Done, and a Tree tab shows the full hierarchy.
- **Keys:** `t` `p` `b` `r` `d` jump to a column, Enter opens a card, `1`–`5` set its status, `e` edits it, `x` closes it, `n` adds an item, `f` filters, and `v` steps through board, tree and backlog. Hand to Claude, Assign me and Unassign have no keys on purpose: Tab to them and press Enter (Hand to Claude then asks you to confirm).
- **Backlog** (third tab) is for triage: todo tasks nobody holds, those without an epic first, then by priority. Each row has a priority picker and a `→ Claude` button.
- **New items:** `n` opens a form (kind, priority, type, where it goes, then the title; Enter creates it). On an open epic or milestone, `n` adds under it.
- **Edit** a card with `e`: Tab into its title, description (one line; ask Claude for longer text), due date, labels, priority, type and parent, and press Enter on a field to save it. On a task, edit mode also lists the checklist (reword an entry, or empty it to drop it), an Add criterion field, and Blocked by (task ids, comma-separated). `e` again leaves edit mode.
- **Filter** with `f`: type words to search, or narrow with `@claude` (`@none` for unassigned), `#label`, `p0`–`p3`, `bug`/`feature`/`chore`, a status (`todo`, `wip`, `blocked`, `review`, `done`) or `under:E3`. The filter applies to the board, tree and backlog; Clear removes it.
- **Comments** you post on a card reach Claude with your next prompt. A `● N` badge marks cards with comments you haven't read yet.
- **Review:** you review what you hand over, once. Hand Claude a task and it goes to Review when finished, not Done. Hand it a whole epic or milestone (Hand to Claude on its card, or "implement E27" in chat) and its tasks close as Claude goes; the epic or milestone goes to Review when they're all done. Open the card and press `a` to approve, or `c` to send it back with what needs changing (Claude picks it up again). You can also tell Claude in chat that it's approved.
- **Priority and type:** each task has a priority (`p0` urgent to `p3` can wait, `p2` by default) and a type (feature, bug or chore). Cards show them when they differ from the defaults, with `p0` in red and `p1` in yellow.
- **Labels and links:** tasks can carry labels (`#ui`, `#auth`), relate to other items (shown on both), or be marked a duplicate of another, which closes them. They show in the card's Links section.
- **The band** above the prompt shows what an agent is working on. Press it to open that task.

What Claude does with it:

- Gets a short brief at the start of each session (open milestones, its own tasks, anything blocked, and your recent changes), plus a reminder if it has been working without updating its tasks.
- Claims a task before starting it. A claim is refused if someone else holds the task or the task is still waiting on unfinished work, so parallel agents don't collide. A claim is a lease: the holder's activity keeps it alive, and once an agent has been silent for 30 minutes its claim goes stale (`⌛stale` on the card). Another agent can then take it over, and the takeover is logged. Subagents show up by name, such as `explore:find-auth-handlers`.
- Can't mark a task done until every item on its checklist is checked, and its done goes to Review for you to approve.
- Leaves a handoff note when it lets a task go (`release` with a note). The next agent to claim the task gets the note first, along with the task's description, checklist, recent activity and linked commits, so it can pick up where the last one stopped.
- Plans a whole breakdown in one call (`plan`): milestones, epics and tasks nested as a tree, with checklists, labels and dependencies between the new tasks. The tree is checked in full before anything is written.
- Searches with `find`: by status, assignee (`none` for unassigned), priority, type, labels, a subtree (`under`) or words in titles, descriptions and comments.
- Uses `next` to pick up the next task that's ready to start, highest priority first.
- Works on one branch per unit you hand over, named after it (`e9-agent-coordination`, or `t47-no-stray-hand-offs` for a task on its own). When the unit goes to Review, Claude is told to push the branch and open its pull request, titled with the unit's id, with a body listing its tasks and checklists (the `pr` action gives the branch, title and body).
- Puts task ids in commit messages (`T12: ...`) and epic or milestone ids in PR titles and branches (`E9: ...`, `e9-agent-coordination`). Commits and PRs show up on the items they name.

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
