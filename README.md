# roadmap

A lightweight Jira for Claude Code. Milestones, epics and tasks live in your project. Claude plans them with you, claims tasks before working on them, leaves comments as it goes and marks tasks done. You follow along, and steer, from a board inside Claude Code.

```
◐ T16 Band above the prompt showing the current task @claude ☑1/4 · M2 3/5
```

## Install

In a Claude Code session in your terminal:

```
/plugin marketplace add astrosteveo/unclaude#stable
/plugin install roadmap@unclaude
```

Pick a scope when asked (user scope makes it available in every project). `#stable` gets you the latest release: the `stable` branch moves only when a version is released, while `main` is where work lands between releases. To update later, refresh the marketplace with `/plugin marketplace update unclaude` and then update the plugin (`claude plugin update roadmap@unclaude`), or turn on auto-update for the marketplace under `/plugin`.

**Requires** the `sqlite3` command line tool (`pacman -S sqlite`, `apt install sqlite3`, `dnf install sqlite`, `brew install sqlite`). If `git` and `gh` are available, they're used to link commits and pull requests to tasks.

## Use it

Ask Claude to plan something, for example *"plan the v2 release as milestones, epics and tasks, with a checklist on each task"*, and then:

- **`/roadmap`** opens the pane: five tabs, one for each stage a piece of work goes through (see [The five tabs](#the-five-tabs) below). It opens on the Board.
- **Keys:** `v` steps through the tabs; `t` `p` `b` `r` `d` jump to a Board column; Enter opens a card, `1`–`5` set its status, `e` edits it, `x` closes it; `n` adds an item, `i` files something to the inbox, `f` filters, `z` undoes, `w` zooms the Roadmap. Hand to Claude, Assign me and Unassign have no keys on purpose: Tab to them and press Enter (Hand to Claude then asks you to confirm).
- **The hierarchy:** work is epic > task > checklist. A **milestone is a target**, not a container: epics and tasks point at one (a task takes its epic's unless it has its own), so an epic can span milestones and a task can be pulled into an earlier or later one. A **release** is what `ship` records: the version, and the tasks it carried.
- **New items:** `n` opens a form (kind, priority, type, where it goes, then the title; Enter creates it). On an open epic or milestone, `n` adds under it.
- **Edit** a card with `e`: Tab into its title, description (one line; ask Claude for longer text), due date, labels, priority, type and parent, and press Enter on a field to save it. On a task, edit mode also lists the checklist (reword an entry, or empty it to drop it), an Add criterion field, and Blocked by (task ids, comma-separated). `e` again leaves edit mode.
- **Filter** with `f`: type words to search, or narrow with `@claude` (`@none` for unassigned), `#label`, `p0`–`p3`, `bug`/`feature`/`chore`, a status (`todo`, `wip`, `blocked`, `review`, `done`) `under:E3` or `m:M2` (what targets a milestone). The filter applies to the board and the plan; Clear removes it.
- **Comments** you post on a card reach Claude with your next prompt. On a card an agent holds, the button beside the comment field switches to *Tells it now*: then each comment starts a turn at once (the setting is kept). A `● N` badge marks cards with comments you haven't read yet; *Mark all read*, by the unread count in the header, clears them all.
- **Ask Claude** on a card puts *"About roadmap task T12 (…): "* in the prompt box; press Esc to finish the question there and send it.
- **Review:** you review what you hand over, once. Hand Claude a task and it goes to Review when finished, not Done. Hand it a whole epic or milestone (Hand to Claude on its card, or "implement E27" in chat) and its tasks close as Claude goes; the epic or milestone goes to Review when they're all done. Open the card and press `a` to approve, or `c` to send it back with what needs changing (Claude picks it up again). When the item has an open pull request, its card shows the PR and its checks; `a` then asks whether to approve and merge it, or approve only, and `c` also posts your note on the PR. You can also tell Claude in chat that it's approved. When PRs are stacked (each based on the branch of the one before), the bottom one's card shows the stack (`#11 ← #12 ← #15`) and offers *Merge the stack*. It merges them in order: each one above the bottom is moved onto main, brought up to date with it, and merged only once its checks pass there. Each merged PR's items are approved. A failure stops the run where it is, and Claude is told why.
- **Won't do:** a task you drop is closed with *Won't do* on its card (it asks why), or by Claude with the reason. It keeps its history and reads `✕ won't do`, struck through, but it isn't finished work: it needs no ticks or release note, never reaches the CHANGELOG, and isn't counted in the done count or progress. Its parent closes as if it were done. Setting any other status takes it back to work. Claude's won't do waits on your approval, like its done.
- **Undo** with `z` (or Undo in the header): it takes back your last change on the board (a status, a field, a tick, a comment, a new item, a removal), and pressing it again goes further back. Every change in a card's Activity has its own `↶ undo`, Claude's too, and an undo has a `↷ redo`. An undo is refused when something changed the same thing since, so later work is never lost. Merges can't be undone.
- **Priority and type:** each task has a priority (`p0` urgent to `p3` can wait, `p2` by default) and a type (feature, bug or chore). Cards show them when they differ from the defaults, with `p0` in red and `p1` in yellow.
- **Labels and links:** tasks can carry labels (`#ui`, `#auth`), relate to other items (shown on both), or be marked a duplicate of another, which closes them. They show in the card's Links section.
- **Run tasks at once:** tick rows in Plan's Unplanned group (☐) and press *Run N at once…*, or press *Run its tasks at once…* on an epic or milestone. Each task gets its own git worktree (`.claude/worktrees/<branch>`), on its own branch named for the task, made from the main line, and its own agent, started by Claude. Agents claim their tasks, commit, open their PRs and set them done with release notes, side by side. A task waiting on another starts by itself once that one is done (approved). Up to four run at once; the rest wait their turn.
- **The band** above the prompt shows what an agent is working on (with several at once, each one's task and checklist). Press it to open that task.

### The five tabs

**Inbox** — capture, and what waits on you. *Needs you* comes first: work in review, comments you haven't read, claims gone quiet and late work, each a press from its card. Under it, what was filed to sort: `i`, `/roadmap inbox <text>`, or Claude filing what it notices but wasn't asked to do. Each item becomes a task or an epic (the new-item form opens with its title), joins existing work (*Into…*: `T12`, or `T12 checklist` for an entry), or is dropped with a reason. Ask Claude to triage the inbox and it proposes a sort for you to agree before it does it.

```
 Inbox 4  v:  Plan   Roadmap   Board   Releases   ███████░ 96/110 done  ● 2 unread
Needs you  2
review  E21 Search
1 unread  T118 Sort the board by due date
To sort  2
I7 Export the roadmap to CSV — user, 10-10
[ → Task ] [ → Epic ] [ Into… ] [ Drop… ]
I8 Board flickers on resize — claude, 10-10
  Seen at 84 columns, while a card is docked.
[ → Task ] [ → Epic ] [ Into… ] [ Drop… ]
```

**Plan** — the hierarchy, open work first. Milestones by date with their progress, each with the epics and tasks that target it; then **Unplanned**, what no milestone holds. There, a todo task nobody holds has a priority picker, `→ Claude`, and a ☐ to pick several to run at once. Finished milestones and epics fold to one line (`▸` opens one: Tab to it and press Enter, or click it), and finished loose tasks fold into one line at the foot. A filter unfolds everything; whatever holds the open card stays unfolded. Done tasks say where they went: `v0.6.3`, or `unreleased`.

```
▾ ◐ M5 Project lifecycle: inbox to release  13/14  @claude
  ▾ ◐ E19 Roadmap: a time axis for milestones, epics and releases  2/3
      ◐ T110 Releases on the roadmap  @claude
      ● T108 Start dates for milestones and epics, given or derived  @claude
▸ ● M4 v0.5 Agent-ready tracker  15/15  @claude
Unplanned  1 for anyone to take
  ☐ p2 ○ T120 Keyboard shortcut for Mark all read  [ → Claude ]
▸ ● E16 Lean agent loop: fewer round trips and tokens per task  6/6  @claude
▸ 29 finished tasks in no epic
```

**Roadmap** — when. In a wide pane, a time axis: each epic a bar from its start (given, or its first claim) to its due date (or its milestone's), filled as far as its tasks are done; each milestone a ◆ on its date; releases as ▲ ticks; a line for today; late work in red. `w` zooms in around today. In a narrow pane, the same as a list: dates, progress and how each stands (*in 11 days*, *4 days late, 1 open*) in columns. Tasks past their due date are marked `⚠late` on the board, and Claude's brief lists what is overdue.

```
w: zoom: all                 09-28      10-05      10-12       10-19      10-26      11-02      11-09
Releases                     ▲0.6.0                ▲0.6.3 +2
M5 Project lifecycle…                              │                                         ◆
  E19 Roadmap: a time axis              ███████████│████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  E20 Inbox: capture anyth…                  ██████│███████████████████████░░░░░░░░░░░░░░░░░
No dates yet: E22
```

**Board** — in flight, by status. In a **narrow pane** (under 100 columns) the columns stack: empty ones fold into one line, and each card's details (priority and type, checklist, assignee, unread comments) line up down the list. In a **wide pane** it's a Kanban board: an empty column shrinks to its heading, the others share the width, and a card takes one line, or its title and then its details (every card in that column, so the column lines up). **Done** shows what was finished in the last week (three to eight tasks); *· show all* lists the rest. An open card sits under the board, with its id highlighted.

```
t: ○ Todo 0 · b: ✗ Blocked 0 · r: ◉ Review 0

p: ◐ In progress 1
T114 Tabs in lifecycle order: Inbox · Plan · Roadmap · Board · Rel… ☑0/3 @claude

d: ● Done 110 · show all
T113 Needs you: reviews, unread comments, stale and late work at t… ☑3/3 @claude ● 1
T112 Triage: an item becomes a task or epic, joins existing work, … ☑4/4 @claude
…102 older
```

**Releases** — what shipped. *Unreleased* lists the notes the next release would carry, by section, with *Release…*: it suggests the next version (a patch when everything waiting is a fix) and runs `ship`, which opens the release PR. Once you've merged it, *Tag and publish* tags it, publishes the GitHub release and moves `stable`. Below, every version with its date, tasks and release PR, the newest open and the rest folded, the one installs get marked `stable ●`.

```
Unreleased 2 notes merged since the last release [ Release… ]
Added
- An Inbox: file anything to sort later, with i on the board, /roadmap inbox <text>… (T111)
- A task can be closed as won't do, with a reason: kept with its history, but not c… (T100)
▾ v0.6.3  2026-10-09  1 task  PR #33  stable ●
  Changed
  - Installing the mod gets the last release, not whatever has merged since.
▸ v0.6.2  2026-10-09  1 task  PR #31
```

The header reads as tabs (the one showing highlighted, a count on Inbox) beside a progress bar and the unread count, with the actions grouped apart: one row on a wide pane, two on a narrow one. The key hints at the bottom fit the width, the most useful first.

What Claude does with it:

- Gets a short brief at the start of each session (open milestones, its own tasks, anything blocked, and your recent changes), plus a reminder if it has been working without updating its tasks.
- Works through a handed epic or milestone in as few calls as it can: `claim E7` takes the whole unit and starts its first ready task, with every task's description and checklist in the answer. Setting a task done ticks its checklist and takes its release note in the same call, then starts the next ready task. On a three-task epic that comes to four tracker calls. On tiny tasks that costs about 1.2× the same work done without the mod. On tasks that each touch several files, the difference is lost in run-to-run noise (`bench/tokens`).
- Claims a task before starting it. A claim is refused if someone else holds the task or the task is still waiting on unfinished work, so parallel agents don't collide. A claim is a lease: the holder's activity keeps it alive, and once an agent has been silent for 30 minutes its claim goes stale (`⌛stale` on the card). Another agent can then take it over, and the takeover is logged. Subagents show up by name, such as `explore:find-auth-handlers`.
- Can't mark a task done until every item on its checklist is checked, and its done goes to Review for you to approve.
- Leaves a handoff note when it lets a task go (`release` with a note). The next agent to claim the task gets the note first, along with the task's description, checklist, recent activity and linked commits, so it can pick up where the last one stopped.
- Plans a whole breakdown in one call (`plan`): milestones, epics and tasks nested as a tree, with checklists, labels and dependencies between the new tasks. The tree is checked in full before anything is written.
- Searches with `find`: by status, assignee (`none` for unassigned), priority, type, labels, a subtree (`under`) or words in titles, descriptions and comments.
- Uses `next` to pick up the next task that's ready to start, highest priority first.
- Files what it notices but wasn't asked to do to the inbox (`file`), and sorts the inbox when you ask (`triage`): it proposes what each item becomes, and acts once you agree.
- Works on one branch per unit you hand over, named after it (`e9-agent-coordination`, or `t47-no-stray-hand-offs` for a task on its own). When the unit goes to Review, Claude is told to push the branch and open its pull request, titled with the unit's id, with a body listing its tasks and checklists (the `pr` action gives the branch, title and body).
- Gives each task a release note when it sets it done: one line for the CHANGELOG (`note`), and its section (Added, Changed or Fixed; by default Fixed for a bug, Changed for a chore, Added otherwise), or `-` when the work needs no line. A done without one is refused until it has one. When you set a task done on the board, its card asks for the note too (or None needed, or Later). The notes go in the pull request's body, and the `changelog` action writes the notes of merged work into `CHANGELOG.md` under `[Unreleased]`, each in its section, skipping any already there.
- Ships a release when you ask for one (`ship` with a version): it bumps `.claude-plugin/plugin.json` and `package.json` (those the project has), writes the release notes of merged work that aren't in the CHANGELOG yet under `[Unreleased]` (so running `changelog` first is optional), turns `[Unreleased]` into that version with today's date and links, and opens a PR on a `release-v<version>` branch. Once that PR has merged and you say so, `ship` again tags the merge, publishes the GitHub release from the version's notes, moves the `stable` branch (what installs get) to it, and records the release with the tasks it carried (shown on their cards as *shipped in vX*). Then it deletes the release branch, here and on origin. It refuses a version that isn't higher, and a first `1.0` unless you've asked for one.
- Puts task ids in commit messages (`T12: ...`) and epic or milestone ids in PR titles and branches (`E9: ...`, `e9-agent-coordination`). Commits and PRs show up on the items they name.

## How it's stored

Everything lives in `.claude/roadmap.db` (SQLite) in your project, shared by every Claude Code session and agent working there. The roadmap is made by the first write, and only at the top of a git repository: a session started in a subfolder uses the repository's roadmap, and one started in a folder that isn't a repository (say, the folder holding your projects) is refused, with the roadmaps it found below. Writes are transactions, so concurrent agents don't lose each other's changes. The file is binary, so it belongs in `.gitignore`. If it isn't ignored, the board offers to add it once (press `g`), or you can turn the offer down. The schema is versioned: a newer build of the mod migrates older databases on first use, and an older build refuses a newer database instead of corrupting it.

### Backups

Because the database is ignored by git and lives in one checkout, deleting or re-cloning the folder would lose it. So the mod backs it up on its own: when the roadmap has changed, at most every 10 minutes while a session is open, it writes a JSON export to `~/.claude/roadmap-backups/<project path>/`, named by time, and keeps the newest 20. Set `ROADMAP_BACKUP_DIR` to keep them somewhere else (a synced folder, say), or to `off` to turn them off.

To restore one, start from an empty roadmap (move `.claude/roadmap.db` aside if there is one) and ask Claude to *"import the roadmap from ~/.claude/roadmap-backups/…/roadmap-….json"*. You can also ask for an export at any time (`export`, to `.claude/roadmap-export-<date>.json` or a path you name). An export holds everything: items, checklists, labels, links, the whole timeline and read marks. Ids carry on where they left off.

## Development

```
claude --plugin-dir .                  # run a session with this checkout loaded (hot-reloads on save)
claude plugin validate .               # what the engine sees and would refuse
claude plugin test .                   # unit and UI tests (hooks/*.test.ts)
node --test tests/sql.integration.mjs  # the generated SQL against a real sqlite3
node --test tests/register.e2e.mjs     # the roadmap tool end to end (hooks/register.tsx) against a real sqlite3
```

`node bench/tokens/run.mjs` measures what the mod costs an agent. It runs the same small epic headless with this checkout loaded and without the mod, 3 runs each, and tabulates turns, tool calls, tokens and cost. These are real runs, billed to your own account: about $1.50 for the default small epic, and about $5 with `--scenario notes`, a heavier epic whose tasks each touch several files of a small API.

CI runs all four on every push to `main` and on pull requests (`.github/workflows/test.yml`).

This roadmap was built by working from itself: its own milestones are in this repo's `.claude/roadmap.db` (not committed).

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
