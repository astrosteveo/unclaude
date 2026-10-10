# Changelog

All notable changes to the roadmap mod. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The major version stays at 0 until the first official release.

## [Unreleased]

## [0.7.1] - 2026-10-10

### Fixed

- Closing a docked card puts the focus ring back on that card, even when the list is slow to redraw.

## [0.7.0] - 2026-10-10

### Added

- A board card lights up whole under the mouse, in its column's colour; the tabs no longer show a v: mark.
- With no card open, the list keeps its frame and fills the pane.
- Frames and the divider light up under the mouse pointer, so you can see which one it is over.
- With a card open, the card takes the room it needs and the list the rest; a divider between them moves the split (k/j).
- A stacked PR's card can merge the stack beneath it and then itself, in order.
- The key hints sit at the bottom of the pane.
- The mouse wheel scrolls every tab when it runs longer than the pane, not only an open card.
- Five tabs in the order work lives through them: Inbox, Plan, Roadmap, Board, Releases.
- The Inbox opens on what needs you: work waiting on your review, comments you haven't read, claims gone quiet and late work, each a press from its card.
- Sort the inbox: an item becomes a task or an epic, joins existing work as a comment or a checklist entry, or is dropped with a reason; ask Claude to triage and it proposes before it sorts.
- In a wide pane the roadmap is drawn on a time axis: epics as bars filled by their progress, milestones as markers on their dates, a line for today, and late work in red; w zooms in around today.
- A Releases tab: what the next release would carry, every version shipped with its notes and the one installs get, and a Release button that runs ship from the board.
- Done work says where it went: shipped in vX, or merged and waiting for the next release, on its card and row; a milestone counts how much of it is out.
- Milestones are targets, not containers: epics and tasks point at one, so an epic can span milestones. A Plan tab shows milestones with what targets them, then Unplanned work with the backlog's controls; it replaces the Tree and Backlog tabs.
- An Inbox: file anything to sort later, with i on the board, /roadmap inbox <text>, or by Claude when it notices something it wasn't asked to do.
- A task can be closed as won't do, with a reason: kept with its history, but not counted as finished work or released.

### Changed

- On the wide board a card shows its whole title, up to two lines, with its details on a line beneath.
- Plan, the Inbox, Releases and the Roadmap list read as tables: a header row over aligned columns.
- On a wide pane, each Board column sits in a frame of its own.

### Fixed

- Opening a card keeps it in sight in the list above it, and a hovered card keeps its colours on a faint highlight.
- Releases: an expanded version's notes keep their indent and colour while scrolling.
- With a card docked, the list and the card fill the pane at every split: moving the divider leaves no gap.
- With a card open, the list above it scrolls too: the wheel moves whichever is under the mouse, and the one in use has its outline lit.
- Scrolling a card or a tab moves a line at a time, wrapped lines included.

## [0.6.3] - 2026-10-09

### Changed

- Installing the mod gets the last release, not whatever has merged since.

## [0.6.2] - 2026-10-09

### Fixed

- Once a release is tagged and published, ship deletes its release branch, locally and on origin.

## [0.6.1] - 2026-10-09

### Fixed

- ship writes the release notes of merged work itself when [Unreleased] is empty, instead of refusing.

## [0.6.0] - 2026-10-09

### Added

- Setting a task done can tick its checklist in the same call, and inside an epic or milestone you hold it goes straight on to the next ready task
- claim on an epic or milestone takes it whole: you hold it, its first ready task is claimed, and the answer shows every task in it
- The tree and the timeline lead with open work and fold finished milestones and epics to one line (▸ opens them); the timeline lines its dates, bars and counts up in columns.
- The pane's header reads as tabs with a progress bar, keeps its actions together, and fits in one row on a wide pane (two on a narrow one); key hints wrap between hints, most useful first.
- The board's Done column shows the last week's work, with the rest a press away (· show all beside its heading).
- In a narrow pane the board folds empty columns into one line, and every card row lines its details up in the same columns.
- In a wide pane the board's columns size to their content: empty ones shrink to their heading, and each card reads on one line, or a title line and a details line, instead of wrapping raggedly.

### Changed

- The roadmap tool's definition is about 40% smaller, and its answers no longer repeat checklist text or the edit log
- show on an epic or milestone lists each open task with its description and checklist, so one call holds the whole unit

### Fixed

- A card docked under the board is no longer overlapped by a long column whose cards wrap onto two lines.
- A roadmap is started only at the top of a git repository: a session opened in a subfolder uses the repository's roadmap, and one opened outside any repository is refused instead of quietly starting an empty roadmap, naming the roadmaps it found below. The first write says where a new roadmap was started.
- A roadmap database from elsewhere (a cloned repo, an import) can no longer run shell commands through undo; ship cuts releases only from an up-to-date main line; a stack merge that hits an unexpected error stops cleanly instead of blocking later merges

## [0.5.0] - 2026-10-09

### Added

- A Timeline tab: milestones by due date, each followed by its epics, with progress bars and how each stands against its date (*in 11 days*, or *4 days late, 1 open*). Tasks past their due date, their own or inherited, are marked `⚠late` on the board, and the session brief lists overdue items.
- A `ship` action for releases, in two steps. First it bumps the manifests' version, cuts CHANGELOG `[Unreleased]` as that version (dated, with compare and tag links) and opens the release PR. Once that PR has merged and the user confirms (`approved`), it tags the merge and publishes the GitHub release from the version's notes. A version that isn't higher is refused, and so is a first 1.0 unless the user asked for it.
- Mark all read, by the unread count in the board's header: every comment on the board counts as read, and comments after it count again.
- Run several tasks at once. Pick todo tasks in the Backlog, or press Run its tasks at once on an epic or milestone, and confirm. Each task gets a git worktree of its own under `.claude/worktrees/`, on a branch named for the task, and an agent of its own (Claude starts them, since agents a mod starts can't call its tool). The board shows whose each is, and the band shows each agent's task and checklist. A task waiting on another starts once that one is done, at most four at a time; the queue survives a restart.
- Merge a stack of pull requests from the board. The card of a stack's bottom PR shows the stack (`#11 ← #12 ← #15`) and offers Merge the stack, after a confirm. The PRs merge in order: each one above the bottom is moved onto the main line (`gh pr edit --base`), brought up to date with it (`gh pr update-branch`), and merged only once its checks pass there. The items of each merged PR are approved. A failure (checks, a conflict, a refused merge) stops the run where it is and tells Claude why; a full run tells Claude to bring the checkout up to date.
- More of the board reaches Claude. Ask Claude on a card puts a question about it in the prompt box for you to finish. On a card an agent holds, a comment can start a turn at once (*Tells it now* beside the comment field, kept as a setting); otherwise it reaches Claude with your next prompt, as before.
- Release notes on tasks. A task carries its line for the CHANGELOG (`note`) and its section (`section`: Added, Changed or Fixed; by default from its type). An agent setting a task done without one is asked for it (`-` when none is needed), and the board asks too when you set a task done. The `pr` body lists the notes by section, and a `changelog` action writes the notes of merged work into `CHANGELOG.md` under `[Unreleased]`, each in its section, newest first, never twice. Cards show the note, and edit mode changes it.
- Backups. The roadmap is backed up on its own as JSON to `~/.claude/roadmap-backups/<project>/` when it changed, at most every 10 minutes, keeping the newest 20 (`ROADMAP_BACKUP_DIR` moves them, or `off` turns them off). `export` writes the whole roadmap as JSON on request, and `import` restores an export into an empty roadmap, timelines, read marks and id counters included. An export from an older schema imports too.
- Undo. `z` (or Undo in the board's header) takes back the person's last change: a status, a field, an assignment, a tick, a checklist, labels, links or blockers, a comment, a new item (one with nothing under it), or a removal, which puts back the whole subtree with its timelines. Pressing it again goes further back. Each change in a card's Activity has its own `↶ undo`. An undo is logged too, and has a `↷ redo`. An undo is refused, and changes nothing, when what it would restore has changed since. Changes logged before this version can't be undone.
- Batch calls. `batch` takes `ops`, a list of any actions, and runs them in order as one call with one answer, all or nothing: they are tried first on a copy of the roadmap, and their writes land in one transaction only if every op passed (and nobody wrote in between). An `add` op can carry a `ref` that later ops use in place of its id. `ids` on any action applies the same change to several items the same way.
- An item's pull request is easy to see. A row in review shows its PR and checks (`PR #12 ✓`); the card holds a line under its buttons with the PR (a link to open it), its checks, and where it merges (`head → base`).
- Approving an agent's work on the board tells it at once, in a turn of its own: that its pull request was merged, so it brings the checkout up to date (switches to main, pulls, deletes the merged branch, checks stacked PRs); or that the merge failed, with gh's reason, so it finds out why. Approving your own work stays quiet.
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

- Approve and merge no longer merges a stacked pull request into the branch under it. The card says which PR is under it and to merge that first, and offers Approve only until then; the merge confirm names where a PR merges. Claude's follow-up names the branch it merged into, and says to switch to main only when that is where it went.
- The roadmap tool's description fits the 2048 characters the model reads. It ran to 2598, so the model never saw the pull request guidance or the working rules (claim before starting, comment on decisions, say why something is blocked). What each action takes now sits on the `action` field.
- The roadmap is found from the project root, however far a shell `cd` moved the session. Before, the database, git and gh were looked for from the session's current directory, so after a `cd` into a subfolder the tool failed ("unable to open database") and the board read as empty. Coming back, the next brief replayed old changes as new; it no longer does.
- Old activity no longer drops out of view. The board's snapshot was the newest 500 entries across the whole roadmap, so past that, older items lost their timeline and handoff notes, and `find` stopped matching their comments. The snapshot now carries each item's newest 20 entries and its latest handoff note; `show` and `claim` read the item's whole timeline, and `find` searches every comment ever written.
- An `add` or `update` that fails writes nothing. Before, a bad related or duplicate id, or a checklist on an epic, failed after the item was added, so a retry added it twice; and an `update` with a bad blocker or link had already written its other fields.
- A task let go while under way (`release`, or Unassign on the board) goes back to todo, so `next` and the backlog offer it to the next agent. Before, it stayed in progress with nobody on it and no agent was offered it again. Blocked and review tasks keep their status.
- A project that never uses the roadmap is left alone: no `.claude/roadmap.db` is created until the first write, and git and gh aren't run there. Before, a user-scope install made an empty database in every folder Claude Code opened.
- A milestone or epic up for review shows in the board's Review column, so its Approve (and the merge of its pull request) is a press away. Before, the board listed tasks only, and it was reachable only from the Tree.

### Changed

- End-to-end tests run the roadmap tool itself (`hooks/register.tsx`) against a real sqlite3 in a temporary project, covering add, plan, claim, update, batch, remove, export and import (`node --test tests/register.e2e.mjs`, also in CI). The band's drawing moved into `hooks/pane.tsx` so the hooks module loads under Node.
- An open card docks at the bottom of the pane, under the board (or tree, or backlog), which keeps the top part of the pane, fitted to it. Pressing another card swaps the docked one; pressing the open card again, or the ✕ on its title row, closes it. A pane too short for both shows the card alone, as before.
- A card in review offers Approve and Request changes, and no longer Hand to Claude, which only resent the first ask.
- Status roll-ups and item lookups are indexed once per snapshot, so a board of a couple of thousand items draws in milliseconds. Before, each roll-up walked the whole roadmap again.
- An `update` that sets several things (fields, checklist, blockers, labels, links) is written as one transaction in one sqlite3 run: it lands whole or not at all.
- Handing work to Claude takes a confirm step (on a card or a backlog row), and the `h`, `m` and `u` keys are gone, so a stray key or an extra Enter no longer hands off or reassigns a task. A card never opens with focus on Hand to Claude, and a finished item doesn't offer it.
- The board has five columns, and needs 100 columns of width to lay them side by side (90 before); narrower, they stack.
- Agents can no longer act under the name `user`, in any case (`User`, `USER`).
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

[Unreleased]: https://github.com/astrosteveo/unclaude/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/astrosteveo/unclaude/releases/tag/v0.7.1
[0.7.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.7.0
[0.6.3]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.3
[0.6.2]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.2
[0.6.1]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.1
[0.6.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.6.0
[0.5.0]: https://github.com/astrosteveo/unclaude/releases/tag/v0.5.0
