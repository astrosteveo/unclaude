import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import type { Activity, Item, Snapshot } from '../types'
import { q, VERSION } from './db'
import { columnCaps, rowsOf } from './pane'
import { ancestors, noRoadmapHere, agentName, approvalNote, commentNote, cutRelease, dueOf, isLate, timelineOf, isAfter, stackFrom, versionOf, webOf, withVersion, lastChange, mergedNotes, withNotes, backlog, branchFor, brief, checksOf, checkLinks, handedScope, pullRequest, unitOf, homesFor, checkPlan, isStale, letGo, matches, parseQuery, linksOf, ignoreState, IGNORE_LINE, shouldOfferIgnore, withIgnore, checkBlockers, checkParent, detail, find, idsIn, parseGitLog, parsePrs, refsFor, refsText, nextUp, outline, statusOf, subtree, unread, waitingOn } from './model'

/** Hooks that stand in for a project with no roadmap: no database file, and every process recorded. */
/** A fresh git repository with no roadmap in it yet. */
const noRoadmap = (on: On, ran: string[][]) => {
  on('fs.stat', ($, e) => (e.path.endsWith('/.git') ? { value: { size: 1, mtimeMs: 1 } } : { deny: 'ENOENT' }) as never)
  on('process.run', ($, e) => (ran.push([...e.argv]), { value: fakeSqlite(e.init?.stdin, { items: [], activity: [], seen: {} }) }))
}

/** What sqlite3 prints for a script, for tests that stand in for it: the version, an item's timeline, what was said, or the snapshot. */
const fakeSqlite = (stdin: string | undefined, snap: unknown) => ({
  exitCode: 0,
  stdout: stdin?.trim() === 'PRAGMA user_version;' ? String(VERSION) : JSON.stringify(fakeAnswer(stdin ?? '', snap as Snapshot)),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const fakeAnswer = (stdin: string, snap: Snapshot) => {
  if (!snap) return snap
  const activity = snap.activity ?? []
  const one = /FROM \(SELECT \* FROM activity WHERE item_id='([^']*)'/.exec(stdin)?.[1]
  if (one !== undefined) return activity.filter(entry => entry.item_id === one).sort((a, b) => a.id - b.id)
  if (stdin.includes("type IN ('comment', 'handoff')")) {
    const said: Record<string, string> = {}
    for (const entry of [...activity].sort((a, b) => a.id - b.id))
      if (entry.type === 'comment' || entry.type === 'handoff') said[entry.item_id] = said[entry.item_id] ? `${said[entry.item_id]}\n${entry.body}` : entry.body
    return said
  }
  return snap
}

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  kind: id[0] === 'M' ? 'milestone' : id[0] === 'E' ? 'epic' : 'task',
  title: `${id} title`,
  status: 'todo',
  parent: null,
  description: null,
  assignee: null,
  due: null,
  priority: 'p2',
  type: 'feature',
  note: null,
  section: null,
  resolution: null,
  lease_at: null,
  labels: [],
  relations: [],
  blocked_by: [],
  checklist: [],
  created_at: '2026-10-09T00:00:00Z',
  updated_at: '2026-10-09T00:00:00Z',
  ...over,
})

const items = [
  item('M1', { due: '2026-11-15' }),
  item('E1', { parent: 'M1' }),
  item('T1', { parent: 'E1', status: 'done' }),
  item('T2', { parent: 'E1', status: 'in_progress', assignee: 'claude' }),
  item('T3', { parent: 'E1', status: 'blocked' }),
  item('T4', { parent: 'M1' }),
  item('T5'),
]

test('status rolls up from tasks, blocked first', async () => {
  expect(statusOf(items, items[0]!)).toBe('blocked')
  expect(outline(items).split('\n')[0]).toBe('M1 ✗ blocked M1 title  (1/4 tasks, due 2026-11-15)')
})

test('rollups scale: a two-thousand-item roadmap draws its outline and brief quickly, and a new list rolls up afresh', async () => {
  const big: Item[] = []
  for (let m = 1; m <= 20; m++) {
    big.push(item(`M${m}`, { assignee: 'claude' }))
    for (let e = 1; e <= 10; e++) {
      const epic = `E${(m - 1) * 10 + e}`
      big.push(item(epic, { parent: `M${m}`, assignee: 'claude' }))
      for (let t = 1; t <= 10; t++) big.push(item(`T${((m - 1) * 10 + e - 1) * 10 + t}`, { parent: epic, status: t % 3 ? 'done' : 'todo' }))
    }
  }
  const started = performance.now()
  big.forEach(one => statusOf(big, one))
  outline(big)
  brief({ items: big, activity: [], seen: {} }, 'claude', [])
  // About 10ms with the index; about 250ms when each roll-up walked the whole list again.
  expect(performance.now() - started).toBeLessThan(100)
  expect(statusOf(big, find(big, 'E1')!)).toBe('in_progress')
  // The next snapshot is a new list: its roll-ups are its own. (E1 sits in M1, handed over whole, so it closes.)
  const next = big.map(one => (one.parent === 'E1' ? { ...one, status: 'done' as const } : one))
  expect(statusOf(next, find(next, 'E1')!)).toBe('done')
  expect(statusOf(big, find(big, 'E1')!)).toBe('in_progress')
})

test('nesting rules and subtrees', async () => {
  expect(() => checkParent(items, 'epic', 'T1')).toThrow('cannot sit under a task')
  expect(() => checkParent(items, 'task', 'E1', 'E1')).toThrow('its own parent')
  expect(checkParent(items, 'task', 'e1')).toBe('E1')
  expect(subtree(items, 'M1')).toEqual(['M1', 'E1', 'T4', 'T1', 'T2', 'T3'])
})

test('next puts your own work first, then free tasks by inherited due date', async () => {
  expect(nextUp(items, 'claude').map(task => task.id)).toEqual(['T2', 'T4', 'T5'])
})

test('brief names your work and the user\'s changes', async () => {
  const news: Activity[] = [{ id: 9, item_id: 'T3', author: 'user', type: 'comment', body: 'vendor replied', at: '' }]
  const text = brief({ items, activity: news, seen: {} }, 'claude', news)!
  expect(text).toContain('Assigned to you (claude):\n- T2')
  expect(text).toContain('Blocked:\n- T3')
  expect(text).toContain('- T3: vendor replied')
  expect(brief({ items: [], activity: [], seen: {} }, 'claude', [])).toBeUndefined()
})

test('SQL literals cannot break out or start a dot-command', async () => {
  expect(q("it's")).toBe("'it''s'")
  expect(q('a\n.shell rm -rf /')).toBe("'a'||char(10)||'.shell rm -rf /'")
  expect(q(null)).toBe('NULL')
})

test('a missing sqlite3 is named, with how to install it', async ($, on) => {
  on('process.run', () => ({ deny: 'spawn sqlite3 ENOENT' }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const ran = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show' } as never)
  expect(ran.deny).toContain('sqlite3 is not installed or not on PATH')
  expect(ran.deny).toContain('pacman -S sqlite')
})

test('a prompt goes in as typed when the roadmap cannot be read', async ($, on) => {
  on('process.run', () => ({ deny: 'spawn sqlite3 ENOENT' }))
  let seen: readonly string[] | undefined = ['unset']
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, origin: e.origin }
  })
  const sent = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(sent.text).toBe('hello')
  expect(seen).toBeUndefined()
})

test('the roadmap is found from the project root, wherever a shell cd took the session', async ($, on) => {
  const snap = { items: [item('T1')], activity: [{ id: 7, item_id: 'T1', author: 'user', type: 'comment', body: 'old news', at: '2026-10-09T10:00:00Z' }], seen: {} }
  const cwds: (string | undefined)[] = []
  const stats: string[] = []
  let isThere = true
  on('session.root', () => ({ value: '/work/project' }) as never)
  on('session.cwd', () => ({ value: '/work/project/sub/dir' }) as never)
  on('fs.stat', ($, e) => (stats.push(e.path), isThere ? { value: { size: 1, mtimeMs: 1 } } : { deny: 'ENOENT' }) as never)
  on('process.run', ($, e) => (cwds.push(e.init?.cwd), { value: e.argv[0] === 'sqlite3' ? fakeSqlite(e.init?.stdin, snap) : { ...fakeSqlite('', null), stdout: '[]' } }))
  on('clock.now', () => ({ value: 1 }) as never)
  let context: readonly string[] | undefined
  on('prompt.submit', ($, e) => ((context = e.context), { text: e.text, origin: e.origin }))
  const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'add', kind: 'task', title: 'x' } as never)
  expect(reply.deny).toBeUndefined()
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show', id: 'T1' } as never)
  // sqlite3, mkdir, git and gh all run in the root; the database is looked for there too.
  expect(cwds.length).toBeGreaterThan(2)
  expect(cwds.every(cwd => cwd === '/work/project')).toBe(true)
  expect(stats.every(path => path === '/work/project/.git' || path.startsWith('/work/project/.claude/roadmap.db'))).toBe(true)

  // A read that finds no database must not make the next brief replay what was already seen.
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })
  isThere = false
  await $.prompt.submit({ text: 'lost', wait: false, origin: { kind: 'composer' } })
  isThere = true
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  expect((context ?? []).join('\n')).not.toContain('old news')
})

test('the tool description fits the 2048 characters the model reads; each action is described on the action field', async ($, on) => {
  let spec: { description: string; inputSchema: { properties: { action: { description: string } } } } | undefined
  on('tool.register', ($, e) => ((spec = e as never), { value: {} }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
  expect(spec!.description.length).toBeLessThanOrEqual(2048)
  for (const rule of ['claim it', 'Claim any task before you start it', 'status done with items', 'handoff note', 'blocked with a comment', 'approved: true', 'PR step'])
    expect(spec!.description).toContain(rule)
  const actions = spec!.inputSchema.properties.action.description
  for (const action of ['show', 'next', 'find', 'pr', 'add', 'plan', 'update', 'claim', 'release', 'comment', 'check', 'remove'])
    expect(actions).toContain(`${action}:`)
})

test('batch: ops run in order on a trial copy, then land on the database in one transaction, or not at all', async ($, on) => {
  const some: Item[] = [item('T1'), item('T2')]
  const real: string[] = []
  const tried: string[] = []
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const stdin = e.init?.stdin ?? ''
    if (e.argv[0] !== 'sqlite3' || e.argv.some(arg => arg.startsWith('.backup'))) return { value: { ...fakeSqlite('', null), stdout: '' } }
    const onCopy = String(e.argv.at(-1)).includes('-batch-')
    if (stdin.startsWith('BEGIN')) (onCopy ? tried : real).push(stdin)
    if (stdin.includes('INSERT INTO counters')) {
      if (onCopy) some.push(item('T9', { title: 'New' }))
      return { value: { ...fakeSqlite('', null), stdout: 'T9' } }
    }
    if (stdin.trim() === 'SELECT COALESCE(MAX(id), 0) FROM activity;') return { value: { ...fakeSqlite('', null), stdout: '41' } }
    return { value: fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: 5 }) as never)
  const call = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  const reply = await call({ action: 'batch', ops: [
    { action: 'update', id: 'T1', status: 'blocked' },
    { action: 'comment', id: 'T2', body: 'looked at it' },
    { action: 'add', kind: 'task', title: 'New', ref: 'new' },
    { action: 'update', id: 'new', priority: 'p1', blocked_by: ['T2'] },
  ] })
  expect(reply.split('\n').map(line => line.slice(0, 3))).toEqual(['1. ', '2. ', '3. ', '4. '])
  expect(reply).toContain('3. Added T9: New')
  expect(reply).toContain('4. T9: priority → p1; blocked by T2')
  // Each op ran on the copy; the database got one script holding all of them, guarded by the stamp.
  expect(tried.length).toBeGreaterThanOrEqual(4)
  expect(real.length).toBe(1)
  for (const part of ["status='blocked'", "'looked at it'", 'INSERT INTO items', "priority='p1'", "VALUES ('T2', 'T9')", "= 41) THEN json_extract("])
    expect(real[0]).toContain(part)
  expect(real[0]!.match(/BEGIN/g)?.length).toBe(1)
  expect(ran.some(argv => argv[0] === 'rm' && String(argv[2]).includes('-batch-'))).toBe(true)

  // An op that fails writes nothing, and says which op it was.
  real.length = 0
  const failed = await call({ action: 'batch', ops: [{ action: 'update', id: 'T1', status: 'todo' }, { action: 'comment', id: 'T99', body: 'x' }] })
  expect(failed).toBe('op 2 (comment T99): No item T99. Nothing in the batch was written.')
  expect(real).toEqual([])
  expect(await call({ action: 'batch', ops: [{ action: 'batch', ops: [] }] })).toContain('cannot hold another batch')

  // ids: the same change to several items, as one batch.
  const both = await call({ action: 'update', ids: ['T1', 'T2'], priority: 'p0' })
  expect(both).toBe('1. T1: priority → p0\n2. T2: priority → p0')
  expect(real.length).toBe(1)
  expect(real[0]).toContain("WHERE id='T1'")
  expect(real[0]).toContain("WHERE id='T2'")

  // The rules hold op by op: a subagent can't approve inside a batch either.
  real.length = 0
  const sub = await call({ action: 'batch', agentId: 'a1', ops: [{ action: 'comment', id: 'T1', body: 'x' }, { action: 'update', id: 'T2', status: 'done', approved: true }] })
  expect(sub).toContain('op 2 (update T2): Only the user approves')
  expect(real).toEqual([])
})

test('subagents get stable, readable names', async () => {
  expect(agentName('Explore', 'Find auth handlers in src/')).toBe('explore:find-auth-handlers-in-src')
  expect(agentName('general-purpose', 'Refactor the very long module name that goes on and on')).toBe('general-purpose:refactor-the-very-long-module')
  expect(agentName('roadmap:planner', '')).toBe('roadmap-planner')
  expect(agentName('teammate', 'whatever', 'reviewer@core-team')).toBe('reviewer')
})

test('unread counts the comments others left since the reader last looked', async () => {
  const at = (id: number, author: string, type: Activity['type']): Activity => ({ id, item_id: 'T2', author, type, body: '', at: '' })
  const activity = [at(1, 'claude', 'create'), at(2, 'claude', 'comment'), at(3, 'user', 'comment'), at(4, 'claude', 'status')]
  expect(unread({ items, activity, seen: {} }, 'T2', 'user').map(one => one.id)).toEqual([2])
  expect(unread({ items, activity, seen: { T2: 2 } }, 'T2', 'user')).toEqual([])
})

test('the board draws on terminal and desktop, and a card opens and closes from the keyboard', async ($, on) => {
  const snap = {
    items,
    activity: [{ id: 7, item_id: 'T2', author: 'claude', type: 'comment', body: 'note', at: '2026-10-09T10:00:00Z' }],
    seen: {},
  }
  // sqlite3 answers the schema version when asked, the snapshot otherwise; writes are ignored.
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [120, 60]) {
      const ui = await $.ui.mount({
        plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap',
        props: { title: 'Roadmap', isFocused: true, bodyColumns, placement: 'dock' } as never,
      })
      expect(await ui.find({ key: 'col-todo-head' })).toBeDefined()
      expect((await ui.find({ key: 'card-T2' }))?.text).toContain('● 1')
      expect((await ui.find({ text: /t p b r d jump to a column/ }))).toBeDefined()
      await ui.press({ key: 'card-T2' })
      expect(await ui.find({ key: 'hand' })).toBeDefined()
      // The detail view stands in for the board, so it is never pushed off screen by a long column.
      expect(await ui.find({ key: 'card-T2' })).toBeUndefined()
      expect((await ui.find({ text: /1–5 status/ }))).toBeDefined()
      await ui.press({ key: 'close' })
      expect(await ui.find({ key: 'hand' })).toBeUndefined()
      expect(await ui.find({ key: 'card-T2' })).toBeDefined()
      await ui.press({ key: 'tab-tree' })
      expect(await ui.find({ key: 'row-M1' })).toBeDefined()
      await ui.press({ key: 'tab-board' })
      await ui.unmount()
    }
  }
})

test('dependencies: blockers must be other tasks, with no cycles; done blockers stop counting', async () => {
  const deps = [
    item('T1', { status: 'done' }),
    item('T2', { blocked_by: ['T1'] }),
    item('T3', { blocked_by: ['T2'] }),
    item('T4', { blocked_by: ['T3'], assignee: 'claude' }),
    item('T5', { assignee: 'claude', status: 'in_progress' }),
    item('E1'),
  ]
  expect(checkBlockers(deps, 'T5', ['t2', 'T3', 'T2'])).toEqual(['T2', 'T3'])
  expect(() => checkBlockers(deps, 'T2', ['T4'])).toThrow('cycle')
  expect(() => checkBlockers(deps, 'T2', ['T2'])).toThrow('cannot block itself')
  expect(() => checkBlockers(deps, 'T2', ['E1'])).toThrow('Only tasks block tasks')
  expect(waitingOn(deps, deps[1]!)).toEqual([])
  expect(waitingOn(deps, deps[2]!).map(one => one.id)).toEqual(['T2'])
  expect(outline(deps)).toContain('T3 ○ todo T3 title  (waiting on T2)')
  // T2's blocker is done, so it is free; T3 waits; your own waiting T4 comes after your T5.
  expect(nextUp(deps, 'claude').map(one => one.id)).toEqual(['T5', 'T4', 'T2'])
})

test('a checklist shows in the outline and the detail', async () => {
  const list = [item('T1', { checklist: [{ n: 1, text: 'tests pass', done: true }, { n: 2, text: 'docs', done: false }] })]
  expect(outline(list)).toBe('T1 ○ todo T1 title  (1/2 checked)')
  expect(detail({ items: list, activity: [], seen: {} }, list[0]!)).toContain('Checklist:\n  [x] 1. tests pass\n  [ ] 2. docs')
})

test('show on an epic carries each open task whole, and a done one as a line', async () => {
  const unit = [
    item('E1'),
    item('T1', { parent: 'E1', status: 'done', description: 'gone', checklist: [{ n: 1, text: 'old', done: true }] }),
    item('T2', { parent: 'E1', description: 'Add slugify.', checklist: [{ n: 1, text: 'lowercases', done: false }] }),
    item('T3', { parent: 'E1', blocked_by: ['T2'], checklist: [{ n: 1, text: 'cli', done: false }] }),
  ]
  const text = detail({ items: unit, activity: [], seen: {} }, unit[0]!)
  expect(text).toContain(
    'T1 ● done T1 title  (1/1 checked)\nT2 ○ todo T2 title  (0/1 checked)\n    Add slugify.\n    [ ] 1. lowercases\n' +
      'T3 ○ todo T3 title  (0/1 checked, waiting on T2)\n    [ ] 1. cli',
  )
  expect(text).not.toContain('gone')
})

test("the band shows the agents' current task, and pressing it opens that task on the board", async ($, on) => {
  const working = [
    ...items.filter(one => one.id !== 'T2'),
    item('T2', { parent: 'E1', status: 'in_progress', assignee: 'claude', checklist: [{ n: 1, text: 'x', done: true }, { n: 2, text: 'y', done: false }] }),
  ]
  const snap = { items: working, activity: [], seen: {} }
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const opened: string[] = []
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  opened.length = 0
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'roadmap', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, bodyColumns: 100, maxRows: 3 } as never,
    })
    const current = await band.find({ key: 'current' })
    expect(current?.text).toContain('T2 T2 title @claude ☑1/2 · M1 1/4')
    await band.press({ key: 'current' })
    expect(opened).toEqual(['roadmap'])
    opened.length = 0
    await band.unmount()
  }
})

test('commits and pull requests are linked to the tasks they name, and roll up to epics', async () => {
  expect(idsIn('T12: links; fixes t3 and [T12], not ST4 or T1x')).toEqual(['T12', 'T3'])
  const log =
    'abc1234\x1fAda\x1f2026-10-09\x1fT2: claim fix\n\nAlso touches T4.\n\x1e\n' +
    'def5678\x1fAda\x1f2026-10-08\x1fchore: no task here\n\x1e\n'
  const commits = parseGitLog(log)
  expect(commits).toEqual([{ hash: 'abc1234', author: 'Ada', date: '2026-10-09', subject: 'T2: claim fix', ids: ['T2', 'T4'] }])
  const prs = parsePrs(JSON.stringify([
    { number: 7, title: 'Board polish', headRefName: 't3-board', state: 'MERGED', url: 'https://x/7' },
    { number: 8, title: 'Docs', headRefName: 'docs', state: 'OPEN', url: 'https://x/8' },
  ]))
  expect(prs.map(pr => [pr.number, pr.state, pr.ids])).toEqual([[7, 'merged', ['T3']]])
  const e1 = refsFor(items, { commits, prs }, items[1]!)
  expect([e1.commits.length, e1.prs.length]).toEqual([1, 1])
  expect(refsText(e1)).toBe('Pull requests:\n  #7 [merged] Board polish  https://x/7\nCommits:\n  abc1234 2026-10-09 Ada: T2: claim fix')
  expect(refsFor(items, { commits, prs }, items[6]!)).toEqual({ commits: [], prs: [] })
})

test('the detail bar sits right under the title on every card, short or long, task or epic', async ($, on) => {
  const long = item('T6', {
    description: 'A long description. '.repeat(20),
    checklist: [1, 2, 3, 4, 5].map(n => ({ n, text: `criterion ${n}`, done: n < 3 })),
    blocked_by: ['T5'],
  })
  const snap = { items: [...items, long], activity: [], seen: {} }
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
  })
  const barIndex = async () => {
    const detail = await ui.find({ key: 'detail' })
    return (detail?.children ?? []).findIndex(c => (c as { key?: string; props?: { key?: string } })?.key === 'bar'
      || (c as { props?: { key?: string } })?.props?.key === 'bar')
  }
  const at: number[] = []
  for (const open of ['card-T5', 'card-T6']) {
    await ui.press({ key: open })
    at.push(await barIndex())
    expect((await ui.find({ key: 'set-todo' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'set-done' }))?.props.variant).toBe('secondary')
    await ui.press({ key: 'close' })
  }
  await ui.press({ key: 'tab-tree' })
  await ui.press({ key: 'row-E1' })
  at.push(await barIndex())
  expect(await ui.find({ key: 'set-todo' })).toBeUndefined()
  expect((await ui.find({ key: 'status-row' }))?.text).toContain('rolled up')
  expect(await ui.find({ key: 'hand' })).toBeDefined()
  expect(at).toEqual([1, 1, 1])
  await ui.unmount()
})

test('a card reads as labelled sections, and a tall one scrolls under its fixed title and bar', async ($, on) => {
  const long = item('T6', {
    description: 'A long description that wraps. '.repeat(12),
    checklist: [1, 2, 3, 4, 5, 6].map(n => ({ n, text: `criterion ${n}`, done: n < 3 })),
    blocked_by: ['T5'],
  })
  const activity = [
    { id: 1, item_id: 'T6', author: 'claude', type: 'event', body: 'created task', at: '2026-10-09T10:00:00Z' },
    { id: 2, item_id: 'T6', author: 'user', type: 'comment', body: 'please keep it short', at: '2026-10-09T10:05:00Z' },
  ]
  const snap = { items: [...items, long], activity, seen: {} }
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const props = (bodyRows: number) =>
    ({ title: 'Roadmap', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows } }) as never
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: props(200) })
  await ui.press({ key: 'card-T6' })

  // Room for everything: every section shows, in order, with no scroll marks.
  const heads = ['head-description', 'head-criteria', 'head-deps', 'head-activity']
  const detail = await ui.find({ key: 'detail' })
  const order = (detail?.children ?? []).map(c => (c as { props?: { key?: string } })?.props?.key).filter(k => heads.includes(k!))
  expect(order).toEqual(heads)
  expect(await ui.find({ key: 'head-links' })).toBeUndefined()
  expect((await ui.find({ key: 'head-criteria' }))?.text).toContain('2/6')
  expect(await ui.find({ type: 'Text', text: /more lines? below/ })).toBeUndefined()
  // A comment is a message, author over body; an event stays one dim line.
  expect((await ui.find({ key: 'act-2' }))?.type).toBe('Box')
  expect((await ui.find({ type: 'Text', text: /claude created task/ }))?.props.dimColor).toBe(true)

  // A short pane: the title and bar stay, the sections window and scroll.
  await ui.redraw(props(20))
  expect(await ui.find({ type: 'Text', text: /more lines? below/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /more lines? above/ })).toBeUndefined()
  expect(await ui.find({ key: 'head-activity' })).toBeUndefined()
  await $.ui.scroll({ component: 'Pane', requestId: 'roadmap', offset: 999, by: 999, bodyRows: 20, contentRows: 20, origin: { kind: 'person' } })
  await ui.redraw(props(20))
  expect(await ui.find({ type: 'Text', text: /more lines? above/ })).toBeDefined()
  expect(await ui.find({ key: 'head-activity' })).toBeDefined()
  expect(await ui.find({ key: 'set-todo' })).toBeDefined()
  expect(await ui.find({ key: 'hand' })).toBeDefined()
  // Reopening a card starts it at the top.
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T6' })
  expect(await ui.find({ type: 'Text', text: /more lines? above/ })).toBeUndefined()
  await ui.unmount()
})

test('the .gitignore offer stands only in a repo that does not ignore the database, until turned down', async () => {
  expect(ignoreState(0)).toBe('ignored')
  expect(ignoreState(1)).toBe('not-ignored')
  expect(ignoreState(128)).toBe('no-repo')
  expect(shouldOfferIgnore('ignored', undefined)).toBe(false)
  expect(shouldOfferIgnore('no-repo', undefined)).toBe(false)
  expect(shouldOfferIgnore('not-ignored', undefined)).toBe(true)
  expect(shouldOfferIgnore('not-ignored', 'told')).toBe(true)
  expect(shouldOfferIgnore('not-ignored', 'dismissed')).toBe(false)
  expect(withIgnore(undefined)).toEndWith(`${IGNORE_LINE}\n`)
  expect(withIgnore('node_modules')).toStartWith('node_modules\n#')
  expect(withIgnore('node_modules\n')).toStartWith('node_modules\n#')
})

for (const [label, exitCode, isOffered] of [['not ignored', 1, true], ['ignored', 0, false], ['outside a repo', 128, false]] as const) {
  test(`the board offers to gitignore the database: ${label}`, async ($, on) => {
    const snap = { items, activity: [], seen: {} }
    const written: string[] = []
    mock.store(on)
    on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
    on('fs.read', () => ({ value: 'node_modules\n' }) as never)
    on('fs.write', ($, e) => (written.push(`${e.path.split('/').at(-1)}:${e.text}`), { value: undefined }) as never)
    on('process.run', ($, e) =>
      e.argv[0] === 'git'
        ? { value: { exitCode: e.argv[1] === 'check-ignore' ? exitCode : 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: fakeSqlite(e.init?.stdin, snap) })
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.focus', () => ({}))
    on('ui.toast', () => ({ value: undefined }) as never)
    on('command.register', () => ({ value: {} }) as never)
    on('tool.register', () => ({ value: {} }) as never)
    on('clock.every', () => ({ value: {} }) as never)
    on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
    on('session.root', () => ({ value: '/work/project' }) as never)
    await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
    await $.command.run({ command: 'roadmap', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
      props: { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await ui.find({ key: 'ignore-add' }) !== undefined).toBe(isOffered)
    if (isOffered) {
      await ui.press({ key: 'ignore-add' })
      expect(written).toEqual([`.gitignore:node_modules\n# The roadmap tracker's database (binary, per checkout).\n${IGNORE_LINE}\n`])
      expect(await ui.find({ key: 'ignore-add' })).toBeUndefined()
    } else expect(written).toEqual([])
    await ui.unmount()
  })
}

test('a roadmap is started only at a repository top; a refusal points at the roadmaps below', () => {
  expect(ancestors('/home/me/Projects/')).toEqual(['/home/me/Projects', '/home/me', '/home', '/'])
  expect(ancestors('/')).toEqual(['/'])
  expect(noRoadmapHere('/p', ['/p/a', '/p/b/c'])).toContain('Roadmaps found below it: /p/a, /p/b/c. Start the session in the project')
  expect(noRoadmapHere('/p', [])).toContain('git init it first')
})

test('a project without a roadmap gets no database, no sqlite3 and no git until the first write', async ($, on) => {
  const ran: string[][] = []
  noRoadmap(on, ran)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('command.register', () => ({ value: {} }) as never)
  on('tool.register', () => ({ value: {} }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  let seen: readonly string[] | undefined = ['unset']
  on('prompt.submit', ($, e) => ((seen = e.context), { text: e.text, origin: e.origin }))
  await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const shown = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show' } as never)
  expect(shown.result).toBe('The roadmap is empty.')
  // Nothing ran: no mkdir, no sqlite3, no git log, no gh; and the brief stayed out of the prompt.
  expect(ran).toEqual([])
  expect(seen).toBeUndefined()
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
  })
  expect(await ui.find({ type: 'Text', text: /No roadmap yet/ })).toBeDefined()
  await ui.unmount()
  // The first write makes the folder and the database.
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'add', kind: 'task', title: 'first' } as never)
  expect(ran.some(argv => argv[0] === 'mkdir')).toBe(true)
  expect(ran.some(argv => argv[0] === 'sqlite3')).toBe(true)
})

test('inline, an open card folds the info line into its title and borrows the tabs\' row', async ($, on) => {
  const snap = { items, activity: [], seen: {} }
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const placement of ['inline', 'dock'] as const) {
    const ui = await $.ui.mount({
      plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
      props: { title: 'Roadmap', isFocused: true, bodyColumns: 80, placement, scroll: { offset: 0, bodyRows: 13 } } as never,
    })
    await ui.press({ key: 'card-T2' })
    const isInline = placement === 'inline'
    expect(await ui.find({ key: 'tab-board' }) === undefined).toBe(isInline)
    expect(await ui.find({ type: 'Text', text: /^assignee claude/ }) === undefined).toBe(isInline)
    expect((await ui.find({ key: 'detail' }))?.text?.includes('@claude')).toBe(isInline)
    await ui.press({ key: 'close' })
    expect(await ui.find({ key: 'tab-board' })).toBeDefined()
    await ui.unmount()
  }
})

test('priority and type: next takes higher priority first, and only what differs from the defaults is shown', async ($, on) => {
  const some = [
    item('T1', { due: '2026-10-10' }),
    item('T2', { priority: 'p0', type: 'bug' }),
    item('T3', { priority: 'p3', due: '2026-10-01' }),
    item('T4', { priority: 'p1', type: 'chore' }),
  ]
  expect(nextUp(some, 'claude').map(one => one.id)).toEqual(['T2', 'T4', 'T1', 'T3'])
  const lines = outline(some).split('\n')
  expect(lines).toContain('T1 ○ todo T1 title  (due 2026-10-10)')
  expect(lines).toContain('T2 ○ todo T2 title  (p0, bug)')

  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const bad = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'update', id: 'T1', priority: 'high' } as never)
  expect(bad.deny).toContain('priority must be one of p0, p1, p2, p3')
  const wrong = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'add', kind: 'task', title: 'x', type: 'story' } as never)
  expect(wrong.deny).toContain('type must be one of feature, bug, chore')
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'update', id: 'T1', priority: 'p1', type: 'bug' } as never)
  expect(scripts.some(one => one.includes("priority='p1'") && one.includes("type='bug'") && one.includes('priority → p1'))).toBe(true)

  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  expect((await ui.find({ key: 'card-T2' }))?.text).toContain('p0 bug')
  expect((await ui.find({ key: 'card-T1' }))?.text).not.toContain('p2')
  await ui.unmount()
})

test('labels and links: shown from both ends, in the outline, the detail and on the card', async ($, on) => {
  const some = [
    item('T1', { labels: ['ui'], relations: [{ type: 'relates', id: 'T2' }] }),
    item('T2'),
    item('T3', { status: 'done', relations: [{ type: 'duplicates', id: 'T1' }] }),
  ]
  expect(linksOf(some, some[1]!)).toEqual({ relates: ['T1'], duplicateOf: [], duplicatedBy: [] })
  expect(linksOf(some, some[0]!)).toEqual({ relates: ['T2'], duplicateOf: [], duplicatedBy: ['T3'] })
  expect(() => checkLinks(some, 'T1', ['T1'])).toThrow('cannot link to itself')
  expect(() => checkLinks(some, 'T1', ['T9'])).toThrow('No item T9')
  expect(outline(some).split('\n')[0]).toBe('T1 ○ todo T1 title  (#ui)')
  const text = detail({ items: some, activity: [], seen: {} }, some[0]!)
  expect(text).toContain('Duplicated by:\n  T3')
  expect(text).toContain('Related:\n  T2')

  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'card-T1' })
  expect(await ui.find({ key: 'head-links' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /relates to ○ T2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /duplicated by ● T3/ })).toBeDefined()
  expect(await ui.find({ text: /#ui/ })).toBeDefined()
  await ui.unmount()
})

test('review: an agent\'s done goes to review; only the person, or their approval passed on, closes it', async ($, on) => {
  const some = [
    item('T1', { status: 'in_progress', assignee: 'claude' }),
    item('T2', { status: 'review', assignee: 'claude', checklist: [{ n: 1, text: 'works', done: true }] }),
  ]
  const scripts: string[] = []
  let submitted = ''
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('prompt.submit', ($, e) => ((submitted = e.text), { text: e.text, origin: e.origin }))
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  const wrote = (needle: string) => scripts.some(one => one.includes(needle))

  const toReview = await call({ action: 'update', id: 'T1', status: 'done', note: '-' })
  expect(String(toReview.result)).toContain("waiting on the user's approval")
  expect(wrote("status='review'")).toBe(true)
  expect(wrote("status='done'")).toBe(false)
  expect((await call({ action: 'update', id: 'T1', status: 'done', approved: true, agentId: 'a1' })).deny).toContain('Only the user approves')
  expect((await call({ action: 'update', id: 'T1', status: 'done', as: 'user' })).deny).toContain('act as yourself')
  expect((await call({ action: 'comment', id: 'T1', body: 'hi', as: 'User' })).deny).toContain('act as yourself')
  expect((await call({ action: 'comment', id: 'T1', body: 'hi', as: ' USER ' })).deny).toContain('act as yourself')
  expect((await call({ action: 'update', id: 'T1', status: 'in_progress', approved: true })).deny).toContain('approved goes with status: done')
  const approved = await call({ action: 'update', id: 'T1', status: 'done', approved: true, note: '-' })
  expect(String(approved.result)).toContain('approved by the user')
  expect(wrote("status='done'")).toBe(true)

  scripts.length = 0
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  expect(await ui.find({ key: 'col-review-head' })).toBeDefined()
  expect(await ui.find({ key: 'card-T2' })).toBeDefined()
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ text: /a approve · c request changes/ })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(wrote("status='done'")).toBe(true)
  await ui.press({ key: 'request' })
  expect(await ui.find({ key: 'approve' })).toBeUndefined()
  await ui.input({ key: 'changes', text: 'handle the empty state' } as never)
  expect(wrote('Changes requested: handle the empty state')).toBe(true)
  expect(wrote("status='in_progress'")).toBe(true)
  expect(submitted).toContain('sent roadmap task T2 (T2 title) back from review: handle the empty state')
  expect(await ui.find({ key: 'approve' })).toBeDefined()
  await ui.unmount()
})

test('review waits on the user: last in next, and listed apart in the brief', async () => {
  const some = [
    item('T1', { status: 'review', assignee: 'claude' }),
    item('T2', { status: 'in_progress', assignee: 'claude' }),
    item('E1', { kind: 'epic' }),
    item('T3', { parent: 'E1', status: 'review' }),
    item('T4', { parent: 'E1', status: 'done' }),
  ]
  expect(nextUp(some, 'claude').map(one => one.id)).toEqual(['T2', 'T1'])
  expect(statusOf(some, some[2]!)).toBe('in_progress')
  const text = brief({ items: some, activity: [], seen: {} }, 'claude', [])!
  expect(text).toContain("Assigned to you (claude):\n- T2")
  expect(text).not.toContain('Assigned to you (claude):\n- T1')
  expect(text).toContain("Waiting on the user's review")
})

test('leases: a quiet claim reads as stale, is offered by next, named in the brief and marked on the card', async ($, on) => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const some = [
    item('T1', { status: 'in_progress', assignee: 'explore:a', lease_at: '2026-10-09T11:00:00Z' }),
    item('T2', { status: 'in_progress', assignee: 'explore:b', lease_at: '2026-10-09T11:45:00Z' }),
    item('T3', { status: 'in_progress', assignee: 'old', updated_at: '2026-10-09T09:00:00Z' }),
    item('T4'),
  ]
  expect(some.map(one => isStale(one, now))).toEqual([true, false, true, false])
  expect(isStale(item('T5', { status: 'review', assignee: 'x', lease_at: '2000-01-01T00:00:00Z' }), now)).toBe(false)
  expect(nextUp(some, 'claude', now).map(one => one.id)).toEqual(['T4', 'T1', 'T3'])
  expect(nextUp(some, 'claude').map(one => one.id)).toEqual(['T4'])
  const text = brief({ items: some, activity: [], seen: {} }, 'claude', [], now)!
  expect(text).toContain('Stale claims (holder silent over 30 min; claiming takes one over):\n- T1')
  expect(text).toContain('In progress by others:\n- T2')

  on('clock.now', () => ({ value: now }) as never)
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  expect((await ui.find({ key: 'card-T1' }))?.text).toContain('⌛stale')
  expect((await ui.find({ key: 'card-T2' }))?.text).not.toContain('stale')
  await ui.unmount()
})

test('heartbeat: every tracker call renews the caller\'s leases; other tools at most every five minutes', async ($, on) => {
  let now = Date.parse('2026-10-09T12:00:00Z')
  const scripts: string[] = []
  on('clock.now', () => ({ value: now }) as never)
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }) as never)
  const renews = () => scripts.filter(one => one.includes('SET lease_at=') && one.includes("assignee='claude'") && !one.includes('BEGIN')).length
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show' } as never)
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show' } as never)
  expect(renews()).toBe(2)
  await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
  expect(renews()).toBe(2)
  now += 6 * 60_000
  await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
  expect(renews()).toBe(3)
})

test('release and Unassign put a task under way back to todo, so next and the backlog offer it again', async ($, on) => {
  const held = item('T1', { status: 'in_progress', assignee: 'claude' })
  const released = { ...held, ...letGo(held) }
  expect(released).toMatchObject({ status: 'todo', assignee: null })
  expect(nextUp([released], 'explore:a').map(one => one.id)).toEqual(['T1'])
  expect(backlog([released]).map(one => one.id)).toEqual(['T1'])
  expect(letGo(item('T2', { status: 'review', assignee: 'claude' }))).toEqual({ assignee: null })
  expect(letGo(item('E1', { status: 'in_progress', assignee: 'claude' }))).toEqual({ assignee: null })

  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: [held], activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  await call({ action: 'release', id: 'T1' })
  expect(scripts.some(one => one.includes("status='todo'") && one.includes('assignee=NULL'))).toBe(true)
  scripts.length = 0
  // The board's Unassign is an update clearing the assignee.
  await call({ action: 'update', id: 'T1', assignee: '' })
  expect(scripts.some(one => one.includes("status='todo'") && one.includes('assignee=NULL'))).toBe(true)
  scripts.length = 0
  // A status given with it wins.
  await call({ action: 'update', id: 'T1', assignee: '', status: 'blocked' })
  expect(scripts.some(one => one.includes("status='blocked'"))).toBe(true)
})

test('a failing add or update writes nothing, so a retry has nothing to duplicate', async ($, on) => {
  const some = [item('E1'), item('T1', { parent: 'E1' })]
  const writes: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    if (stdin.includes('BEGIN')) writes.push(stdin)
    return { value: fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  const denied = async (input: Record<string, unknown>, why: RegExp) => {
    expect(String((await call(input)).deny)).toMatch(why)
    expect(writes).toEqual([])
  }
  await denied({ action: 'add', kind: 'task', title: 'x', relates_to: ['T99'] }, /No item T99/)
  await denied({ action: 'add', kind: 'task', title: 'x', duplicates: 'T99' }, /No item T99/)
  await denied({ action: 'add', kind: 'epic', title: 'x', checklist: ['done means'] }, /Only tasks carry a checklist/)
  await denied({ action: 'add', kind: 'task', title: 'x', parent: 'T1' }, /cannot sit under/)
  await denied({ action: 'update', id: 'T1', title: 'renamed', blocked_by: ['T99'] }, /No item T99/)
  await denied({ action: 'update', id: 'T1', title: 'renamed', relates_to: ['T1'] }, /cannot link to itself/)
  await denied({ action: 'update', id: 'T1', title: 'renamed', duplicates: 'T99' }, /No item T99/)
  await denied({ action: 'update', id: 'E1', title: 'renamed', blocked_by: ['T1'] }, /Only tasks wait/)
  await denied({ action: 'update', id: 'T1', title: 'renamed', parent: 'T1' }, /own parent|cannot sit under/)
})

test('an update of several fields is one sqlite3 run, in one transaction', async ($, on) => {
  const some = [item('T1'), item('T2')]
  const writes: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    if (stdin.includes('BEGIN')) writes.push(stdin)
    return { value: fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const reply = await $.tool.call({
    tool: 'mcp__roadmap__roadmap', action: 'update', id: 'T1', title: 'renamed', checklist: ['a', 'b'], blocked_by: ['T2'], labels: ['ui'], relates_to: ['T2'],
  } as never)
  expect(String(reply.result)).toContain('title → renamed; checklist set (2 items); blocked by T2; labels: ui; relates to T2')
  expect(writes.length).toBe(1)
  expect(writes[0]!.match(/BEGIN/g)?.length).toBe(1)
})

test('show and find read the whole timeline, not only what the snapshot carries', async ($, on) => {
  const some = [item('T1'), item('T2')]
  const old: Activity[] = [
    { id: 1, item_id: 'T1', author: 'explore:a', type: 'handoff', body: 'stopped at the zebra parser', at: '2026-10-01T10:00:00Z' },
    { id: 2, item_id: 'T1', author: 'claude', type: 'comment', body: 'an old finding about zebras', at: '2026-10-01T11:00:00Z' },
  ]
  const recent: Activity[] = [{ id: 3, item_id: 'T1', author: 'claude', type: 'comment', body: 'latest', at: '2026-10-09T10:00:00Z' }]
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    // The snapshot holds only the recent part; history and said answer from the whole of it.
    const isWhole = stdin.includes("FROM (SELECT * FROM activity WHERE item_id=") || stdin.includes("type IN ('comment', 'handoff')")
    return { value: fakeSqlite(stdin, { items: some, activity: isWhole ? [...old, ...recent] : recent, seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  const call = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  const shown = await call({ action: 'show', id: 'T1' })
  expect(shown).toContain('Handoff from explore:a')
  expect(shown).toContain('an old finding about zebras')
  expect(await call({ action: 'find', text: 'zebras' })).toContain('1 match:\nT1')
})

test('a subagent the agent list does not know is named once, and the list is asked once', async ($, on) => {
  const scripts: string[] = []
  let asked = 0
  on('agent.list', () => (asked++, { value: [] }) as never)
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: [item('T1')], activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: 0 }) as never)
  for (const body of ['one', 'two', 'three'])
    await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'comment', id: 'T1', body, agentId: 'f00dfeed12345678' } as never)
  expect(asked).toBe(1)
  expect(scripts.filter(one => one.includes("'agent-f00dfeed'") && one.includes("'comment'")).length).toBe(3)
})

test('handoff: release leaves a note that leads the detail, counts as unread, and a claim answers with the task', async ($, on) => {
  const activity: Activity[] = [
    { id: 1, item_id: 'T1', author: 'claude', type: 'comment', body: 'started on the parser', at: '2026-10-09T10:00:00Z' },
    { id: 2, item_id: 'T1', author: 'explore:a', type: 'handoff', body: 'parser done; tests for edge cases left', at: '2026-10-09T11:00:00Z' },
  ]
  const some = [item('T1', { description: 'Parse the config', checklist: [{ n: 1, text: 'edge cases', done: false }] })]
  const snap = { items: some, activity, seen: {} }
  const text = detail(snap, some[0]!)
  expect(text.split('\n').slice(1, 3)).toEqual(['Handoff from explore:a (2026-10-09 11:00):', '  parser done; tests for edge cases left'])
  expect(unread(snap, 'T1', 'user').map(one => one.id)).toEqual([1, 2])

  const scripts: string[] = []
  on('process.run', ($, e) => {
    scripts.push(e.init?.stdin ?? '')
    // The claim answers its new holder; everything else, the snapshot.
    const isClaim = e.init?.stdin?.includes("'assign'") && e.init?.stdin?.includes('lease_at=')
    return { value: isClaim ? { ...fakeSqlite('', snap), stdout: 'claude' } : fakeSqlite(e.init?.stdin, snap) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  const claimed = String((await call({ action: 'claim', id: 'T1' })).result)
  expect(claimed).toContain('T1 is yours (claude), in progress.')
  expect(claimed).toContain('Handoff from explore:a')
  expect(claimed).toContain('[ ] 1. edge cases')
  const released = String((await call({ action: 'release', id: 'T1', body: 'blocked on vendor docs' })).result)
  expect(released).toBe('T1 released, with your handoff note.')
  expect(scripts.some(one => one.includes("'handoff'") && one.includes('blocked on vendor docs'))).toBe(true)

  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'card-T1' })
  expect((await ui.find({ key: 'act-2' }))?.type).toBe('Box')
  expect(await ui.find({ type: 'Text', text: /explore:a handoff/ })).toBeDefined()
  await ui.unmount()
})

test('plan: the whole tree is checked before anything is written', async () => {
  const have = [item('M1'), item('E1', { parent: 'M1' }), item('T1', { parent: 'E1' })]
  const ok = checkPlan(have, [
    { ref: 'auth', kind: 'epic', title: 'Auth', children: [
      { ref: 'login', kind: 'task', title: 'Login', blocked_by: ['T1'] },
      { kind: 'task', title: 'Logout', blocked_by: ['login'] },
    ] },
  ], 'M1')
  expect(ok.map(one => [one.ref, one.parentId, one.parentRef, one.blockerRefs, one.blockerIds])).toEqual([
    ['auth', 'M1', null, [], []],
    ['login', null, 'auth', [], ['T1']],
    ['#3', null, 'auth', ['login'], []],
  ])
  const bad = (nodes: unknown[], parent?: string) => () => checkPlan(have, nodes as never, parent)
  expect(bad([{ kind: 'epic', title: 'x', children: [{ kind: 'milestone', title: 'y' }] }])).toThrow('a milestone cannot sit under a epic')
  expect(bad([{ kind: 'epic', title: 'x' }], 'E1')).toThrow('cannot sit under a epic')
  expect(bad([{ kind: 'task', title: 'x' }], 'M9')).toThrow('No item M9')
  expect(bad([{ kind: 'task', title: '' }])).toThrow('title is required')
  expect(bad([{ ref: 'a', kind: 'task', title: 'x' }, { ref: 'a', kind: 'task', title: 'y' }])).toThrow('ref a is used twice')
  expect(bad([{ ref: 'a', kind: 'task', title: 'x', blocked_by: ['b'] }, { ref: 'b', kind: 'task', title: 'y', blocked_by: ['a'] }])).toThrow('cycle')
  expect(bad([{ kind: 'task', title: 'x', blocked_by: ['nope'] }])).toThrow('No item nope')
  expect(bad([{ kind: 'epic', title: 'x', checklist: ['a'] }])).toThrow('only tasks carry a checklist')
  expect(bad([{ kind: 'task', title: 'x', priority: 'urgent' }])).toThrow('priority must be one of')
})

test('plan: creates parents first, wires refs to new ids, and answers the map', async ($, on) => {
  // A small stand-in for sqlite3 that keeps the items it is asked to insert.
  const made: Item[] = [item('M1')]
  const scripts: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    scripts.push(stdin)
    const m = stdin.match(/VALUES \('(\w)'\|\|\(SELECT n FROM counters WHERE prefix='\w'\), '(\w+)',\s*'([^']*)', '\w+', (NULL|'\w+')/)
    if (m) {
      const id = `${m[1]}${made.filter(one => one.id[0] === m[1]).length + 1}`
      made.push(item(id, { kind: m[2] as Item['kind'], title: m[3]!, parent: m[4] === 'NULL' ? null : m[4]!.slice(1, -1) }))
      return { value: { ...fakeSqlite('', null), stdout: id } }
    }
    return { value: fakeSqlite(stdin, { items: made, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const ran = await $.tool.call({
    tool: 'mcp__roadmap__roadmap', action: 'plan', parent: 'M1',
    tree: [{ ref: 'auth', kind: 'epic', title: 'Auth', children: [
      { ref: 'login', kind: 'task', title: 'Login', checklist: ['works'], labels: ['UI'] },
      { ref: 'logout', kind: 'task', title: 'Logout', blocked_by: ['login'] },
    ] }],
  } as never)
  expect(String(ran.result)).toContain('Planned 3 item(s): auth → E1, login → T1, logout → T2')
  expect(made.find(one => one.id === 'T2')?.parent).toBe('E1')
  expect(scripts.some(one => one.includes("INSERT OR IGNORE INTO links(blocker, blocked) VALUES ('T1', 'T2')"))).toBe(true)
  expect(scripts.some(one => one.includes("INSERT INTO checks(item_id, n, text, done) VALUES ('T1', 1, 'works', 0)"))).toBe(true)
  expect(scripts.some(one => one.includes("INSERT INTO labels(item_id, label) VALUES ('T1', 'ui')"))).toBe(true)
  // A bad tree writes nothing.
  const before = scripts.length
  const refused = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'plan', tree: [{ kind: 'task', title: 'x', blocked_by: ['ghost'] }] } as never)
  expect(refused.deny).toContain('No item ghost')
  expect(scripts.slice(before).some(one => one.includes('INSERT'))).toBe(false)
})

test('find: every given filter must match, with text searched in titles, descriptions and comments', async ($, on) => {
  const some = [
    item('M1'),
    item('E1', { parent: 'M1' }),
    item('T1', { parent: 'E1', title: 'Login form', priority: 'p0', type: 'bug', labels: ['ui'], assignee: 'claude', status: 'in_progress' }),
    item('T2', { parent: 'E1', title: 'Session store', description: 'Redis backed', labels: ['api'] }),
    item('T3', { title: 'Docs' }),
  ]
  const activity: Activity[] = [{ id: 1, item_id: 'T3', author: 'user', type: 'comment', body: 'mention the login flow', at: '' }]
  const snap = { items: some, activity, seen: {} }
  const ids = (query: object) => some.filter(one => matches(snap, one, query)).map(one => one.id)
  expect(ids({ labels: ['ui', 'api'] })).toEqual(['T1', 'T2'])
  expect(ids({ assignee: ['none'], kind: 'task' })).toEqual(['T2', 'T3'])
  expect(ids({ under: 'M1' })).toEqual(['E1', 'T1', 'T2'])
  expect(ids({ text: 'login' })).toEqual(['T1', 'T3'])
  expect(ids({ text: 'redis session' })).toEqual(['T2'])
  expect(ids({ status: ['in_progress'] })).toEqual(['M1', 'E1', 'T1'])
  expect(ids({ priority: ['p0'], type: ['bug'] })).toEqual(['T1'])
  expect(ids({ priority: ['p2'], kind: 'task' })).toEqual(['T2', 'T3'])

  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'find', ...input } as never)
  expect(String((await call({ labels: ['#UI'] })).result)).toBe('1 match:\nT1 ◐ in_progress Login form  (p0, bug, #ui, @claude) [E1]')
  expect(String((await call({ text: 'nothing like this' })).result)).toBe('Nothing matches.')
  expect((await call({ under: 'E9' })).deny).toContain('No item E9')
})

test('board filter: a typed query narrows the board and the tree, shows in the header, and clears', async ($, on) => {
  expect(parseQuery('@claude #UI p0 p1 bug review under:e3 login form')).toEqual({
    assignee: ['claude'], labels: ['ui'], priority: ['p0', 'p1'], type: ['bug'], status: ['review'], under: 'E3', text: 'login form',
  })
  expect(parseQuery('  ')).toBeUndefined()
  expect(parseQuery('wip @none')).toEqual({ status: ['in_progress'], assignee: ['none'] })

  const some = [
    item('M1'),
    item('E1', { parent: 'M1' }),
    item('T1', { parent: 'E1', title: 'Login form', labels: ['ui'] }),
    item('T2', { parent: 'E1', title: 'Session store' }),
    item('T3', { title: 'Docs', status: 'done' }),
  ]
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'filter' })
  await ui.input({ key: 'filter-input', text: '#ui' } as never)
  expect(await ui.find({ key: 'card-T1' })).toBeDefined()
  expect(await ui.find({ key: 'card-T2' })).toBeUndefined()
  expect((await ui.find({ key: 'filter' }))?.text).toContain('Filter: #ui')
  await ui.press({ key: 'tab-tree' })
  expect(await ui.find({ key: 'row-M1' })).toBeDefined()
  expect(await ui.find({ key: 'row-T1' })).toBeDefined()
  expect(await ui.find({ key: 'row-T2' })).toBeUndefined()
  expect(await ui.find({ key: 'row-T3' })).toBeUndefined()
  await ui.press({ key: 'filter' })
  await ui.input({ key: 'filter-input', text: 'nothing like it' } as never)
  expect(await ui.find({ type: 'Text', text: /Nothing matches the filter/ })).toBeDefined()
  await ui.press({ key: 'filter-clear' })
  expect(await ui.find({ key: 'row-T2' })).toBeDefined()
  expect(await ui.find({ key: 'filter-clear' })).toBeUndefined()
  await ui.unmount()
})

test('backlog: unheld todo tasks, homeless first then by priority; a row sets priority and hands off', async ($, on) => {
  const some = [
    item('E1'),
    item('T1', { parent: 'E1', priority: 'p3' }),
    item('T2', { parent: 'E1', priority: 'p0', labels: ['ui'] }),
    item('T3', { priority: 'p3' }),
    item('T4', { assignee: 'claude' }),
    item('T5', { status: 'done' }),
  ]
  expect(backlog(some).map(one => one.id)).toEqual(['T3', 'T2', 'T1'])
  const scripts: string[] = []
  let submitted = ''
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('prompt.submit', ($, e) => ((submitted = e.text), { text: e.text, origin: e.origin }))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  // v steps board → tree → backlog.
  await ui.press({ key: 'tab-tree' })
  await ui.press({ key: 'tab-backlog' })
  expect(await ui.find({ key: 'row-T3' })).toBeDefined()
  expect(await ui.find({ key: 'row-T4' })).toBeUndefined()
  await ui.select({ key: 'prio-T1', value: 'p1' } as never)
  expect(scripts.some(one => one.includes("priority='p1'") && one.includes("WHERE id='T1'"))).toBe(true)
  await ui.press({ key: 'hand-T2' })
  expect(submitted).toBe('')
  await ui.press({ key: 'hand-yes' })
  expect(submitted).toContain('Work on roadmap task T2')
  await ui.press({ key: 'filter' })
  await ui.input({ key: 'filter-input', text: '#ui' } as never)
  expect(await ui.find({ key: 'row-T3' })).toBeUndefined()
  expect(await ui.find({ key: 'row-T2' })).toBeDefined()
  await ui.unmount()
})

test('review at the level handed over: tasks in a handed epic close as they go; the epic is reviewed once', async ($, on) => {
  const some = [
    item('M1'),
    item('E1', { parent: 'M1', assignee: 'claude' }),
    item('T1', { parent: 'E1', status: 'done' }),
    item('T2', { parent: 'E1', status: 'in_progress', assignee: 'claude' }),
    item('T3', { status: 'in_progress', assignee: 'claude' }),
  ]
  expect(handedScope(some, some[3]!)?.id).toBe('E1')
  expect(handedScope(some, some[4]!)).toBeUndefined()
  expect(handedScope([...some.slice(1), item('M1', { assignee: 'claude' })], some[3]!)?.id).toBe('M1')
  const allDone = some.map(one => (one.id === 'T2' ? { ...one, status: 'done' as const } : one))
  expect(statusOf(allDone, allDone[1]!)).toBe('review')
  // M1 wasn't handed over, but isn't done while E1 waits on review.
  expect(statusOf(allDone, allDone[0]!)).toBe('review')
  expect(statusOf(allDone.map(one => (one.id === 'E1' ? { ...one, status: 'done' as const } : one)), allDone[0]!)).toBe('done')
  expect(statusOf(allDone, { ...allDone[1]!, status: 'done' })).toBe('done')
  expect(statusOf(allDone, { ...allDone[1]!, status: 'in_progress' })).toBe('in_progress')
  // The outermost handed scope holds the only review.
  const both = allDone.map(one => (one.id === 'M1' ? { ...one, assignee: 'claude' } : one))
  expect(statusOf(both, both[1]!)).toBe('done')
  expect(statusOf(both, both[0]!)).toBe('review')
  // Nothing handed: a finished epic is just done.
  expect(statusOf(allDone.map(one => (one.id === 'E1' ? { ...one, assignee: null } : one)), { ...allDone[1]!, assignee: null })).toBe('done')

  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  const inScope = String((await call({ action: 'update', id: 'T2', status: 'done', note: '-' })).result)
  // Nothing else in E1 to start, so the answer stops at the close.
  expect(inScope).toContain('T2: status in_progress → done; no release note needed; nothing else in E1 is ready')
  expect(scripts.some(one => one.includes("status='done'") && one.includes("WHERE id='T2'"))).toBe(true)
  expect(String((await call({ action: 'update', id: 'T3', status: 'done', note: '-' })).result)).toContain("waiting on the user's approval")
  expect((await call({ action: 'update', id: 'E1', status: 'done' })).deny).toContain('closes when its tasks are done')
})

test('a handed epic in review is approved, or sent back, from its card', async ($, on) => {
  const some = [item('E1', { assignee: 'claude' }), item('T1', { parent: 'E1', status: 'done' })]
  const scripts: string[] = []
  let submitted = ''
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('prompt.submit', ($, e) => ((submitted = e.text), { text: e.text, origin: e.origin }))
  const agentDone = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'update', id: 'E1', status: 'done' } as never)).result)
  expect(agentDone).toContain("waiting on the user's approval")
  expect(scripts.some(one => one.includes("status='review'") && one.includes("WHERE id='E1'"))).toBe(true)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'tab-tree' })
  await ui.press({ key: 'row-E1' })
  await ui.press({ key: 'approve' })
  expect(scripts.some(one => one.includes("status='done'") && one.includes("WHERE id='E1'"))).toBe(true)
  await ui.press({ key: 'request' })
  await ui.input({ key: 'changes', text: 'add an empty state' } as never)
  expect(submitted).toContain('sent roadmap epic E1')
  await ui.unmount()
})

test("an epic up for review waits in the board's Review column, whose card approves and merges it", async ($, on) => {
  const some = [
    item('E1', { assignee: 'claude', title: 'Things' }), item('T1', { parent: 'E1', status: 'done' }), item('T2', { parent: 'E1', status: 'done' }),
    // Not up for review: nobody was handed E2, and E3's tasks aren't all done.
    item('E2'), item('T3', { parent: 'E2', status: 'done' }),
    item('E3', { assignee: 'claude' }), item('T4', { parent: 'E3' }),
  ]
  const ghList = JSON.stringify([{ number: 9, title: 'E1: Things', headRefName: 'e1-things', state: 'OPEN', url: 'https://x/9', statusCheckRollup: [] }])
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'gh' && e.argv[2] === 'list') return { value: { ...fakeSqlite('', null), stdout: ghList } }
    if (e.argv[0] === 'gh' || e.argv[0] === 'git') return { value: { ...fakeSqlite('', null), stdout: '' } }
    return { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1 }) as never)
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show', id: 'E1' } as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  expect(await ui.find({ key: 'card-E1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/2 tasks/ })).toBeDefined()
  expect(await ui.find({ key: 'card-E2' })).toBeUndefined()
  expect(await ui.find({ key: 'card-E3' })).toBeUndefined()
  await ui.press({ key: 'card-E1' })
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'merge-yes' })
  expect(ran.some(argv => argv.join(' ') === 'gh pr merge 9 --merge')).toBe(true)
  await ui.unmount()
})

test('new item from the board: n opens the form, choices narrow the parents, Enter creates and opens it', async ($, on) => {
  const some = [item('M1'), item('E1', { parent: 'M1' }), item('T1', { parent: 'E1' }), item('M2'), item('T2', { parent: 'M2', status: 'done' })]
  expect(homesFor(some, 'task').map(one => one.id)).toEqual(['M1', 'E1'])
  expect(homesFor(some, 'epic').map(one => one.id)).toEqual(['M1'])
  expect(homesFor(some, 'milestone')).toEqual([])
  const scripts: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    scripts.push(stdin)
    return { value: stdin.includes('INSERT INTO counters') ? { ...fakeSqlite('', null), stdout: 'T9' } : fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'new' })
  expect(await ui.find({ key: 'new-title' })).toBeDefined()
  await ui.select({ key: 'new-parent', value: 'E1' } as never)
  await ui.select({ key: 'new-priority', value: 'p1' } as never)
  await ui.select({ key: 'new-type', value: 'bug' } as never)
  await ui.input({ key: 'new-title', text: 'Crash on empty input' } as never)
  const insert = scripts.find(one => one.includes('INSERT INTO items'))!
  expect(insert).toContain("'Crash on empty input'")
  expect(insert).toContain("'E1'")
  expect(insert).toContain("'p1', 'bug'")
  expect(await ui.find({ key: 'new-title' })).toBeUndefined()

  // From an open epic, n adds under it; switching to a milestone drops the parent it can't take.
  await ui.press({ key: 'close' }).catch(() => undefined)
  await ui.press({ key: 'tab-tree' })
  await ui.press({ key: 'row-E1' })
  await ui.press({ key: 'new-under' })
  expect((await ui.find({ key: 'new-parent' }))?.props.value).toBe('E1')
  await ui.select({ key: 'new-kind', value: 'milestone' } as never)
  expect(await ui.find({ key: 'new-parent' })).toBeUndefined()
  await ui.press({ key: 'new-cancel' })
  expect(await ui.find({ key: 'hand' })).toBeDefined()
  await ui.unmount()
})

test('edit a card: e shows its fields; each saves on its own through update', async ($, on) => {
  const some = [
    item('M1'), item('E1', { parent: 'M1' }), item('E2', { parent: 'M1' }),
    item('T1', { parent: 'E1', title: 'Old title', description: 'one line', labels: ['ui'] }),
    item('T2', { description: 'first\nsecond' }),
  ]
  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  const wrote = (...needles: string[]) => scripts.some(one => needles.every(n => one.includes(n)))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'card-T1' })
  expect(await ui.find({ key: 'edit-title' })).toBeUndefined()
  await ui.press({ key: 'edit' })
  expect((await ui.find({ key: 'edit-title' }))?.props.value).toBe('Old title')
  await ui.input({ key: 'edit-title', text: 'New title' } as never)
  expect(wrote("title='New title'", "WHERE id='T1'")).toBe(true)
  await ui.input({ key: 'edit-labels', text: 'ui, Auth Flow' } as never)
  expect(wrote("INSERT INTO labels(item_id, label) VALUES ('T1', 'auth-flow')")).toBe(true)
  await ui.select({ key: 'edit-priority', value: 'p0' } as never)
  expect(wrote("priority='p0'")).toBe(true)
  await ui.select({ key: 'edit-parent', value: 'E2' } as never)
  expect(wrote("parent='E2'")).toBe(true)
  await ui.input({ key: 'edit-desc', text: '' } as never)
  expect(wrote('description=NULL')).toBe(true)
  const before = scripts.length
  await ui.input({ key: 'edit-due', text: 'next week' } as never)
  expect(scripts.slice(before).some(one => one.includes('due='))).toBe(false)
  await ui.press({ key: 'edit' })
  expect(await ui.find({ key: 'edit-title' })).toBeUndefined()
  // A description of several lines isn't flattened by a one-line field.
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T2' })
  await ui.press({ key: 'edit' })
  expect(await ui.find({ key: 'edit-desc' })).toBeUndefined()
  await ui.unmount()
})

test('edit a card\'s checklist and blockers: reword, drop, add, and set what it waits on', async ($, on) => {
  const some = [
    item('T1', { checklist: [{ n: 1, text: 'parses', done: true }, { n: 2, text: 'errs', done: false }, { n: 3, text: 'docs', done: true }] }),
    item('T2'), item('T3', { blocked_by: ['T1'] }),
  ]
  const scripts: string[] = []
  let toast = ''
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', ($, e) => ((toast = String((e as { text?: string }).text ?? JSON.stringify(e))), { value: undefined }) as never)
  const wrote = (...needles: string[]) => scripts.some(one => needles.every(n => one.includes(n)))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'card-T1' })
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit-check-2', text: 'errors are named' } as never)
  expect(wrote("VALUES ('T1', 1, 'parses', 1)", "VALUES ('T1', 2, 'errors are named', 0)", "VALUES ('T1', 3, 'docs', 1)")).toBe(true)
  await ui.input({ key: 'edit-check-1', text: '' } as never)
  expect(wrote("VALUES ('T1', 1, 'errs', 0)", "VALUES ('T1', 2, 'docs', 1)")).toBe(true)
  await ui.input({ key: 'edit-check-new', text: 'tested' } as never)
  expect(wrote("VALUES ('T1', 4, 'tested', 0)")).toBe(true)
  await ui.input({ key: 'edit-blockers', text: 'T2' } as never)
  expect(wrote("INSERT OR IGNORE INTO links(blocker, blocked) VALUES ('T2', 'T1')")).toBe(true)
  // T3 already waits on T1: T1 waiting on T3 would be a cycle, and says so.
  await ui.input({ key: 'edit-blockers', text: 'T3' } as never)
  expect(toast).toContain('cycle')
  await ui.unmount()
})

test("approving the person's own work starts no turn; an agent's approvals each start their own", async ($, on) => {
  const some = [item('T1', { status: 'review', assignee: 'user' }), item('T2', { status: 'review', assignee: 'claude' }), item('T3', { status: 'review', assignee: 'explore:a' })]
  const submitted: string[] = []
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text, origin: e.origin }))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  for (const id of ['T1', 'T2', 'T3']) {
    await ui.press({ key: `card-${id}` })
    await ui.press({ key: 'approve' })
    await ui.press({ key: 'close' })
  }
  expect(submitted.map(text => /roadmap task (T\d)/.exec(text)?.[1])).toEqual(['T2', 'T3'])
  await ui.unmount()
})

test('pull requests on the board: a tag on the row, a line under the bar, and a stacked one waits for the one below', async ($, on) => {
  const some = [
    item('T1', { status: 'review', assignee: 'claude', title: 'Top' }),
    item('T2', { status: 'review', assignee: 'claude', title: 'Bottom' }),
  ]
  const ghList = JSON.stringify([
    { number: 12, title: 'T1: Top', headRefName: 't1-top', baseRefName: 't2-bottom', state: 'OPEN', url: 'https://x/12', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    { number: 11, title: 'T2: Bottom', headRefName: 't2-bottom', baseRefName: 'main', state: 'OPEN', url: 'https://x/11', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  ])
  const ran: string[][] = []
  const submitted: string[] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'gh' && e.argv[2] === 'list') return { value: { ...fakeSqlite('', null), stdout: ghList } }
    if (e.argv[0] === 'gh' || e.argv[0] === 'git') return { value: { ...fakeSqlite('', null), stdout: '' } }
    return { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1 }) as never)
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text, origin: e.origin }))
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show', id: 'T1' } as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  // The rows say which PR each Approve would merge.
  expect(await ui.find({ type: 'Text', text: /PR #12 ✓/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR #11 ✓/ })).toBeDefined()
  // The top of the stack: its line says where it merges and what goes first; Approve won't merge it.
  await ui.press({ key: 'card-T1' })
  expect(await ui.find({ key: 'pr-line' })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://x/12')
  expect(await ui.find({ type: 'Text', text: /stacked on #11: merge that first/ })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(await ui.find({ type: 'Text', text: /PR #12 is stacked on #11; merge #11 first/ })).toBeDefined()
  expect(await ui.find({ key: 'merge-yes' })).toBeUndefined()
  expect(await ui.find({ key: 'merge-no' })).toBeDefined()
  await ui.press({ key: 'merge-cancel' })
  await ui.press({ key: 'close' })
  // The bottom one merges into main, and says so.
  await ui.press({ key: 'card-T2' })
  await ui.press({ key: 'approve' })
  expect(await ui.find({ type: 'Text', text: /Merge PR #11 into main\?/ })).toBeDefined()
  await ui.press({ key: 'merge-yes' })
  expect(ran.some(argv => argv.join(' ') === 'gh pr merge 11 --merge')).toBe(true)
  expect(ran.some(argv => argv.join(' ') === 'gh pr merge 12 --merge')).toBe(false)
  expect(submitted.at(-1)).toContain('merged PR #11 (branch t2-bottom) into main')
  await ui.unmount()
  // A PR merged into a branch other than main is said to be so, with no "switch to main".
  const note = approvalNote(some[0]!, { number: 12, title: '', state: 'open', url: '', ids: ['T1'], checks: 'pass', branch: 't1-top', base: 't2-bottom' })
  expect(note).toContain('into t2-bottom, not into main')
  expect(note).not.toContain('switch to main')
})

test('a card docks under the board: the board stays, another card swaps it, the open one or its ✕ closes it; a short pane shows the card alone', async ($, on) => {
  const ones = (n: number) => Array<number>(n).fill(1)
  expect(columnCaps({ todo: ones(10), in_progress: ones(2), blocked: [], review: ones(1), done: ones(40) }, 14, false)).toEqual({ todo: 2, in_progress: 2, blocked: 0, review: 1, done: 0 })
  expect(columnCaps({ todo: ones(10), in_progress: ones(2), blocked: [], review: ones(1), done: ones(40) }, 8, true)).toEqual({ todo: 6, in_progress: 2, blocked: 0, review: 1, done: 6 })
  // Cards that wrap to two rows in a narrow column count as two: the column stays above the card.
  expect(columnCaps({ todo: [1], in_progress: [], blocked: [], review: [2], done: Array<number>(40).fill(2) }, 12, true)).toEqual({ todo: 1, in_progress: 0, blocked: 0, review: 1, done: 5 })
  expect(rowsOf('T80 Safe… p1 bug ☑4/4 @claude', 35)).toBe(1)
  expect(rowsOf('T80 Safe… p1 bug ☑4/4 @claude', 22)).toBe(2)
  expect(rowsOf('T80 Safe… p1 bug ☑4/4 @claude', 21)).toBe(2)
  const some = [item('T1', { title: 'First' }), item('T2', { title: 'Second', status: 'in_progress' })]
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const mount = (bodyRows: number) => $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows } } as never,
  })
  const ui = await mount(45)
  await ui.press({ key: 'card-T1' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  expect(await ui.find({ key: 'card-T2' })).toBeDefined()
  expect((await ui.find({ key: 'detail' }))?.text).toContain('First')
  // Another card swaps what is docked.
  await ui.press({ key: 'card-T2' })
  expect((await ui.find({ key: 'detail' }))?.text).toContain('Second')
  expect((await ui.find({ key: 'detail' }))?.text).not.toContain('First')
  // The open card, pressed again, closes it.
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  // So does the ✕ on the card's title row.
  await ui.press({ key: 'card-T1' })
  await ui.press({ key: 'close-x' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  await ui.unmount()
  // Too short for both: the card stands in for the board.
  const short = await mount(20)
  await short.press({ key: 'card-T1' })
  expect(await short.find({ key: 'detail' })).toBeDefined()
  expect(await short.find({ key: 'card-T2' })).toBeUndefined()
  await short.unmount()
})

test('no stray hand-offs: no h/m/u keys, a yes before handing over, none on done work or work in review', async ($, on) => {
  const some = [
    item('T1'), item('T2', { status: 'done' }), item('T3', { status: 'review', assignee: 'claude' }),
    item('T4', { status: 'blocked' }), item('T5', { status: 'in_progress', assignee: 'claude' }),
    item('E1', { assignee: 'claude' }), item('T6', { parent: 'E1', status: 'done' }),
  ]
  let submitted = ''
  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('prompt.submit', ($, e) => ((submitted = e.text), { text: e.text, origin: e.origin }))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  await ui.press({ key: 'card-T1' })
  for (const key of ['hand', 'mine', 'unassign']) expect((await ui.find({ key }))?.props.hotkey).toBeUndefined()
  expect(await ui.find({ text: /h hand to Claude|m\/u assign/ })).toBeUndefined()
  await ui.press({ key: 'hand' })
  expect(submitted).toBe('')
  await ui.press({ key: 'hand-cancel' })
  expect(await ui.find({ key: 'hand-yes' })).toBeUndefined()
  expect(submitted).toBe('')
  await ui.press({ key: 'hand' })
  await ui.press({ key: 'hand-yes' })
  expect(submitted).toContain('Work on roadmap task T1')
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ key: 'hand' })).toBeUndefined()
  // In review the card approves or asks for changes; handing it over again would only repeat the first ask.
  for (const id of ['T3', 'E1']) {
    await ui.press({ key: 'close' })
    await ui.press({ key: `card-${id}` })
    expect(await ui.find({ key: 'hand' })).toBeUndefined()
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    expect(await ui.find({ key: 'request' })).toBeDefined()
  }
  for (const id of ['T4', 'T5']) {
    await ui.press({ key: 'close' })
    await ui.press({ key: `card-${id}` })
    expect(await ui.find({ key: 'hand' })).toBeDefined()
  }
  await ui.unmount()
})

test('epic and milestone ids link too: a scope\'s PR shows on it, on what it sits in, and on its tasks', async () => {
  expect(idsIn('E9: agent coordination (M4), branch e9-agent-coordination; e2e tests, t3a, ME4')).toEqual(['E9', 'M4'])
  const some = [item('M1'), item('E1', { parent: 'M1' }), item('T1', { parent: 'E1' }), item('T2')]
  const prs = parsePrs(JSON.stringify([{ number: 9, title: 'E1: Auth', headRefName: 'e1-auth', state: 'OPEN', url: 'https://x/9' }]))
  const commits = parseGitLog('aaa1111\x1fAda\x1f2026-10-09\x1fE1: wire it up\n\x1e\n')
  const on = (id: string) => refsFor(some, { commits, prs }, some.find(one => one.id === id)!)
  expect(on('E1').prs.map(pr => pr.number)).toEqual([9])
  expect(on('M1').prs.map(pr => pr.number)).toEqual([9])
  expect(on('T1').prs.map(pr => pr.number)).toEqual([9])
  expect(on('T1').commits).toEqual([])
  expect(on('M1').commits.map(c => c.hash)).toEqual(['aaa1111'])
  expect(on('T2')).toEqual({ commits: [], prs: [] })
})

test('branch and pull request per unit of work: named from the unit, body from its tasks, asked for at review', async ($, on) => {
  const some = [
    item('E1', { title: 'Agent coordination!', assignee: 'claude', description: 'Keep agents apart.' }),
    item('T1', { parent: 'E1', title: 'Leases', status: 'in_progress', assignee: 'claude', checklist: [{ n: 1, text: 'renews', done: true }] }),
    item('T2', { title: 'Lone fix', status: 'in_progress', assignee: 'claude', checklist: [{ n: 1, text: 'fixed', done: true }] }),
  ]
  expect(unitOf(some, some[1]!).id).toBe('E1')
  expect(unitOf(some, some[2]!).id).toBe('T2')
  expect(branchFor(some[0]!)).toBe('e1-agent-coordination')
  expect(pullRequest(some, some[0]!)).toEqual({
    branch: 'e1-agent-coordination',
    title: 'E1: Agent coordination!',
    body: 'Keep agents apart.\n\n- **T1** Leases\n  - [x] renews\n\nTracked on the roadmap as E1.',
  })
  expect(pullRequest(some, some[2]!).body).toBe('- [x] fixed\n\nTracked on the roadmap as T2.')
  const reviewing = [{ ...some[0]!, status: 'review' as const }, { ...some[1]!, status: 'done' as const }, item('T3', { status: 'review', assignee: 'claude' })]
  const refs = { commits: [], prs: parsePrs(JSON.stringify([{ number: 4, title: 'E1: Agent coordination', headRefName: 'e1-agent-coordination', state: 'OPEN', url: 'https://x/4' }])) }
  const text = brief({ items: reviewing, activity: [], seen: {} }, 'claude', [], undefined, refs)!
  expect(text).toMatch(/E1 .* — PR #4 https:\/\/x\/4/)
  expect(text).toMatch(/T3 .* — no PR yet/)

  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    const isClaim = stdin.includes("'assign'") && stdin.includes('lease_at=')
    return { value: isClaim ? { ...fakeSqlite('', null), stdout: 'claude' } : fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
  expect(String((await call({ action: 'claim', id: 'T1' })).result)).toContain("Work on branch e1-agent-coordination (E1's, which this task ships in)")
  expect(String((await call({ action: 'claim', id: 'T2' })).result)).toContain('Work on branch t2-lone-fix:')
  const done = String((await call({ action: 'update', id: 'T2', status: 'done', note: '-' })).result)
  expect(done).toContain('Now open its pull request')
  expect(done).toContain('gh pr create --title "T2: Lone fix"')
  const pr = String((await call({ action: 'pr', id: 'T1' })).result)
  expect(pr).toContain('Branch: e1-agent-coordination')
  expect(pr).toContain('Title: E1: Agent coordination!')
})

test('review with a pull request: checks on the card; Approve offers to merge and tells Claude how it went; changes go on the PR too', async ($, on) => {
  expect(checksOf([])).toBe('none')
  expect(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass')
  expect(checksOf([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pending')
  expect(checksOf([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail')

  const some = [item('E1', { assignee: 'claude', status: 'review' }), item('T1', { parent: 'E1', status: 'done' }), item('T2', { status: 'review', assignee: 'claude' })]
  const ghList = JSON.stringify([
    { number: 8, title: 'E1: Things', headRefName: 'e1-things', baseRefName: 'main', state: 'OPEN', url: 'https://x/8', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] },
  ])
  const ran: string[][] = []
  const scripts: string[] = []
  let mergeExit = 1
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'gh' && e.argv[2] === 'list') return { value: { ...fakeSqlite('', null), stdout: ghList } }
    if (e.argv[0] === 'gh' && e.argv[2] === 'merge') return { value: { ...fakeSqlite('', null), exitCode: mergeExit, stderr: 'not mergeable' } }
    if (e.argv[0] === 'gh' || e.argv[0] === 'git') return { value: { ...fakeSqlite('', null), stdout: '' } }
    scripts.push(e.init?.stdin ?? '')
    return { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1 }) as never)
  const submitted: string[] = []
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text, origin: e.origin }))
  // `show` asks git and gh afresh, which is how the board learns of the PR here.
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show', id: 'E1' } as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'tab-tree' })
  await ui.press({ key: 'row-E1' })
  expect(await ui.find({ type: 'Text', text: /✗ checks failing/ })).toBeDefined()
  const wrote = (needle: string) => scripts.some(one => one.includes(needle))
  // A merge that fails leaves it in review.
  await ui.press({ key: 'approve' })
  expect(wrote("status='done'")).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Merge PR #8 into main \(checks: fail\)\?/ })).toBeDefined()
  await ui.press({ key: 'merge-yes' })
  expect(ran.some(argv => argv.join(' ') === 'gh pr merge 8 --merge')).toBe(true)
  expect(wrote("status='done'")).toBe(false)
  // Claude hears of the failure, with gh's reason, so it can deal with it.
  expect(submitted.at(-1)).toContain('merging PR #8 (branch e1-things) failed: not mergeable')
  expect(submitted.at(-1)).toContain('E1 stays in review')
  // Merged: approved, with a note saying so.
  mergeExit = 0
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'merge-yes' })
  expect(wrote('Approved; merged PR #8.')).toBe(true)
  expect(wrote("status='done'")).toBe(true)
  // And of the merge, to bring the checkout up to date.
  expect(submitted.at(-1)).toContain('approved roadmap epic E1 (E1 title) on the board and merged PR #8 (branch e1-things)')
  expect(submitted.at(-1)).toContain('switch to main and pull, delete the local branch e1-things')
  // Approve only never merges.
  const merges = ran.filter(argv => argv[2] === 'merge').length
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'merge-no' })
  expect(ran.filter(argv => argv[2] === 'merge').length).toBe(merges)
  expect(submitted.at(-1)).toContain('No pull request was merged with it')
  expect(submitted.length).toBe(3)
  // Request changes puts the note on the PR too.
  await ui.press({ key: 'request' })
  await ui.input({ key: 'changes', text: 'split the migration' } as never)
  expect(ran.some(argv => argv.join(' ') === 'gh pr comment 8 --body Changes requested: split the migration')).toBe(true)
  await ui.unmount()
})

test('undo on the board: Undo (z) takes back the last change; a line on a card reverts that change; a refusal says why', async ($, on) => {
  const some = [item('T1', { status: 'done' })]
  const activity: Activity[] = [
    { id: 6, item_id: 'T1', author: 'user', type: 'edit', body: 'priority → p1', at: '2026-10-09T10:00:00Z', op: 6, undone: null, undoable: true },
    { id: 7, item_id: 'T1', author: 'user', type: 'status', body: 'status todo → done', at: '2026-10-09T10:01:00Z', op: 7, undone: null, undoable: true },
    { id: 8, item_id: 'T1', author: 'claude', type: 'comment', body: 'mine', at: '2026-10-09T10:02:00Z', op: 8, undone: null, undoable: true },
  ]
  const stored = (id: number) => ({ ...activity.find(one => one.id === id)!, undo: `SELECT 'UNDO-${id}';`, redo: `SELECT 'REDO-${id}';`, reverts: null })
  const writes: string[] = []
  const toasts: string[] = []
  let isStale = false
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    const asked = /FROM activity WHERE id IN \(([\d, ]+)\)/.exec(stdin)?.[1]
    if (asked) return { value: { ...fakeSqlite('', null), stdout: JSON.stringify(asked.split(', ').map(Number).map(stored)) } }
    if (stdin.startsWith('BEGIN')) {
      writes.push(stdin)
      if (isStale) return { value: { ...fakeSqlite('', null), exitCode: 1, stdout: '', stderr: "Error near line 3: bad JSON path: '!T1''s status has changed since; change it directly'" } }
    }
    return { value: fakeSqlite(stdin, { items: some, activity, seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  // The header's Undo takes back the person's newest change, not Claude's comment after it.
  expect((await ui.find({ key: 'undo' }))?.props.hotkey).toBe('z')
  await ui.press({ key: 'undo' })
  expect(writes.at(-1)).toContain("SELECT 'UNDO-7';")
  expect(writes.at(-1)).toContain('undid “status todo → done”')
  expect(writes.at(-1)).not.toContain('UNDO-6')
  expect(toasts.at(-1)).toBe('roadmap: Undid T1: status todo → done')
  // On the card, each change still standing has its own revert, Claude's comment too.
  await ui.press({ key: 'card-T1' })
  for (const id of [6, 7, 8]) expect(await ui.find({ key: `revert-${id}` })).toBeDefined()
  await ui.press({ key: 'revert-6' })
  expect(writes.at(-1)).toContain("SELECT 'UNDO-6';")
  // A change something later overwrote is refused, in the guard's words.
  isStale = true
  await ui.press({ key: 'revert-7' })
  expect(toasts.at(-1)).toBe("roadmap: T1's status has changed since; change it directly")
  await ui.unmount()
  // Undone changes, undos and others' changes aren't the person's last change.
  expect(lastChange({ items: some, activity: [{ ...activity[1]!, undone: 9 }, activity[0]!, activity[2]!], seen: {} }, 'user').map(one => one.id)).toEqual([6])
  expect(lastChange({ items: some, activity: [activity[2]!], seen: {} }, 'user')).toEqual([])
})

test('export and import: the whole roadmap to a JSON file, and back only into an empty roadmap', async ($, on) => {
  const written: Record<string, string> = {}
  let count = '0 0'
  const scripts: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    scripts.push(stdin)
    if (stdin.startsWith('SELECT json_object(\'items\', (SELECT json_group_array(json_object(\'id\', id, \'kind\'')) {
      if (stdin.includes('FROM counters')) return { value: { ...fakeSqlite('', null), stdout: JSON.stringify({ items: [{ id: 'T1', kind: 'task', title: 'kept' }], activity: [], counters: [{ prefix: 'T', n: 1 }] }) } }
    }
    if (stdin.startsWith('SELECT (SELECT count(*) FROM items)')) return { value: { ...fakeSqlite('', null), stdout: count } }
    return { value: fakeSqlite(stdin, { items: [], activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('fs.write', ($, e) => ((written[e.path] = e.text), { value: undefined }) as never)
  on('fs.read', ($, e) => (written[e.path] === undefined ? { deny: 'ENOENT' } : { value: written[e.path] }) as never)
  on('session.root', () => ({ value: '/work/project' }) as never)
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  const call = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  expect(await call({ action: 'export' })).toBe('Exported 1 item(s) and 0 timeline entries to .claude/roadmap-export-2026-10-09.json. import (path) restores it into an empty roadmap.')
  const file = JSON.parse(written['/work/project/.claude/roadmap-export-2026-10-09.json']!)
  expect(file).toEqual({ roadmap: 'export', schema: VERSION, exported_at: '2026-10-09T12:00:00.000Z', tables: { items: [{ id: 'T1', kind: 'task', title: 'kept' }], activity: [], counters: [{ prefix: 'T', n: 1 }] } })
  await call({ action: 'export', path: '~/saved.json' })
  expect(written['/home/me/saved.json']).toBeDefined()
  // Into a roadmap that holds anything, it is refused; into an empty one, it lands in one transaction.
  count = '3 9'
  expect(await call({ action: 'import', path: '~/saved.json' })).toContain('already holds 3 item(s) and 9 timeline entries')
  count = '0 0'
  expect(await call({ action: 'import', path: '~/saved.json' })).toBe('Imported 1 item(s) and 0 timeline entries from ~/saved.json.')
  const landed = scripts.find(one => one.includes('INSERT OR IGNORE INTO items(id, kind, title)'))!
  expect(landed.startsWith('BEGIN IMMEDIATE;')).toBe(true)
  expect(landed).toContain("INSERT INTO counters(prefix, n) VALUES ('T', 1)")
  // Not an export, or one from a newer build: refused, naming why.
  written['/work/project/x.json'] = '{"hello": 1}'
  expect(await call({ action: 'import', path: 'x.json' })).toBe('not a roadmap export')
  written['/work/project/y.json'] = JSON.stringify({ roadmap: 'export', schema: VERSION + 1, exported_at: '', tables: {} })
  expect(await call({ action: 'import', path: 'y.json' })).toContain('from a newer roadmap mod')
  expect(await call({ action: 'import', path: 'nope.json' })).toBe('cannot read nope.json')
})

test('backups: on start, a JSON export outside the checkout when the roadmap changed, the newest twenty kept', async ($, on) => {
  const written: string[] = []
  const removed: string[][] = []
  let stamp = '41'
  let listed = Array.from({ length: 20 }, (_, i) => ({ name: `roadmap-2026-10-0${i < 9 ? i + 1 : 9}T00-00-${String(i).padStart(2, '0')}Z-a${i}.json`, kind: 'file' }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') return (removed.push([...e.argv]), { value: { ...fakeSqlite('', null), stdout: '' } })
    if (e.argv[0] !== 'sqlite3') return { value: { ...fakeSqlite('', null), stdout: '' } }
    const stdin = e.init?.stdin ?? ''
    if (stdin.trim() === 'SELECT COALESCE(MAX(id), 0) FROM activity;') return { value: { ...fakeSqlite('', null), stdout: stamp } }
    if (stdin.includes('FROM counters')) return { value: { ...fakeSqlite('', null), stdout: '{"items":[]}' } }
    return { value: fakeSqlite(stdin, { items: [item('T1')], activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('fs.list', () => ({ value: listed }) as never)
  on('fs.write', ($, e) => (written.push(e.path), { value: undefined }) as never)
  on('session.root', () => ({ value: '/work/project' }) as never)
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('tool.register', () => ({ value: {} }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: {} }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
  expect(written).toEqual(['/home/me/.claude/roadmap-backups/-work-project/roadmap-2026-10-09T12-00-00-000Z-a41.json'])
  // Twenty were there: the oldest goes.
  expect(removed).toEqual([['rm', '-f', `/home/me/.claude/roadmap-backups/-work-project/${listed[0]!.name}`]])
  // The newest backup already holds the roadmap as it stands: nothing new is written.
  written.length = 0
  stamp = '19'
  listed = listed.slice(0, 20)
  await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
  expect(written).toEqual([])
})

test('release notes: an agent sets a task done with its note; the PR body lists the notes by section', async ($, on) => {
  const some = [item('E1', { assignee: 'claude', title: 'Things' }), item('T1', { parent: 'E1', type: 'bug', status: 'in_progress' }), item('T2', { parent: 'E1', assignee: 'explore:x' })]
  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  const call = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  // Done without a note is asked for one, naming the section its type suggests, and writes nothing.
  scripts.length = 0
  const asked = await call({ action: 'update', id: 'T1', status: 'done' })
  expect(asked).toContain('T1 has no release note')
  expect(asked).toContain('Fixed by default')
  expect(scripts.some(one => one.startsWith('BEGIN'))).toBe(false)
  expect(await call({ action: 'update', id: 'T1', status: 'done', note: 'Cards no longer flicker', section: 'nope' })).toContain('section must be one of Added, Changed, Fixed')
  const done = await call({ action: 'update', id: 'T1', status: 'done', note: 'Cards no longer flicker', section: 'fixed' })
  expect(done).toContain('release note set')
  expect(done).toContain('section → Fixed')
  expect(scripts.some(one => one.startsWith('BEGIN') && one.includes("note='Cards no longer flicker'"))).toBe(true)
  // "none" or "-": the work needs no line.
  expect(await call({ action: 'update', id: 'T2', note: 'none' })).toBe('T2: no release note needed')
  expect(await call({ action: 'update', id: 'E1', note: 'x' })).toBe('Only tasks carry a release note')
  // The PR body: notes by section, with their task; a "-" or missing note is left out.
  const noted = [
    some[0]!, { ...some[1]!, note: 'Cards no longer flicker', section: 'Fixed' as const },
    { ...some[2]!, note: 'Undo on the board' }, item('T3', { parent: 'E1', note: '-' }), item('T4', { parent: 'E1', type: 'chore', note: 'Faster tests' }),
  ]
  expect(pullRequest(noted, noted[0]!).body).toContain('### Release notes\n\nAdded:\n- Undo on the board (T2)\n\nChanged:\n- Faster tests (T4)\n\nFixed:\n- Cards no longer flicker (T1)')
  expect(pullRequest([item('T9')], item('T9')).body).not.toContain('Release notes')
})

test('changelog: merged notes go under [Unreleased], each in its section, newest first; nothing twice', async ($, on) => {
  const file = [
    '# Changelog', '', 'Intro.', '', '## [Unreleased]', '', '### Added', '', '- Older thing.', '', '### Fixed', '', '- Old fix.', '', '## 0.4.0 - 2026-10-09', '', '### Added', '', '- Install.', '',
  ].join('\n')
  const out = withNotes(file, [{ section: 'Added', note: 'Undo.' }, { section: 'Changed', note: 'Faster.' }, { section: 'Fixed', note: 'Old fix.' }, { section: 'Fixed', note: 'New fix.' }])
  expect(out.added).toEqual(['Undo.', 'Faster.', 'New fix.'])
  expect(out.text).toBe([
    '# Changelog', '', 'Intro.', '', '## [Unreleased]', '', '### Added', '', '- Undo.', '- Older thing.', '', '### Changed', '', '- Faster.', '', '### Fixed', '', '- New fix.', '- Old fix.', '', '## 0.4.0 - 2026-10-09', '', '### Added', '', '- Install.', '',
  ].join('\n'))
  expect(withNotes(out.text, [{ section: 'Added', note: 'Undo.' }])).toEqual({ text: out.text, added: [] })
  // No [Unreleased] yet: made above the newest version. No file: made from scratch.
  expect(withNotes('# Changelog\n\n## 0.4.0\n\n- x\n', [{ section: 'Fixed', note: 'y' }]).text).toBe('# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- y\n\n## 0.4.0\n\n- x\n')
  expect(withNotes(undefined, [{ section: 'Added', note: 'First.' }]).text.replace(/\n*$/, '\n')).toBe('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- First.\n')

  // Merged work only: an open PR holds its notes back; a merged one, or none at all, lets them through.
  const some = [
    item('E1', { assignee: 'claude' }), item('T1', { parent: 'E1', status: 'done', note: 'In an open PR' }),
    item('E2', { assignee: 'claude' }), item('T2', { parent: 'E2', status: 'done', note: 'Merged' }),
    item('T3', { status: 'done', note: 'Straight to main', type: 'bug' }), item('T4', { status: 'review', note: 'Not done' }), item('T5', { status: 'done', note: '-' }),
  ]
  const prs = parsePrs(JSON.stringify([
    { number: 1, title: 'E1: a', headRefName: 'e1-a', state: 'OPEN', url: '' }, { number: 2, title: 'E2: b', headRefName: 'e2-b', state: 'MERGED', url: '' },
  ]))
  expect(mergedNotes(some, { commits: [], prs }).map(one => one.id)).toEqual(['T3', 'T2'])

  const written: Record<string, string> = {}
  on('process.run', ($, e) =>
    e.argv[0] === 'gh' ? { value: { ...fakeSqlite('', null), stdout: JSON.stringify([{ number: 2, title: 'E2: b', headRefName: 'e2-b', state: 'MERGED', url: '' }, { number: 1, title: 'E1: a', headRefName: 'e1-a', state: 'OPEN', url: '' }]) } }
    : e.argv[0] === 'git' ? { value: { ...fakeSqlite('', null), stdout: '' } }
    : { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('session.root', () => ({ value: '/work/project' }) as never)
  on('clock.now', () => ({ value: 1 }) as never)
  on('fs.read', ($, e) => (written[e.path] === undefined ? { deny: 'ENOENT' } : { value: written[e.path] }) as never)
  on('fs.write', ($, e) => ((written[e.path] = e.text), { value: undefined }) as never)
  written['/work/project/CHANGELOG.md'] = '# Changelog\n\n## [Unreleased]\n\n## 0.4.0\n'
  const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'changelog' } as never)
  expect(reply.result).toBe('Wrote 2 note(s) into CHANGELOG.md under [Unreleased]:\n- Straight to main\n- Merged')
  expect(written['/work/project/CHANGELOG.md']).toBe('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Merged\n\n### Fixed\n\n- Straight to main\n\n## 0.4.0\n')
  expect((await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'changelog' } as never)).result).toBe('CHANGELOG.md already has the notes of all merged work.')
})

test('release notes on the board: setting a task done asks for its note; the card shows it', async ($, on) => {
  const some = [item('T1', { status: 'in_progress' }), item('T2', { note: 'Shown on the card', section: 'Changed' })]
  const scripts: string[] = []
  on('process.run', ($, e) => (scripts.push(e.init?.stdin ?? ''), { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'card-T1' })
  await ui.press({ key: 'set-done' })
  // The person's done is final at once; the card then asks for the CHANGELOG line, Added for a feature.
  expect(scripts.some(one => one.includes("status='done'"))).toBe(true)
  expect((await ui.find({ key: 'note' }))?.props.label).toBe('Release note (Added)')
  await ui.input({ key: 'note', text: 'Something new' } as never)
  expect(scripts.some(one => one.includes("note='Something new'"))).toBe(true)
  expect(await ui.find({ key: 'note' })).toBeUndefined()
  await ui.press({ key: 'set-done' })
  await ui.press({ key: 'note-none' })
  expect(scripts.some(one => one.includes("note='-'"))).toBe(true)
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ type: 'Text', text: /Release note {2}\(Changed\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Shown on the card/ })).toBeDefined()
  await ui.unmount()
})

test('board to Claude: Ask Claude fills the prompt; a comment on an agent\'s card reaches it at once when set to, else with the next prompt', async ($, on) => {
  const some = [item('T1', { assignee: 'claude', status: 'in_progress', title: 'Parser' }), item('T2', { title: 'Free' })]
  const activity: Activity[] = []
  const filled: string[] = []
  const submitted: string[] = []
  const contexts: string[] = []
  const stored: Record<string, unknown> = {}
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    // A comment written lands in the timeline the next read sees.
    const said = /'user', 'comment', '([^']*)'/.exec(stdin)?.[1]
    if (stdin.startsWith('BEGIN') && said) activity.push({ id: 100 + activity.length, item_id: 'T1', author: 'user', type: 'comment', body: said, at: '2026-10-09T10:00:00Z' })
    return { value: fakeSqlite(stdin, { items: some, activity, seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', ($, e) => ({ value: stored[e.key] }) as never)
  on('store.set', ($, e) => ((stored[e.key] = e.value), { value: undefined }) as never)
  on('prompt.fill', ($, e) => (filled.push(e.text), { isFilled: true, text: e.text, cursor: e.text.length }) as never)
  on('prompt.submit', ($, e) => (submitted.push(e.text), contexts.push((e.context ?? []).join('\n')), { text: e.text, origin: e.origin }))
  // The first prompt takes the session's opening brief; news comes after.
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'card-T1' })
  await ui.press({ key: 'ask' })
  expect(filled).toEqual(['About roadmap task T1 (Parser): '])
  // Off by default: the comment waits, and Claude reads it in the brief of the person's next prompt.
  expect((await ui.find({ key: 'comment-turns' }))?.props.label).toBe('Waits for your prompt')
  await ui.input({ key: 'comment', text: 'use the new lexer' } as never)
  expect(submitted.length).toBe(1)
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
  expect(contexts.at(-1)).toContain('- T1: use the new lexer')
  // On: the next comment starts a turn of its own, and the setting is kept.
  await ui.press({ key: 'comment-turns' })
  expect(stored.commentTurns).toBe(true)
  expect((await ui.find({ key: 'comment-turns' }))?.props.label).toBe('Tells it now')
  await ui.input({ key: 'comment', text: 'and skip comments' } as never)
  expect(submitted.at(-1)).toBe('The user commented on roadmap task T1 (Parser), which you hold: "and skip comments". Read it with the roadmap tool (show T1) and act on it, commenting back there.')
  // A card nobody holds has no one to tell: no toggle, and no turn.
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ key: 'comment-turns' })).toBeUndefined()
  const before = submitted.length
  await ui.input({ key: 'comment', text: 'just a note' } as never)
  expect(submitted.length).toBe(before)
  await ui.unmount()
  expect(commentNote(item('T5', { assignee: 'explore:a', title: 'X' }), 'hi')).toContain('which explore:a holds: "hi". If explore:a is still running, pass it on (SendMessage)')
})

test('merge a stack from its bottom card: in order, each after its checks pass on main; items approved; a failure stops and tells Claude', async ($, on) => {
  const some = [
    item('T1', { status: 'review', assignee: 'claude', title: 'Bottom' }), item('T2', { status: 'review', assignee: 'claude', title: 'Middle' }),
    item('T3', { status: 'review', assignee: 'claude', title: 'Top' }),
  ]
  const pr = (number: number, id: string, branch: string, base: string) =>
    ({ number, title: `${id}: x`, headRefName: branch, baseRefName: base, state: 'OPEN', url: `https://x/${number}`, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  const ghList = JSON.stringify([pr(15, 'T3', 't3-top', 't2-middle'), pr(12, 'T2', 't2-middle', 't1-bottom'), pr(11, 'T1', 't1-bottom', 'main')])
  const ran: string[] = []
  const scripts: string[] = []
  const submitted: string[] = []
  let failing = 0
  let isGarbled = false
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === 'gh') {
      if (e.argv[2] === 'list') return { value: { ...fakeSqlite('', null), stdout: ghList } }
      ran.push(argv)
      if (e.argv[2] === 'view' && isGarbled) return { value: { ...fakeSqlite('', null), stdout: 'warning: not JSON' } }
      if (e.argv[2] === 'view') {
        const isFailing = Number(e.argv[3]) === failing
        return { value: { ...fakeSqlite('', null), stdout: JSON.stringify({ mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: isFailing ? 'FAILURE' : 'SUCCESS' }] }) } }
      }
      return { value: { ...fakeSqlite('', null), stdout: '' } }
    }
    if (e.argv[0] === 'git') return { value: { ...fakeSqlite('', null), stdout: '' } }
    scripts.push(e.init?.stdin ?? '')
    return { value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: 1 }) as never)
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text, origin: e.origin }))
  await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'show', id: 'T1' } as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  // Only the bottom's card offers the stack; the others are stacked on another PR.
  await ui.press({ key: 'card-T2' })
  expect(await ui.find({ key: 'merge-stack' })).toBeUndefined()
  await ui.press({ key: 'close' })
  await ui.press({ key: 'card-T1' })
  expect(await ui.find({ type: 'Text', text: /stack #11 ← #12 ← #15/ })).toBeDefined()
  await ui.press({ key: 'merge-stack' })
  expect(await ui.find({ type: 'Text', text: /Merge #11, then #12, then #15 into main, each once its checks pass there\?/ })).toBeDefined()
  await ui.press({ key: 'stack-yes' })
  expect(ran).toEqual([
    'gh pr view 11 --json statusCheckRollup,mergeable', 'gh pr merge 11 --merge',
    'gh pr edit 12 --base main', 'gh pr update-branch 12', 'gh pr view 12 --json statusCheckRollup,mergeable', 'gh pr merge 12 --merge',
    'gh pr edit 15 --base main', 'gh pr update-branch 15', 'gh pr view 15 --json statusCheckRollup,mergeable', 'gh pr merge 15 --merge',
  ])
  for (const id of ['T1', 'T2', 'T3']) expect(scripts.some(one => one.includes(`status='done'`) && one.includes(`WHERE id='${id}'`))).toBe(true)
  expect(submitted.at(-1)).toContain('The user merged the stack #11 ← #12 ← #15 from the board: merged #11 (t1-bottom), #12 (t2-middle), #15 (t3-top) into main')
  await ui.press({ key: 'close' })
  await ui.unmount()

  // The top's checks fail once it is on main: the run stops there, its item stays in review, and Claude hears where.
  ran.length = 0
  scripts.length = 0
  failing = 15
  const again = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await again.press({ key: 'card-T1' })
  await again.press({ key: 'merge-stack' })
  await again.press({ key: 'stack-yes' })
  expect(ran).not.toContain('gh pr merge 15 --merge')
  expect(ran).toContain('gh pr merge 12 --merge')
  expect(scripts.some(one => one.includes(`status='done'`) && one.includes("WHERE id='T3'"))).toBe(false)
  expect(submitted.at(-1)).toContain('then stopped at PR #15 (branch t3-top): its checks failed on main')
  await again.press({ key: 'close' })
  await again.unmount()

  // gh answers something that isn't JSON: the run stops there and says so, and a later run isn't refused as already merging.
  failing = 0
  isGarbled = true
  ran.length = 0
  const garbled = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await garbled.press({ key: 'card-T1' })
  await garbled.press({ key: 'merge-stack' })
  await garbled.press({ key: 'stack-yes' })
  expect(ran).toEqual(['gh pr view 11 --json statusCheckRollup,mergeable'])
  expect(submitted.at(-1)).toContain('stopped at PR #11')
  isGarbled = false
  ran.length = 0
  await garbled.press({ key: 'merge-stack' })
  await garbled.press({ key: 'stack-yes' })
  expect(ran).toContain('gh pr merge 11 --merge')
  await garbled.unmount()
  expect(stackFrom({ commits: [], prs: parsePrs(ghList) }, parsePrs(ghList)[1]!).map(one => one.number)).toEqual([12])
})

test('run tasks at once: picked backlog rows each get an agent, a worktree and a branch; a blocked one starts when its blocker is done', async ($, on) => {
  const some = [
    item('E1', { title: 'Group' }), item('T1', { parent: 'E1', title: 'Alpha', checklist: [{ n: 1, text: 'a', done: true }, { n: 2, text: 'b', done: false }] }),
    item('T2', { parent: 'E1', title: 'Beta' }), item('T3', { parent: 'E1', title: 'Gamma', blocked_by: ['T1'] }),
  ]
  const ran: string[] = []
  const spawned: { prompt: string; description: string; cwd?: string }[] = []
  const submitted: string[] = []
  const stored: Record<string, unknown> = {}
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    if (e.argv[0] === 'git') {
      ran.push(e.argv.join(' '))
      return { value: { ...fakeSqlite('', null), stdout: e.argv[1] === 'rev-parse' ? 'origin/main\n' : '' } }
    }
    if (e.argv[0] === 'gh') return { value: { ...fakeSqlite('', null), stdout: '[]' } }
    // Assignments land, so the next read sees whose each task is.
    for (const [, who, id] of [...stdin.matchAll(/UPDATE items SET assignee='([^']*)'.*? WHERE id='(T\d)'/g)])
      some.splice(some.findIndex(one => one.id === id), 1, { ...find(some, id!)!, assignee: who! })
    return { value: fakeSqlite(stdin, { items: some, activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('session.root', () => ({ value: '/work/project' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', ($, e) => ({ value: stored[e.key] }) as never)
  on('store.set', ($, e) => ((stored[e.key] = e.value), { value: undefined }) as never)
  on('agent.spawn', ($, e) => (spawned.push({ prompt: e.prompt, description: e.description, cwd: e.cwd }), { model: 'x', agentId: `a${spawned.length}` }) as never)
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text, origin: e.origin }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 200 } } as never,
  })
  await ui.press({ key: 'tab-backlog' })
  for (const id of ['T1', 'T2', 'T3']) await ui.press({ key: `pick-${id}` })
  await ui.press({ key: 'run-picked' })
  expect(await ui.find({ type: 'Text', text: /Run T1, T2, T3 at once, each by its own agent in its own worktree\? T3 starts when what it waits on is done\./ })).toBeDefined()
  await ui.press({ key: 'parallel-yes' })
  // T1 and T2 start now, each in a worktree on its own branch from the main line; T3 waits on T1.
  expect(ran.filter(one => one.startsWith('git worktree'))).toEqual([
    'git worktree add -b t1-alpha /work/project/.claude/worktrees/t1-alpha origin/main',
    'git worktree add -b t2-beta /work/project/.claude/worktrees/t2-beta origin/main',
  ])
  // Agents a plugin spawns can't call its tool, so the main loop is asked to start them, one turn for both.
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('roadmap tasks to run at once from the board: T1, T2. Start each now as its own background agent')
  expect(submitted[0]).toContain('--- T1\ndescription: T1 Alpha\nprompt:\nYou are working roadmap task T1: Alpha.')
  expect(submitted[0]).toContain('Your worktree is /work/project/.claude/worktrees/t2-beta, already on branch t2-beta')
  // The main loop's Agent call for one is put in its worktree, and named for its task.
  const prompt = submitted[0]!.split('--- T1\ndescription: T1 Alpha\nprompt:\n')[1]!.split('\n\n--- T2')[0]!
  await $.agent.spawn({ prompt, description: 'T1 Alpha', subagentType: 'general-purpose' } as never)
  expect(spawned.map(one => one.cwd)).toEqual(['/work/project/.claude/worktrees/t1-alpha'])
  // Each is assigned to its agent by name, T3 too, so the board shows whose each will be.
  expect(some.filter(one => one.kind === 'task').map(one => one.assignee)).toEqual(['general-purpose:t1-alpha', 'general-purpose:t2-beta', 'general-purpose:t3-gamma'])
  expect(stored.parallel).toEqual({ '/work/project': ['T3'] })
  // The band shows each agent's task and checklist once they are under way.
  some.splice(1, 2, { ...some[1]!, status: 'in_progress' }, { ...some[2]!, status: 'in_progress' })
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { bodyColumns: 100 } as never })
  expect((await band.find({ key: 'agent-T1' }))?.text).toContain('T1 ☑1/2')
  expect(await band.find({ key: 'agent-T2' })).toBeDefined()
  await band.unmount()
  // T1 done: when a turn ends (T1's agent's last), T3 starts.
  some.splice(1, 1, { ...some[1]!, status: 'done' })
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1' } as never)
  for (let i = 0; i < 100 && !submitted.at(-1)!.includes('T3'); i++) await ui.redraw()
  expect(submitted.at(-1)).toContain('from the board: T3. Start each now')
  expect(stored.parallel).toEqual({ '/work/project': [] })
  await ui.unmount()
})

test('mark all read: the button by the unread count reads everything; a comment after counts again', async ($, on) => {
  const snap: Snapshot = {
    items: [item('T1'), item('T2')],
    activity: [
      { id: 3, item_id: 'T1', author: 'claude', type: 'comment', body: 'one', at: '2026-10-09T10:00:00Z' },
      { id: 4, item_id: 'T2', author: 'claude', type: 'comment', body: 'two', at: '2026-10-09T10:00:00Z' },
    ],
    seen: {},
  }
  const scripts: string[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    scripts.push(stdin)
    // The database's answer: everything read, up to each item's newest entry.
    if (stdin.startsWith("INSERT INTO reads(reader, item_id, seen) SELECT 'user'")) snap.seen = { T1: 3, T2: 4 }
    return { value: fakeSqlite(stdin, snap) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
  expect(await ui.find({ type: 'Text', text: /● 2 unread/ })).toBeDefined()
  await ui.press({ key: 'mark-read' })
  expect(await ui.find({ type: 'Text', text: /unread/ })).toBeUndefined()
  expect(await ui.find({ key: 'mark-read' })).toBeUndefined()
  expect((await ui.find({ key: 'card-T1' }))?.text).not.toContain('●')
  // A new comment counts again.
  snap.activity.push({ id: 5, item_id: 'T2', author: 'claude', type: 'comment', body: 'three', at: '2026-10-09T11:00:00Z' })
  await $.command.run({ command: 'roadmap', args: '' } as never)
  expect(await ui.find({ type: 'Text', text: /● 1 unread/ })).toBeDefined()
  expect((await ui.find({ key: 'card-T2' }))?.text).toContain('● 1')
  await ui.unmount()
})

test('ship: versions compare, manifests bump in place, and [Unreleased] is cut with its links', async () => {
  expect(versionOf('v0.4.0')).toEqual([0, 4, 0])
  expect(versionOf('1.2')).toBeUndefined()
  expect(isAfter([0, 5, 0], [0, 4, 9])).toBe(true)
  expect(isAfter([0, 4, 0], [0, 4, 0])).toBe(false)
  expect(isAfter([0, 3, 9], [0, 4, 0])).toBe(false)
  expect(withVersion('{\n  "name": "x",\n  "version": "0.4.0",\n  "deps": { "version": "9" }\n}\n', '0.5.0')).toBe('{\n  "name": "x",\n  "version": "0.5.0",\n  "deps": { "version": "9" }\n}\n')
  expect(withVersion('{}', '1.0.0')).toBeUndefined()
  expect(webOf('git@github.com:astrosteveo/unclaude.git\n')).toBe('https://github.com/astrosteveo/unclaude')
  expect(webOf('https://github.com/astrosteveo/unclaude.git')).toBe('https://github.com/astrosteveo/unclaude')
  const log = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- Undo.\n\n## 0.4.0 - 2026-10-09\n\n- Old.\n\n[Unreleased]: https://github.com/o/r/commits/main\n'
  const cut = cutRelease(log, '0.5.0', '2026-10-10', 'https://github.com/o/r')
  expect(cut.notes).toBe('### Added\n\n- Undo.')
  expect(cut.text).toBe('# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.5.0] - 2026-10-10\n\n### Added\n\n- Undo.\n\n## 0.4.0 - 2026-10-09\n\n- Old.\n\n[Unreleased]: https://github.com/o/r/compare/v0.5.0...HEAD\n[0.5.0]: https://github.com/o/r/releases/tag/v0.5.0\n')
  expect(() => cutRelease(cut.text, '0.6.0', '2026-10-11', 'https://github.com/o/r')).toThrow('nothing is under [Unreleased]')
  // No links yet: they go at the end.
  expect(cutRelease('# C\n\n## [Unreleased]\n\n- x\n', '0.1.0', 'd', 'https://w').text).toBe('# C\n\n## [Unreleased]\n\n## [0.1.0] - d\n\n- x\n\n[Unreleased]: https://w/compare/v0.1.0...HEAD\n[0.1.0]: https://w/releases/tag/v0.1.0\n')
})

test('ship: a bump goes out as a PR; refused when lower, a first 1.0 unasked, or a dirty tree; tagging waits on the user', async ($, on) => {
  const files: Record<string, string> = {
    '/p/.claude-plugin/plugin.json': '{\n  "name": "roadmap",\n  "version": "0.4.0"\n}\n',
    '/p/CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Undo.\n\n## 0.4.0 - 2026-10-09\n\n- Old.\n\n[Unreleased]: https://github.com/o/r/commits/main\n',
  }
  const ran: string[] = []
  let dirty = ''
  let mergedPr = '[]'
  let branch = 'main'
  let behind = '0'
  let deleteFails = false
  let stableFails = false
  let onOrigin = true
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    if (e.argv[0] === 'git' || e.argv[0] === 'gh') {
      ran.push(line)
      const stdout = line === 'git remote get-url origin' ? 'git@github.com:o/r.git\n' : line === 'git status --porcelain' ? dirty
        : line === 'git symbolic-ref --short refs/remotes/origin/HEAD' ? 'origin/main\n' : line === 'git rev-parse --abbrev-ref HEAD' ? `${branch}\n`
        : line.startsWith('git rev-list --count') ? `${behind}\n`
        : line.startsWith('gh pr create') ? 'https://github.com/o/r/pull/30\n' : line.startsWith('gh pr list --head') ? mergedPr
        : line.startsWith('gh release create') ? 'https://github.com/o/r/releases/tag/v0.5.0\n'
        : line.startsWith('git ls-remote --heads origin') && onOrigin ? 'abc123\trefs/heads/release-v0.5.0\n' : ''
      const exitCode = line.startsWith('git rev-parse -q --verify') || (deleteFails && /^git (branch -D|push origin --delete)/.test(line)) ||
        (stableFails && line.endsWith(':refs/heads/stable')) ? 1 : 0
      return { value: { ...fakeSqlite('', null), stdout, exitCode } }
    }
    return { value: fakeSqlite(e.init?.stdin, { items: [], activity: [], seen: {} }) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('session.root', () => ({ value: '/p' }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-10T09:00:00Z') }) as never)
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] }) as never)
  on('fs.write', ($, e) => ((files[e.path] = e.text), { value: undefined }) as never)
  const ship = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'ship', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  expect(await ship({ version: '0.3.0' })).toBe("0.3.0 isn't after 0.4.0, the version now")
  expect(await ship({ version: '1.0.0' })).toContain('would be the first 1.x')
  dirty = ' M x\n'
  expect(await ship({ version: '0.5.0' })).toBe('the working tree has changes; commit or stash them first')
  dirty = ''
  // Cut from the main line only, and only once it is up to date with origin.
  branch = 'feature-x'
  expect(await ship({ version: '0.5.0' })).toBe('the checkout is on feature-x; a release is cut from main: switch to it and pull first')
  branch = 'main'
  behind = '2'
  expect(await ship({ version: '0.5.0' })).toBe('main is 2 commit(s) behind origin/main; pull first')
  behind = '0'
  expect(files['/p/.claude-plugin/plugin.json']).toContain('"version": "0.4.0"')
  ran.length = 0
  expect(await ship({ version: '0.5.0' })).toContain('Opened https://github.com/o/r/pull/30 for 0.5.0: .claude-plugin/plugin.json bumped')
  expect(ran.filter(one => !one.startsWith('git log') && !one.startsWith('gh pr list --state'))).toEqual([
    'git remote get-url origin', 'git status --porcelain', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git rev-parse --abbrev-ref HEAD',
    'git fetch origin main', 'git rev-list --count HEAD..origin/main', 'git switch -c release-v0.5.0', 'git commit -am Release 0.5.0',
    'git push -u origin release-v0.5.0', 'git switch main', 'gh pr create --head release-v0.5.0 --title Release 0.5.0 --body ### Added\n\n- Undo.',
  ])
  expect(files['/p/.claude-plugin/plugin.json']).toContain('"version": "0.5.0"')
  expect(files['/p/CHANGELOG.md']).toContain('## [Unreleased]\n\n## [0.5.0] - 2026-10-10\n\n### Added')
  // After the merge (the manifest reads 0.5.0): no merged PR yet is said; then tagging waits on the user's say.
  expect(await ship({ version: '0.5.0' })).toBe('no merged PR from release-v0.5.0 yet: merge the release PR first')
  mergedPr = JSON.stringify([{ number: 30, mergeCommit: { oid: 'abc123' } }])
  expect(await ship({ version: '0.5.0' })).toContain("Tagging v0.5.0 and publishing the release is the user's call")
  expect(ran.some(one => one.startsWith('git tag'))).toBe(false)
  ran.length = 0
  expect(await ship({ version: '0.5.0', approved: true })).toBe(
    "Released 0.5.0: tagged v0.5.0 on PR #30's merge and published https://github.com/o/r/releases/tag/v0.5.0. stable now serves 0.5.0. Deleted release-v0.5.0.")
  // stable, what installs get, moves to the release, and only here; then the release branch goes, here and on origin.
  expect(ran.slice(-4)).toEqual([
    'git push origin abc123:refs/heads/stable',
    'git branch -D release-v0.5.0', 'git ls-remote --heads origin release-v0.5.0', 'git push origin --delete release-v0.5.0',
  ])
  expect(ran.filter(one => one.includes('refs/heads/stable'))).toHaveLength(1)
  // One GitHub already deleted on the merge isn't asked for again.
  onOrigin = false
  ran.length = 0
  expect(await ship({ version: '0.5.0', approved: true })).toContain('Deleted release-v0.5.0.')
  expect(ran.some(one => one.startsWith('git push origin --delete'))).toBe(false)
  onOrigin = true
  // A branch that won't go never fails the release.
  deleteFails = true
  expect(await ship({ version: '0.5.0', approved: true })).toBe(
    "Released 0.5.0: tagged v0.5.0 on PR #30's merge and published https://github.com/o/r/releases/tag/v0.5.0. stable now serves 0.5.0.")
  deleteFails = false
  // A stable that can't fast-forward is left where it is, and said so; the release itself stands.
  stableFails = true
  expect(await ship({ version: '0.5.0', approved: true })).toContain('stable was not moved')
  stableFails = false
  expect(ran).toContain('git tag -a v0.5.0 -m v0.5.0 abc123')
  expect(ran).toContain('git push origin v0.5.0')
  expect(ran).toContain('gh release create v0.5.0 --title v0.5.0 --verify-tag --notes ### Added\n\n- Undo.')
  // A subagent's approval doesn't count.
  ran.length = 0
  expect(await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'ship', version: '0.5.0', approved: true, agentId: 'a1' } as never).then(r => String(r.result ?? r.deny))).toContain("the user's call")
})

test('ship with nothing under [Unreleased] writes the notes of merged work itself, and takes a CHANGELOG changelog left uncommitted', async ($, on) => {
  const files: Record<string, string> = {
    '/p/.claude-plugin/plugin.json': '{\n  "name": "roadmap",\n  "version": "0.6.0"\n}\n',
    '/p/CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-10-09\n\n### Fixed\n\n- Old fix.\n\n[Unreleased]: https://github.com/o/r/compare/v0.6.0...HEAD\n',
  }
  // T1 shipped in 0.6.0 already (its note is in the file); T2 merged since; T3 is still open on its PR.
  const snap = {
    items: [
      item('T1', { status: 'done', type: 'bug', note: 'Old fix.' }),
      item('T2', { status: 'done', type: 'bug', note: 'ship writes the notes itself.', updated_at: '2026-10-10T08:00:00Z' }),
      item('T3', { status: 'done', note: 'Not merged yet.' }),
    ],
    activity: [], seen: {},
  }
  const ran: string[] = []
  let dirty = ''
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    if (e.argv[0] === 'git' || e.argv[0] === 'gh') {
      ran.push(line)
      const stdout = line === 'git remote get-url origin' ? 'git@github.com:o/r.git\n' : line === 'git status --porcelain' ? dirty
        : line === 'git symbolic-ref --short refs/remotes/origin/HEAD' ? 'origin/main\n' : line === 'git rev-parse --abbrev-ref HEAD' ? 'main\n'
        : line.startsWith('git rev-list --count') ? '0\n'
        : line.startsWith('gh pr list --state') ? JSON.stringify([{ number: 9, title: 'T3: open work', headRefName: 't3-x', baseRefName: 'main', state: 'OPEN', url: '', statusCheckRollup: [] }])
        : line.startsWith('gh pr create') ? 'https://github.com/o/r/pull/31\n' : ''
      return { value: { ...fakeSqlite('', null), stdout, exitCode: 0 } }
    }
    return { value: fakeSqlite(e.init?.stdin, snap) }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('session.root', () => ({ value: '/p' }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-10T09:00:00Z') }) as never)
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] }) as never)
  on('fs.write', ($, e) => ((files[e.path] = e.text), { value: undefined }) as never)
  const ship = async (input: Record<string, unknown>) => {
    const reply = await $.tool.call({ tool: 'mcp__roadmap__roadmap', action: 'ship', ...input } as never)
    return String(reply.result ?? reply.deny)
  }
  // Another changed file still stops it; the CHANGELOG alone (changelog run first) does not.
  dirty = ' M CHANGELOG.md\n M hooks/x.ts\n'
  expect(await ship({ version: '0.7.0' })).toBe('the working tree has changes; commit or stash them first')
  dirty = ' M CHANGELOG.md\n'
  const reply = await ship({ version: '0.7.0' })
  expect(reply).toContain('Opened https://github.com/o/r/pull/31 for 0.7.0: .claude-plugin/plugin.json bumped, 1 release note(s) of merged work added and CHANGELOG [Unreleased] cut as 0.7.0')
  const log = files['/p/CHANGELOG.md']!
  expect(log).toContain('## [Unreleased]\n\n## [0.7.0] - 2026-10-10\n\n### Fixed\n\n- ship writes the notes itself.')
  expect(log.match(/Old fix\./g)).toHaveLength(1)
  expect(log).not.toContain('Not merged yet.')
  // One commit on the release branch carries the bump and the notes; main is left as it was.
  expect(ran.filter(one => one.startsWith('git commit') || one.startsWith('git switch'))).toEqual(['git switch -c release-v0.7.0', 'git commit -am Release 0.7.0', 'git switch main'])
  expect(ran.find(one => one.startsWith('gh pr create'))).toContain('### Fixed\n\n- ship writes the notes itself.')
})

test('timeline: milestones and epics by due date with their progress; late work marked on the board and in the brief', async ($, on) => {
  const some = [
    item('M1', { title: 'Launch', due: '2026-10-20' }), item('E1', { parent: 'M1', title: 'Billing', due: '2026-10-05' }),
    item('T1', { parent: 'E1', status: 'done' }), item('T2', { parent: 'E1', status: 'in_progress', assignee: 'claude' }),
    item('T3', { parent: 'M1' }), item('M2', { title: 'Later' }), item('T4', { parent: 'M2' }),
  ]
  const now = Date.parse('2026-10-09T12:00:00Z')
  expect(dueOf(some, find(some, 'T2')!)).toBe('2026-10-05')
  expect(dueOf(some, find(some, 'T3')!)).toBe('2026-10-20')
  expect(dueOf(some, find(some, 'T4')!)).toBeUndefined()
  expect(['T1', 'T2', 'T3', 'T4', 'E1', 'M1'].filter(id => isLate(some, find(some, id)!, now))).toEqual(['T2', 'E1'])
  expect(isLate(some, find(some, 'T2')!, 0)).toBe(false)
  expect(timelineOf(some).map(one => one.id)).toEqual(['M1', 'E1', 'M2'])
  expect(timelineOf([item('M1'), item('M2', { due: '2026-01-01' }), item('E2', { parent: 'M2' }), item('E1', { parent: 'M2', due: '2026-02-01' }), item('E3')]).map(one => one.id))
    .toEqual(['M2', 'E1', 'E2', 'M1', 'E3'])
  // The brief names what is overdue, by its own date.
  expect(brief({ items: some, activity: [], seen: {} }, 'claude', [], now)).toContain('Overdue (past their due date, not done; today is 2026-10-09):\n- E1')

  on('process.run', ($, e) => ({ value: fakeSqlite(e.init?.stdin, { items: some, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('clock.now', () => ({ value: now }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock' } as never,
  })
  // On the board, a task past its (inherited) date is marked late.
  expect((await ui.find({ key: 'card-T2' }))?.text).toContain('⚠late')
  expect((await ui.find({ key: 'card-T3' }))?.text).not.toContain('late')
  await ui.press({ key: 'tab-timeline' })
  expect((await ui.find({ key: 'time-E1' }))?.text).toContain('2026-10-05  ▓▓▓▓▓░░░░░ 1/2  4 days late, 1 open')
  expect((await ui.find({ key: 'time-M1' }))?.text).toContain('2026-10-20  ▓▓▓░░░░░░░ 1/3  in 11 days')
  expect((await ui.find({ key: 'time-M2' }))?.text).toMatch(/M2 Later +— /)
  // A row opens its card.
  await ui.press({ key: 'time-M1' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  await ui.unmount()
})
