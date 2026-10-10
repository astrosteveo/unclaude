# Changelog

All notable changes to the roadmap plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The major version stays at 0 until the first official release.

## [Unreleased]

## [0.7.2] - 2026-10-10

### Changed

- The board's wording is plainer. A claim whose agent stopped working is marked `⌛inactive` (it was `⌛stale`), a card's dependencies say "blocked by", and the comment button's off state reads "With your next prompt".
- Claude's tool replies and descriptions use plainer wording, such as "blocked by" in place of "waits on".
- The summary Claude gets at the start of a session and the activity log use plainer wording, and error messages say "plugin" in place of "mod".
- The plugin's description, the CHANGELOG and the benchmark's messages are rewritten in plain English.

## [0.7.1] - 2026-10-10

### Fixed

- When you close an open card, the focus outline goes back to that card in the list, even when the list is slow to redraw.

## [0.7.0] - 2026-10-10

### Added

- On the board, the whole card under the mouse pointer is highlighted in its column's colour. The tabs no longer show a v: mark.
- With no card open, the list keeps its frame and fills the pane.
- Frames and the divider are highlighted when the mouse pointer is over them, so you can see which one it is on.
- With a card open, the card gets the space it needs and the list gets the rest. You can move the divider between them with k and j.
- From the card of a stacked PR, you can merge the PRs beneath it and then that PR, in order.
- The key hints are shown at the bottom of the pane.
- The mouse wheel scrolls any tab that is longer than the pane, not only an open card.
- Five tabs, in the order work moves through them: Inbox, Plan, Roadmap, Board, Releases.
- The Inbox opens with what needs your attention: work waiting for your review, comments you haven't read, claims whose agent has stopped working, and late work. One press on any of them opens its card.
- You can sort the inbox: turn an item into a task or an epic, add it to existing work as a comment or a checklist entry, or drop it with a reason. If you ask Claude to triage, it proposes a sort before it changes anything.
- In a wide pane, the roadmap is drawn on a timeline: epics are bars filled to show their progress, milestones are markers on their dates, a line marks today, and late work is red. w zooms in around today.
- A Releases tab shows what the next release would include, every version shipped with its notes, which version new installs get, and a Release button that runs ship from the board.
- Finished work shows on its card and row whether it shipped (in vX) or is merged and waiting for the next release. A milestone shows how much of its work has shipped.
- Epics and tasks now name the milestone they target instead of sitting inside it, so the tasks of one epic can target different milestones. A Plan tab lists each milestone with the work that targets it, then Unplanned work with the backlog's controls. It replaces the Tree and Backlog tabs.
- An Inbox for anything to sort later. You add to it with i on the board or /roadmap inbox <text>, and Claude adds to it when it notices something it wasn't asked to do.
- A task can be closed as won't do, with a reason. It keeps its history, but it isn't counted as finished work or included in a release.

### Changed

- On the wide board, a card shows its whole title, up to two lines, with its details on a line below.
- Plan, the Inbox, Releases and the Roadmap list are shown as tables, with a header row above aligned columns.
- On a wide pane, each Board column has its own frame.

### Fixed

- When you open a card, it stays visible in the list above it, and a card under the mouse pointer keeps its colours on a faint highlight.
- On the Releases tab, an expanded version's notes keep their indent and colour when you scroll.
- With a card open, the list and the card fill the pane wherever you put the divider, with no gap.
- With a card open, the list above it scrolls too. The mouse wheel scrolls whichever one is under the pointer, and the one in use has a highlighted outline.
- Scrolling a card or a tab moves one line at a time, counting wrapped lines.

## [0.6.3] - 2026-10-09

### Changed

- Installing the plugin gets the latest release, not whatever has been merged since.

## [0.6.2] - 2026-10-09

### Fixed

- Once a release is tagged and published, ship deletes its release branch, both locally and on origin.

## [0.6.1] - 2026-10-09

### Fixed

- When [Unreleased] is empty, ship writes the release notes from merged work itself instead of refusing.

## [0.6.0] - 2026-10-09

### Added

- Setting a task done can tick its checklist in the same call. Inside an epic or milestone you hold, it then moves straight on to the next ready task.
- claim on an epic or milestone takes the whole unit: you hold it, its first ready task is claimed, and the answer lists every task in it.
- The tree and the timeline show open work first and collapse finished milestones and epics to one line each (▸ expands them). The timeline lines up its dates, bars and counts in columns.
- The pane's header shows tabs and a progress bar, keeps its actions together, and fits in one row on a wide pane (two on a narrow one). Key hints wrap between hints rather than inside one, with the most useful first.
- The board's Done column shows the last week's work. Press · show all, beside its heading, to see the rest.
- In a narrow pane, the board collapses empty columns into one line, and the details on every card row line up in the same columns.
- In a wide pane, the board's columns are sized to their content: empty ones shrink to their heading, and each card takes one line, or a title line and a details line, instead of wrapping unevenly.

### Changed

- The roadmap tool's definition is about 40% smaller, and its answers no longer repeat checklist text or the edit log.
- show on an epic or milestone lists each open task with its description and checklist, so one call returns the whole unit.

### Fixed

- A card open under the board is no longer covered by a long column whose cards wrap onto two lines.
- A roadmap is created only at the top of a git repository. A session opened in a subfolder uses the repository's roadmap. A session opened outside any repository gets an error naming the roadmaps found below it, instead of quietly starting an empty roadmap. The first write says where a new roadmap was created.
- A roadmap database from somewhere else (a cloned repo, an import) can no longer run shell commands through undo. ship makes releases only from an up-to-date main branch. A stack merge that hits an unexpected error stops cleanly instead of blocking later merges.

## [0.5.0] - 2026-10-09

### Added

- A Timeline tab lists milestones by due date, each followed by its epics, with progress bars and how each one stands against its date (*in 11 days*, or *4 days late, 1 open*). Tasks past their due date (their own, or one inherited from their epic or milestone) are marked `⚠late` on the board, and the session brief lists overdue items.
- A `ship` action makes a release in two steps. First it raises the version in the manifests, turns the CHANGELOG's `[Unreleased]` section into that version (dated, with compare and tag links) and opens the release PR. Once that PR is merged and the user confirms (`approved`), it tags the merge and publishes the GitHub release with the version's notes. It refuses a version that isn't higher than the current one, and a first 1.0 unless the user asked for it.
- Mark all read, next to the unread count in the board's header, marks every comment on the board as read. Comments posted after that count as unread again.
- You can run several tasks at once. Pick todo tasks in the Backlog, or press Run its tasks at once on an epic or milestone, and confirm. Each task gets its own git worktree under `.claude/worktrees/`, on a branch named for the task, and its own agent (Claude starts the agents, because agents started by a plugin can't call that plugin's tool). The board shows which agent has each task, and the band above the prompt shows each agent's task and checklist. A task waiting on another starts once that one is done. At most four run at a time, and the queue is kept across a restart.
- You can merge a stack of pull requests from the board. The card of the bottom PR in a stack shows the stack (`#11 ← #12 ← #15`) and a Merge the stack button, which asks you to confirm. The PRs are merged in order: each one above the bottom is moved onto the main branch (`gh pr edit --base`), updated from it (`gh pr update-branch`), and merged only once its checks pass there. The items of each merged PR are approved. If something fails (checks, a conflict, a refused merge), the run stops there and Claude is told why. When the whole stack is merged, Claude is told to update the checkout.
- More of what you do on the board gets to Claude. Ask Claude on a card puts a question about that card in the prompt box for you to finish. On a card an agent holds, a comment can start a turn for the agent right away (*Tells it now* beside the comment field, saved as a setting). Otherwise the comment reaches Claude with your next prompt, as before.
- Tasks carry release notes. A task holds its CHANGELOG line (`note`) and its section (`section`: Added, Changed or Fixed; by default chosen from its type). An agent that sets a task done without a note is asked for one (`-` when none is needed), and the board asks you too when you set a task done. The `pr` body lists the notes by section, and a `changelog` action writes the notes of merged work into `CHANGELOG.md` under `[Unreleased]`, each in its section, newest first, and never twice. Cards show the note, and you can change it in edit mode.
- Backups. When the roadmap has changed, it is saved automatically as JSON to `~/.claude/roadmap-backups/<project>/`, at most every 10 minutes, and the newest 20 are kept. Set `ROADMAP_BACKUP_DIR` to another folder to move them, or to `off` to turn them off. `export` writes the whole roadmap as JSON on request, and `import` restores an export into an empty roadmap, including timelines, read marks and id counters. Exports from an older schema can be imported too.
- Undo. `z` (or Undo in the board's header) reverses your last change: a status, a field, an assignment, a tick, a checklist, labels, links or blockers, a comment, a new item (if nothing is under it), or a removal, which restores the item and everything under it with their timelines. Pressing it again goes further back. Each change in a card's Activity has its own `↶ undo`. Each undo is logged too, with a `↷ redo`. If what an undo would restore has changed since, the undo is refused and changes nothing. Changes logged before this version can't be undone.
- Batch calls. `batch` takes `ops`, a list of any actions, and runs them in order as one call with one answer, all or nothing. The ops are first tried on a copy of the roadmap, and their changes are written in one transaction only if every op succeeded and nobody else wrote in between. An `add` op can carry a `ref` that later ops use in place of its id. `ids` on any action applies the same change to several items.
- Pull requests are easier to see. A row in review shows its PR and checks (`PR #12 ✓`). The card has a line under its buttons with the PR (a link that opens it), its checks, and which branch it merges into (`head → base`).
- When you approve an agent's work on the board, the agent is told right away, in a turn of its own. If its pull request was merged, it updates the checkout (switches to main, pulls, deletes the merged branch, checks stacked PRs). If the merge failed, it gets gh's reason and finds out why. Approving your own work sends no message.
- Tasks have a priority (`p0`–`p3`, `p2` by default) and a type (feature, bug or chore). Claude sets them with `add` or `update`, `next` offers higher-priority work first, and cards show a priority or type that isn't the default.
- Review works on the pull request. A card shows its PRs with their checks (running, passed or failing). When you approve an item whose PR is open, you're asked whether to merge it (`gh pr merge --merge`) or only approve it. If the merge fails, the item stays in review. Request changes also posts your note on the PR. Nothing is merged or posted until you press the button.
- The board's header wraps onto another line instead of squeezing its counts when the filter and buttons don't fit.
- Each unit of work you hand over gets one branch and one pull request. `claim` names the branch to work on (the epic's or milestone's if you handed over one, otherwise the task's own). When the unit goes to Review, Claude is told to open its PR, and the `pr` action gives its branch, title and body. The session brief lists each item in review with its PR, or says it doesn't have one yet.
- Commits and pull requests that name an epic or milestone (`E9:`, `M4`, a branch like `e9-agent-coordination`) are linked to it, as they always were for task ids. A PR shows on the item it names, on the epic or milestone that item is in, and on the tasks under it.
- Review happens at the level of the work you handed over. Inside a milestone or epic assigned to an agent, tasks close as the agent finishes them. Once they're all done, the milestone or epic shows Review until you approve it on its card or in chat. A task handed over on its own is reviewed on its own. Milestones and epics finished before this version still show done.
- A Review status between In progress and Done. When an agent sets a task done, it goes to Review. You approve it on the board (`a`) or send it back with a note (`c`), which puts Claude back to work on it. Claude closes a task itself only when you tell it in chat that the task is approved (`approved: true`); subagents can't. The session brief lists tasks waiting for review.
- Claims time out. Every roadmap call by the holder renews its claims, and so does its other tool use (at most every five minutes). A claim whose holder has done nothing for 30 minutes becomes stale: the card marks it `⌛stale`, the brief and `next` list it, and `claim` can take it over without `force`, logging the takeover.
- Handoff notes: `release` takes a `body` that is kept as a handoff note. It comes first in the task's detail, shows on the card marked "handoff", and counts as unread. A successful `claim` now returns the task's detail and linked commits, so an agent starting with no context gets what it needs.
- A `plan` action adds a whole tree of items in one call. Each node can carry a `ref`, and other nodes' `blocked_by` can name that ref before the item has an id. The whole tree is checked before anything is written, and the answer lists each ref with its new id.
- A `find` action searches the roadmap by kind, status (rolled up, as the board shows it), assignee (`none` for unassigned), priority, type, labels, subtree (`under`) and text (words searched in titles, descriptions and recent comments).
- Edit a card on the board (`e`): title, a one-line description, due date, labels, priority, type and parent, each saved on Enter. A description of several lines can't be edited there, so it isn't flattened to one line; Claude changes it instead. A due date must be `YYYY-MM-DD`. On a task, edit mode also lets you reword, remove and add checklist entries (unchanged entries keep their ticks) and set what the task is blocked by. Unknown ids and cycles are refused.
- Create items from the board: `n` opens a form for kind, priority, type, parent (the open milestones and epics that kind can go under) and title, then opens the new card. On an open epic or milestone, `n` adds the new item under it.
- A Backlog tab for triage lists todo tasks nobody holds, those without a milestone or epic first, then by priority, each with a priority picker and a `→ Claude` button. `v` now switches between Board, Tree and Backlog.
- A board filter (`f`). It takes the same filters as `find`, typed as `@claude #ui p0 bug review under:E3 login`, and applies to the board, tree and backlog (in the tree, an item's parents stay visible). The header shows the active filter with a Clear button.
- Labels (`labels`), related items (`relates_to`, shown on both items) and duplicates (`duplicates`, which closes the duplicate). The card lists them under Links, and `show` lists them in the detail.
- In a git repository that doesn't ignore `.claude/roadmap.db`, the board offers to add it to `.gitignore` (press `g`). A notification mentions it once per project, and "Don't ask again" turns the offer off for that project. Nothing is written unless you agree.

### Fixed

- Approve and merge no longer merges a stacked pull request into the branch under it. The card names the PR under it and says to merge that one first, and offers only Approve until then. The merge confirmation names the branch a PR merges into. Claude's follow-up names the branch the PR was merged into, and says to switch to main only when that branch is main.
- The roadmap tool's description now fits in the 2048 characters the model reads. It was 2598 characters long, so the model never saw the pull request guidance or the working rules (claim before starting, comment on decisions, say why something is blocked). What each action takes is now described on the `action` field.
- The roadmap is found from the project root, even after a shell `cd` moves the session to another folder. Before, the database, git and gh were looked up from the session's current directory, so after a `cd` into a subfolder the tool failed ("unable to open database") and the board showed as empty. After a `cd` back, the next brief showed old changes as new; it no longer does.
- Old activity no longer disappears. The board loaded only the newest 500 activity entries across the whole roadmap, so beyond that, older items lost their timeline and handoff notes, and `find` stopped matching their comments. The board now loads each item's newest 20 entries and its latest handoff note; `show` and `claim` read the item's whole timeline, and `find` searches every comment ever written.
- An `add` or `update` that fails writes nothing. Before, a bad related or duplicate id, or a checklist on an epic, failed after the item was added, so a retry added it twice; and an `update` with a bad blocker or link had already written its other fields.
- A task released while in progress (`release`, or Unassign on the board) goes back to todo, so `next` and the backlog offer it to the next agent. Before, it stayed in progress with nobody assigned, and no agent was offered it again. Blocked and review tasks keep their status.
- A project that never uses the roadmap is left alone: no `.claude/roadmap.db` is created until the first write, and git and gh aren't run there. Before, a user-scope install made an empty database in every folder Claude Code opened.
- A milestone or epic waiting for review shows in the board's Review column, so you can approve it (and merge its pull request) with one press. Before, the board listed only tasks, and you could reach it only from the Tree.

### Changed

- End-to-end tests run the roadmap tool itself (`hooks/register.tsx`) against a real sqlite3 in a temporary project, covering add, plan, claim, update, batch, remove, export and import (`node --test tests/register.e2e.mjs`, also in CI). The code that draws the band moved into `hooks/pane.tsx` so the hooks module can load under Node.
- An open card is shown at the bottom of the pane, under the board (or tree, or backlog), which is fitted into the top part of the pane. Pressing another card replaces the open one; pressing the open card again, or the ✕ on its title row, closes it. A pane too short for both shows only the card, as before.
- A card in review offers Approve and Request changes, and no longer offers Hand to Claude, which only sent the original request again.
- Rolled-up statuses and item lookups are computed once each time the board reads the roadmap, so a board of a couple of thousand items draws in milliseconds. Before, each rolled-up status went through the whole roadmap again.
- An `update` that sets several things (fields, checklist, blockers, labels, links) is written as one transaction in one sqlite3 run, so either all of it is saved or none of it is.
- Handing work to Claude now asks you to confirm (on a card or a backlog row), and the `h`, `m` and `u` keys are removed, so a stray key or an extra Enter no longer hands off or reassigns a task. A card never opens with the focus on Hand to Claude, and finished items don't offer it.
- The board has five columns, and needs a pane 100 columns wide to show them side by side (90 before); in a narrower pane they are stacked.
- Agents can no longer act under the name `user`, in any case (`User`, `USER`).
- The card detail's status and action buttons are in one bar right under the title, in the same place on every card. The current status is marked in the accent color, and epics and milestones show their rolled-up status in the same place.
- A card is laid out in labelled sections: Description, Acceptance criteria (with a count of checked entries), Dependencies, Links and Activity. Empty sections are hidden, and comments are shown as messages, set apart from the events the tracker logs itself.
- A card taller than the pane scrolls below its title and button bar, with markers showing there is more above or below.

## 0.4.0 - 2026-10-09

### Added

- Install from the `astrosteveo/unclaude` marketplace: `/plugin install roadmap --marketplace astrosteveo/unclaude`.
- Schema versions. A newer version of the plugin upgrades an older `roadmap.db` the first time it opens it, and an older version refuses to open a newer database instead of damaging it.
- MIT license.

### Changed

- The plugin now has its own repository.

## 0.3.0 - 2026-10-09

### Added

- Dependencies: a task can be blocked by other tasks. It can't be claimed until they are done, `next` skips tasks with open blockers, and cycles are refused.
- Acceptance criteria: a checklist on each task. A task can't be marked done while any entry is unchecked.
- Commits and pull requests that name a task id (`T12: ...`) show up on that task and on its epic.
- A band above the prompt that shows the task an agent is working on. Pressing it opens the task on the board.

## 0.2.0 - 2026-10-09

### Added

- Milestones, epics and tasks in `.claude/roadmap.db` (SQLite), with ids that are never reused.
- Claim, release and comment actions. A claim is refused while someone else holds the task.
- A `/roadmap` board with Todo, In progress, Blocked and Done columns, a Tree view, and a detail panel.
- Keyboard navigation: `t` `p` `b` `d` jump to a column, Enter opens a card, `1`–`4` set the status, `h` hands the task to Claude, `m`/`u` assign, `x` closes.
- A session brief (a summary of the roadmap) for Claude at the start of each session, and a reminder when Claude works without updating its tasks.
- Comments the user posts on a card reach Claude with the next prompt, and a `● N` badge marks unread comments.
- Subagents get stable, readable names such as `explore:find-auth-handlers`.
- A clear error, with install commands, when `sqlite3` is missing.

[Unreleased]: https://github.com/astrosteveo/unclaude/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/astrosteveo/unclaude/releases/tag/v0.7.2
[0.7.1]: https://github.com/astrosteveo/unclaude/releases/tag/v0.7.1
[0.7.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.7.0
[0.6.3]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.3
[0.6.2]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.2
[0.6.1]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.1
[0.6.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.0
[0.5.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.5.0
