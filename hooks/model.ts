import type { Activity, Checks, Commit, IssueType, Item, Kind, PlanNode, PlannedItem, Pr, Priority, Query, Refs, Snapshot, Status } from '../types'

// The person at the board, and the main loop's agent; subagents go by names from agentName.
export const USER = 'user'
export const CLAUDE = 'claude'
export const KINDS: Kind[] = ['milestone', 'epic', 'task']
export const STATUSES: Status[] = ['todo', 'in_progress', 'blocked', 'review', 'done']
export const GLYPH: Record<Status, string> = { todo: '○', in_progress: '◐', blocked: '✗', review: '◉', done: '●' }
export const LABEL: Record<Status, string> = { todo: 'Todo', in_progress: 'In progress', blocked: 'Blocked', review: 'Review', done: 'Done' }
export const PRIORITIES: Priority[] = ['p0', 'p1', 'p2', 'p3']
export const TYPES: IssueType[] = ['feature', 'bug', 'chore']
/** Priority and type as worth saying: the defaults (p2, feature) go without saying. */
export const marks = (item: Item) =>
  [item.priority && item.priority !== 'p2' ? item.priority : '', item.type && item.type !== 'feature' ? item.type : ''].filter(Boolean)
const byPriority = (a: Item, b: Item) => PRIORITIES.indexOf(a.priority ?? 'p2') - PRIORITIES.indexOf(b.priority ?? 'p2')
export const PREFIX: Record<Kind, string> = { milestone: 'M', epic: 'E', task: 'T' }
// Which kinds each kind may sit under.
const PARENTS: Record<Kind, Kind[]> = { milestone: [], epic: ['milestone'], task: ['epic', 'milestone'] }

export const emptySnapshot = (): Snapshot => ({ items: [], activity: [], seen: {} })

export const find = (items: Item[], id: string | undefined) =>
  id === undefined ? undefined : items.find(item => item.id.toUpperCase() === id.toUpperCase())

export const childrenOf = (items: Item[], id: string | null) => items.filter(item => item.parent === id)

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
    else if ((PRIORITIES as string[]).includes(low)) add('priority', low as Priority)
    else if ((TYPES as string[]).includes(low)) add('type', low as IssueType)
    else if (STATUS_WORDS[low]) add('status', STATUS_WORDS[low]!)
    else words.push(word)
  }
  if (words.length) q.text = words.join(' ')
  return Object.keys(q).length ? q : undefined
}

/** Whether `item` is what `query` looks for. Status is the rolled-up one, as the board shows it. */
export function matches(snap: Snapshot, item: Item, query: Query): boolean {
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
  if (query.text?.trim()) {
    const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
    const said = snap.activity.filter(one => one.item_id === item.id && isMessage(one)).map(one => one.body)
    const hay = [item.id, item.title, item.description ?? '', ...said].join('\n').toLowerCase()
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

const tasksUnder = (items: Item[], item: Item) =>
  subtree(items, item.id)
    .map(id => find(items, id)!)
    .filter(one => one.kind === 'task' && one.id !== item.id)

/** Tasks in an item's subtree: done and total. */
export function progress(items: Item[], item: Item): { done: number; total: number } {
  if (item.kind === 'task') return { done: item.status === 'done' ? 1 : 0, total: 1 }
  const tasks = tasksUnder(items, item)
  return { done: tasks.filter(task => task.status === 'done').length, total: tasks.length }
}

/** Whether `who` is an agent: anyone holding work who isn't the person at the board. */
export const isAgent = (who: string | null | undefined) => Boolean(who) && who !== USER

/**
 * The milestone or epic above `item` that was handed to an agent as a whole, the outermost when there
 * are several: the unit of work that is reviewed once, at its end, in place of what is inside it.
 */
export function handedScope(items: Item[], item: Item): Item | undefined {
  let scope: Item | undefined
  for (let at = find(items, item.parent ?? undefined); at; at = find(items, at.parent ?? undefined))
    if (at.kind !== 'task' && isAgent(at.assignee)) scope = at
  return scope
}

/**
 * A milestone's or epic's status follows its tasks once it has any; a task's is its own. A milestone or
 * epic handed to an agent as a whole is reviewed once its tasks are all done: it reads `review` until
 * the person approves it (its own status set to done), or `in_progress` once they've asked for changes.
 */
export function statusOf(items: Item[], item: Item): Status {
  if (item.kind === 'task') return item.status
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
  for (let at = find(items, item.parent ?? undefined); at; at = find(items, at.parent ?? undefined)) chain.unshift(at)
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
  return `${item.id} ${GLYPH[status]} ${status} ${item.title}${bits ? `  (${bits})` : ''}`
}

export function outline(items: Item[], root: string | null = null): string {
  return rows(items, root)
    .map(({ item, depth }) => '  '.repeat(depth) + line(items, item))
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

/** Whether an entry is something someone wrote (a comment or a handoff note), not a change the tracker logged. */
export const isMessage = (one: Activity) => one.type === 'comment' || one.type === 'handoff'

export const timeline = (activity: Activity[], id: string) =>
  activity.filter(one => one.item_id === id).sort((a, b) => a.id - b.id)

export function detail(snap: Snapshot, item: Item, limit = 15): string {
  const parts = [line(snap.items, item)]
  const where = path(snap.items, item)
  if (where) parts.push(`in: ${where}`)
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
  const under = outline(snap.items, item.id)
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
    .sort((a, b) => Number(a.parent !== null) - Number(b.parent !== null) || byPriority(a, b) || Number(a.id.slice(1)) - Number(b.id.slice(1)))

/**
 * What to work on next for `actor`: their own open tasks (those still waiting on others last), then
 * unassigned todo tasks that wait on nothing unfinished, by priority, then due date, then others'
 * claims gone stale (given `now`), which a claim takes over.
 */
export function nextUp(items: Item[], actor: string, now?: number): Item[] {
  const tasks = items.filter(item => item.kind === 'task')
  const mine = tasks.filter(task => task.assignee === actor && task.status !== 'done')
  const due = (task: Item) => {
    let at: Item | undefined = task
    while (at && !at.due) at = find(items, at.parent ?? undefined)
    return at?.due ?? '9999'
  }
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

/** The roadmap as a short brief for an agent: its own work, what is blocked, and what changed. */
export function brief(snap: Snapshot, actor: string, news: Activity[], now?: number, refs?: Refs): string | undefined {
  if (snap.items.length === 0) return undefined
  const items = snap.items
  const tasks = items.filter(item => item.kind === 'task')
  const list = (some: Item[], cap = 8) =>
    some.slice(0, cap).map(item => `- ${line(items, item)}${item.parent ? ` [${item.parent}]` : ''}`).join('\n') +
    (some.length > cap ? `\n- …${some.length - cap} more` : '')
  const milestones = items.filter(item => item.kind === 'milestone' && statusOf(items, item) !== 'done').sort(byId)
  const mine = tasks.filter(task => task.assignee === actor && task.status !== 'done' && task.status !== 'review')
  const blocked = tasks.filter(task => task.status === 'blocked')
  const review = items.filter(item => statusOf(items, item) === 'review')
  const stale = now === undefined ? [] : tasks.filter(task => task.assignee !== actor && isStale(task, now))
  const active = tasks.filter(task => task.status === 'in_progress' && task.assignee !== actor && !stale.includes(task))
  const parts = [
    'Project roadmap (roadmap tool; .claude/roadmap.db). Keep it current: claim a task before working on it, comment on progress and decisions, set done when finished (it goes to review for the user to approve).',
  ]
  if (milestones.length) parts.push('Open milestones:\n' + list(milestones, 4))
  if (mine.length) parts.push(`Assigned to you (${actor}):\n` + list(mine))
  if (active.length) parts.push('In progress by others:\n' + list(active))
  if (stale.length)
    parts.push(`Stale claims (holder silent over ${LEASE_MS / 60_000} min; claiming takes one over):\n` + list(stale))
  if (blocked.length) parts.push('Blocked:\n' + list(blocked))
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
  if (news.length)
    parts.push(
      'Changes by the user since you last looked:\n' +
        news.slice(-10).map(one => `- ${one.item_id}: ${one.body}`).join('\n'),
    )
  return `<roadmap>\n${parts.join('\n\n')}\n</roadmap>`
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
  const tasks = item.kind === 'task' ? [item] : subtree(items, item.id).map(id => find(items, id)!).filter(one => one.kind === 'task')
  const parts: string[] = []
  if (item.description) parts.push(item.description)
  parts.push(
    tasks
      .map(task => {
        const head = item.kind === 'task' ? '' : `- **${task.id}** ${task.title}\n`
        const pad = item.kind === 'task' ? '' : '  '
        return head + task.checklist.map(c => `${pad}- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      })
      .join('\n')
      .trim(),
  )
  parts.push(`Tracked on the roadmap as ${item.id}${item.parent ? `, in ${path(items, item)}` : ''}.`)
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

/** Pull requests from `gh pr list --json number,title,headRefName,state,url,statusCheckRollup` that name a roadmap id. */
export function parsePrs(out: string): Pr[] {
  const list = JSON.parse(out) as { number: number; title: string; headRefName: string; state: string; url: string; statusCheckRollup?: CheckEntry[] }[]
  return list
    .map(pr => ({
      number: pr.number, title: pr.title, state: pr.state.toLowerCase(), url: pr.url,
      ids: idsIn(`${pr.title} ${pr.headRefName}`), checks: checksOf(pr.statusCheckRollup),
    }))
    .filter(pr => pr.ids.length > 0)
}

/** The open pull request a unit of work ships in: the one naming the unit itself. */
export const openPrOf = (refs: Refs, item: Item): Pr | undefined =>
  refs.prs.find(pr => pr.state === 'open' && pr.ids.includes(item.id))

/**
 * The commits and pull requests that name `item` or anything under it; and the pull requests of what
 * it sits in, since a task handed over inside an epic ships in the epic's PR.
 */
export function refsFor(items: Item[], refs: Refs, item: Item): Refs {
  const ids = new Set(subtree(items, item.id))
  const above = new Set<string>()
  for (let at = find(items, item.parent ?? undefined); at; at = find(items, at.parent ?? undefined)) above.add(at.id)
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

/** A .gitignore's text with the database's line appended, on a line of its own. */
export function withIgnore(text: string | undefined): string {
  const base = text ?? ''
  const gap = base === '' || base.endsWith('\n') ? '' : '\n'
  return `${base}${gap}# The roadmap tracker's database (binary, per checkout).\n${IGNORE_LINE}\n`
}
