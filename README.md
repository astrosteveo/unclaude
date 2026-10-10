# roadmap

roadmap is a Claude Code plugin that tracks your project's work as milestones, epics and tasks. Claude plans the work with you, claims a task before it starts on it, leaves comments as it goes, and marks the task done when it's finished. You watch the work and steer it from a board inside Claude Code.

```
◐ T16 Band above the prompt showing the current task @claude ☑1/4 · M2 3/5
```

That line appears above the prompt while Claude works. It shows the task, who holds it, how much of its checklist is done, and how far along its milestone is.

## Install

Run these two commands in a Claude Code session in your terminal:

```
/plugin marketplace add astrosteveo/unclaude#stable
/plugin install roadmap@unclaude
```

Pick a scope when asked. User scope makes the plugin available in every project.

`#stable` installs the latest release. The `stable` branch only moves when a version is released. Work lands on `main` between releases.

To update later, refresh the marketplace with `/plugin marketplace update unclaude`, then update the plugin with `claude plugin update roadmap@unclaude`. You can also turn on auto-update for the marketplace under `/plugin`.

**Requirements:** the `sqlite3` command line tool (`pacman -S sqlite`, `apt install sqlite3`, `dnf install sqlite`, `brew install sqlite`). If `git` and `gh` are installed, the plugin uses them to link commits and pull requests to tasks.

## Use it

Ask Claude to plan something, for example *"plan the v2 release as milestones, epics and tasks, with a checklist on each task"*. Then use the board:

- **`/roadmap`** opens the roadmap pane. It has five tabs, one for each stage of work (see [The five tabs](#the-five-tabs) below). It opens on the Board tab.
- **Keys:** `v` moves to the next tab. `t` `p` `b` `r` `d` jump to a Board column. Enter opens a card, `1`–`5` set its status, `e` edits it and `x` closes it. `n` adds an item, `i` adds something to the inbox, `f` filters, `z` undoes, and `w` zooms the Roadmap tab. Hand to Claude, Assign me and Unassign have no keys on purpose. To use them, Tab to the button and press Enter. Hand to Claude then asks you to confirm.
- **How work is organized:** epics hold tasks, and tasks have checklists. A **milestone** is a goal that epics and tasks are aimed at. It doesn't contain them. Each epic or task points at one milestone, and a task uses its epic's milestone unless you give it its own. So an epic can span several milestones, and you can move a single task to an earlier or later one. A **release** is the record `ship` makes: the version number and the tasks that went into it.
- **New items:** `n` opens a form. Fill in the kind, priority, type, where it goes and the title, then press Enter to create it. When an epic or milestone is open, `n` adds the new item under it.
- **Edit:** press `e` on a card to edit it. Tab to the title, description, due date, labels, priority, type or parent, and press Enter on a field to save it. The description is one line; ask Claude if you need longer text. On a task, edit mode also lists the checklist. You can reword an entry, or empty it to remove it. There is also an Add criterion field, and a Blocked by field that takes task ids separated by commas. Press `e` again to leave edit mode.
- **Filter:** press `f` and type words to search. You can also narrow the list with `@claude` (`@none` for unassigned), `#label`, `p0`–`p3`, `bug`/`feature`/`chore`, a status (`todo`, `wip`, `blocked`, `review`, `done`), `under:E3`, or `m:M2` for items aimed at a milestone. The filter applies to the Board and Plan tabs. Clear removes it.
- **Comments:** Claude gets the comments you post on a card with your next prompt. If an agent holds the card, the button next to the comment field changes to *Tells it now*. Then each comment starts a new turn right away. The board remembers this setting. A `● N` badge marks cards with comments you haven't read. *Mark all read*, next to the unread count in the header, clears them all.
- **Ask Claude:** this button on a card puts *"About roadmap task T12 (…): "* in the prompt box. Press Esc, finish your question there, and send it.
- **Review:** you review each piece of work you hand over once.
  - If you hand Claude a single task, it goes to Review when Claude finishes it, not to Done.
  - If you hand Claude a whole epic or milestone (Hand to Claude on its card, or "implement E27" in chat), Claude closes its tasks as it goes. The epic or milestone goes to Review once all its tasks are done.
  - To review, open the card and press `a` to approve, or `c` to send it back with what needs to change. Claude then picks it up again. You can also tell Claude in chat that the work is approved.
  - If the item has an open pull request, its card shows the PR and its checks. `a` then asks whether to approve and merge, or approve only. `c` also posts your note on the PR.
  - When pull requests are stacked (each one based on the branch of the one before it), the bottom PR's card shows the stack (`#11 ← #12 ← #15`) and offers *Merge the stack*. This merges the PRs in order. Each PR above the bottom one is moved onto main, updated with main's latest changes, and merged only after its checks pass there. The items in each merged PR are approved. If a step fails, the merge stops there and Claude is told why.
- **Won't do:** to drop a task, press *Won't do* on its card and give a reason. Claude can also close a task as won't do, with a reason, but that waits for your approval, the same as when Claude marks a task done. The task keeps its history and shows `✕ won't do` in struck-through text. It doesn't count as finished work: it needs no checklist ticks or release note, never appears in the CHANGELOG, and isn't counted in the done count or in progress. Its parent can still close as if the task were done. Setting any other status reopens it.
- **Undo:** press `z` (or Undo in the header) to undo your last change on the board: a status, a field, a tick, a comment, a new item or a removal. Press it again to go further back. Each change in a card's Activity list has its own `↶ undo`, including Claude's changes, and each undo has a `↷ redo`. The board refuses an undo if something changed the same thing since, so later work is never lost. Merges can't be undone.
- **Priority and type:** each task has a priority, from `p0` (urgent) to `p3` (can wait), with `p2` as the default. It also has a type: feature, bug or chore. Cards show these only when they differ from the defaults. `p0` is shown in red and `p1` in yellow.
- **Labels and links:** tasks can have labels (`#ui`, `#auth`). A task can be linked to related items, and the link shows on both. A task can also be marked as a duplicate of another, which closes it. All of these show in the card's Links section.
- **Run several tasks at once:** in the Plan tab's Unplanned group, tick tasks (☐) and press *Run N at once…*. Or press *Run its tasks at once…* on an epic or milestone. Claude gives each task its own git worktree (`.claude/worktrees/<branch>`) on a new branch named after the task and made from the main branch, and starts a separate agent for each one. Each agent claims its task, commits, opens a pull request, and sets the task done with a release note. A task that depends on another starts by itself once that one is done and approved. Up to four tasks run at once; the rest wait their turn.
- **The line above the prompt** shows what each agent is working on. With several agents, it shows each one's task and checklist. Press it to open that task.

### The five tabs

**Inbox: new ideas, and things waiting on you.** *Needs you* is at the top. It lists work in review, comments you haven't read, claims whose agent has stopped working, and late work. You can act on each one from its card. Below that are items filed to sort later. You file them with `i` or `/roadmap inbox <text>`, and Claude files things it notices but wasn't asked to do. Each item can become a task or an epic (the new-item form opens with its title filled in), be added to existing work (*Into…*: `T12`, or `T12 checklist` to add it as a checklist entry), or be dropped with a reason. If you ask Claude to triage the inbox, it proposes what to do with each item and waits for you to agree before it acts.

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

**Plan: all the work by milestone, open work first.** Milestones are listed by date with their progress, each followed by the epics and tasks aimed at it. After them comes **Unplanned**: everything not aimed at a milestone. There, each todo task that nobody holds has a priority picker, a `→ Claude` button, and a ☐ box for picking several tasks to run at once. Finished milestones and epics collapse to one line. To expand one, Tab to its `▸` and press Enter, or click it. Finished tasks with no epic collapse into one line at the bottom. A filter expands everything, and whatever contains the open card stays expanded. Done tasks show the release they shipped in, such as `v0.6.3`, or `unreleased`.

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

**Roadmap: dates.** In a wide pane, it shows a timeline:

- Each epic is a bar from its start date to its due date. The start is the date you gave it, or the date its first task was claimed. The due date is its own, or its milestone's. The bar is filled in to show how many of its tasks are done.
- Each milestone is a ◆ on its date, and each release is a ▲ mark.
- A vertical line marks today, and late work is red.
- `w` zooms in around today.

In a narrow pane, it shows the same information as a list, with columns for dates, progress and status (*in 11 days*, *4 days late, 1 open*). Tasks past their due date show `⚠late` on the Board, and the summary Claude gets at the start of a session lists overdue work.

```
w: zoom: all                 09-28      10-05      10-12       10-19      10-26      11-02      11-09
Releases                     ▲0.6.0                ▲0.6.3 +2
M5 Project lifecycle…                              │                                         ◆
  E19 Roadmap: a time axis              ███████████│████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  E20 Inbox: capture anyth…                  ██████│███████████████████████░░░░░░░░░░░░░░░░░
No dates yet: E22
```

**Board: work in progress, by status.**

- In a **narrow pane** (under 100 columns), the columns are stacked. Empty ones collapse into one line, and each card's details (priority and type, checklist, assignee, unread comments) line up down the list.
- In a **wide pane**, it's a Kanban board. An empty column shrinks to its heading and the others share the width. Each card takes one line, or a title line and a details line. When one card in a column needs two lines, every card in that column uses two, so the column lines up.
- **Done** shows what was finished in the last week (three to eight tasks). *· show all* lists the rest.
- The open card appears below the board, with its id highlighted.

```
t: ○ Todo 0 · b: ✗ Blocked 0 · r: ◉ Review 0

p: ◐ In progress 1
T114 Tabs in lifecycle order: Inbox · Plan · Roadmap · Board · Rel… ☑0/3 @claude

d: ● Done 110 · show all
T113 Needs you: reviews, unread comments, stale and late work at t… ☑3/3 @claude ● 1
T112 Triage: an item becomes a task or epic, joins existing work, … ☑4/4 @claude
…102 older
```

**Releases: what has shipped.** *Unreleased* lists the notes the next release would include, by section, with a *Release…* button. It suggests the next version number (a patch release when everything waiting is a fix) and runs `ship`, which opens the release pull request. After you merge that PR, *Tag and publish* tags it, publishes the GitHub release and moves the `stable` branch. Below that is every past version with its date, tasks and release PR. The newest is expanded and the rest are collapsed. The version new installs get is marked `stable ●`.

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

The header shows the tabs (the current one highlighted, with a count on Inbox), a progress bar and the unread count. The action buttons sit in a separate group. The header takes one row in a wide pane and two in a narrow one. The key hints at the bottom are cut to fit the width, with the most useful ones first.

### What Claude does

- **Session start:** Claude gets a short summary of open milestones, its own tasks, anything blocked, and your recent changes. It also gets a reminder if it has been working without updating its tasks.
- **Working through an epic or milestone:** Claude uses as few tracker calls as it can. `claim E7` takes the whole epic and starts its first ready task, and the answer includes every task's description and checklist. Setting a task done ticks its checklist and records its release note in the same call, then starts the next ready task. A three-task epic takes four tracker calls. On very small tasks, the work costs about 1.2 times what it costs without the plugin. On tasks that each change several files, the extra cost is smaller than the normal difference between one run and the next (measured with `bench/tokens`).
- **Claims:** Claude claims a task before starting it. The claim is refused if someone else holds the task or if the task is still waiting on unfinished work, so agents running at the same time don't work on the same thing. A claim stays active while the agent holding it keeps working. If that agent does nothing for 30 minutes, the claim is marked stale (`⌛stale` on the card) and another agent can take the task over. The takeover is logged. Subagents show up by name, such as `explore:find-auth-handlers`.
- **Done:** Claude can't mark a task done until every checklist item is ticked, and its done goes to Review for you to approve.
- **Handoffs:** when Claude stops working on a task, it leaves a note for the next agent (`release` with a note). The next agent to claim the task gets that note first, along with the task's description, checklist, recent activity and linked commits, so it can continue where the last one stopped.
- **Planning:** Claude can plan a whole breakdown in one call (`plan`): milestones, epics and tasks nested together, with checklists, labels, and dependencies between the new tasks. The plugin checks the whole plan before it saves anything.
- **Search:** Claude searches with `find`, by status, assignee (`none` for unassigned), priority, type, labels, everything under one item (`under`), or words in titles, descriptions and comments.
- **Next task:** Claude uses `next` to pick the next task that's ready to start, highest priority first.
- **Inbox:** Claude files things it notices but wasn't asked to do to the inbox (`file`). When you ask, it sorts the inbox (`triage`): it proposes what each item should become, and acts once you agree.
- **Branches and pull requests:** Claude works on one branch for each piece of work you hand it, named after it (`e9-agent-coordination`, or `t47-no-stray-hand-offs` for a single task). When the work goes to Review, Claude is told to push the branch and open a pull request. The PR title includes the item's id, and the body lists its tasks and checklists. The `pr` action gives the branch, title and body.
- **Release notes:** when Claude sets a task done, it writes one line for the CHANGELOG (`note`) and picks its section: Added, Changed or Fixed. The section defaults to Fixed for a bug, Changed for a chore, and Added for anything else. If the work needs no CHANGELOG line, the note is `-`. The plugin refuses a done without a note. When you set a task done on the board, its card asks for a note too (or None needed, or Later). The notes go in the pull request's body. The `changelog` action adds the notes from merged work to `CHANGELOG.md` under `[Unreleased]`, each in its section, and skips any that are already there.
- **Releases:** when you ask for a release, Claude runs `ship` with the version number. It:
  1. Updates the version in `.claude-plugin/plugin.json` and `package.json` (whichever the project has).
  2. Adds release notes from merged work that aren't in the CHANGELOG yet under `[Unreleased]`, so running `changelog` first is optional.
  3. Renames `[Unreleased]` to the new version, with today's date and links.
  4. Opens a pull request on a `release-v<version>` branch.

  After that PR is merged and you tell Claude, it runs `ship` again. This tags the merge, publishes the GitHub release from the version's notes, moves the `stable` branch (the one new installs use) to it, and records the release with the tasks it included. Those tasks' cards then show *shipped in vX*. Last, it deletes the release branch locally and on origin. `ship` refuses a version that isn't higher than the last one, and refuses a first `1.0` unless you've asked for one.
- **Commit messages:** Claude puts task ids in commit messages (`T12: ...`) and epic or milestone ids in PR titles and branch names (`E9: ...`, `e9-agent-coordination`). Commits and PRs then show up on the items they name.

## How it's stored

Everything is stored in `.claude/roadmap.db`, a SQLite file in your project. Every Claude Code session and agent working in the project shares it.

- The file is created on the first write, and only at the top level of a git repository. A session started in a subfolder uses the repository's roadmap. A session started in a folder that isn't a repository (for example, the folder that holds all your projects) is refused, and the plugin lists the roadmaps it found in the folders below.
- Writes use transactions, so agents working at the same time don't lose each other's changes.
- The file is binary, so it should be in `.gitignore`. If it isn't, the board offers once to add it (press `g`), and you can say no.
- The database has a schema version. A newer version of the plugin upgrades an older database the first time it opens it. An older version of the plugin refuses to open a newer database, so it can't damage it.

### Backups

The plugin backs up the database automatically. This matters because git ignores the file and it exists in only one checkout, so deleting or re-cloning the folder would lose it.

While a session is open and the roadmap has changed, the plugin writes a JSON export to `~/.claude/roadmap-backups/<project path>/`, at most every 10 minutes. Each file is named by its time, and the newest 20 are kept. Set `ROADMAP_BACKUP_DIR` to save them somewhere else (such as a synced folder), or set it to `off` to turn backups off.

To restore a backup, start with an empty roadmap (move `.claude/roadmap.db` aside if it exists) and ask Claude to *"import the roadmap from ~/.claude/roadmap-backups/…/roadmap-….json"*.

You can also ask Claude for an export at any time (`export`). It's saved to `.claude/roadmap-export-<date>.json`, or to a path you choose. An export contains everything: items, checklists, labels, links, the full history, and what you've read. After an import, new ids continue from where the old ones stopped.

## Development

```
claude --plugin-dir .                  # run a session with this checkout loaded (reloads when you save)
claude plugin validate .               # show what Claude Code loads from the plugin and what it rejects
claude plugin test .                   # unit and UI tests (hooks/*.test.ts)
node --test tests/sql.integration.mjs  # run the generated SQL against a real sqlite3
node --test tests/register.e2e.mjs     # test the roadmap tool (hooks/register.tsx) end to end against a real sqlite3
tsc --noEmit -p .                      # type check (needs the API types a session writes to .claude-plugin/types/)
```

`node bench/tokens/run.mjs` measures how much the plugin costs an agent. It runs the same small epic headless 3 times with this checkout loaded and 3 times without the plugin, then prints a table of turns, tool calls, tokens and cost. These are real runs, billed to your own account: about $1.50 for the default small epic, and about $5 with `--scenario notes`, a larger epic whose tasks each change several files of a small API.

CI runs `claude plugin validate`, `claude plugin test` and the two `node --test` commands on every push to `main` and on pull requests (`.github/workflows/test.yml`). It doesn't run the type check.

This plugin's own work is tracked with the plugin. Its milestones are in this repo's `.claude/roadmap.db`, which isn't committed.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
