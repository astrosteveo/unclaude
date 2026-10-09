import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft, IssueType, Item, Kind, PlanNode, Priority, Query, Refs, Snapshot, Status, View } from '../types'
import type { IgnoreAnswer } from './model'
import * as db from './db'
import { COLOR, drawPane, type PaneActions, type PaneState } from './pane'
import {
  agentName, brief, handedScope, CLAUDE, line, matches, checkLinks, checkPlan, PRIORITIES, TYPES, ignoreState, shouldOfferIgnore, withIgnore, checkBlockers, checkParent, detail, emptySnapshot, find, KINDS, nextUp, outline, progress, rows,
  parseGitLog, parsePrs, refsFor, refsText, STATUSES, subtree, USER, waitingOn,
} from './model'

const PANE = 'roadmap'
const TOOL = 'mcp__roadmap__roadmap'
// Tools whose use counts as work that may have moved a task along.
const WORK = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])

const snapshot = atom({ plugin: 'roadmap', key: 'snapshot' } as const, emptySnapshot())
const view = atom({ plugin: 'roadmap', key: 'view' } as const, 'board' as View)
const selected = atom({ plugin: 'roadmap', key: 'selected' } as const, null as string | null)
// Whether to offer adding the database to .gitignore (see `checkIgnore`).
const ignoreOffer = atom({ plugin: 'roadmap', key: 'ignoreOffer' } as const, false)
let isIgnoreChecked = false
// Whether the open card is asking what needs changing before sending it back from review.
const requesting = atom({ plugin: 'roadmap', key: 'requesting' } as const, false)
// The board's filter as typed, and whether its field is open.
const filter = atom({ plugin: 'roadmap', key: 'filter' } as const, '')
const filtering = atom({ plugin: 'roadmap', key: 'filtering' } as const, false)
// The new-item form's choices while it is open.
const draft = atom({ plugin: 'roadmap', key: 'draft' } as const, null as Draft | null)
// How many rows the open card's sections are scrolled under its fixed title and bar.
const scrolled = atom({ plugin: 'roadmap', key: 'scrolled' } as const, 0)
// The furthest the open card can scroll, as last drawn.
let scrollMax = 0
// Commits and pull requests that name tasks, refreshed in the background (see `refreshRefs`).
const refs = atom({ plugin: 'roadmap', key: 'refs' } as const, { commits: [], prs: [] } as Refs)
// Why the database cannot be read, shown in the pane in place of the board.
const problem = atom({ plugin: 'roadmap', key: 'problem' } as const, null as string | null)

// When git and gh were last asked; gh goes over the network, so it is asked far less often.
let gitAskedAt = 0
let ghAskedAt = 0
const GIT_EVERY = 15_000
const GH_EVERY = 120_000

/**
 * Re-reads the commits (and, where gh is installed and signed in, the pull requests) that name task ids.
 * Not a git repository, no gh, no network: each just comes back empty.
 */
async function refreshRefs($: EngineInterface, isForced = false) {
  const now = await $.clock.now()
  const current = await read($, refs)
  let { commits, prs } = current
  if (isForced || now - gitAskedAt > GIT_EVERY) {
    gitAskedAt = now
    const ran = await $.process
      .run(['git', 'log', '-n', '1000', '--format=%h%x1f%an%x1f%as%x1f%B%x1e'])
      .catch(() => undefined)
    commits = ran && ran.exitCode === 0 ? parseGitLog(ran.stdout) : []
  }
  if (isForced || now - ghAskedAt > GH_EVERY) {
    ghAskedAt = now
    const ran = await $.process
      .run(['gh', 'pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,title,headRefName,state,url'], { timeoutMs: 15_000 })
      .catch(() => undefined)
    try {
      prs = ran && ran.exitCode === 0 ? parsePrs(ran.stdout) : []
    } catch {
      prs = []
    }
  }
  if (JSON.stringify({ commits, prs }) !== JSON.stringify(current)) await update($, refs, () => ({ commits, prs }))
  return { commits, prs }
}


export const MISSING_SQLITE =
  'sqlite3 is not installed or not on PATH, and the roadmap is stored with it. Install it ' +
  '(Arch: pacman -S sqlite; Debian/Ubuntu: apt install sqlite3; Fedora: dnf install sqlite; macOS: brew install sqlite), then run /roadmap again.'


// The main loop's view of the roadmap: the newest activity it has been told about, and whether it
// has done work since it last touched the roadmap. Module state: a reload starts both over.
let seenActivity = -1
let hasWorkedSinceUpdate = false
let dbStamp = ''
let hasDir = false
// Subagent ids to their board names, learned at spawn or from the running list.
const agentNames = new Map<string, string>()

async function actorFor($: EngineInterface, agentId: string | undefined, as: string | undefined): Promise<string> {
  if (as?.trim()) return as.trim()
  if (!agentId) return CLAUDE
  const known = agentNames.get(agentId)
  if (known) return known
  const info = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)
  if (!info) return `agent-${agentId.slice(0, 8)}`
  const name = agentName(info.type, info.description, info.teammateId)
  agentNames.set(agentId, name)
  return name
}

// When each actor's leases were last renewed, so a busy agent renews at most every RENEW_EVERY.
const renewedAt = new Map<string, number>()
const RENEW_EVERY = 5 * 60_000

/** Renews `actor`'s leases, unless done within RENEW_EVERY (or `isForced`), in a project with a roadmap. */
async function heartbeat($: EngineInterface, actor: string, isForced = false) {
  const now = await $.clock.now()
  if (!isForced && now - (renewedAt.get(actor) ?? 0) < RENEW_EVERY) return
  renewedAt.set(actor, now)
  if (await hasDb($)) await sql($, db.renew(actor))
}

/** Runs one script through sqlite3 and answers what its last statement printed. */
async function run($: EngineInterface, script: string): Promise<string> {
  const ran = await $.process.run(db.ARGV, { stdin: script }).catch(async (err: unknown) => {
    // A command that cannot start rejects; tell a missing sqlite3 apart from, say, a timeout.
    const isThere = await $.process.run(['sqlite3', '-version']).then(() => true, () => false)
    throw isThere ? err : new Error(MISSING_SQLITE)
  })
  if (ran.exitCode !== 0) throw new Error(`sqlite3: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
  return db.answer(ran.stdout)
}

// Whether this load has seen the database at the schema version it reads. Cleared when the file
// changes under us (a checkout, a copy), so a swapped-in database is checked again.
let isSchemaReady = false

/** Brings the database to this build's schema version, or throws when it is from a newer build. */
async function ensureSchema($: EngineInterface) {
  const version = Number(await run($, db.READ_VERSION))
  const problem = db.versionProblem(version)
  if (problem) throw new Error(problem)
  if (version < db.VERSION) {
    try {
      await run($, db.migrate(version))
    } catch (err) {
      // Another session may have migrated first, and a migration that is not idempotent then fails here.
      const now = Number(await run($, db.READ_VERSION))
      if (now !== db.VERSION) throw err
    }
  }
  isSchemaReady = true
}

async function sql($: EngineInterface, script: string): Promise<string> {
  if (!hasDir) {
    // A folder that cannot be made shows up as sqlite3's own "unable to open database".
    await $.process.run(['mkdir', '-p', '.claude']).catch(() => undefined)
    hasDir = true
  }
  if (!isSchemaReady) await ensureSchema($)
  return run($, script)
}

/** Whether the project has a roadmap yet. Reads never make one: the database is created by the first write. */
const hasDb = ($: EngineInterface) => $.fs.stat(db.DB).then(() => true, () => false)

async function refresh($: EngineInterface): Promise<Snapshot> {
  try {
    if (!(await hasDb($))) {
      // Dormant: a project that never used the roadmap gets no file, no folder and no sqlite3.
      const empty = emptySnapshot()
      await update($, snapshot, () => empty)
      await update($, problem, () => null)
      return empty
    }
    const snap = db.parseLoad(await sql($, db.load(USER)))
    await update($, snapshot, () => snap)
    await update($, problem, () => null)
    return snap
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, problem, () => message)
    throw err
  }
}

/** Reloads when another process (an agent in another session, a git checkout) changed the database. */
/** The person's answers to the .gitignore offer, by project root, kept across sessions. */
async function ignoreAnswers($: EngineInterface): Promise<Record<string, IgnoreAnswer>> {
  return ((await $.store.get('gitignore')) ?? {}) as Record<string, IgnoreAnswer>
}

async function answerIgnore($: EngineInterface, answer: IgnoreAnswer) {
  const root = await $.session.root()
  await $.store.set('gitignore', { ...(await ignoreAnswers($)), [root]: answer })
}

/**
 * Once the database exists, asks git whether it is ignored. A binary database in a commit is a merge
 * conflict waiting to happen, so where it isn't, the board offers to add it; nothing is written unasked.
 */
async function checkIgnore($: EngineInterface) {
  isIgnoreChecked = true
  const ran = await $.process.run(['git', 'check-ignore', '-q', db.DB]).catch(() => undefined)
  if (!ran) return
  const answer = (await ignoreAnswers($))[await $.session.root()]
  const isOffered = shouldOfferIgnore(ignoreState(ran.exitCode), answer)
  await update($, ignoreOffer, () => isOffered)
  // Said once per project: after that the offer waits on the board until answered.
  if (isOffered && answer === undefined) {
    $.ui.toast(`roadmap: ${db.DB} isn't in .gitignore. Open /roadmap to add it.`, { timeoutMs: 8000 })
    await answerIgnore($, 'told')
  }
}

async function addIgnore($: EngineInterface) {
  const text = await $.fs.read('.gitignore').then(t => String(t), () => undefined)
  await $.fs.write('.gitignore', withIgnore(text))
  await answerIgnore($, 'added')
  await update($, ignoreOffer, () => false)
  $.ui.toast(`roadmap: added ${db.DB}* to .gitignore`)
}

async function dismissIgnore($: EngineInterface) {
  await answerIgnore($, 'dismissed')
  await update($, ignoreOffer, () => false)
}

async function poll($: EngineInterface) {
  const stamps = await Promise.all(
    [db.DB, `${db.DB}-wal`].map(file => $.fs.stat(file).then(s => `${s.size}:${s.mtimeMs}`, () => '-')),
  )
  const stamp = stamps.join('|')
  if (stamp !== dbStamp) {
    dbStamp = stamp
    isSchemaReady = false
    await refresh($)
  }
  // Without a roadmap there is nothing to link commits to, so git and gh aren't asked.
  if (stamps[0] === '-') return
  if (!isIgnoreChecked) await checkIgnore($)
  await refreshRefs($)
}

type Input = {
  action: 'show' | 'next' | 'find' | 'add' | 'plan' | 'update' | 'claim' | 'release' | 'comment' | 'check' | 'remove'
  id?: string
  kind?: Kind
  title?: string
  description?: string
  status?: Status
  parent?: string
  assignee?: string
  due?: string
  priority?: Priority
  type?: IssueType
  labels?: string[] | string
  tree?: PlanNode[] | PlanNode | string
  under?: string
  text?: string
  relates_to?: string[] | string
  duplicates?: string
  body?: string
  blocked_by?: string[] | string
  checklist?: string[] | string
  items?: number[] | string
  done?: boolean
  as?: string
  approved?: boolean
  force?: boolean
  cascade?: boolean
}

const fail = (message: string): never => {
  throw new Error(message)
}

/**
 * A list argument as the model may send it: a real list, a list sent as JSON text (it does that while its
 * copy of the tool's schema predates the field), or plain text split on `separator`. Entries are trimmed,
 * empty ones dropped.
 */
function listOf(value: unknown, separator: RegExp): string[] {
  let list = value
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      list = JSON.parse(value)
    } catch {
      // Not JSON after all: split it below.
    }
  }
  const entries = Array.isArray(list) ? list.map(String) : String(list ?? '').split(separator)
  return entries.map(entry => entry.trim()).filter(Boolean)
}

/** Checklist texts: one per line when sent as plain text. */
const texts = (value: unknown) => listOf(value, /\n/)

/** `blocked_by` ids: comma-separated when sent as plain text. */
const idList = (value: unknown) => listOf(value, /,/)

/** `check` entry numbers. */
const numbers = (value: unknown) => listOf(value, /,/).map(Number)

/**
 * Carries out one roadmap action for `actor`. Agents don't close their own work: their `done` goes to
 * review, and only the person (on the board) or the main loop passing on their approval sets done.
 */
async function act($: EngineInterface, actor: string, a: Input, isSubagent = false): Promise<string> {
  const snap = await refresh($)
  const item = find(snap.items, a.id)
  const need = () => item ?? fail(a.id ? `No item ${a.id}` : 'id is required')
  if (a.status && !STATUSES.includes(a.status)) fail(`status must be one of ${STATUSES.join(', ')}`)
  if (a.priority && !PRIORITIES.includes(a.priority)) fail(`priority must be one of ${PRIORITIES.join(', ')}`)
  if (a.type && !TYPES.includes(a.type)) fail(`type must be one of ${TYPES.join(', ')}`)

  switch (a.action) {
    case 'show':
      if (a.id) {
        const it = need()
        const linked = refsText(refsFor(snap.items, await refreshRefs($, true), it))
        return detail(snap, it) + (linked ? `\n${linked}` : '')
      }
      return outline(snap.items) || 'The roadmap is empty.'
    case 'next': {
      const up = nextUp(snap.items, actor, await $.clock.now().catch(() => undefined)).slice(0, 5)
      if (up.length === 0) return 'Nothing open: no tasks assigned to you and no unassigned todo tasks.'
      return up.map(task => detail(snap, task, 5)).join('\n\n')
    }
    case 'find': {
      const query: Query = {
        kind: a.kind,
        status: a.status ? [a.status] : undefined,
        assignee: a.assignee ? [a.assignee] : undefined,
        priority: a.priority ? [a.priority] : undefined,
        type: a.type ? [a.type] : undefined,
        labels: a.labels === undefined ? undefined : idList(a.labels).map(db.label),
        under: a.under || undefined,
        text: a.text || undefined,
      }
      if (query.under && !find(snap.items, query.under)) fail(`No item ${query.under}`)
      const found = rows(snap.items).map(row => row.item).filter(one => matches(snap, one, query))
      if (found.length === 0) return 'Nothing matches.'
      const cap = 40
      return [
        `${found.length} match${found.length === 1 ? '' : 'es'}:`,
        ...found.slice(0, cap).map(one => `${line(snap.items, one)}${one.parent ? ` [${one.parent}]` : ''}`),
        ...(found.length > cap ? [`…${found.length - cap} more; narrow the search`] : []),
      ].join('\n')
    }
    case 'add': {
      if (!a.kind || !KINDS.includes(a.kind)) fail(`kind must be one of ${KINDS.join(', ')}`)
      if (!a.title?.trim()) fail('title is required')
      if (a.blocked_by !== undefined && a.kind !== 'task') fail('Only tasks wait on other tasks')
      // Checked before the insert, against a placeholder id no existing task can wait on.
      const blockers = a.blocked_by === undefined ? [] : checkBlockers(snap.items, '\u0000new', idList(a.blocked_by))
      const id = await sql($, db.insert(actor, {
        kind: a.kind!,
        title: a.title!.trim(),
        parent: checkParent(snap.items, a.kind!, a.parent),
        description: a.description,
        due: a.due,
        status: a.status,
        assignee: a.assignee,
        priority: a.priority || undefined,
        type: a.type || undefined,
      }))
      const checklist = a.checklist === undefined ? [] : texts(a.checklist)
      if (checklist.length && a.kind !== 'task') fail('Only tasks carry a checklist')
      const related = a.relates_to === undefined ? [] : checkLinks(snap.items, '\u0000new', idList(a.relates_to))
      const original = a.duplicates ? checkLinks(snap.items, '\u0000new', [a.duplicates]) : []
      const tags = a.labels === undefined ? [] : idList(a.labels)
      if (blockers.length || checklist.length || related.length || original.length || tags.length) {
        const created = find((await refresh($)).items, id) as Item
        if (blockers.length) await sql($, db.setBlockers(actor, created, blockers).script)
        if (checklist.length) await sql($, db.setChecklist(actor, created, checklist).script)
        if (tags.length) await sql($, db.setLabels(actor, created, tags).script)
        if (related.length) await sql($, db.setRelations(actor, created, 'relates', related).script)
        if (original.length) await sql($, db.setRelations(actor, created, 'duplicates', original).script)
      }
      return `Added ${id}: ${a.title!.trim()}${blockers.length ? `, blocked by ${blockers.join(', ')}` : ''}`
    }
    case 'update': {
      const it = need()
      if (a.checklist !== undefined && it.kind !== 'task') fail('Only tasks carry a checklist')
      const list = a.checklist === undefined ? it.checklist : db.setChecklistPreview(it, texts(a.checklist))
      const open = list.filter(c => !c.done)
      if (a.status === 'done' && open.length && !a.force)
        fail(
          `${it.id} has ${open.length} unchecked item(s): ${open.map(c => `${c.n}. ${c.text}`).join('; ')}. ` +
            'Check them (action check), or pass force: true to close it anyway.',
        )
      if (a.approved && actor === USER) a.approved = undefined
      if (a.approved && isSubagent) fail('Only the user approves work; a subagent sets done and it goes to review.')
      if (a.approved && a.status !== 'done') fail('approved goes with status: done')
      // An agent's done waits on the user's approval in review; the person's own is final. Inside a
      // milestone or epic handed over whole, a task's done is final too: the review comes once, on that.
      const scope = it.kind === 'task' ? handedScope(snap.items, it) : undefined
      const isToReview = a.status === 'done' && actor !== USER && !a.approved && !scope
      const left = progress(snap.items, it)
      if (isToReview && it.kind !== 'task' && left.done < left.total)
        fail(`${it.id} closes when its tasks are done; finish those (they close as you go when ${it.id} is assigned to you)`)
      const { script, notes } = db.change(actor, it, {
        title: a.title?.trim() || undefined,
        status: isToReview ? 'review' : a.status,
        description: a.description === undefined ? undefined : a.description || null,
        due: a.due === undefined ? undefined : a.due || null,
        assignee: a.assignee === undefined ? undefined : a.assignee || null,
        priority: a.priority || undefined,
        type: a.type || undefined,
        parent: a.parent === undefined ? undefined : checkParent(snap.items, it.kind, a.parent, it.id),
      })
      if (script) await sql($, script)
      if (a.checklist !== undefined) {
        const set = db.setChecklist(actor, it, texts(a.checklist))
        if (set.script) await sql($, set.script)
        notes.push(...set.notes)
      }
      if (a.blocked_by !== undefined) {
        if (it.kind !== 'task') fail('Only tasks wait on other tasks')
        const links = db.setBlockers(actor, it, checkBlockers(snap.items, it.id, idList(a.blocked_by)))
        if (links.script) await sql($, links.script)
        notes.push(...links.notes)
      }
      if (a.labels !== undefined) {
        const set = db.setLabels(actor, it, idList(a.labels))
        if (set.script) await sql($, set.script)
        notes.push(...set.notes)
      }
      if (a.relates_to !== undefined) {
        const set = db.setRelations(actor, it, 'relates', checkLinks(snap.items, it.id, idList(a.relates_to)))
        if (set.script) await sql($, set.script)
        notes.push(...set.notes)
      }
      if (a.duplicates !== undefined) {
        const set = db.setRelations(actor, it, 'duplicates', checkLinks(snap.items, it.id, idList(a.duplicates)))
        if (set.script) await sql($, set.script)
        notes.push(...set.notes)
      }
      if (isToReview)
        notes.push("waiting on the user's approval. They approve on the board; pass approved: true only when they tell you in chat")
      else if (scope && a.status === 'done' && actor !== USER)
        notes.push(`closed as part of ${scope.id}, which the user reviews as a whole once all its tasks are done`)
      else if (a.approved) notes.push('approved by the user')
      return notes.length ? `${it.id}: ${notes.join('; ')}` : `${it.id}: nothing changed`
    }
    case 'claim': {
      const it = need()
      if (it.kind !== 'task') fail(`Only tasks are claimed; ${it.id} is a ${it.kind}. Claim its tasks one at a time.`)
      const waiting = waitingOn(snap.items, it)
      if (waiting.length && !a.force)
        fail(`${it.id} waits on ${waiting.map(one => `${one.id} (${one.status})`).join(', ')}; finish those first, or pass force: true`)
      const holder = (await sql($, db.claim(actor, it.id, a.force === true, it.assignee))) || null
      const tookOver = it.assignee && it.assignee !== actor ? ` Took it over from ${it.assignee}${a.force ? '' : ', whose claim had gone stale'}.` : ''
      if (holder !== actor) fail(`${it.id} is held by ${holder}; leave it, or pass force: true if they handed it to you`)
      // Everything needed to start cold: the task as it stands, its notes, and the work already committed.
      const after = await refresh($)
      // Commits are extra context: a repository that can't be asked leaves them out, not the claim.
      const known = await refreshRefs($, true).catch(() => ({ commits: [], prs: [] }) as Refs)
      const linked = refsText(refsFor(after.items, known, it))
      return `${it.id} is yours (${actor}), in progress.${tookOver}\n\n${detail(after, find(after.items, it.id) ?? it, 10)}${linked ? `\n${linked}` : ''}`
    }
    case 'release': {
      const it = need()
      // The note goes in first, so the timeline reads: what was left, then who let go.
      if (a.body?.trim()) await sql($, db.comment(actor, it.id, a.body.trim(), 'handoff'))
      const { script } = db.change(actor, it, { assignee: null })
      if (script) await sql($, script)
      return `${it.id} released${a.body?.trim() ? ', with your handoff note' : ''}.`
    }
    case 'check': {
      const it = need()
      if (!it.checklist.length) fail(`${it.id} has no checklist; set one with update checklist`)
      const ns = numbers(a.items ?? [])
      const unknown = ns.filter(n => !it.checklist.some(c => c.n === n))
      if (ns.length === 0 || unknown.length)
        fail(`items must name entries 1–${it.checklist.length}${unknown.length ? `; there is no ${unknown.join(', ')}` : ''}`)
      const { script, notes } = db.check(actor, it, ns, a.done !== false)
      if (script) await sql($, script)
      const left = it.checklist.filter(c => !(ns.includes(c.n) ? a.done !== false : c.done)).length
      return `${it.id}: ${notes.length ? notes.join('; ') : 'nothing changed'}. ${left ? `${left} left to check.` : 'All checked.'}`
    }
    case 'comment': {
      const it = need()
      if (!a.body?.trim()) fail('body is required')
      await sql($, db.comment(actor, it.id, a.body!.trim()))
      return `Commented on ${it.id}.`
    }
    case 'plan': {
      let tree: unknown = a.tree
      if (typeof tree === 'string') {
        try {
          tree = JSON.parse(tree)
        } catch {
          fail('tree must be a list of items (JSON)')
        }
      }
      const nodes = (Array.isArray(tree) ? tree : tree ? [tree] : []) as PlanNode[]
      if (nodes.length === 0) fail('tree is required: a list of { kind, title, …, children }')
      // All or nothing up front: nothing is written until the whole tree has passed.
      const planned = checkPlan(snap.items, nodes, a.parent || undefined)
      const ids = new Map<string, string>()
      for (const one of planned) {
        const n = one.node
        const id = await sql($, db.insert(actor, {
          kind: n.kind,
          title: n.title.trim(),
          parent: one.parentRef ? ids.get(one.parentRef)! : one.parentId,
          description: n.description,
          due: n.due,
          assignee: n.assignee,
          priority: n.priority,
          type: n.type,
        }))
        ids.set(one.ref, id)
      }
      const after = (await refresh($)).items
      for (const one of planned) {
        const created = find(after, ids.get(one.ref))!
        const blockers = [...one.blockerRefs.map(ref => ids.get(ref)!), ...one.blockerIds]
        if (blockers.length) await sql($, db.setBlockers(actor, created, blockers).script)
        if (one.node.checklist?.length) await sql($, db.setChecklist(actor, created, texts(one.node.checklist)).script)
        if (one.node.labels?.length) await sql($, db.setLabels(actor, created, idList(one.node.labels)).script)
      }
      const final = (await refresh($)).items
      const roots = planned.filter(one => !one.parentRef).map(one => ids.get(one.ref)!)
      return [
        `Planned ${planned.length} item(s): ${planned.map(one => `${one.ref} → ${ids.get(one.ref)}`).join(', ')}`,
        ...roots.map(id => [line(final, find(final, id)!), outline(final, id)].filter(Boolean).join('\n')),
      ].join('\n')
    }
    case 'remove': {
      const it = need()
      const ids = subtree(snap.items, it.id)
      if (ids.length > 1 && !a.cascade)
        fail(`${it.id} has ${ids.length - 1} item(s) under it; pass cascade: true to remove them too`)
      await sql($, db.remove(ids))
      return `Removed ${ids.join(', ')}`
    }
  }
  return fail(`Unknown action ${a.action}`)
}

/** A change the person makes from the pane: written as `user`, then redrawn. */
async function userAct($: EngineInterface, a: Input) {
  try {
    await act($, USER, a)
    // What the person just did there, they have seen.
    if (a.id && a.action !== 'remove') await sql($, db.markSeen(USER, a.id))
  } catch (err) {
    $.ui.toast(`roadmap: ${err instanceof Error ? err.message : String(err)}`)
  }
  await refresh($)
}


/** Moves the keyboard ring to an element of the pane; a pane not holding the keys just stays as it is. */
const focusOn = ($: EngineInterface, key: string) => $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

// The inline height an open card asks for: more than most cards need; the layout caps it.
const CARD_ROWS = 40


/** Closes the detail panel and hands the ring back to the card or row it was opened from. */
async function closeDetail($: EngineInterface, id: string) {
  await update($, selected, () => null)
  await $.ui.open({ id: PANE, title: 'Roadmap', focus: true })
  await focusOn($, (await read($, view)) === 'board' ? `card-${id}` : `row-${id}`)
}

/** Opens an item in the detail panel, marking what is on it as read. */
async function open($: EngineInterface, id: string | null) {
  await update($, selected, () => id)
  await update($, scrolled, () => 0)
  await update($, requesting, () => false)
  if (id === null) return
  // Inline, a card asks for as much height as the layout spares; the board goes back to the default third.
  await $.ui.open({ id: PANE, title: 'Roadmap', focus: true, rows: CARD_ROWS })
  // The card that held the ring is gone once the panel stands in for the board: hand the ring to the
  // panel, on the first unticked checklist entry when there is one.
  const item = find((await read($, snapshot)).items, id)
  const firstOpen = item?.checklist?.find(c => !c.done)
  await focusOn($, firstOpen ? `check-${firstOpen.n}` : 'hand')
  try {
    await sql($, db.markSeen(USER, id))
    await refresh($)
  } catch {
    // Read marks are a nicety: the panel opens whatever becomes of them.
  }
}

/** Opens the board on one item, as pressing its card would. */
async function showItem($: EngineInterface, id: string) {
  await open($, id)
}

/** Sends a task back from review with what needs changing, and puts its agent back on it. */
async function requestChanges($: EngineInterface, item: Item, what: string) {
  const body = what.trim()
  if (!body) return
  await update($, requesting, () => false)
  await userAct($, { action: 'comment', id: item.id, body: `Changes requested: ${body}` })
  await userAct($, { action: 'update', id: item.id, status: 'in_progress' })
  await focusOn($, 'hand')
  if (item.assignee && item.assignee !== USER)
    await $.prompt.submit({
      text: `The user sent roadmap ${item.kind} ${item.id} (${item.title}) back from review: ${body}. Read it with the roadmap tool (show ${item.id}), make the changes (adding tasks under it if that helps), comment, and set it done again when finished.`,
    })
}

/** Adds what the new-item form describes, as the person, and opens it. */
async function create($: EngineInterface, choice: Draft, title: string) {
  try {
    const reply = await act($, USER, {
      action: 'add', kind: choice.kind, title, parent: choice.parent || undefined,
      ...(choice.kind === 'task' ? { priority: choice.priority, type: choice.type } : {}),
    })
    await update($, draft, () => null)
    const id = /^Added (\w+)/.exec(reply)?.[1]
    await refresh($)
    if (id) await open($, id)
  } catch (err) {
    $.ui.toast(`roadmap: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handToClaude($: EngineInterface, item: Item) {
  await userAct($, { action: 'update', id: item.id, assignee: CLAUDE })
  await $.prompt.submit({
    text:
      item.kind === 'task'
        ? `Work on roadmap task ${item.id}: ${item.title}. Read it with the roadmap tool (show ${item.id}), claim it, and comment as you go.`
        : `Work on roadmap ${item.kind} ${item.id}: ${item.title}. It's yours as a whole: read it with the roadmap tool (show ${item.id}), then claim its tasks one at a time, commenting as you go. They close as you finish them; set ${item.id} done when they all are, and I'll review it then.`,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'roadmap', description: 'Open the project roadmap board' })
    await $.tool.register({
      name: 'roadmap',
      isDeferred: false,
      description: [
        "The project's shared tracker, a lightweight Jira kept in .claude/roadmap.db that you, the user and other agents all work from.",
        'Hierarchy: milestone > epic > task (ids M1, E1, T1; never reused). Epics sit under milestones; tasks under epics or milestones.',
        'Actions: show (whole tree, or one item with its activity), next (your open tasks, then unassigned ones by priority and due date),',
        'find (any of kind, status, assignee ("none" for unassigned), priority, type, labels, under (an id: its subtree), text (title, description, comments)),',
        'add (kind, title; optional parent, description, due, status, assignee, priority, type), update (id plus any field; empty string clears),',
        'claim (id: take a task and start it, answering with its detail; refused when someone else holds it or it waits on unfinished tasks), release (id; body leaves a handoff note for whoever picks it up next),',
        'comment (id, body), remove (id; cascade for children).',
        'plan (tree; optional parent): add a whole breakdown in one call, checked in full before anything is written. Each node takes the add fields',
        "plus ref, children and blocked_by naming other nodes' refs or existing task ids; the answer maps each ref to its new id.",
        'Dependencies: blocked_by lists the tasks a task waits on; relates_to and duplicates link items otherwise, and labels tag them. Acceptance criteria: a task\'s checklist; check (id, items) ticks entries,',
        'and a task cannot be set done while any is unchecked. Give each task you plan a checklist of what done means.',
        'Review: the user reviews what they handed you, once. A task you set done goes to review; but when they hand you a whole epic or milestone',
        '("implement E27"), first assign it to yourself (update id, assignee) so its tasks close as you go, then set it done when they all are: it goes to review.',
        "Pass approved: true with status done only when the user has told you in this conversation that the work is approved; subagents can't.",
        'Name the task id in commit messages and PR titles or branches (e.g. "T12: ..."); show lists the commits and PRs that name it.',
        'Milestone and epic status roll up from their tasks. Working rules: claim a task before you start it; comment on decisions,',
        'findings and handoff notes; mark it done when finished, or blocked with a comment saying why. Subagents are named from their type and task automatically.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'next', 'find', 'add', 'plan', 'update', 'claim', 'release', 'comment', 'check', 'remove'] },
          id: { type: 'string', description: 'Item id, e.g. T12' },
          kind: { type: 'string', enum: KINDS },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          parent: { type: 'string', description: 'Parent id; empty string moves to top level' },
          checklist: {
            type: 'array', items: { type: 'string' },
            description: 'Acceptance criteria for a task (add/update); replaces the list, keeping ticks on unchanged entries; [] clears.',
          },
          items: { type: 'array', items: { type: 'integer' }, description: 'check: the 1-based checklist entries to tick' },
          done: { type: 'boolean', description: 'check: false unticks instead' },
          blocked_by: {
            type: 'array', items: { type: 'string' },
            description: 'Tasks this task waits on (add/update); replaces the list, [] clears. Claiming waits for them; next skips it.',
          },
          assignee: { type: 'string', description: `"${USER}", "${CLAUDE}", or an agent's name; empty string unassigns` },
          due: { type: 'string', description: 'Target date, YYYY-MM-DD' },
          under: { type: 'string', description: 'find: only items under this milestone or epic' },
          text: { type: 'string', description: 'find: words that must all appear in the title, description or comments' },
          tree: {
            type: 'array',
            description: 'plan: new items, each { ref?, kind, title, description?, due?, assignee?, priority?, type?, labels?, checklist?, blocked_by?, children? }',
            items: { type: 'object', properties: { ref: { type: 'string' }, kind: { type: 'string', enum: KINDS }, title: { type: 'string' }, children: { type: 'array' } }, required: ['kind', 'title'] },
          },
          labels: { type: 'array', items: { type: 'string' }, description: 'Tags such as "ui" or "auth" (add/update); replaces the list, [] clears.' },
          relates_to: {
            type: 'array', items: { type: 'string' },
            description: 'Items this one is related to, shown on both (add/update); replaces the list, [] clears.',
          },
          duplicates: { type: 'string', description: 'The item this one duplicates (add/update); closes this task as done. Empty string clears.' },
          priority: { type: 'string', enum: PRIORITIES, description: 'p0 urgent … p3 can wait; p2 is the default. next picks higher priority first.' },
          type: { type: 'string', enum: TYPES, description: 'What sort of work: feature (default), bug or chore' },
          body: { type: 'string', description: 'Comment text (comment), or a handoff note (release): where you got to and what is left' },
          as: { type: 'string', description: `Who is acting, to override the default: "${CLAUDE}", or a subagent's name from its type and task.` },
          approved: { type: 'boolean', description: 'update with status done: the user has explicitly approved this work in chat, so it skips review. Never on your own judgment.' },
          force: { type: 'boolean', description: 'claim: take over a held or waiting task; update: set done with unchecked items' },
          cascade: { type: 'boolean', description: 'remove: also remove everything under the item' },
        },
        required: ['action'],
      },
    })
    try {
      await poll($)
    } catch (err) {
      $.ui.toast(`roadmap: could not open ${db.DB}: ${err instanceof Error ? err.message : String(err)}`)
    }
    $.clock.every(3000, () => poll($).catch(() => undefined))
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { tool, tool_use_id, agentId, requestMeta, ...input } = e as typeof e & Record<string, unknown>
    const a = input as unknown as Input
    const actor = await actorFor($, agentId === undefined ? undefined : String(agentId), a.as)
    try {
      // The person's name is theirs: what they do happens on the board, not through an agent's call.
      if (actor === USER) fail(`"${USER}" is the person at the board; act as yourself`)
      // Any call to the tracker is a sign of life for the caller's claims.
      await heartbeat($, actor, true).catch(() => undefined)
      const reply = await act($, actor, a, agentId !== undefined)
      if (!agentId && a.action !== 'show' && a.action !== 'next') hasWorkedSinceUpdate = false
      await refresh($)
      return { result: reply }
    } catch (err) {
      return { deny: err instanceof Error ? err.message : String(err) }
    }
  }).catch(($, e, next) =>
    // The tool is answered here or nowhere: a hook that failed outright (its budget ran out, or it was
    // asked again beneath its own call) says so rather than leaving the engine's "no hook answered".
    next.called ? next(e) : { deny: `roadmap: the tracker did not answer (${next.error.kind}); try again` },
  )

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) agentNames.set(started.agentId, agentName(e.subagentType, e.description, started.teammateId))
    return started
  }).catch(($, e, next) => next(e)) // Naming only: never stands in the way of a spawn.

  // Note work done in the main loop, for the nudge below.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId && WORK.has(String(e.tool))) hasWorkedSinceUpdate = true
    // An agent busy with other tools is alive too; renewed now and then rather than on every call.
    if (String(e.tool) !== TOOL) {
      const actor = await actorFor($, e.agentId === undefined ? undefined : String(e.agentId), undefined)
      await heartbeat($, actor).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // Bookkeeping only: never stands in the way of a tool.

  // The session brief: on the first prompt, and again whenever the person changed the roadmap;
  // a nudge when work happened while a task of Claude's sat untouched.
  on('prompt.submit', async ($, e, next) => {
    const context: string[] = []
    try {
      const snap = await refresh($)
      const newest = snap.activity.reduce((max, one) => Math.max(max, one.id), 0)
      const news = snap.activity.filter(one => one.id > seenActivity && one.author === USER)
      if (seenActivity < 0 || news.length > 0) {
        const text = brief(snap, CLAUDE, seenActivity < 0 ? [] : news, await $.clock.now().catch(() => undefined))
        if (text) context.push(text)
      } else if (hasWorkedSinceUpdate) {
        const open = snap.items.filter(item => item.kind === 'task' && item.assignee === CLAUDE && item.status === 'in_progress')
        if (open.length)
          context.push(
            `<roadmap-reminder>You have in-progress roadmap tasks: ${open.map(t => `${t.id} ${t.title}`).join('; ')}. ` +
              'If your recent work moved any of them, comment or update its status with the roadmap tool.</roadmap-reminder>',
          )
      }
      seenActivity = newest
      hasWorkedSinceUpdate = false
    } catch {
      // The brief is a courtesy: a roadmap that cannot be read never holds up a prompt.
    }
    return next(context.length ? { ...e, context: [...(e.context ?? []), ...context] } : e)
  }).catch(($, e, next) => next(e)) // A brief that fails never holds up a prompt: it goes in as typed.

  on('command.run', { command: 'roadmap' }, async $ => {
    // The pane shows what went wrong, so a failed read still opens it.
    await refresh($).catch(() => undefined)
    // Asks for the keys, so the board is driven from the keyboard at once (granted from an empty prompt).
    await $.ui.open({ id: PANE, title: 'Roadmap', focus: true })
    return { text: 'Roadmap opened.' }
  })

  // The band above the prompt: what the agents are working on right now, one line, pressable.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const working = snap.items
      .filter(item => item.kind === 'task' && item.status === 'in_progress' && item.assignee && item.assignee !== USER)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const task = working[0]
    if (e.props.hasSurvey || !task) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const milestone = (() => {
      let at: Item | undefined = task
      while (at && at.kind !== 'milestone') at = find(snap.items, at.parent ?? undefined)
      return at
    })()
    const list = task.checklist ?? []
    const ticks = list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : ''
    const more = working.length > 1 ? ` +${working.length - 1} more` : ''
    const where = milestone ? ` · ${milestone.id} ${progress(snap.items, milestone).done}/${progress(snap.items, milestone).total}` : ''
    const room = ((e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80) - 1
    const fixed = `◐ ${task.id}  @${task.assignee}${ticks}${where}${more}`.length
    const title = task.title.length + fixed > room ? task.title.slice(0, Math.max(8, room - fixed - 1)) + '…' : task.title

    return (
      <Box>
        <Button key="current" plain onPress={() => void showItem($, task.id)}>
          <Text color={COLOR.in_progress}>◐</Text> <Text dimColor>{task.id}</Text> {title}
          <Text color="cyan"> @{task.assignee}</Text>
          <Text dimColor>
            {ticks}
            {where}
            {more}
          </Text>
        </Button>
      </Box>
    )
  })

  // While a card is open its title and bar hold still and only the sections under them scroll.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if ((await read($, selected)) === null) return next(e)
    await update($, scrolled, at => Math.max(0, Math.min(scrollMax, at + e.by)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state: PaneState = {
      snap: await read($, snapshot),
      mode: await read($, view),
      pick: await read($, selected),
      trouble: await read($, problem),
      known: await read($, refs),
      isIgnoreOffered: await read($, ignoreOffer),
      isRequesting: await read($, requesting),
      filter: await read($, filter),
      isFiltering: await read($, filtering),
      draft: await read($, draft),
      scrolledTo: await read($, scrolled),
      // Without a clock nothing reads as stale: the mark is a hint, never a reason not to draw.
      now: await $.clock.now().catch(() => 0),
    }
    const actions: PaneActions = {
      open: id => void open($, id),
      closeDetail: id => void closeDetail($, id),
      userAct: a => void userAct($, a as Input),
      handToClaude: item => void handToClaude($, item),
      requestChanges: (item, what) => void requestChanges($, item, what),
      setView: mode => void update($, view, () => mode),
      setRequesting: isOn => void update($, requesting, () => isOn).then(() => (isOn ? focusOn($, 'changes') : undefined)),
      focus: key => void focusOn($, key),
      setFilter: text => void update($, filter, () => text).then(() => update($, filtering, () => false)),
      setDraft: next => void update($, draft, () => next).then(() => (next ? focusOn($, 'new-title') : undefined)),
      create: (choice, title) => void create($, choice, title),
      setFiltering: isOn => void update($, filtering, () => isOn).then(() => (isOn ? focusOn($, 'filter-input') : undefined)),
      addIgnore: () => void addIgnore($),
      dismissIgnore: () => void dismissIgnore($),
    }
    const drawn = drawPane($.ui.resolve(e), e, state, actions)
    scrollMax = drawn.scrollMax
    return drawn.node
  })
}
