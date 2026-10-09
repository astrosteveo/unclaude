import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import type { Activity, Item } from '../types'
import { q, VERSION } from './db'
import { agentName, brief, checkLinks, isStale, linksOf, ignoreState, IGNORE_LINE, shouldOfferIgnore, withIgnore, checkBlockers, checkParent, detail, idsIn, parseGitLog, parsePrs, refsFor, refsText, nextUp, outline, statusOf, subtree, unread, waitingOn } from './model'

/** What sqlite3 prints for a script, for tests that stand in for it: the version, or the snapshot. */
/** Hooks that stand in for a project with no roadmap: no database file, and every process recorded. */
const noRoadmap = (on: On, ran: string[][]) => {
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  on('process.run', ($, e) => (ran.push([...e.argv]), { value: fakeSqlite(e.init?.stdin, { items: [], activity: [], seen: {} }) }))
}

const fakeSqlite = (stdin: string | undefined, snap: unknown) => ({
  exitCode: 0,
  stdout: stdin?.trim() === 'PRAGMA user_version;' ? String(VERSION) : JSON.stringify(snap),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

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

  const toReview = await call({ action: 'update', id: 'T1', status: 'done' })
  expect(String(toReview.result)).toContain("waiting on the user's approval")
  expect(wrote("status='review'")).toBe(true)
  expect(wrote("status='done'")).toBe(false)
  expect((await call({ action: 'update', id: 'T1', status: 'done', approved: true, agentId: 'a1' })).deny).toContain('Only the user approves')
  expect((await call({ action: 'update', id: 'T1', status: 'done', as: 'user' })).deny).toContain('act as yourself')
  expect((await call({ action: 'update', id: 'T1', status: 'in_progress', approved: true })).deny).toContain('approved goes with status: done')
  const approved = await call({ action: 'update', id: 'T1', status: 'done', approved: true })
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
