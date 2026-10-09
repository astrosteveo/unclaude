export type Kind = 'milestone' | 'epic' | 'task'
export type Status = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done'
/** How urgent: p0 drops everything, p2 is the default, p3 can wait. */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3'
/** What sort of work an item is, as Jira's issue type. */
export type IssueType = 'feature' | 'bug' | 'chore'
/** A CHANGELOG section a task's release note goes under. */
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
  /** When a milestone or epic is meant to start (YYYY-MM-DD); without one, the roadmap derives it. */
  start: string | null
  due: string | null
  priority: Priority
  type: IssueType
  /** The task's line for the CHANGELOG, as the person using the project reads it; `-` for none needed. */
  note: string | null
  /** The CHANGELOG section the note goes under. */
  section: Section | null
  /** How a closed task was closed, when not by doing it: `wontdo`, dropped (with its reason on the timeline). */
  resolution: 'wontdo' | null
  /** When the holder last showed signs of life; a claim gone quiet too long can be taken over. */
  lease_at: string | null
  /** Free-form tags, sorted. */
  labels: string[]
  /** Links this item makes to others (stored on this side). */
  relations: Relation[]
  /** Ids of the tasks this one waits on (`links`); empty for none. */
  blocked_by: string[]
  /** Acceptance criteria, in order; a task with any unchecked is not done. */
  checklist: Check[]
  created_at: string
  updated_at: string
}

/**
 * What to look for (`find`, and the board's filter); every field given must match. `assignee` "none"
 * means unassigned; `labels` matches an item carrying any of them; `text` searches title, description
 * and what was written on the item.
 */
export type Query = {
  kind?: Kind
  status?: Status[]
  assignee?: string[]
  priority?: Priority[]
  type?: IssueType[]
  labels?: string[]
  under?: string
  /** A milestone id: the epics and tasks that target it (a task its own, else its epic's), and it. */
  milestone?: string
  text?: string
}

/** One item of a `plan` call: a new item and, nested under it, its own new items. */
export type PlanNode = {
  /** A name other nodes' blocked_by can use before the item has an id; defaults to its place, `#1`, `#2`… */
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

/** A plan node checked and placed: under an existing item (`parentId`) or a new one (`parentRef`). */
export type PlannedItem = {
  ref: string
  node: PlanNode
  parentId: string | null
  parentRef: string | null
  blockerRefs: string[]
  blockerIds: string[]
}

/** One acceptance criterion: `n` is its 1-based place in the list. */
export type Check = { n: number; text: string; done: boolean }

/** One entry of an item's timeline: a comment, or a change someone made. */
export type Activity = {
  id: number
  item_id: string
  author: string
  /**
   * `handoff`: the note an agent leaves when it lets a task go, for whoever picks it up. `remove`: an
   * item removed, logged under its id; `undo`: a change taken back (or, undone itself, made again).
   */
  type: 'create' | 'status' | 'assign' | 'edit' | 'comment' | 'handoff' | 'remove' | 'undo'
  body: string
  at: string
  /** The write it was logged in: entries of one op were one change, and are undone together. */
  op?: number | null
  /** The undo entry that took it back, while it stays taken back. */
  undone?: number | null
  /** Whether it can be taken back. */
  undoable?: boolean
}

/** The roadmap as read: items, recent activity, and the newest activity id the user has seen per item. */
export type Snapshot = { items: Item[]; activity: Activity[]; seen: Record<string, number>; releases?: Release[]; inbox?: InboxItem[] }

/**
 * Something filed to sort later (an idea, a bug, a "we should…"), kept apart from planned work: open
 * until triaged into a task or epic, or folded into existing work (`became` names it), or dropped (`reason`).
 */
export type InboxItem = { id: string; title: string; body: string | null; author: string; at: string; state: 'open' | 'triaged' | 'dropped'; became: string | null; reason: string | null }

/** A version that shipped: when, from which tag and release PR, its notes, and the tasks it carried. */
export type Release = { version: string; tag: string | null; at: string; pr: number | null; notes: string; tasks: { id: string; note: string; section: Section | null }[] }

export type View = 'board' | 'plan' | 'timeline' | 'inbox' | 'releases'

/** The new-item form's choices so far; the title is typed last and submits it. */
export type Draft = { kind: Kind; priority: Priority; type: IssueType; parent: string }

/** A commit whose message names roadmap ids. */
export type Commit = { hash: string; author: string; date: string; subject: string; ids: string[] }

/** A pull request whose title or branch names roadmap ids. */
/** A pull request whose title or branch names roadmap ids; `checks` sums up its CI. */
export type Pr = { number: number; title: string; state: string; url: string; ids: string[]; checks: Checks; /** Its head branch. */ branch: string; /** The branch it merges into. */ base: string }

/** A pull request's checks at a glance: none reported, still running, all passed, or one failed. */
export type Checks = 'none' | 'pending' | 'pass' | 'fail'

/** What the repository says about the roadmap: commits and pull requests that name items. */
export type Refs = { commits: Commit[]; prs: Pr[]; /** The version the stable branch serves, when known. */ stable?: string }

declare module 'claude-code' {
  interface PluginState {
    roadmap: { snapshot: Snapshot; view: View; selected: string | null; problem: string | null; refs: Refs; scrolled: number; ignoreOffer: boolean; requesting: boolean; filter: string; filtering: boolean; draft: Draft | null; editing: boolean; handing: string | null; merging: string | null; noting: string | null; commentTurns: boolean; stacking: string | null; stackRun: string; picked: string[]; parallelAsk: string[] | null; doneOpen: boolean; flipped: string[]; dropping: string | null; filing: boolean; releasing: boolean }
  }
}
