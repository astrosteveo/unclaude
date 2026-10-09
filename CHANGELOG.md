# Changelog

All notable changes to the roadmap mod. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The card detail's status and action buttons sit in one bar right under the title, in the same place on every card. The current status is marked in the accent color, and epics and milestones show their rolled-up status in the same spot.
- A card reads as labelled sections: Description, Acceptance criteria (with a checked count), Dependencies, Links and Activity. Empty sections are left out, and comments read as messages, set apart from the tracker's own events.
- A card taller than the pane scrolls under its title and bar, with marks for what is above and below.

## [1.0.0] - 2026-10-09

### Added

- Install from the `astrosteveo/unclaude` marketplace: `/plugin install roadmap --marketplace astrosteveo/unclaude`.
- Schema versioning. A newer build migrates an older `roadmap.db` on first use, and an older build refuses a newer database instead of corrupting it.
- MIT license.

### Changed

- The mod lives in its own repository.

## 0.3.0 - 2026-10-09

### Added

- Dependencies: a task can be blocked by other tasks. Claiming waits for them, `next` skips tasks with open blockers, and cycles are refused.
- Acceptance criteria: a checklist on each task. A task can't be marked done while any item is unchecked.
- Commits and pull requests that name a task id (`T12: ...`) show up on that task and roll up to its epic.
- A band above the prompt showing the task an agent is working on. Pressing it opens the task on the board.

## 0.2.0 - 2026-10-09

### Added

- Milestones, epics and tasks in `.claude/roadmap.db` (SQLite), with ids that are never reused.
- Claim, release and comment actions. A claim is refused while someone else holds the task.
- `/roadmap` board with Todo, In progress, Blocked and Done columns, a Tree view, and a detail panel.
- Keyboard navigation: `t` `p` `b` `d` jump to a column, Enter opens a card, `1`–`4` set status, `h` hands it to Claude, `m`/`u` assign, `x` closes.
- A session brief for Claude at the start of each session, and a nudge when it works without updating its tasks.
- Comments the user posts on a card reach Claude with the next prompt, and a `● N` badge marks unread comments.
- Subagents get stable, readable names such as `explore:find-auth-handlers`.
- A clear error, with install commands, when `sqlite3` is missing.

[Unreleased]: https://github.com/astrosteveo/unclaude/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/astrosteveo/unclaude/releases/tag/v1.0.0
