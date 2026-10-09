export type Kind = 'milestone' | 'epic' | 'task'
export type Status = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done'
/** How urgent: p0 drops everything, p2 is the default, p3 can wait. */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3'
/** What sort of work an item is, as Jira's issue type. */
export type IssueType = 'feature' | 'bug' | 'chore'
/** A link other than blocked-by: this item relates to, or duplicates, item `id`. */
export type Relation = { type: 'relates' | 'duplicates'; id: string }

export type Item = {
  id: string
  kind: Kind
  title: string
  status: Status
  parent: string | null
  description: string | null
  assignee: string | null
  due: string | null
  priority: Priority
  type: IssueType
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

/** One acceptance criterion: `n` is its 1-based place in the list. */
export type Check = { n: number; text: string; done: boolean }

/** One entry of an item's timeline: a comment, or a change someone made. */
export type Activity = {
  id: number
  item_id: string
  author: string
  /** `handoff`: the note an agent leaves when it lets a task go, for whoever picks it up. */
  type: 'create' | 'status' | 'assign' | 'edit' | 'comment' | 'handoff'
  body: string
  at: string
}

/** The roadmap as read: items, recent activity, and the newest activity id the user has seen per item. */
export type Snapshot = { items: Item[]; activity: Activity[]; seen: Record<string, number> }

export type View = 'board' | 'tree'

/** A commit whose message names roadmap ids. */
export type Commit = { hash: string; author: string; date: string; subject: string; ids: string[] }

/** A pull request whose title or branch names roadmap ids. */
export type Pr = { number: number; title: string; state: string; url: string; ids: string[] }

/** What the repository says about the roadmap: commits and pull requests that name items. */
export type Refs = { commits: Commit[]; prs: Pr[] }

declare module 'claude-code' {
  interface PluginState {
    roadmap: { snapshot: Snapshot; view: View; selected: string | null; problem: string | null; refs: Refs; scrolled: number; ignoreOffer: boolean; requesting: boolean }
  }
}
