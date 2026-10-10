export type Kind = 'milestone' | 'epic' | 'task'
export type Status = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done'
/** How urgent an item is: p0 means drop everything, p2 is the default, p3 is the least urgent. */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3'
/** What kind of work an item is, like Jira's issue type. */
export type IssueType = 'feature' | 'bug' | 'chore'
/** The CHANGELOG section a task's release note goes under. */
export type Section = 'Added' | 'Changed' | 'Fixed'
/** A link other than blocked-by: this item relates to, or duplicates, item `id`. */
export type Relation = { type: 'relates' | 'duplicates'; id: string }

export type Item = {
  id: string
  kind: Kind
  title: string
  status: Status
  /** The epic a task belongs to; null for an epic, a milestone, or a task in no epic. */
  parent: string | null
  /** The milestone an epic or task targets; a task without one takes its epic's. */
  milestone: string | null
  description: string | null
  assignee: string | null
  /** When a milestone or epic is meant to start (YYYY-MM-DD); when it is empty, the plugin works out a start date. */
  start: string | null
  due: string | null
  priority: Priority
  type: IssueType
  /** The task's line for the CHANGELOG, written for the people who use the project; `-` when none is needed. */
  note: string | null
  /** The CHANGELOG section the note goes under. */
  section: Section | null
  /** How a closed task was closed, when the work wasn't done: `wontdo`, dropped (with the reason on its timeline). */
  resolution: 'wontdo' | null
  /** When the holder last renewed the claim; a claim not renewed for 30 minutes can be taken over. */
  lease_at: string | null
  /** Free-form tags, sorted. */
  labels: string[]
  /** Links from this item to others (stored on this item). */
  relations: Relation[]
  /** Ids of the tasks that block this one (stored in `links`); empty for none. */
  blocked_by: string[]
  /** Acceptance criteria, in order; a task can't be done while any of them is unchecked. */
  checklist: Check[]
  created_at: string
  updated_at: string
}

/**
 * What to look for (`find`, and the board's filter); every field given must match. `assignee` "none"
 * means unassigned; `labels` matches an item that has any of them; `text` searches the title, the
 * description, and the comments and handoff notes on the item.
 */
export type Query = {
  kind?: Kind
  status?: Status[]
  assignee?: string[]
  priority?: Priority[]
  type?: IssueType[]
  labels?: string[]
  under?: string
  /** A milestone id: matches the milestone and the epics and tasks that target it (a task's own target, else its epic's). */
  milestone?: string
  text?: string
}

/** One item in a `plan` call: a new item, and the new items nested under it. */
export type PlanNode = {
  /** A name other nodes' blocked_by can use before the item has an id; defaults to its position, `#1`, `#2`… */
  ref?: string
  kind: Kind
  title: string
  description?: string
  /** A milestone's or epic's start date, YYYY-MM-DD. */
  start?: string
  due?: string
  assignee?: string
  priority?: Priority
  type?: IssueType
  /** The milestone an epic or task targets (an id, or a ref of a new milestone in the same plan). */
  milestone?: string
  labels?: string[]
  checklist?: string[]
  /** Refs of other new tasks, or ids of existing ones. */
  blocked_by?: string[]
  children?: PlanNode[]
}

/** A plan node that has been checked and placed: under an existing item (`parentId`) or a new one (`parentRef`). */
export type PlannedItem = {
  ref: string
  node: PlanNode
  parentId: string | null
  parentRef: string | null
  blockerRefs: string[]
  blockerIds: string[]
}

/** One acceptance criterion: `n` is its 1-based position in the list. */
export type Check = { n: number; text: string; done: boolean }

/** One entry of an item's timeline: a comment, or a change someone made. */
export type Activity = {
  id: number
  item_id: string
  author: string
  /**
   * `handoff`: the note an agent leaves when it releases a task, for whoever picks it up next. `remove`:
   * an item was removed, logged under its id. `undo`: a change was undone (or, if this undo was itself
   * undone, made again).
   */
  type: 'create' | 'status' | 'assign' | 'edit' | 'comment' | 'handoff' | 'remove' | 'undo'
  body: string
  at: string
  /** The write it was logged in: entries with the same op were one change, and are undone together. */
  op?: number | null
  /** The id of the undo entry that reverted it, for as long as it stays reverted. */
  undone?: number | null
  /** Whether it can be undone. */
  undoable?: boolean
}

/** The roadmap as read from the database: items, recent activity, and the newest activity id the user has seen on each item. */
export type Snapshot = { items: Item[]; activity: Activity[]; seen: Record<string, number>; releases?: Release[]; inbox?: InboxItem[] }

/**
 * Something filed to sort later (an idea, a bug, a "we should…"), kept apart from planned work. It stays
 * open until it is triaged into a task or epic or added to existing work (`became` is that item's id), or
 * dropped (with the reason in `reason`).
 */
export type InboxItem = { id: string; title: string; body: string | null; author: string; at: string; state: 'open' | 'triaged' | 'dropped'; became: string | null; reason: string | null }

/** A released version: when, from which tag and release PR, its notes, and the tasks it included. */
export type Release = { version: string; tag: string | null; at: string; pr: number | null; notes: string; tasks: { id: string; note: string; section: Section | null }[] }

export type View = 'inbox' | 'plan' | 'roadmap' | 'board' | 'releases'

/** The new-item form's choices so far; the title is typed last, and entering it submits the form. */
export type Draft = {
  kind: Kind; priority: Priority; type: IssueType; parent: string
  /** The inbox item it is made from, when triaging one; the title starts as that item's title. */
  from?: string; title?: string
}

/** A commit whose message names roadmap ids. */
export type Commit = { hash: string; author: string; date: string; subject: string; ids: string[] }

/** A pull request whose title or branch names roadmap ids; `checks` is the overall result of its CI. */
export type Pr = { number: number; title: string; state: string; url: string; ids: string[]; checks: Checks; /** Its head branch. */ branch: string; /** The branch it merges into. */ base: string }

/** A pull request's checks in one word: none reported, still running, all passed, or at least one failed. */
export type Checks = 'none' | 'pending' | 'pass' | 'fail'

/** The commits and pull requests in the repository that name roadmap items. */
export type Refs = { commits: Commit[]; prs: Pr[]; /** The version on the stable branch, when known. */ stable?: string }

declare module 'claude-code' {
  interface PluginState {
    roadmap: { snapshot: Snapshot; view: View; selected: string | null; problem: string | null; refs: Refs; scrolled: number; ignoreOffer: boolean; requesting: boolean; filter: string; filtering: boolean; draft: Draft | null; editing: boolean; handing: string | null; merging: string | null; noting: string | null; commentTurns: boolean; stacking: string | null; stackRun: string; picked: string[]; parallelAsk: string[] | null; doneOpen: boolean; flipped: string[]; dropping: string | null; filing: boolean; releasing: boolean; zoom: number; triaging: { id: string; mode: 'into' | 'drop' } | null; viewScrolled: Record<string, number>; region: 'list' | 'card'; split: number | null; revealing: boolean }
  }
}
