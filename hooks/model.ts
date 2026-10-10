import type { Activity, Checks, Commit, IssueType, Item, Kind, PlanNode, PlannedItem, Pr, Priority, Query, Refs, Release, Section, Snapshot, Status } from '../types'

// The person at the board, and the main loop's agent; subagents go by names from agentName.
export const USER = 'user'
export const CLAUDE = 'claude'
export const KINDS: Kind[] = ['milestone', 'epic', 'task']
export const STATUSES: Status[] = ['todo', 'in_progress', 'blocked', 'review', 'done']
export const GLYPH: Record<Status, string> = { todo: '○', in_progress: '◐', blocked: '✗', review: '◉', done: '●' }
export const LABEL: Record<Status, string> = { todo: 'Todo', in_progress: 'In progress', blocked: 'Blocked', review: 'Review', done: 'Done' }
export const PRIORITIES: Priority[] = ['p0', 'p1', 'p2', 'p3']
export const TYPES: IssueType[] = ['feature', 'bug', 'chore']
export const SECTIONS: Section[] = ['Added', 'Changed', 'Fixed']
// The order Keep a Changelog puts its sections in, those this mod writes among them.
const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']

/** A section as given (`fixed`, `Fixed`), or undefined when it is none of them. */
export const sectionOf = (text: string | undefined): Section | undefined =>
  SECTIONS.find(one => one.toLowerCase() === text?.trim().toLowerCase())

/** The section a task's note goes under: its own, else what its type suggests (a bug is a fix). */
export const sectionFor = (item: Item): Section => item.section ?? (item.type === 'bug' ? 'Fixed' : item.type === 'chore' ? 'Changed' : 'Added')

/** Whether a task has a note worth a CHANGELOG line (not none, and not `-`, none needed). */
/** A task closed as won't do: closed, but dropped rather than finished. */
export const isDropped = (item: Item) => item.resolution === 'wontdo'
export const hasNote = (item: Item) => Boolean(item.note && item.note !== '-') && !isDropped(item)
/** Priority and type as worth saying: the defaults (p2, feature) go without saying. */
// How a task closed as won't do is marked.
export const WONTDO_GLYPH = '✕'
export const marks = (item: Item) =>
  [item.priority && item.priority !== 'p2' ? item.priority : '', item.type && item.type !== 'feature' ? item.type : ''].filter(Boolean)
const byPriority = (a: Item, b: Item) => PRIORITIES.indexOf(a.priority ?? 'p2') - PRIORITIES.indexOf(b.priority ?? 'p2')
export const PREFIX: Record<Kind, string> = { milestone: 'M', epic: 'E', task: 'T' }
// Which kinds each kind may sit under.
const PARENTS: Record<Kind, Kind[]> = { milestone: [], epic: ['milestone'], task: ['epic', 'milestone'] }

export const emptySnapshot = (): Snapshot => ({ items: [], activity: [], seen: {} })

/**
 * Lookups over one list of items, built the first time it is asked about. A snapshot's list is replaced
 * on every load, never changed in place, so an index stays true for as long as its list is around.
 */
type Index = { byId: Map<string, Item>; children: Map<string | null, Item[]>; status: Map<Item, Status> }
const indexes = new WeakMap<Item[], Index>()

function indexOf(items: Item[]): Index {
  let index = indexes.get(items)
  if (!index) {
    index = { byId: new Map(), children: new Map(), status: new Map() }
    for (const item of items) {
      const key = item.id.toUpperCase()
      if (!index.byId.has(key)) index.byId.set(key, item)
      const up = upOf(item)
      const siblings = index.children.get(up)
      if (siblings) siblings.push(item)
      else index.children.set(up, [item])
    }
    indexes.set(items, index)
  }
  return index
}

/**
 * What an item sits under in the tree: a task its epic, else (a task in no epic, or an epic) the milestone it
 * targets. A milestone is a target, not a container, but the tree shows what targets it beneath it.
 */
export const upOf = (item: Item): string | null => item.parent ?? item.milestone ?? null

/** The milestone a task or epic targets: its own, else (a task) its epic's; a milestone is its own. */
export function targetOf(items: Item[], item: Item): string | null {
  if (item.kind === 'milestone') return item.id
  if (item.milestone) return item.milestone
  const up = find(items, item.parent ?? undefined)
  // Under a milestone, as data from before targets had it: that milestone; under an epic, the epic's.
  if (!up) return null
  return up.kind === 'milestone' ? up.id : item.kind === 'task' ? targetOf(items, up) : null
}

export const find = (items: Item[], id: string | undefined) =>
  id === undefined ? undefined : indexOf(items).byId.get(id.toUpperCase())

/** An item's children, as a list of the caller's own (free to sort). */
export const childrenOf = (items: Item[], id: string | null): Item[] => [...(indexOf(items).children.get(id) ?? [])]

/**
 * Where "under X" puts an item: under an epic, `parent` is the epic (and a task's own target goes, so it
 * follows its epic's); under a milestone, `milestone` is it and there is no epic; under nothing, neither.
 */
export function placeOf(items: Item[], kind: Kind, under: string | undefined, self?: string): { parent: string | null; milestone: string | null } {
  const at = checkParent(items, kind, under, self)
  const found = at ? find(items, at) : undefined
  return found?.kind === 'milestone' ? { parent: null, milestone: found.id } : { parent: at, milestone: null }
}

/** The milestone a target names, or throws: only epics and tasks target, and only milestones are targets. */
export function checkTarget(items: Item[], kind: Kind, milestone: string): string | null {
  if (milestone === '') return null
  if (kind === 'milestone') throw new Error('A milestone targets nothing; epics and tasks target milestones')
  const found = find(items, milestone)
  if (!found) throw new Error(`No item ${milestone}`)
  if (found.kind !== 'milestone') throw new Error(`${found.id} is a ${found.kind}; a target is a milestone`)
  return found.id
}

/** The parent id to store, or throws when the nesting is not allowed. */
export function checkParent(items: Item[], kind: Kind, parent: string | undefined, self?: string): string | null {
  if (parent === undefined || parent === '') return null
  const found = find(items, parent)
  if (!found) throw new Error(`No item ${parent}`)
  if (found.id === self) throw new Error(`${self} cannot be its own parent`)
  if (!PARENTS[kind].includes(found.kind)) throw new Error(`A ${kind} cannot sit under a ${found.kind} (${found.id})`)
  return found.id
}

/** How long a claim lasts without a sign of life from its holder before anyone may take it over. */
export const LEASE_MS = 30 * 60_000

/**
 * Whether a task's claim has gone quiet: in progress under someone whose last heartbeat (or, for a claim
 * made before leases, the task's last change) is older than LEASE_MS.
 */
export function isStale(item: Item, now: number): boolean {
  if (item.kind !== 'task' || item.status !== 'in_progress' || !item.assignee) return false
  const at = Date.parse(item.lease_at ?? item.updated_at)
  return Number.isFinite(at) && now - at > LEASE_MS
}

/**
 * A whole plan checked before anything is written, flattened parents first, or throws naming the first
 * problem: a bad kind or nesting, a missing title, a ref used twice, a blocker that is neither a new
 * task nor an existing one, or new tasks waiting on each other in a cycle.
 */
export function checkPlan(items: Item[], nodes: PlanNode[], parent: string | undefined): PlannedItem[] {
  const out: PlannedItem[] = []
  const refs = new Map<string, PlannedItem>()
  const walk = (list: PlanNode[], parentId: string | null, parentRef: string | null, parentKind: Kind | null) => {
    for (const node of list) {
      const ref = String(node.ref ?? `#${out.length + 1}`).trim()
      const where = `${ref}${node.title ? ` (${node.title})` : ''}`
      if (!KINDS.includes(node.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(', ')}`)
      if (!node.title?.trim()) throw new Error(`${where}: title is required`)
      if (refs.has(ref)) throw new Error(`ref ${ref} is used twice`)
      if (find(items, ref)) throw new Error(`ref ${ref} is an existing item's id; pick another`)
      if (node.priority && !PRIORITIES.includes(node.priority)) throw new Error(`${where}: priority must be one of ${PRIORITIES.join(', ')}`)
      if (node.type && !TYPES.includes(node.type)) throw new Error(`${where}: type must be one of ${TYPES.join(', ')}`)
      if (node.kind !== 'task' && (node.checklist?.length || node.blocked_by?.length))
        throw new Error(`${where}: only tasks carry a checklist or blocked_by`)
      if (node.milestone !== undefined) {
        if (node.kind === 'milestone') throw new Error(`${where}: a milestone targets nothing`)
        const named = String(node.milestone).trim()
        const local = nodes.flatMap(function all(one: PlanNode): PlanNode[] { return [one, ...(one.children ?? []).flatMap(all)] }).find(one => one.ref === named)
        if (local ? local.kind !== 'milestone' : (find(items, named)?.kind ?? 'none') !== 'milestone')
          throw new Error(`${where}: milestone ${named} is not a milestone here or in the plan`)
      }
      if (parentKind === null) checkParent(items, node.kind, parentId ?? undefined)
      else if (!PARENTS[node.kind].includes(parentKind)) throw new Error(`${where}: a ${node.kind} cannot sit under a ${parentKind}`)
      const planned: PlannedItem = { ref, node, parentId: parentRef ? null : parentId, parentRef, blockerRefs: [], blockerIds: [] }
      refs.set(ref, planned)
      out.push(planned)
      walk(node.children ?? [], null, ref, node.kind)
    }
  }
  const top = parent ? find(items, parent)?.id ?? null : null
  if (parent && !top) throw new Error(`No item ${parent}`)
  walk(nodes, top, null, null)
  for (const one of out) {
    for (const raw of one.node.blocked_by ?? []) {
      const name = String(raw).trim()
      const local = refs.get(name)
      if (local) {
        if (local.node.kind !== 'task') throw new Error(`${one.ref}: only tasks block tasks; ${name} is a ${local.node.kind}`)
        if (local === one) throw new Error(`${one.ref} cannot block itself`)
        one.blockerRefs.push(local.ref)
      } else one.blockerIds.push(...checkBlockers(items, '\u0000new', [name]))
    }
  }
  // Existing tasks can't wait on new ones, so a cycle can only run through the new tasks.
  const state = new Map<string, 'open' | 'done'>()
  const visit = (ref: string) => {
    if (state.get(ref) === 'done') return
    if (state.get(ref) === 'open') throw new Error(`blocked_by runs in a cycle through ${ref}`)
    state.set(ref, 'open')
    for (const next of refs.get(ref)!.blockerRefs) visit(next)
    state.set(ref, 'done')
  }
  for (const one of out) visit(one.ref)
  return out
}

// Words a query reads as a status; the rest of the words are searched for.
const STATUS_WORDS: Record<string, Status> = {
  todo: 'todo', 'in-progress': 'in_progress', in_progress: 'in_progress', wip: 'in_progress', blocked: 'blocked', review: 'review', done: 'done',
}

/**
 * A query as typed on the board: `@claude` (assignee; `@none` for unassigned), `#ui` (label), `p0`–`p3`,
 * `bug`/`feature`/`chore`, a status word (`todo`, `wip`, `blocked`, `review`, `done`), `under:E3`, and
 * any other words, which must all appear in the text. Repeats of a kind widen it: `p0 p1` is either.
 * Undefined when there is nothing to look for.
 */
export function parseQuery(text: string): Query | undefined {
  const q: Query = {}
  const add = <K extends 'status' | 'assignee' | 'priority' | 'type' | 'labels'>(key: K, value: NonNullable<Query[K]>[number]) =>
    ((q[key] as unknown[] | undefined) ??= []).push(value)
  const words: string[] = []
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const low = word.toLowerCase()
    if (low.startsWith('@') && low.length > 1) add('assignee', low.slice(1))
    else if (low.startsWith('#') && low.length > 1) add('labels', low.slice(1))
    else if (low.startsWith('under:') && low.length > 6) q.under = low.slice(6).toUpperCase()
    else if (low.startsWith('m:') && low.length > 2) q.milestone = low.slice(2).toUpperCase()
    else if ((PRIORITIES as string[]).includes(low)) add('priority', low as Priority)
    else if ((TYPES as string[]).includes(low)) add('type', low as IssueType)
    else if (STATUS_WORDS[low]) add('status', STATUS_WORDS[low]!)
    else words.push(word)
  }
  if (words.length) q.text = words.join(' ')
  return Object.keys(q).length ? q : undefined
}

/**
 * Whether `item` is what `query` looks for. Status is the rolled-up one, as the board shows it. Text is
 * looked for in what was written on the item: `said` (every message, by item id) when given, else the
 * snapshot's recent timeline.
 */
export function matches(snap: Snapshot, item: Item, query: Query, said?: Record<string, string>): boolean {
  if (query.kind && item.kind !== query.kind) return false
  if (query.status?.length && !query.status.includes(statusOf(snap.items, item))) return false
  if (query.assignee?.length && !query.assignee.some(who => (who === 'none' ? !item.assignee : item.assignee?.toLowerCase() === who.toLowerCase())))
    return false
  if (query.priority?.length && !query.priority.includes(item.priority ?? 'p2')) return false
  if (query.type?.length && !query.type.includes(item.type ?? 'feature')) return false
  if (query.labels?.length && !query.labels.some(one => (item.labels ?? []).includes(one))) return false
  if (query.under) {
    const root = find(snap.items, query.under)
    if (!root || root.id === item.id || !subtree(snap.items, root.id).includes(item.id)) return false
  }
  if (query.milestone && item.id !== query.milestone.toUpperCase() && targetOf(snap.items, item) !== query.milestone.toUpperCase()) return false
  if (query.text?.trim()) {
    const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
    const written = said ? [said[item.id] ?? ''] : snap.activity.filter(one => one.item_id === item.id && isMessage(one)).map(one => one.body)
    const hay = [item.id, item.title, item.description ?? '', ...written].join('\n').toLowerCase()
    if (!words.every(word => hay.includes(word))) return false
  }
  return true
}

/** The tasks `item` waits on that are not done yet. */
export const waitingOn = (items: Item[], item: Item): Item[] =>
  (item.blocked_by ?? []).map(id => find(items, id)).filter((one): one is Item => one !== undefined && one.status !== 'done')

/** The tasks that wait on `item`. */
export const blocks = (items: Item[], item: Item): Item[] => items.filter(one => (one.blocked_by ?? []).includes(item.id))

/**
 * The blocker ids to store for task `id`, normalized, or throws: each must be another task, and none may
 * already wait on `id`, directly or through others (that would be a cycle nobody can finish).
 */
export function checkBlockers(items: Item[], id: string, blockers: string[]): string[] {
  const out: string[] = []
  for (const raw of blockers) {
    const found = find(items, raw.trim())
    if (!found) throw new Error(`No item ${raw}`)
    if (found.kind !== 'task') throw new Error(`Only tasks block tasks; ${found.id} is a ${found.kind}`)
    if (found.id.toUpperCase() === id.toUpperCase()) throw new Error(`${found.id} cannot block itself`)
    const seen = new Set<string>()
    const stack = [found.id]
    while (stack.length) {
      const at = find(items, stack.pop())
      if (!at || seen.has(at.id)) continue
      seen.add(at.id)
      if (at.id.toUpperCase() === id.toUpperCase()) throw new Error(`${found.id} already waits on ${id}; that would be a cycle`)
      stack.push(...(at.blocked_by ?? []))
    }
    if (!out.includes(found.id)) out.push(found.id)
  }
  return out
}

/** The item ids to link to, normalized, or throws: each must exist and not be `id` itself. */
export function checkLinks(items: Item[], id: string, ids: string[]): string[] {
  const out: string[] = []
  for (const raw of ids) {
    const found = find(items, raw.trim())
    if (!found) throw new Error(`No item ${raw}`)
    if (found.id.toUpperCase() === id.toUpperCase()) throw new Error(`${found.id} cannot link to itself`)
    if (!out.includes(found.id)) out.push(found.id)
  }
  return out
}

/**
 * An item's links other than blocked-by, read from both ends: `relates` goes both ways, so an item
 * relates to those it names and to those that name it; a duplicate names its original.
 */
export function linksOf(items: Item[], item: Item) {
  const out = (type: string) => (item.relations ?? []).filter(one => one.type === type).map(one => one.id)
  const into = (type: string) =>
    items.filter(one => (one.relations ?? []).some(r => r.type === type && r.id === item.id)).map(one => one.id)
  return {
    relates: [...new Set([...out('relates'), ...into('relates')])],
    duplicateOf: out('duplicates'),
    duplicatedBy: into('duplicates'),
  }
}

/** Where a new item of `kind` may go: the open milestones (and, for a task, epics) it can sit under. */
export const homesFor = (items: Item[], kind: Kind): Item[] =>
  rows(items)
    .map(row => row.item)
    .filter(one => PARENTS[kind].includes(one.kind) && statusOf(items, one) !== 'done')

/** Ids in an item's subtree, the item first. */
export function subtree(items: Item[], id: string): string[] {
  const out = [id]
  for (let i = 0; i < out.length; i++) out.push(...childrenOf(items, out[i]!).map(child => child.id))
  return out
}

/**
 * The tasks an item is made of: an epic's, its tasks; a milestone's, the tasks that target it, directly
 * or through their epic (a task can target another milestone than its epic's).
 */
export const tasksIn = (items: Item[], item: Item): Item[] =>
  item.kind === 'milestone'
    ? items.filter(one => one.kind === 'task' && targetOf(items, one) === item.id)
    : subtree(items, item.id)
        .map(id => find(items, id)!)
        .filter(one => one.kind === 'task' && one.id !== item.id)
const tasksUnder = tasksIn

/** Tasks in an item's subtree: done and total. */
export function progress(items: Item[], item: Item): { done: number; total: number } {
  // Dropped work is closed, but neither done nor still to do.
  if (item.kind === 'task') return isDropped(item) ? { done: 0, total: 0 } : { done: item.status === 'done' ? 1 : 0, total: 1 }
  const tasks = tasksUnder(items, item).filter(task => !isDropped(task))
  return { done: tasks.filter(task => task.status === 'done').length, total: tasks.length }
}

/**
 * What letting go of an item changes: nobody holds it, and a task that was under way goes back to todo,
 * where `next` and the backlog offer it to the next taker. Blocked and review keep their status.
 */
export const letGo = (item: Item): { assignee: null; status?: Status } =>
  item.kind === 'task' && item.status === 'in_progress' ? { assignee: null, status: 'todo' } : { assignee: null }

/** Whether `who` is an agent: anyone holding work who isn't the person at the board. */
export const isAgent = (who: string | null | undefined) => Boolean(who) && who !== USER

/**
 * The milestone or epic above `item` that was handed to an agent as a whole, the outermost when there
 * are several: the unit of work that is reviewed once, at its end, in place of what is inside it.
 */
export function handedScope(items: Item[], item: Item): Item | undefined {
  // What holds it, inner first: a task's epic, then the milestone it targets (its own, else its epic's).
  if (item.kind === 'milestone') return undefined
  const epic = item.kind === 'task' && item.parent ? find(items, item.parent) : undefined
  const milestone = find(items, targetOf(items, item) ?? undefined)
  let scope: Item | undefined
  for (const at of [epic, milestone]) if (at && isAgent(at.assignee)) scope = at
  return scope
}

/**
 * A milestone's or epic's status follows its tasks once it has any; a task's is its own. A milestone or
 * epic handed to an agent as a whole is reviewed once its tasks are all done: it reads `review` until
 * the person approves it (its own status set to done), or `in_progress` once they've asked for changes.
 */
export function statusOf(items: Item[], item: Item): Status {
  if (item.kind === 'task') return item.status
  // Rolled up once per list: the board asks for every row's status, and each roll-up asks for its parts'.
  const memo = indexOf(items).status
  let status = memo.get(item)
  if (status === undefined) memo.set(item, (status = rollUp(items, item)))
  return status
}

function rollUp(items: Item[], item: Item): Status {
  const tasks = tasksUnder(items, item).map(task => task.status)
  if (tasks.length === 0) return item.status
  if (tasks.every(status => status === 'done')) {
    if (isAgent(item.assignee) && item.status !== 'done' && !handedScope(items, item))
      return item.status === 'in_progress' ? 'in_progress' : 'review'
    // Not done while a part of it still waits on the person's review.
    const isPartInReview = childrenOf(items, item.id).some(one => one.kind !== 'task' && statusOf(items, one) === 'review')
    return isPartInReview ? 'review' : 'done'
  }
  if (tasks.includes('blocked')) return 'blocked'
  if (tasks.some(status => status !== 'todo')) return 'in_progress'
  return 'todo'
}

const byId = (a: Item, b: Item) =>
  KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
  (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
  Number(a.id.slice(1)) - Number(b.id.slice(1))

/** Rows of the tree under `root` (the whole roadmap when absent), depth-first. */
export function rows(items: Item[], root: string | null = null): { item: Item; depth: number }[] {
  const out: { item: Item; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const item of childrenOf(items, parent).sort(byId)) {
      out.push({ item, depth })
      walk(item.id, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** The item's ancestors, root first, as `M1 v1 launch › E2 Billing`. */
export const path = (items: Item[], item: Item): string => {
  const chain: Item[] = []
  for (let at = find(items, upOf(item) ?? undefined); at; at = find(items, upOf(at) ?? undefined)) chain.unshift(at)
  return chain.map(one => `${one.id} ${one.title}`).join(' › ')
}

export function line(items: Item[], item: Item): string {
  const p = progress(items, item)
  const status = statusOf(items, item)
  const bits = [
    ...marks(item),
    ...(item.labels ?? []).map(one => `#${one}`),
    item.kind !== 'task' && p.total > 0 ? `${p.done}/${p.total} tasks` : '',
    item.assignee ? `@${item.assignee}` : '',
    item.due ? `due ${item.due}` : '',
    item.checklist?.length ? `${item.checklist.filter(c => c.done).length}/${item.checklist.length} checked` : '',
    waitingOn(items, item).length ? `waiting on ${waitingOn(items, item).map(one => one.id).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const state = isDropped(item) ? `${WONTDO_GLYPH} won't do` : `${GLYPH[status]} ${status}`
  return `${item.id} ${state} ${item.title}${bits ? `  (${bits})` : ''}`
}

export function outline(items: Item[], root: string | null = null): string {
  return rows(items, root)
    .map(({ item, depth }) => '  '.repeat(depth) + line(items, item))
    .join('\n')
}

/**
 * The work under a milestone or epic, as an agent starts it: each open task with its description and
 * checklist beneath its line, finished ones a line each. One show then holds the whole unit.
 */
export function workOutline(items: Item[], root: string): string {
  return rows(items, root)
    .map(({ item, depth }) => {
      const pad = '  '.repeat(depth)
      const head = pad + line(items, item)
      if (item.kind !== 'task' || item.status === 'done') return head
      const more = [
        ...(item.description?.trim() ? item.description.trim().split('\n').map(text => `${pad}    ${text}`) : []),
        ...item.checklist.map(c => `${pad}    [${c.done ? 'x' : ' '}] ${c.n}. ${c.text}`),
      ]
      return [head, ...more].join('\n')
    })
    .join('\n')
}

/**
 * Comments others left on an item since `reader` last opened it. Status and assignment changes are not
 * counted: the board already shows them by where the card sits and whose name is on it.
 */
export const unread = (snap: Snapshot, id: string, reader: string) =>
  snap.activity.filter(
    one => one.item_id === id && one.author !== reader && isMessage(one) && one.id > (snap.seen[id] ?? 0),
  )

/**
 * What `who`'s Undo takes back: their latest change still standing, every entry of the write it was
 * (its op). Undos are passed over, so pressing Undo again walks further back.
 */
export function lastChange(snap: Snapshot, who: string): Activity[] {
  const mine = snap.activity.filter(one => one.author === who && !one.undone && one.type !== 'undo')
  const newest = mine.reduce<Activity | undefined>((max, one) => (!max || one.id > max.id ? one : max), undefined)
  // One logged before undo existed can't be taken back, and Undo never skips it for an older one.
  if (!newest?.undoable) return []
  return newest.op ? mine.filter(one => one.op === newest.op && one.undoable).sort((a, b) => a.id - b.id) : [newest]
}

/** Whether an entry is something someone wrote (a comment or a handoff note), not a change the tracker logged. */
export const isMessage = (one: Activity) => one.type === 'comment' || one.type === 'handoff'

export const timeline = (activity: Activity[], id: string) =>
  activity.filter(one => one.item_id === id).sort((a, b) => a.id - b.id)

export function detail(snap: Snapshot, item: Item, limit = 15, refs?: Refs): string {
  const parts = [line(snap.items, item)]
  const where = path(snap.items, item)
  if (where) parts.push(`in: ${where}`)
  const shipped = shipNote(snap, item, refs)
  if (shipped) parts.push(shipped.charAt(0).toUpperCase() + shipped.slice(1))
  // Whoever picks the task up reads the last holder's note before anything else.
  const handoff = timeline(snap.activity, item.id).filter(one => one.type === 'handoff').at(-1)
  if (handoff) parts.push(`Handoff from ${handoff.author} (${handoff.at.slice(0, 16).replace('T', ' ')}):\n  ${handoff.body}`)
  if (item.description) parts.push(item.description)
  if (item.checklist?.length)
    parts.push('Checklist:\n' + item.checklist.map(c => `  [${c.done ? 'x' : ' '}] ${c.n}. ${c.text}`).join('\n'))
  const before = (item.blocked_by ?? []).map(id => find(snap.items, id)).filter((one): one is Item => one !== undefined)
  if (before.length) parts.push('Blocked by:\n' + before.map(one => `  ${line(snap.items, one)}`).join('\n'))
  const after = blocks(snap.items, item)
  if (after.length) parts.push('Blocks:\n' + after.map(one => `  ${line(snap.items, one)}`).join('\n'))
  const links = linksOf(snap.items, item)
  const named = (ids: string[]) => ids.map(id => find(snap.items, id)).filter((one): one is Item => one !== undefined)
  if (links.duplicateOf.length) parts.push('Duplicate of:\n' + named(links.duplicateOf).map(one => `  ${line(snap.items, one)}`).join('\n'))
  if (links.duplicatedBy.length) parts.push('Duplicated by:\n' + named(links.duplicatedBy).map(one => `  ${line(snap.items, one)}`).join('\n'))
  if (links.relates.length) parts.push('Related:\n' + named(links.relates).map(one => `  ${line(snap.items, one)}`).join('\n'))
  const under = item.kind === 'task' ? '' : workOutline(snap.items, item.id)
  if (under) parts.push(under)
  const log = timeline(snap.activity, item.id).slice(-limit)
  if (log.length) parts.push('Activity:\n' + log.map(one => `  ${one.at.slice(0, 16).replace('T', ' ')} ${one.author}: ${one.body}`).join('\n'))
  return parts.join('\n')
}

/**
 * The backlog to triage: todo tasks nobody holds, those filed under no milestone or epic first (they
 * still need a home), then by priority, then oldest first.
 */
export const backlog = (items: Item[]): Item[] =>
  items
    .filter(item => item.kind === 'task' && item.status === 'todo' && !item.assignee)
    .sort((a, b) => Number(upOf(a) !== null) - Number(upOf(b) !== null) || byPriority(a, b) || Number(a.id.slice(1)) - Number(b.id.slice(1)))

/**
 * What to work on next for `actor`: their own open tasks (those still waiting on others last), then
 * unassigned todo tasks that wait on nothing unfinished, by priority, then due date, then others'
 * claims gone stale (given `now`), which a claim takes over.
 */
export function nextUp(items: Item[], actor: string, now?: number): Item[] {
  const tasks = items.filter(item => item.kind === 'task')
  const mine = tasks.filter(task => task.assignee === actor && task.status !== 'done')
  const due = (task: Item) => dueOf(items, task) ?? '9999'
  const isWaiting = (task: Item) => waitingOn(items, task).length > 0
  const free = tasks
    .filter(task => !task.assignee && task.status === 'todo' && !isWaiting(task))
    .sort((a, b) => byPriority(a, b) || due(a).localeCompare(due(b)) || byId(a, b))
  // Work in review waits on the user, so it comes after everything an agent can move on itself.
  const rank: Record<Status, number> = { in_progress: 0, todo: 1, blocked: 2, review: 3, done: 4 }
  const stale = now === undefined ? [] : tasks.filter(task => task.assignee !== actor && isStale(task, now)).sort(byPriority)
  return [
    ...mine.sort((a, b) => Number(isWaiting(a)) - Number(isWaiting(b)) || rank[a.status] - rank[b.status] || byPriority(a, b)),
    ...free,
    ...stale,
  ]
}

/**
 * The task in a milestone or epic for `actor` to start next: one they already have under way, else
 * the first free todo task that waits on nothing unfinished, as next orders them; never `besides`.
 */
export function readyIn(items: Item[], unit: Item, actor: string, besides?: string): Item | undefined {
  const under = new Set(tasksIn(items, unit).map(one => one.id).filter(id => id !== besides))
  return nextUp(items, actor).find(
    task => under.has(task.id) && (task.status === 'todo' || task.status === 'in_progress') && !waitingOn(items, task).length,
  )
}

/** The date of a clock reading, as due dates are written (YYYY-MM-DD). */
export const dateOf = (now: number) => new Date(now).toISOString().slice(0, 10)

/** When an item is due: its own date, else the nearest one above it. */
export function dueOf(items: Item[], item: Item): string | undefined {
  // Its own date, else its epic's, else the milestone it targets.
  if (item.due) return item.due
  const epic = item.kind === 'task' && item.parent ? find(items, item.parent) : undefined
  if (epic?.due) return epic.due
  return item.kind === 'milestone' ? undefined : find(items, targetOf(items, item) ?? undefined)?.due ?? undefined
}

/**
 * Where a milestone or epic sits on the roadmap's time axis: from its start, given or derived, to its
 * end, its due date (an epic's, else its milestone's). An epic without a start begins at its first claim
 * (the earliest claim or status change on its tasks), else when it was made; a milestone at the earliest
 * of what targets it, else when it was made. `isStartGiven` says which.
 */
export function spanOf(snap: Snapshot, item: Item): { start: string; end?: string; isStartGiven: boolean } {
  const items = snap.items
  const end = dueOf(items, item)
  if (item.start) return { start: item.start, end, isStartGiven: true }
  const made = item.created_at.slice(0, 10)
  if (item.kind === 'milestone') {
    const parts = items.filter(one => one.kind === 'epic' && targetOf(items, one) === item.id).map(one => spanOf(snap, one).start)
    const loose = tasksIn(items, item).filter(one => !one.parent).map(one => one.created_at.slice(0, 10))
    const first = [...parts, ...loose].sort()[0]
    return { start: first ?? made, end, isStartGiven: false }
  }
  const ids = new Set(tasksIn(items, item).map(one => one.id))
  const begun = snap.activity
    .filter(one => ids.has(one.item_id) && (one.type === 'status' || (one.type === 'assign' && one.body === 'claimed')))
    .map(one => one.at.slice(0, 10))
    .sort()[0]
  return { start: begun ?? made, end, isStartGiven: false }
}

/** Whether an item is past when it was due (its own date or one above it) and not done; never without a clock. */
export const isLate = (items: Item[], item: Item, now: number) => {
  const due = dueOf(items, item)
  return now > 0 && due !== undefined && due < dateOf(now) && statusOf(items, item) !== 'done'
}

/** Days from date `a` to date `b` (YYYY-MM-DD): negative when `b` is before `a`. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/**
 * The timeline: milestones (and epics under none) by due date, soonest first and undated last, each
 * milestone followed by its epics in the same order.
 */
/** A CHANGELOG's released versions, newest first as written: each with its date and the text under it. */
export function changelogVersions(text: string): { version: string; date: string; body: string }[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: { version: string; date: string; body: string }[] = []
  lines.forEach((line, i) => {
    const head = /^## \[?(\d+\.\d+\.\d+)\]?(?: - (\d{4}-\d{2}-\d{2}))?/.exec(line)
    if (!head) return
    const next = lines.findIndex((other, j) => j > i && (other.startsWith('## ') || /^\[[^\]]+\]: \S/.test(other)))
    out.push({ version: head[1]!, date: head[2] ?? '', body: lines.slice(i + 1, next < 0 ? undefined : next).join('\n').trim() })
  })
  return out
}

/** The tasks a release's notes carry: those whose note is in `body`, but not ones `taken` by another release. */
export function shippedIn(items: Item[], body: string, taken: Set<string> = new Set()): { id: string; note: string; section: Section | null }[] {
  return items
    .filter(task => task.kind === 'task' && hasNote(task) && !taken.has(task.id) && body.includes(task.note!))
    .map(task => ({ id: task.id, note: task.note!, section: sectionFor(task) }))
}

/** The release a task shipped in, from the record of releases. */
export const releaseOf = (snap: Snapshot, id: string): Release | undefined => (snap.releases ?? []).find(one => one.tasks.some(task => task.id === id))

/** Merged work no release carries yet: the tasks whose notes the next release would ship. */
export function unreleased(snap: Snapshot, refs: Refs): Item[] {
  const shipped = new Set((snap.releases ?? []).flatMap(one => one.tasks.map(task => task.id)))
  return mergedNotes(snap.items, refs).filter(task => !shipped.has(task.id))
}

/**
 * How an item stands against releases, in a few words, or undefined: a task "shipped in vX", or "merged,
 * not released" (given `refs`); a milestone how many of its noted tasks are out, and in which versions.
 */
export function shipNote(snap: Snapshot, item: Item, refs?: Refs): string | undefined {
  if (item.kind === 'task') {
    const release = releaseOf(snap, item.id)
    if (release) return `shipped in v${release.version}`
    return refs && unreleased(snap, refs).some(one => one.id === item.id) ? 'merged, not released' : undefined
  }
  if (item.kind !== 'milestone') return undefined
  const noted = tasksIn(snap.items, item).filter(hasNote)
  const out = noted.map(task => releaseOf(snap, task.id)).filter((one): one is Release => one !== undefined)
  if (out.length === 0) return undefined
  const versions = [...new Set(out.map(one => one.version))].sort((a, b) => (isAfter(versionOf(a)!, versionOf(b)!) ? 1 : -1))
  return `${out.length}/${noted.length} shipped (${versions.map(one => `v${one}`).join(', ')})`
}

/** The version to suggest for the next release after `last`: a patch when it only fixes, else a minor. */
export function nextVersion(last: string | undefined, notes: Item[]): string {
  const [major, minor, patch] = versionOf(last) ?? [0, 0, 0]
  return notes.length > 0 && notes.every(task => sectionFor(task) === 'Fixed') ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`
}

/** Releases, newest version first. */
export const releasesOf = (snap: Snapshot): Release[] =>
  [...(snap.releases ?? [])].sort((a, b) => (isAfter(versionOf(a.version) ?? [0, 0, 0], versionOf(b.version) ?? [0, 0, 0]) ? -1 : 1))

/** Open work first, then what is done, each in the order `list` gives. */
export const openFirst = (items: Item[], list: Item[]): Item[] => [
  ...list.filter(one => statusOf(items, one) !== 'done'),
  ...list.filter(one => statusOf(items, one) === 'done'),
]

/** The tree's rows: open work first at every level, and none under an item `isFolded` says is folded. */
export function treeRows(items: Item[], isFolded: (item: Item) => boolean): { item: Item; depth: number }[] {
  const out: { item: Item; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const item of openFirst(items, childrenOf(items, parent).sort(byId))) {
      out.push({ item, depth })
      if (!isFolded(item)) walk(item.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** The timeline's rows: `timelineOf`'s, open work first, a milestone's epics left out while it is folded. */
export function timelineRows(items: Item[], isFolded: (item: Item) => boolean): { item: Item; depth: number }[] {
  const all = timelineOf(items)
  const tops = openFirst(items, all.filter(one => !find(items, upOf(one) ?? undefined)))
  return tops.flatMap(top => [
    { item: top, depth: 0 },
    ...(isFolded(top) ? [] : openFirst(items, all.filter(one => upOf(one) === top.id)).map(item => ({ item, depth: 1 }))),
  ])
}

export function timelineOf(items: Item[]): Item[] {
  const byDue = (list: Item[]) => [...list].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || byId(a, b))
  const top = byDue(items.filter(one => one.kind !== 'task' && !find(items, upOf(one) ?? undefined)))
  return top.flatMap(one => [one, ...(one.kind === 'milestone' ? byDue(childrenOf(items, one.id).filter(child => child.kind === 'epic')) : [])])
}

/** The roadmap as a short brief for an agent: its own work, what is blocked, and what changed. */
export function brief(snap: Snapshot, actor: string, news: Activity[], now?: number, refs?: Refs): string | undefined {
  if (snap.items.length === 0) return undefined
  const items = snap.items
  const tasks = items.filter(item => item.kind === 'task')
  const list = (some: Item[], cap = 8) =>
    some.slice(0, cap).map(item => `- ${line(items, item)}${upOf(item) ? ` [${upOf(item)}]` : ''}`).join('\n') +
    (some.length > cap ? `\n- …${some.length - cap} more` : '')
  const milestones = items.filter(item => item.kind === 'milestone' && statusOf(items, item) !== 'done').sort(byId)
  const mine = tasks.filter(task => task.assignee === actor && task.status !== 'done' && task.status !== 'review')
  const blocked = tasks.filter(task => task.status === 'blocked')
  const review = items.filter(item => statusOf(items, item) === 'review')
  const stale = now === undefined ? [] : tasks.filter(task => task.assignee !== actor && isStale(task, now))
  const active = tasks.filter(task => task.status === 'in_progress' && task.assignee !== actor && !stale.includes(task))
  const parts = [
    'Project roadmap (roadmap tool). Claim before you start; keep it current as you go.',
  ]
  if (milestones.length) parts.push('Open milestones:\n' + list(milestones, 4))
  if (mine.length) parts.push(`Assigned to you (${actor}):\n` + list(mine))
  if (active.length) parts.push('In progress by others:\n' + list(active))
  if (stale.length)
    parts.push(`Stale claims (holder silent over ${LEASE_MS / 60_000} min; claiming takes one over):\n` + list(stale))
  if (blocked.length) parts.push('Blocked:\n' + list(blocked))
  // Dated items past their date: a milestone, epic or task with a due date of its own.
  const late = now === undefined ? [] : items.filter(item => item.due && isLate(items, item, now)).sort((a, b) => a.due!.localeCompare(b.due!))
  if (late.length) parts.push(`Overdue (past their due date, not done; today is ${dateOf(now!)}):\n` + list(late))
  if (review.length) {
    // Each with its pull request, or a note that it still needs one.
    const pr = (item: Item) => {
      if (!refs) return ''
      const open = refs.prs.find(one => one.state === 'open' && one.ids.includes(item.id))
      return open ? ` — PR #${open.number} ${open.url}` : ' — no PR yet'
    }
    parts.push(
      "Waiting on the user's review (they approve on the board, or tell you to):\n" +
        review.slice(0, 8).map(item => `- ${line(items, item)}${pr(item)}`).join('\n'),
    )
  }
  // What a release would ship now: said so a "release" from the user finds it in hand.
  const waiting = refs ? unreleased(snap, refs) : []
  if (waiting.length) parts.push(`Merged, not released yet: ${waiting.slice(0, 8).map(one => one.id).join(', ')}${waiting.length > 8 ? ` and ${waiting.length - 8} more` : ''}.`)
  if (news.length)
    parts.push(
      'Changes by the user since you last looked:\n' +
        news.slice(-10).map(one => `- ${one.item_id}: ${one.body}`).join('\n'),
    )
  return `<roadmap>\n${parts.join('\n\n')}\n</roadmap>`
}

/**
 * The turn that tells the agent who did `item` how the person's Approve on the board went: merged (or
 * approved without a merge), so it brings the checkout up to date; or a merge that failed, so it finds out why.
 */
export function approvalNote(item: Item, pr: Pr | undefined, failure?: string): string {
  const what = `roadmap ${item.kind} ${item.id} (${item.title})`
  if (pr && failure !== undefined)
    return (
      `The user approved ${what} on the board, but merging PR #${pr.number} (branch ${pr.branch}) failed: ${failure || 'no reason given'}. ` +
      `${item.id} stays in review. Find out why (failing checks, a conflict with its base, branch protection), fix what you can on ${pr.branch}, ` +
      'and tell the user what you found and whether it is ready to approve again.'
    )
  if (pr && pr.base && !isMainLine(pr.base))
    return (
      `The user approved ${what} on the board and merged PR #${pr.number} (branch ${pr.branch}) into ${pr.base}, not into main. ` +
      `Its work reaches main only when ${pr.base} does. Pull ${pr.base}, delete the local branch ${pr.branch}, keep the checkout on the ` +
      'top of what is still open (the user runs the mod from it), and say what is left to merge, in order.'
    )
  if (pr)
    return (
      `The user approved ${what} on the board and merged PR #${pr.number} (branch ${pr.branch}) into ${pr.base || 'main'}. Bring the checkout up to date: ` +
      `switch to ${pr.base || 'main'} and pull, delete the local branch ${pr.branch}, and make sure any open PR that was based on ${pr.branch} now targets ${pr.base || 'main'}. ` +
      'Then say in a line or two what is next on the roadmap.'
    )
  return `The user approved ${what} on the board; it is done. No pull request was merged with it. Say in a line or two what is next on the roadmap.`
}

/** The agent type a task run in parallel goes to, and the most such agents working at once. */
export const WORKER_TYPE = 'general-purpose'
export const WORKERS_MAX = 4

/** What a parallel task's agent is spawned as: its task, by id and title. */
export const workerTask = (task: Item) => `${task.id} ${task.title}`

/** The name a parallel task's agent goes by on the board, as its own calls will be named. */
export const workerName = (task: Item) => agentName(WORKER_TYPE, workerTask(task))

/** The first turn of a parallel task's agent, which starts in the worktree made for it, on its branch. */
export function workerPrompt(task: Item, branch: string, dir: string): string {
  return [
    `You are working roadmap task ${task.id}: ${task.title}. The user handed out several tasks to run at once, each to its own agent in its own git worktree.`,
    `Your worktree is ${dir}, already on branch ${branch}, made from the main line. Work only there; other agents work in the other worktrees.`,
    `1. Claim the task with the roadmap tool (claim ${task.id}); it is assigned to you, and the claim starts it. Read what it asks (show ${task.id}).`,
    '2. Do the work. Tick its checklist as each criterion is met (check), and comment on decisions and findings.',
    `3. Commit as "${task.id}: ...". If the repository has a remote, push the branch and open its pull request (pr ${task.id} gives the title and body; base it on the main line).`,
    `4. Set ${task.id} done with its release note (note, section). It goes to the user's review.`,
    `If you cannot finish, release ${task.id} with a handoff note saying where you got to. Don't remove the worktree.`,
  ].join('\n')
}

/** A parallel task's prompt, recognised as the main loop's Agent call passes it on: the task and its worktree. */
export function workerOf(prompt: string): { id: string; dir: string } | undefined {
  const found = /^You are working roadmap task (\w+):[\s\S]*?\nYour worktree is (.+?), already on branch /.exec(prompt)
  return found ? { id: found[1]!, dir: found[2]! } : undefined
}

/**
 * The turn asking the main loop to start parallel tasks: agents a plugin spawns can't call the plugin's
 * own tool, so the main loop's Agent tool starts them, each prompt passed on as written.
 */
export function workersNote(work: { task: Item; prompt: string }[]): string {
  return [
    `The user handed out roadmap tasks to run at once from the board: ${work.map(one => one.task.id).join(', ')}. Start each now as its own background agent: ` +
      `one Agent call per task, all in this one message, subagent_type "${WORKER_TYPE}", run_in_background true, the description given, and the prompt exactly as written ` +
      '(its worktree and branch are made). Then say in a line which started; their progress shows on the board.',
    ...work.map(one => `--- ${one.task.id}\ndescription: ${workerTask(one.task)}\nprompt:\n${one.prompt}`),
  ].join('\n\n')
}

/** The prompt Ask Claude puts in the box for the person to finish: which item, by id and title. */
export const askAbout = (item: Item) => `About roadmap ${item.kind} ${item.id} (${item.title}): `

/** The turn a comment starts when the person sends it to the agent holding the item. */
export function commentNote(item: Item, body: string): string {
  const what = `roadmap ${item.kind} ${item.id} (${item.title})`
  return item.assignee === CLAUDE
    ? `The user commented on ${what}, which you hold: "${body}". Read it with the roadmap tool (show ${item.id}) and act on it, commenting back there.`
    : `The user commented on ${what}, which ${item.assignee} holds: "${body}". If ${item.assignee} is still running, pass it on (SendMessage); otherwise act on it yourself. Comment back on ${item.id}.`
}

/** Lowercase words joined by hyphens, cut at a word boundary to at most `cap` characters. */
function slug(text: string, cap: number): string {
  const full = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (full.length <= cap) return full
  const cut = full.slice(0, cap + 1).lastIndexOf('-')
  return cut > 0 ? full.slice(0, cut) : full.slice(0, cap)
}

/**
 * What `item` ships in: the milestone or epic it was handed over inside, or the item itself. One unit
 * of work, one review, one branch and one pull request.
 */
export const unitOf = (items: Item[], item: Item): Item => handedScope(items, item) ?? item

/** The branch a unit of work is built on: its id and title, as `e9-agent-coordination`. */
export const branchFor = (item: Item) => `${item.id.toLowerCase()}-${slug(item.title, 40)}`.replace(/-$/, '')

/** A unit's pull request: titled with its id, the body listing what was done and what done meant. */
export function pullRequest(items: Item[], item: Item): { branch: string; title: string; body: string } {
  const tasks = item.kind === 'task' ? [item] : tasksIn(items, item)
  const parts: string[] = []
  if (item.description) parts.push(item.description)
  parts.push(
    tasks
      .map(task => {
        if (isDropped(task)) return `- **${task.id}** ~~${task.title}~~ (won't do)`
        const head = item.kind === 'task' ? '' : `- **${task.id}** ${task.title}\n`
        const pad = item.kind === 'task' ? '' : '  '
        return head + task.checklist.map(c => `${pad}- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      })
      .join('\n')
      .trim(),
  )
  // The tasks' release notes, as they will read in the CHANGELOG.
  const noted = tasks.filter(hasNote)
  if (noted.length)
    parts.push(['### Release notes', ...SECTIONS.flatMap(section => {
      const some = noted.filter(task => sectionFor(task) === section)
      return some.length ? ['', `${section}:`, ...some.map(task => `- ${task.note} (${task.id})`)] : []
    })].join('\n'))
  parts.push(`Tracked on the roadmap as ${item.id}${upOf(item) ? `, in ${path(items, item)}` : ''}.`)
  return { branch: branchFor(item), title: `${item.id}: ${item.title}`, body: parts.filter(Boolean).join('\n\n') }
}

/**
 * A subagent's name on the board, stable for its whole run: a teammate's own name, else its type and
 * task (`explore:find-auth-handlers`). Two agents of one type on one task share it, as they share the work.
 */
export function agentName(type: string, description: string, teammateId?: string): string {
  if (teammateId) return teammateId.split('@')[0] || teammateId
  const task = slug(description, 32)
  return task ? `${slug(type, 24) || 'agent'}:${task}` : slug(type, 24) || 'agent'
}

/**
 * Roadmap ids a text names, as written in a commit, a PR title or a branch: `T12`, `[T12]`, `E9:`,
 * `M4`, `e9-agent-coordination`. A word that only starts like one (`e2e`, `t3a`) is not one.
 */
export function idsIn(text: string): string[] {
  const found = (text.match(/\b[TtEeMm]\d+\b/g) ?? []).map(id => id.toUpperCase())
  return [...new Set(found)]
}

/** Commits from `git log --format=%h%x1f%an%x1f%as%x1f%B%x1e` that name a task id. */
export function parseGitLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map(record => record.replace(/^\n+/, '').split('\x1f'))
    .filter(fields => fields.length >= 4)
    .map(([hash, author, date, body]) => ({
      hash: hash!, author: author!, date: date!, subject: body!.trim().split('\n')[0] ?? '', ids: idsIn(body!),
    }))
    .filter(commit => commit.ids.length > 0)
}

type CheckEntry = { status?: string; conclusion?: string; state?: string }

/** A rollup of check runs and status contexts as one word: a failure wins, then anything unfinished. */
export function checksOf(rollup: CheckEntry[] | null | undefined): Checks {
  const list = rollup ?? []
  if (list.length === 0) return 'none'
  const outcome = (one: CheckEntry) => (one.conclusion || one.state || '').toUpperCase()
  if (list.some(one => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(outcome(one)))) return 'fail'
  if (list.some(one => (one.status && one.status.toUpperCase() !== 'COMPLETED') || ['PENDING', 'EXPECTED', ''].includes(outcome(one)))) return 'pending'
  return 'pass'
}

/** Pull requests from `gh pr list --json number,title,headRefName,baseRefName,state,url,statusCheckRollup` that name a roadmap id. */
export function parsePrs(out: string): Pr[] {
  const list = JSON.parse(out) as { number: number; title: string; headRefName: string; baseRefName?: string; state: string; url: string; statusCheckRollup?: CheckEntry[] }[]
  return list
    .map(pr => ({
      number: pr.number, title: pr.title, state: pr.state.toLowerCase(), url: pr.url,
      ids: idsIn(`${pr.title} ${pr.headRefName}`), checks: checksOf(pr.statusCheckRollup), branch: pr.headRefName, base: pr.baseRefName ?? '',
    }))
    // Those naming items, and release PRs, which the record of releases names.
    .filter(pr => pr.ids.length > 0 || pr.branch.startsWith('release-v'))
}

/** The open pull request a unit of work ships in: the one naming the unit itself. */
export const openPrOf = (refs: Refs, item: Item): Pr | undefined =>
  refs.prs.find(pr => pr.state === 'open' && pr.ids.includes(item.id))

/**
 * The open pull request `pr` is stacked on: the one whose branch it merges into. Merging `pr` first would
 * land it in that branch, not in main, so that one goes first.
 */
export const stackedOn = (refs: Refs, pr: Pr): Pr | undefined =>
  pr.base ? refs.prs.find(one => one.state === 'open' && one.number !== pr.number && one.branch === pr.base) : undefined

/**
 * The stack `pr` is the bottom of: it, then each open PR based on the branch of the one before (the
 * lowest-numbered where two are), up to the top. Just `[pr]` when nothing is stacked on it, or when it
 * is itself stacked on another open PR (only a stack's bottom merges it).
 */
export function stackFrom(refs: Refs, pr: Pr): Pr[] {
  if (stackedOn(refs, pr)) return [pr]
  const out = [pr]
  for (;;) {
    const top = out.at(-1)!
    const next = refs.prs
      .filter(one => one.state === 'open' && one.base === top.branch && !out.includes(one))
      .sort((a, b) => a.number - b.number)[0]
    if (!next) return out
    out.push(next)
  }
}

/** A stack as the card shows it: `#11 ← #12 ← #15`, bottom first. */
export const stackText = (stack: Pr[]) => stack.map(pr => `#${pr.number}`).join(' ← ')

/**
 * The turn telling Claude how merging a stack from the board went: all merged into `base`, so it brings
 * the checkout up to date; or stopped at a PR, with why, so it finds out and fixes what it can.
 */
export function stackNote(stack: Pr[], merged: Pr[], base: string, failure?: { at: Pr; why: string }): string {
  const done = merged.length ? `merged ${merged.map(pr => `#${pr.number} (${pr.branch})`).join(', ')} into ${base}` : 'merged none of it'
  if (failure)
    return (
      `The user merged the stack ${stackText(stack)} from the board, bottom first: it ${done}, then stopped at PR #${failure.at.number} ` +
      `(branch ${failure.at.branch}): ${failure.why}. What is left stays in review. Find out why (failing checks on ${base}, a conflict, branch protection), ` +
      `fix what you can on ${failure.at.branch}, bring the checkout up to date with ${base}, and tell the user whether the rest is ready to merge.`
    )
  return (
    `The user merged the stack ${stackText(stack)} from the board: ${done}, each after its checks passed on ${base}; their items are approved. ` +
    `Bring the checkout up to date: switch to ${base} and pull, delete the local branches ${stack.map(pr => pr.branch).join(', ')}, ` +
    'then say in a line or two what is next on the roadmap.'
  )
}

/** Whether a branch is the repository's main line, where a merged pull request's work is done. */
export const isMainLine = (branch: string) => branch === 'main' || branch === 'master'

/**
 * The commits and pull requests that name `item` or anything under it; and the pull requests of what
 * it sits in, since a task handed over inside an epic ships in the epic's PR.
 */
export function refsFor(items: Item[], refs: Refs, item: Item): Refs {
  const ids = new Set(subtree(items, item.id))
  const above = new Set<string>()
  for (let at = find(items, upOf(item) ?? undefined); at; at = find(items, upOf(at) ?? undefined)) above.add(at.id)
  return {
    commits: refs.commits.filter(commit => commit.ids.some(id => ids.has(id))),
    prs: refs.prs.filter(pr => pr.ids.some(id => ids.has(id) || above.has(id))),
  }
}

export function refsText(found: Refs, limit = 8): string {
  const parts: string[] = []
  if (found.prs.length)
    parts.push('Pull requests:\n' + found.prs.slice(0, limit).map(pr => `  #${pr.number} [${pr.state}] ${pr.title}  ${pr.url}`).join('\n'))
  if (found.commits.length)
    parts.push(
      'Commits:\n' +
        found.commits.slice(0, limit).map(c => `  ${c.hash} ${c.date} ${c.author}: ${c.subject}`).join('\n') +
        (found.commits.length > limit ? `\n  …${found.commits.length - limit} more` : ''),
    )
  return parts.join('\n')
}

/** What git says of the database's path: ignored, tracked-or-not-ignored, or no repository here. */
export type IgnoreState = 'ignored' | 'not-ignored' | 'no-repo'

/** `git check-ignore -q` exits 0 for an ignored path, 1 for one that is not, 128 outside a repository. */
export const ignoreState = (exitCode: number): IgnoreState =>
  exitCode === 0 ? 'ignored' : exitCode === 1 ? 'not-ignored' : 'no-repo'

/** Where the offer stands, per project: absent until first made, `told` until the person answers it. */
export type IgnoreAnswer = 'told' | 'added' | 'dismissed'

/** The offer stands only in a repository that doesn't ignore the database, to someone who hasn't turned it down. */
export const shouldOfferIgnore = (state: IgnoreState, answer: IgnoreAnswer | undefined) =>
  state === 'not-ignored' && answer !== 'dismissed'

export const IGNORE_LINE = '.claude/roadmap.db*'

/** `dir` and the folders above it, nearest first: /a/b gives /a/b, /a, /. */
export function ancestors(dir: string): string[] {
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('/') || '/')
}

/** Why a write found no roadmap to make here, and where to go instead. */
export function noRoadmapHere(dir: string, found: string[]): string {
  const why = `No roadmap here, and none was started: ${dir} is not the top of a git repository, so a new one would be in the wrong place.`
  if (found.length === 0)
    return `${why} Start the session in the project's folder (its git top level; git init it first if it has none) and the first write starts its roadmap there.`
  return `${why} Roadmaps found below it: ${found.join(', ')}. Start the session in the project's folder (cd there and run claude) to use its roadmap.`
}

/** A .gitignore's text with the database's line appended, on a line of its own. */
export function withIgnore(text: string | undefined): string {
  const base = text ?? ''
  const gap = base === '' || base.endsWith('\n') ? '' : '\n'
  return `${base}${gap}# The roadmap tracker's database (binary, per checkout).\n${IGNORE_LINE}\n`
}

/**
 * The release notes of merged work: done tasks with a note whose unit of work has no open pull request,
 * and has a merged one, or none at all and is done (work committed straight to the main line).
 */
export function mergedNotes(items: Item[], refs: Refs): Item[] {
  return rows(items)
    .map(row => row.item)
    .filter(task => task.kind === 'task' && task.status === 'done' && hasNote(task))
    .filter(task => {
      const unit = unitOf(items, task)
      const prs = refs.prs.filter(pr => pr.ids.includes(unit.id))
      if (prs.some(pr => pr.state === 'open')) return false
      // Merged by its PR; or, with none, once its whole unit is done (committed straight to the main line),
      // not while a milestone or epic it ships in is still under way on its branch.
      return prs.some(pr => pr.state === 'merged') || (prs.length === 0 && statusOf(items, unit) === 'done')
    })
    // Newest first, as a CHANGELOG reads.
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || Number(b.id.slice(1)) - Number(a.id.slice(1)))
}

/**
 * A CHANGELOG's text with `notes` added under `## [Unreleased]`, each in its section, newest first, as
 * Keep a Changelog lays it out; the heading and sections are made when missing. A note already in the
 * file is left out. Answers the text and the notes that went in.
 */
export function withNotes(text: string | undefined, notes: { section: Section; note: string }[]): { text: string; added: string[] } {
  const before = text ?? ''
  const fresh = notes.filter((one, i) => !before.includes(one.note) && notes.findIndex(other => other.note === one.note) === i)
  if (fresh.length === 0) return { text: before, added: [] }
  const lines = (before || '# Changelog\n').replace(/\r\n/g, '\n').split('\n')
  let start = lines.findIndex(line => /^## \[?unreleased\]?/i.test(line))
  if (start < 0) {
    // Above the newest version, set off by blank lines.
    const first = lines.findIndex(line => line.startsWith('## '))
    let at = first < 0 ? lines.length : first
    while (at > 0 && lines[at - 1]!.trim() === '') at--
    lines.splice(at, 0, '', '## [Unreleased]', ...(first < 0 ? [] : ['']))
    start = at + 1
    while (start + 2 < lines.length && lines[start + 2]!.trim() === '' && lines[start + 1]!.trim() === '') lines.splice(start + 2, 1)
  }
  for (const section of SECTION_ORDER.filter(one => fresh.some(note => note.section === one))) {
    const bullets = fresh.filter(one => one.section === section).map(one => `- ${one.note}`)
    const next = lines.findIndex((line, i) => i > start && line.startsWith('## '))
    const end = next < 0 ? lines.length : next
    const head = lines.findIndex((line, i) => i > start && i < end && line.trim() === `### ${section}`)
    if (head >= 0) {
      let at = head + 1
      while (at < end && lines[at]!.trim() === '') at++
      if (at < end && lines[at]!.startsWith('- ')) lines.splice(at, 0, ...bullets)
      else lines.splice(head + 1, 0, '', ...bullets)
      continue
    }
    const later = lines.findIndex((line, i) => i > start && i < end && line.startsWith('### ') &&
      SECTION_ORDER.indexOf(line.slice(4).trim()) > SECTION_ORDER.indexOf(section))
    if (later >= 0) lines.splice(later, 0, `### ${section}`, '', ...bullets, '')
    else {
      let at = end
      while (at - 1 > start && lines[at - 1]!.trim() === '') at--
      const block = ['', `### ${section}`, '', ...bullets]
      lines.splice(at, 0, ...block)
      // A blank line between it and whatever follows (the next version's heading).
      const after = at + block.length
      if (after < lines.length && lines[after]!.trim() !== '') lines.splice(after, 0, '')
    }
  }
  return { text: lines.join('\n'), added: fresh.map(one => one.note) }
}

/** A version as `[major, minor, patch]`, from `1.2.3` or `v1.2.3`; undefined when it is not one. */
export function versionOf(text: string | undefined): [number, number, number] | undefined {
  const found = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text?.trim() ?? '')
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined
}

/** Whether version `a` comes after `b`. */
export const isAfter = (a: [number, number, number], b: [number, number, number]) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0

/** A manifest's text (plugin.json, package.json) with its version set, the rest as it was; undefined when it has none. */
export function withVersion(text: string, version: string): string | undefined {
  const pattern = /("version"\s*:\s*")([^"]*)(")/
  return pattern.test(text) ? text.replace(pattern, `$1${version}$3`) : undefined
}

/** The repository's web address from a git remote (`git@github.com:o/r.git`, `https://github.com/o/r.git`). */
export const webOf = (remote: string) =>
  remote.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').replace(/\/+$/, '')

/**
 * A CHANGELOG with its [Unreleased] section cut as `version`, dated `date`, under a fresh empty
 * [Unreleased], and its links pointing [Unreleased] at what comes after the version's tag. Answers the
 * text and the version's notes (what [Unreleased] held), or throws when there is nothing to release.
 */
export function cutRelease(text: string, version: string, date: string, web: string): { text: string; notes: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => /^## \[?unreleased\]?/i.test(line))
  if (start < 0) throw new Error('the CHANGELOG has no [Unreleased] section to release')
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  const links = lines.findIndex((line, i) => i > start && /^\[[^\]]+\]: \S/.test(line))
  const end = next >= 0 ? next : links >= 0 ? links : lines.length
  const notes = lines.slice(start + 1, end).join('\n').trim()
  if (!notes) throw new Error('nothing is under [Unreleased] in the CHANGELOG; there is nothing to release')
  lines.splice(start, 1, '## [Unreleased]', '', `## [${version}] - ${date}`)
  // The links: [Unreleased] now compares against this version's tag, which gets one of its own.
  const ours = [`[Unreleased]: ${web}/compare/v${version}...HEAD`, `[${version}]: ${web}/releases/tag/v${version}`]
  const old = lines.findIndex(line => /^\[unreleased\]: /i.test(line))
  if (old >= 0) lines.splice(old, 1, ...ours)
  else {
    while (lines.length && lines.at(-1)!.trim() === '') lines.pop()
    lines.push('', ...ours, '')
  }
  return { text: lines.join('\n'), notes }
}
