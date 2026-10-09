export type Kind = 'milestone' | 'epic' | 'task'
export type Status = 'todo' | 'in_progress' | 'blocked' | 'done'

export type Item = {
  id: string
  kind: Kind
  title: string
  status: Status
  parent: string | null
  description: string | null
  assignee: string | null
  due: string | null
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
  type: 'create' | 'status' | 'assign' | 'edit' | 'comment'
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
    roadmap: { snapshot: Snapshot; view: View; selected: string | null; problem: string | null; refs: Refs; scrolled: number }
  }
}
