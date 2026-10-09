# Changelog

All notable changes to the roadmap mod. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The major version stays at 0 until the first official release.

## [Unreleased]

### Added

- Tasks have a priority (`p0`–`p3`, `p2` by default) and a type (feature, bug or chore). Claude sets them with `add` or `update`, `next` offers higher-priority work first, and cards show a priority or type that isn't the default.
- Review acts on the pull request. A card shows its PRs with their checks (running, passed or failing). Approving an item whose PR is open asks whether to merge it (`gh pr merge --merge`) or approve only; if the merge fails, the item stays in review. Request changes also posts the note on the PR. Nothing is merged or posted without the person's press.
- The board's header wraps instead of squeezing its counts when the filter and buttons crowd it.
- One branch and one pull request per unit of work handed over. `claim` names the branch to work on (the handed epic's or milestone's, or the task's own). When the unit goes to Review, Claude is told to open its PR, and the `pr` action gives its branch, title and body. The session brief lists each item in review with its PR, or notes it has none yet.
- Commits and pull requests that name an epic or milestone (`E9:`, `M4`, a branch like `e9-agent-coordination`) link to it, as task ids always did. A PR shows on the item it names, on what that item sits in, and on the tasks under it.
- Review happens at the level of the work handed over. Inside a milestone or epic assigned to an agent, tasks close as the agent finishes them, and the milestone or epic itself reads Review once they're all done, until approved on its card or in chat. A task handed over on its own is reviewed by itself. Milestones and epics finished before this keep reading done.
- A Review status between In progress and Done. When an agent sets a task done, it goes to Review. The person approves it on the board (`a`) or sends it back with a note (`c`), which puts Claude back on it. Claude closes a task itself only when told in chat that it's approved (`approved: true`); subagents can't. The session brief lists tasks waiting on review.
- Claims are leases. Every roadmap call by the holder renews its leases, and so does its other tool use (at most every five minutes). A claim whose holder has been silent for 30 minutes goes stale: the card marks it `⌛stale`, the brief and `next` list it, and `claim` takes it over without `force`, logging the takeover.
- Handoff notes: `release` takes a `body` that is kept as a handoff note. It leads the task's detail, shows on the card marked "handoff", and counts as unread. A successful `claim` now answers with the task's detail and linked commits, so an agent starting cold has the context.
- A `plan` action adds a whole tree of items in one call. Each node can carry a `ref`, and other nodes' `blocked_by` can name that ref before the item has an id. The whole tree is checked before anything is written, and the answer maps each ref to its new id.
- A `find` action searches the roadmap by kind, status (rolled up, as the board shows it), assignee (`none` for unassigned), priority, type, labels, subtree (`under`) and text (words searched in titles, descriptions and recent comments).
- Edit a card on the board (`e`): title, a one-line description, due date, labels, priority, type and parent, each saved on Enter. A description of several lines is left to Claude rather than flattened. A due date must be `YYYY-MM-DD`. On a task, edit mode also rewords, drops and adds checklist entries (unchanged entries keep their ticks) and sets what it is blocked by, refusing unknown ids and cycles.
- New items from the board: `n` opens a form for kind, priority, type, parent (open milestones and epics that kind can sit under) and title, and opens the new card. On an open epic or milestone, `n` adds under it.
- A Backlog tab for triage: todo tasks nobody holds, those without a milestone or epic first, then by priority, each with a priority picker and a `→ Claude` button. `v` now steps through Board, Tree and Backlog.
- A board filter (`f`). It reads the same filters as `find`, typed as `@claude #ui p0 bug review under:E3 login`, and applies to the board, tree and backlog (in the tree, an item's parents stay shown). The header shows the active filter with a Clear button.
- Labels (`labels`), related items (`relates_to`, shown on both items) and duplicates (`duplicates`, which closes the duplicate). The card lists them under Links, and `show` lists them in the detail.

- In a git repository that doesn't ignore `.claude/roadmap.db`, the board offers to add it to `.gitignore` (press `g`). A toast mentions it once per project, and "Don't ask again" turns it off for that project. Nothing is written without the person's say-so.

### Fixed

- A task let go while under way (`release`, or Unassign on the board) goes back to todo, so `next` and the backlog offer it to the next agent. Before, it stayed in progress with nobody on it and no agent was offered it again. Blocked and review tasks keep their status.
- A project that never uses the roadmap is left alone: no `.claude/roadmap.db` is created until the first write, and git and gh aren't run there. Before, a user-scope install made an empty database in every folder Claude Code opened.

### Changed

- Handing work to Claude takes a confirm step (on a card or a backlog row), and the `h`, `m` and `u` keys are gone, so a stray key or an extra Enter no longer hands off or reassigns a task. A card never opens with focus on Hand to Claude, and a finished item doesn't offer it.

- The board has five columns, and needs 100 columns of width to lay them side by side (90 before); narrower, they stack.
- Agents can no longer act under the name `user`.

- The card detail's status and action buttons sit in one bar right under the title, in the same place on every card. The current status is marked in the accent color, and epics and milestones show their rolled-up status in the same spot.
- A card reads as labelled sections: Description, Acceptance criteria (with a checked count), Dependencies, Links and Activity. Empty sections are left out, and comments read as messages, set apart from the tracker's own events.
- A card taller than the pane scrolls under its title and bar, with marks for what is above and below.

## 0.4.0 - 2026-10-09

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

[Unreleased]: https://github.com/astrosteveo/unclaude/commits/main
