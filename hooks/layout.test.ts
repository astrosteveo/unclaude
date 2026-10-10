import { expect, test } from 'claude-code/testing'

import type { Activity, InboxItem, Item, Snapshot } from '../types'
import { VERSION } from './db'
import { paintPane } from './paint'
import { cellOf, columnWidths, fitColumns, fitHints, progressBar } from './pane'

// Layout at the sizes people use: every view, with and without a card docked under it, drawn at narrow
// and wide widths and short and tall heights, then laid out by `paint` and checked for what doesn't fit.

const WIDTHS = [60, 84, 120, 180]
const HEIGHTS = [30, 50]
// Set to, say, 'board 120x30' to see that drawing (in the failure) while working on the layout.
const SHOW = ''

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, kind: id[0] === 'M' ? 'milestone' : id[0] === 'E' ? 'epic' : 'task', title: `${id} title`, status: 'todo', parent: null, milestone: null, start: null,
  description: null, assignee: null, due: null, priority: 'p2', type: 'feature', note: null, section: null, resolution: null, lease_at: null,
  labels: [], relations: [], blocked_by: [], checklist: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  ...over,
})

const WORDS = 'Make the board read cleanly when a long title meets a narrow column and the assignee is a subagent'.split(' ')
const titled = (n: number) => WORDS.slice(0, 3 + (n * 7) % (WORDS.length - 3)).join(' ')

/** A roadmap of the size a project reaches: three milestones, epics, dozens of done tasks, long names. */
export function bigRoadmap(): Snapshot {
  const items: Item[] = [
    item('M1', { title: 'v0.2 Agent collaboration core', due: '2026-10-01' }),
    item('M2', { title: 'v0.3 Planning power with a much longer milestone name than usual', due: '2026-11-20' }),
    item('M3', { title: 'v1.0' }),
    item('E1', { parent: 'M1', title: 'Core tracker' }),
    item('E2', { parent: 'M2', title: 'Dependencies and the things that wait on them', due: '2026-11-01' }),
    item('E3', { parent: 'M3', title: 'Polish', assignee: 'claude' }),
  ]
  const statuses = ['done', 'done', 'done', 'todo', 'in_progress', 'review', 'blocked', 'done', 'todo', 'done'] as const
  const assignees = [null, 'claude', 'user', 'general-purpose-implement-the-login-and-session-flow', 'claude']
  for (let n = 1; n <= 60; n++) {
    const status = statuses[n % statuses.length]!
    items.push(item(`T${n}`, {
      parent: ['E1', 'E2', 'E3', 'M2', null][n % 5] ?? null,
      title: titled(n),
      status,
      assignee: status === 'todo' && n % 3 ? null : assignees[n % assignees.length] ?? null,
      priority: (['p0', 'p1', 'p2', 'p3'] as const)[n % 4]!,
      type: (['feature', 'bug', 'chore'] as const)[n % 3]!,
      labels: n % 4 === 0 ? ['ui', 'storage'] : [],
      checklist: n % 2 ? [1, 2, 3].map(k => ({ n: k, text: `criterion ${k} for ${titled(n + k)}`, done: k <= n % 4 })) : [],
      description: n % 3 ? null : `${titled(n)}. `.repeat(4),
      updated_at: `2026-10-0${1 + (n % 9)}T10:00:00Z`,
    }))
  }
  const activity: Activity[] = items.slice(6, 20).map((one, i) => ({
    id: i + 1, item_id: one.id, author: i % 2 ? 'user' : 'claude', type: 'comment', body: `${titled(i)}, and a second sentence to wrap.`, at: '2026-10-09T10:00:00Z',
  }))
  const inbox: InboxItem[] = [1, 2, 3].map(n => ({
    id: `I${n}`, title: titled(n * 5), body: n === 2 ? `${titled(n)}. `.repeat(6) : null, author: n === 3 ? 'general-purpose-implement-the-login-and-session-flow' : 'user',
    at: '2026-10-09T10:00:00Z', state: 'open', became: null, reason: null,
  }))
  return { items, activity, seen: {}, inbox }
}

const fake = (stdin: string | undefined, snap: Snapshot) => {
  const input = stdin ?? ''
  const one = /FROM \(SELECT \* FROM activity WHERE item_id='([^']*)'/.exec(input)?.[1]
  const answer = input.trim() === 'PRAGMA user_version;'
    ? VERSION
    : one !== undefined
      ? snap.activity.filter(entry => entry.item_id === one)
      : input.includes("type IN ('comment', 'handoff')") ? {} : snap
  return { exitCode: 0, stdout: typeof answer === 'number' ? String(answer) : JSON.stringify(answer), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** A painted pane with the list's frame taken off: its lines without the two columns of border and padding. */
const unframed = (painted: { lines: string[]; problems: string[] }) => ({ ...painted, lines: painted.lines.map(line => line.replace(/^  /, '')) })

/** Each view: the tab that shows it, and the key of a row that opens a card from it. */
const VIEWS = [
  ['board', 'tab-board', 'card-T5'],
  ['plan', 'tab-plan', 'row-T5'],
  ['roadmap', 'tab-roadmap', 'time-E2'],
  ['inbox', 'tab-inbox', null],
  ['releases', 'tab-releases', null],
] as const

test('every view fits the pane at narrow and wide widths, with and without a docked card', async ($, on) => {
  const snap = bigRoadmap()
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const found: string[] = []
  for (const width of WIDTHS)
    for (const height of HEIGHTS) {
      const ui = await $.ui.mount({
        plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
        props: { title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: height } } as never,
      })
      for (const [view, tab, row] of VIEWS) {
        await ui.press({ key: tab })
        const plain = paintPane(await ui.drawn(), width)
        if (SHOW === `${view} ${width}x${height}`) found.push(...plain.lines.map(line => `|${line}`))
        for (const problem of plain.problems) found.push(`${view} ${width}x${height}: ${problem}`)
        if (row === null) continue
        // A short pane shows the board's first screen; its first card stands in when T5 is further down.
        const first = view === 'board' ? (await ui.findAll({ type: 'Button' })).map(one => String(one.key)).find(key => key.startsWith('card-')) : undefined
        const target = view === 'board' && !(await ui.find({ key: row })) && first ? first : row
        if (!(await ui.find({ key: target }))) {
          found.push(`${view} ${width}x${height}: no ${row} to open`)
          continue
        }
        await ui.press({ key: target })
        const docked = paintPane(await ui.drawn(), width)
        if (SHOW === `${view} + card ${width}x${height}`) found.push(...docked.lines.map(line => `|${line}`))
        for (const problem of docked.problems) found.push(`${view} + card ${width}x${height}: ${problem}`)
        await ui.press({ key: 'close' })
      }
      await ui.unmount()
    }
  expect(found).toEqual([])
})

test('side by side, an empty column takes its heading and the columns with cards share the rest', () => {
  const widths = columnWidths({ todo: 0, in_progress: 15, blocked: 11, review: 0, done: 0 }, 120, 2)
  expect(widths).toEqual({ todo: 28, in_progress: 15, blocked: 11, review: 28, done: 28 })
  expect(Object.values(widths).reduce((sum, one) => sum + one, 0) + 8).toBeLessThanOrEqual(120)
})

test('wide board cards: the title on up to two lines, its details on a line under it; one line when docked short', async ($, on) => {
  const snap = bigRoadmap()
  // A short task with no details takes a line; one with details a line more; Done's long titles wrap.
  snap.items = snap.items.filter(one => one.kind !== 'task' || one.status === 'done')
  snap.items.push(item('T90', { status: 'in_progress', title: 'Short' }), item('T91', { status: 'in_progress', title: 'Tiny', assignee: 'claude' }))
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } } as never,
  })
  const { lines, problems } = paintPane(await ui.drawn(), 140)
  expect(problems).toEqual([])
  const heads = lines.find(line => line.includes('○ Todo 0'))!
  // Empty Todo, Blocked and Review keep to their headings; In progress and Done share the rest.
  expect(heads.indexOf('◐ In progress')).toBeLessThan(24)
  expect(heads.indexOf('● Done') - heads.indexOf('◐ In progress')).toBeGreaterThan(40)
  const at = heads.indexOf('p: ◐ In progress')
  // (The cards start right under the headings: the frame's border is above them.)
  const progress = lines.slice(lines.indexOf(heads) + 1).map(line => line.slice(at, heads.indexOf('b: ✗ Blocked')).trim())
  expect(progress.slice(0, 3)).toEqual(['T90 Short', 'T91 Tiny', '@claude'])
  const done = lines.slice(lines.indexOf(heads) + 1, lines.indexOf(heads) + 5).map(line => line.slice(heads.indexOf('d: ● Done')).trim())
  expect(done[0]).toMatch(/^T\d+ Make the board/)
  expect(done[1]).not.toMatch(/^T\d+/)
  expect(done.slice(2).some(line => /^T\d+ Make the board/.test(line))).toBe(true)
  // The open card's id stands out.
  await ui.press({ key: 'card-T90' })
  const open = await ui.find({ key: 'card-T90' })
  expect(JSON.stringify(open)).toContain('"inverse":true')
  await ui.unmount()
})

test('narrow board: empty columns fold into one line, and every row puts its details in the same slots', async ($, on) => {
  const snap = bigRoadmap()
  snap.items = snap.items.filter(one => one.kind !== 'task' || one.status === 'done' || one.status === 'todo')
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never,
  })
  const { lines, problems } = unframed(paintPane(await ui.drawn(), 84))
  expect(problems).toEqual([])
  // One line for the empty columns (Review holds a handed epic), each heading still a button with its jump key.
  expect(lines.filter(line => /In progress 0/.test(line))).toEqual(['p: ◐ In progress 0 · b: ✗ Blocked 0'])
  for (const status of ['in_progress', 'blocked']) expect((await ui.find({ key: `col-${status}-head` }))?.props.hotkey).toBeDefined()
  // Rows line up: each card's checklist sits in the same column, under Todo and Done alike.
  const ticks = lines.filter(line => /^[TE]\d+ /.test(line) && line.includes('☑')).map(line => line.indexOf('☑'))
  expect(ticks.length).toBeGreaterThan(5)
  expect(new Set(ticks).size).toBe(1)
  // One blank row between each of the four blocks (the folded line, Todo, Review, Done), none for the empty ones.
  // (Counted down to the board's last row: under it the pane is padded down to the key hints.)
  const hintsAt = lines.findIndex(line => line.startsWith('Enter opens'))
  let end = hintsAt
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  const content = lines.slice(0, end)
  // (The list's frame takes a blank-looking row at its top too.)
  expect(content.filter(line => line.trim() === '').length).toBe(4)
  await ui.unmount()
})

test('Done shows the last week\'s work, a few at least; the rest open from its heading, narrow and wide alike', async ($, on) => {
  const snap = bigRoadmap()
  // Thirty done tasks, two of them finished this week.
  for (const one of snap.items) if (one.status === 'done') one.updated_at = '2026-09-01T10:00:00Z'
  snap.items.find(one => one.id === 'T1')!.updated_at = '2026-10-08T10:00:00Z'
  snap.items.find(one => one.id === 'T2')!.updated_at = '2026-10-09T09:00:00Z'
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const width of [84, 140]) {
    const ui = await $.ui.mount({
      plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
      props: { title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never,
    })
    const doneCards = async () => (await ui.findAll({ type: 'Button' })).filter(one => /^card-T\d+$/.test(String(one.key)) && snap.items.find(i => i.id === String(one.key).slice(5))?.status === 'done')
    // The two of this week and one more: at least three.
    expect((await doneCards()).map(one => one.key)).toEqual(['card-T2', 'card-T1', expect.stringMatching(/^card-T/)])
    expect(await ui.find({ type: 'Text', text: '…27 older' })).toBeDefined()
    // Opened, Done takes the rows the pane has left: some narrow, where the columns stack, more side by side.
    await ui.press({ key: 'done-toggle' })
    expect((await doneCards()).length).toBeGreaterThan(width > 100 ? 12 : 5)
    expect(paintPane(await ui.drawn(), width).problems).toEqual([])
    expect(await ui.find({ type: 'Text', text: '· recent only' })).toBeDefined()
    await ui.press({ key: 'done-toggle' })
    expect((await doneCards()).length).toBe(3)
    await ui.unmount()
  }
})

test('the header: views as tabs, a progress bar, actions apart; one row wide, two at 84; hints whole, least useful dropped', async ($, on) => {
  expect(progressBar(3, 4, 8)).toEqual({ done: '██████', left: '░░' })
  expect(progressBar(0, 0, 8)).toEqual({ done: '', left: '░░░░░░░░' })
  const hints = ['Enter opens', 'Tab/↑↓ move', 'v releases', 't p b r d jump to a column', 'n new', 'i file to the inbox', 'f filter']
  expect(fitHints(hints, 200, 1)).toEqual(hints)
  expect(fitHints(hints, 40, 1)).toEqual(['Enter opens', 'Tab/↑↓ move', 'v releases'])
  expect(fitHints(hints, 40, 2)).toEqual(hints.slice(0, 5))

  const snap = bigRoadmap()
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const [width, rows] of [[84, 2], [140, 1]] as const) {
    const ui = await $.ui.mount({
      plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
      props: { title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } } as never,
    })
    const { lines } = unframed(paintPane(await ui.drawn(), width))
    // (The list is framed, and side by side its columns too: each top border is a row of its own.)
    const top = lines.findIndex(line => /Todo \d+/.test(line))
    expect(top).toBe(rows + 1 + (width >= 100 ? 1 : 0))
    expect(lines[0]).toMatch(/Inbox \d+ +Plan +Roadmap +Board +v: +Releases +█+░* 30\/60 done +● 7 unread/)
    expect(lines.slice(0, rows).join(' ')).toContain('[ Mark all read ] [ Filter ] [ New ]')
    // The view showing is the tab drawn inverse.
    expect(JSON.stringify(await ui.find({ key: 'tab-board' }))).toContain('"inverse":true')
    // Hints break between hints: every footer line starts a hint.
    const footer = lines.slice(lines.findIndex(line => line.startsWith('Enter opens')))
    expect(footer.length).toBeLessThanOrEqual(width >= 100 ? 1 : 2)
    for (const line of footer) expect(hints.some(hint => line.startsWith(hint))).toBe(true)
    await ui.unmount()
  }
})

test('tree and timeline: open work first, finished scopes folded to a line, a toggle (Tab to it, Enter) opens them', async ($, on) => {
  const items = [
    item('M1', { title: 'Shipped', due: '2026-09-01' }), item('E1', { parent: 'M1', title: 'Old epic' }),
    item('T1', { parent: 'E1', status: 'done' }), item('T2', { parent: 'E1', status: 'done' }),
    item('M2', { title: 'Going', due: '2026-12-01' }), item('E2', { parent: 'M2', title: 'Current' }),
    item('T3', { parent: 'E2', status: 'done' }), item('T4', { parent: 'E2', status: 'in_progress' }),
    item('M3', { title: 'Undated' }), item('E3', { parent: 'M3' }), item('T5', { parent: 'E3' }),
  ]
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, { items, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } } as never,
  })
  const rowsOf = async (prefix: string) =>
    (await ui.findAll({ type: 'Button' })).map(one => String(one.key)).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
  await ui.press({ key: 'tab-plan' })
  // Open milestones lead, done tasks after open ones; finished M1 is one line, its epic and tasks folded away.
  expect(await rowsOf('row-')).toEqual(['M2', 'E2', 'T4', 'T3', 'M3', 'E3', 'T5', 'M1'])
  expect((await ui.find({ key: 'fold-M1' }))?.text).toBe('▸')
  // Opened, M1 shows its finished epic, itself folded until opened.
  await ui.press({ key: 'fold-M1' })
  expect(await rowsOf('row-')).toEqual(['M2', 'E2', 'T4', 'T3', 'M3', 'E3', 'T5', 'M1', 'E1'])
  await ui.press({ key: 'fold-E1' })
  expect(await rowsOf('row-')).toEqual(['M2', 'E2', 'T4', 'T3', 'M3', 'E3', 'T5', 'M1', 'E1', 'T1', 'T2'])
  // An open one folds too.
  await ui.press({ key: 'fold-M2' })
  expect(await rowsOf('row-')).toEqual(['M2', 'M3', 'E3', 'T5', 'M1', 'E1', 'T1', 'T2'])
  await ui.press({ key: 'fold-M2' })
  await ui.press({ key: 'fold-M1' })

  // A card open on work inside a folded scope unfolds what holds it.
  await ui.press({ key: 'tab-board' })
  await ui.press({ key: 'card-T1' })
  await ui.press({ key: 'tab-plan' })
  expect(await rowsOf('row-')).toContain('T1')
  await ui.press({ key: 'close' })

  await ui.press({ key: 'tab-roadmap' })
  expect(await rowsOf('time-')).toEqual(['M2', 'E2', 'M3', 'E3', 'M1'])
  // Only milestones fold here, where epics have no rows under them.
  expect(await ui.find({ key: 'fold-E2', type: 'Button' })).toBeUndefined()
  await ui.press({ key: 'fold-M1' })
  expect(await rowsOf('time-')).toEqual(['M2', 'E2', 'M3', 'E3', 'M1', 'E1'])
  // Bars and counts line up; an undated milestone shows a dash, not words.
  const { lines } = paintPane(await ui.drawn(), 84)
  const rows = lines.filter(line => /[▓░]/.test(line) && !line.includes('done'))
  expect(new Set(rows.map(line => line.search(/[▓░]/))).size).toBe(1)
  expect(rows.find(line => line.includes('M3 Undated'))).toMatch(/M3 Undated +— +░/)
  await ui.unmount()
})

test("won't do on the board: marked on its card and row, left out of the counts; the card drops a task with a reason", async ($, on) => {
  const items = [
    item('E1', { title: 'Polish' }),
    item('T1', { parent: 'E1', status: 'done', title: 'Kept' }),
    item('T2', { parent: 'E1', status: 'done', title: 'Dropped', resolution: 'wontdo' }),
    item('T3', { parent: 'E1', title: 'Open' }),
  ]
  const ran: string[] = []
  on('process.run', ($, e) => (ran.push(e.init?.stdin ?? ''), { value: fake(e.init?.stdin, { items, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } } as never,
  })
  // Two tasks count (T1 done, T3 open); the dropped one neither way.
  expect(paintPane(await ui.drawn(), 84).lines[0]).toContain('1/2 done')
  const card = await ui.find({ key: 'card-T2' })
  expect(card?.text).toContain("✕ won't do")
  expect(JSON.stringify(card)).toContain('"strikethrough":true')
  await ui.press({ key: 'tab-plan' })
  expect((await ui.find({ key: 'row-T2' }))?.text).toMatch(/^✕ T2\s+Dropped/)
  // Its card shows Won't do where Done would be.
  await ui.press({ key: 'row-T2' })
  expect((await ui.find({ key: 'set-wontdo' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'set-done' }))?.props.variant).toBe('secondary')
  await ui.press({ key: 'close' })
  // Dropping an open task asks why, then closes it so.
  await ui.press({ key: 'row-T3' })
  await ui.press({ key: 'set-wontdo' })
  ran.length = 0
  await ui.input({ key: 'wontdo-reason', text: 'not needed after all' })
  const write = ran.find(one => one.includes('resolution='))
  expect(write).toContain("resolution='wontdo'")
  expect(write).toContain("Won''t do: not needed after all")
  expect(await ui.find({ key: 'wontdo-reason' })).toBeUndefined()
  await ui.unmount()
})

test('inbox: i files a line from any tab; the Inbox tab lists what waits, with who filed it, and counts it', async ($, on) => {
  const snap = bigRoadmap()
  const ran: string[] = []
  on('process.run', ($, e) => (ran.push(e.init?.stdin ?? ''), { value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  expect((await ui.find({ key: 'tab-inbox' }))?.text).toMatch(/Inbox \d+/)
  expect((await ui.find({ key: 'file' }))?.props.hotkey).toBe('i')
  await ui.press({ key: 'file' })
  ran.length = 0
  await ui.input({ key: 'inbox-input', text: "we should export to CSV" })
  expect(ran.some(one => one.includes('INSERT INTO inbox(id, title, body, author)') && one.includes("'we should export to CSV'") && one.includes("'user'"))).toBe(true)
  expect(await ui.find({ key: 'inbox-input' })).toBeUndefined()
  await ui.press({ key: 'tab-inbox' })
  const { lines } = unframed(paintPane(await ui.drawn(), 120))
  expect(lines.some(line => /^I1 +.+ +user +2026-10-09$/.test(line))).toBe(true)
  expect(lines.some(line => /^I3 +.+ +general-purpose… +2026-10-09$/.test(line))).toBe(true)
  await ui.unmount()
})

test('releases on the board: a done card and its plan row name the version it shipped in, or say unreleased; the card says so too', async ($, on) => {
  const items = [
    item('T1', { status: 'done', title: 'Shipped one', note: 'One.' }),
    item('T2', { status: 'done', title: 'Merged one', note: 'Two.' }),
  ]
  const snap = { items, activity: [], seen: {}, releases: [{ version: '0.6.3', tag: 'v0.6.3', at: '2026-10-09', pr: 33, notes: '- One.', tasks: [{ id: 'T1', note: 'One.', section: 'Added' as const }] }] }
  on('process.run', ($, e) => ({ value: e.argv[0] === 'sqlite3' ? fake(e.init?.stdin, snap) : { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  expect((await ui.find({ key: 'card-T1' }))?.text).toContain('v0.6.3')
  expect((await ui.find({ key: 'card-T2' }))?.text).toContain('unreleased')
  await ui.press({ key: 'tab-plan' })
  await ui.press({ key: 'fold-loose' })
  expect((await ui.find({ key: 'row-T1' }))?.text).toContain('v0.6.3')
  await ui.press({ key: 'row-T1' })
  expect(paintPane(await ui.drawn(), 84).lines.some(line => line.includes('shipped in v0.6.3'))).toBe(true)
  await ui.unmount()
})

test('releases tab: what the next release carries by section, each version newest first (older folded), stable marked; Release… runs ship', async ($, on) => {
  const items = [
    item('T1', { status: 'done', note: 'One.' }), item('T2', { status: 'done', note: 'A fix.', type: 'bug' }),
    item('T3', { status: 'done', note: 'New thing.' }),
  ]
  const releases = [
    { version: '0.6.2', tag: 'v0.6.2', at: '2026-10-08', pr: 31, notes: '### Fixed\n\n- One.', tasks: [{ id: 'T1', note: 'One.', section: 'Fixed' as const }] },
    { version: '0.6.3', tag: 'v0.6.3', at: '2026-10-09', pr: 33, notes: '### Changed\n\n- Installs get releases.', tasks: [] },
  ]
  const snap = { items, activity: [], seen: {}, releases }
  const toasts: string[] = []
  const ran: string[] = []
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    ran.push(line)
    if (e.argv[0] === 'sqlite3') return { value: fake(e.init?.stdin, snap) }
    const stdout = line.startsWith('git ls-remote') ? 'abc\trefs/heads/stable\n' : line.startsWith('git tag --points-at') ? 'v0.6.3\n' : '[]'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('fs.read', () => ({ deny: 'ENOENT' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', ($, e) => (toasts.push(String((e as { text?: string }).text ?? '')), { value: undefined }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('tool.register', () => ({ value: {} }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ source: 'startup', cwd: '/work/project' } as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  await ui.press({ key: 'tab-releases' })
  const { lines, problems } = unframed(paintPane(await ui.drawn(), 100))
  expect(problems).toEqual([])
  const text = lines.join('\n')
  // T2 and T3 merged since; T1 shipped in 0.6.2. By section, Added before Fixed.
  expect(text).toMatch(/Unreleased +2 notes merged since the last release +\[ Release… \]\nAdded\n- New thing\. \(T3\)\nFixed\n- A fix\. \(T2\)/)
  // Newest open with its notes, stable marked; the older one folded to its line.
  expect(text).toMatch(/▾ v0\.6\.3 +2026-10-09 +#33 +stable ●\n *Changed\n *- Installs get releases\./)
  expect(text).toMatch(/▸ v0\.6\.2 +2026-10-08 +1 #31 *\n/)
  // Release… suggests the next minor (an Added note waits) and runs ship with what is typed.
  await ui.press({ key: 'release' })
  expect((await ui.find({ key: 'release-version' }))?.props.value).toBe('0.7.0')
  await ui.input({ key: 'release-version', text: '0.7.0' })
  expect(toasts.at(-1)).toMatch(/^roadmap: no manifest with a version here/)
  await ui.unmount()
})

test('roadmap on a time axis: epics as bars filled by progress, milestones as markers, a today line, late in red, undated listed; w zooms', async ($, on) => {
  const items = [
    item('M1', { title: 'Launch', due: '2026-11-15', created_at: '2026-09-01T00:00:00Z' }),
    item('E1', { milestone: 'M1', title: 'Billing', start: '2026-09-15', due: '2026-10-05' }),
    item('T1', { parent: 'E1', status: 'done' }), item('T2', { parent: 'E1', status: 'in_progress', assignee: 'claude' }),
    item('E2', { milestone: 'M1', title: 'Auth', start: '2026-10-10' }),
    item('T3', { parent: 'E2' }),
    item('M2', { title: 'Later' }),
  ]
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, { items, activity: [], seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  await ui.press({ key: 'tab-roadmap' })
  const { lines, problems } = unframed(paintPane(await ui.drawn(), 140))
  expect(problems).toEqual([])
  const row = (id: string) => lines.find(line => line.replace(/^\u00a0+/, '').startsWith(`${id} `))!
  // E1: late (its date passed, a task open), half done; a bar of red, half filled.
  const e1 = await ui.find({ key: 'time-E1' })
  expect(JSON.stringify(e1)).toContain('"color":"red"')
  expect(row('E1')).toMatch(/█+░+/)
  // M1 is a marker on its date; E2 runs to it (its milestone's date), nothing done yet.
  expect(row('M1')).toContain('◆')
  expect(row('E2')).toMatch(/░+/)
  expect(row('E2').lastIndexOf('░')).toBe(row('M1').indexOf('◆'))
  // Today is a line through every row, at the same column.
  const today = row('M1').indexOf('│')
  expect(today).toBeGreaterThan(0)
  expect(row('E2').charAt(today) === '│' || row('E2').charAt(today) === '░').toBe(true)
  // Weeks mark the scale over two months (months over longer); M2 has no dates and is listed under the axis.
  expect(lines.some(line => /09-28 +10-05 +10-12/.test(line))).toBe(true)
  expect(lines.some(line => line === 'No dates yet: M2')).toBe(true)
  // w zooms in around today, and again, then back to all of it.
  expect((await ui.find({ key: 'zoom' }))?.props.hotkey).toBe('w')
  await ui.press({ key: 'zoom' })
  expect((await ui.find({ key: 'zoom' }))?.text).toContain('zoom 120d')
  await ui.press({ key: 'zoom' })
  await ui.press({ key: 'zoom' })
  expect((await ui.find({ key: 'zoom' }))?.text).toContain('zoom: all')
  // A bar opens its card.
  await ui.press({ key: 'time-E1' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  await ui.unmount()
})

test('releases on the roadmap: a tick at each release\'s date, named for its version (one day, one tick); pressing it opens that release', async ($, on) => {
  const items = [item('M1', { title: 'Launch', due: '2026-11-15', start: '2026-09-01' })]
  const releases = [
    { version: '0.6.0', tag: 'v0.6.0', at: '2026-09-20', pr: 27, notes: '- A.', tasks: [] },
    { version: '0.6.2', tag: 'v0.6.2', at: '2026-10-09', pr: 31, notes: '- B.', tasks: [] },
    { version: '0.6.3', tag: 'v0.6.3', at: '2026-10-09', pr: 33, notes: '- C.', tasks: [] },
  ]
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, { items, activity: [], seen: {}, releases }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-12T12:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  await ui.press({ key: 'tab-roadmap' })
  const { lines, problems } = unframed(paintPane(await ui.drawn(), 140))
  expect(problems).toEqual([])
  const ticks = lines.find(line => line.startsWith('Releases'))!
  expect(ticks).toMatch(/▲0\.6\.0[\s\u00a0]+▲0\.6\.3 \+1/)
  // 0.6.3's tick sits where the scale would put 10-09: before today's line on M1's row.
  const m1 = lines.find(line => line.startsWith('M1 '))!
  expect(ticks.indexOf('▲0.6.3')).toBeLessThan(m1.indexOf('│'))
  // Pressing a tick opens the Releases tab on that release, unfolded even if it is not the newest.
  await ui.press({ key: 'release-tick-0.6.0' })
  expect((await ui.find({ key: 'tab-releases' }))?.props.variant).toBe('primary')
  const text = unframed(paintPane(await ui.drawn(), 140)).lines.join('\n')
  expect(text).toMatch(/▾ v0\.6\.0[^\n]*\n *- A\./)
  await ui.unmount()
})

test('triage in the Inbox: → Task opens the form with the title filled in and sorts the item; Into… and Drop… ask, then sort it', async ($, on) => {
  const snap = bigRoadmap()
  const ran: string[] = []
  // A new item answers with its id, as sqlite3 does.
  on('process.run', ($, e) => (ran.push(e.init?.stdin ?? ''), {
    value: (e.init?.stdin ?? '').includes('INSERT INTO items') ? { exitCode: 0, stdout: 'T99\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : fake(e.init?.stdin, snap),
  }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  await ui.press({ key: 'tab-inbox' })
  expect(paintPane(await ui.drawn(), 100).problems).toEqual([])
  await ui.press({ key: 'to-task-I1' })
  expect((await ui.find({ key: 'new-title' }))?.props.value).toBe(snap.inbox![0]!.title)
  ran.length = 0
  await ui.input({ key: 'new-title', text: 'Export, as a task' })
  // Made from I1: the item goes in with its new title and I1 is marked sorted, in one go.
  expect(ran.some(one => one.includes("'Export, as a task'"))).toBe(true)
  expect(ran.some(one => one.includes("UPDATE inbox SET state='triaged'") && one.includes("WHERE id='I1'"))).toBe(true)
  await ui.press({ key: 'into-I2' })
  ran.length = 0
  await ui.input({ key: 'triage-input', text: 'T7 checklist' })
  expect(ran.some(one => one.includes("INSERT INTO checks") && one.includes("UPDATE inbox SET state='triaged', became='T7'"))).toBe(true)
  await ui.press({ key: 'drop-I3' })
  ran.length = 0
  await ui.input({ key: 'triage-input', text: 'not worth it' })
  expect(ran.some(one => one.includes("UPDATE inbox SET state='dropped', became=NULL, reason='not worth it' WHERE id='I3'"))).toBe(true)
  await ui.unmount()
})

test('needs you: work in review, unread comments, stale claims and late work head the Inbox, each once, opening its card; they agree with the board', async ($, on) => {
  const items = [
    item('E1', { title: 'Handed', assignee: 'claude' }),
    item('T1', { parent: 'E1', status: 'done' }),
    item('T2', { status: 'review', title: 'Reviewed' }),
    item('T3', { status: 'in_progress', assignee: 'explore:x', lease_at: '2026-10-09T08:00:00Z', title: 'Quiet' }),
    item('T4', { due: '2026-10-01', title: 'Overdue' }),
    item('T5', { title: 'Talked about' }),
  ]
  const activity = [
    { id: 1, item_id: 'T5', author: 'claude', type: 'comment', body: 'a question', at: '2026-10-09T10:00:00Z' },
    { id: 2, item_id: 'T2', author: 'claude', type: 'comment', body: 'ready', at: '2026-10-09T10:00:00Z' },
  ]
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, { items, activity, seen: {}, inbox: [] }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('clock.now', () => ({ value: Date.parse('2026-10-09T12:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  // The Board's Review column holds T2 and the handed E1; the header counts 2 unread.
  const reviewColumn = (await ui.find({ key: 'col-review-head' }))?.text
  expect(reviewColumn).toContain('Review 2')
  expect(paintPane(await ui.drawn(), 100).lines[0]).toContain('● 2 unread')
  expect((await ui.find({ key: 'tab-inbox' }))?.text).toContain('Inbox 5')
  await ui.press({ key: 'tab-inbox' })
  const needs = (await ui.findAll({ type: 'Button' })).filter(one => String(one.key).startsWith('need-')).map(one => `${String(one.key).slice(5)}: ${String(one.text).replace(/ {2,}/g, '  ')}`)
  expect(needs).toEqual([
    'E1: review  E1 Handed',
    'T2: review · 1 unread  T2 Reviewed',
    'T3: stale claim  T3 Quiet',
    'T4: late  T4 Overdue',
    'T5: 1 unread  T5 Talked about',
  ])
  await ui.press({ key: 'need-T4' })
  expect(await ui.find({ key: 'detail' })).toBeDefined()
  await ui.unmount()
})

test('mouse scroll: a tab longer than the pane scrolls under a header that stays put; each tab keeps its place; a wide board scrolls its columns', async ($, on) => {
  const snap = bigRoadmap()
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const props = (width: number) => ({ title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } }) as never
  const wheel = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'roadmap', offset: 0, by, bodyRows: 20, contentRows: 20, origin: { kind: 'person' } } as never)
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: props(84) })
  await ui.press({ key: 'tab-plan' })
  const lines = async () => unframed(paintPane(await ui.drawn(), 84))
  let drawn = await lines()
  expect(drawn.problems).toEqual([])
  expect(drawn.lines.length).toBeLessThanOrEqual(21)
  expect(drawn.lines.some(line => /^↓ \d+ more lines below · scroll down$/.test(line))).toBe(true)
  const firstRow = drawn.lines.find(line => /^[▾▸ ] +[○◐✗◉●✕]/.test(line))
  // The wheel moves the plan; the header and hints stay.
  await wheel(3)
  await ui.redraw(props(84))
  drawn = await lines()
  expect(drawn.lines[0]).toContain('Plan')
  expect(drawn.lines.some(line => /^↑ 3 more lines above · scroll up$/.test(line))).toBe(true)
  expect(drawn.lines.some(line => line === firstRow)).toBe(false)
  // Past the end, it stops at the end.
  await wheel(500)
  await ui.redraw(props(84))
  drawn = await lines()
  expect(drawn.lines.some(line => /more lines? below/.test(line))).toBe(false)
  // The board keeps its own place: still at the top.
  await ui.press({ key: 'tab-board' })
  expect((await lines()).lines.some(line => /above · scroll up/.test(line))).toBe(false)
  await ui.press({ key: 'tab-plan' })
  expect((await lines()).lines.some(line => /above · scroll up/.test(line))).toBe(true)
  await ui.unmount()
  // Side by side, the columns scroll a card at a time.
  const wide = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: props(180) })
  await wide.press({ key: 'tab-board' })
  const before = (await wide.findAll({ type: 'Button' })).map(one => String(one.key)).filter(key => key.startsWith('card-'))
  await wheel(2)
  await wide.redraw(props(180))
  const after = (await wide.findAll({ type: 'Button' })).map(one => String(one.key)).filter(key => key.startsWith('card-'))
  expect(after).not.toEqual(before)
  expect(unframed(paintPane(await wide.drawn(), 180)).lines.some(line => line.includes('↑ 2 above'))).toBe(true)
  expect(unframed(paintPane(await wide.drawn(), 180)).problems).toEqual([])
  await wide.unmount()
})

test('the key hints sit on a docked pane\'s last row, on every tab, with a card open or the form up; an inline pane stays as tall as its content', async ($, on) => {
  const snap = { ...bigRoadmap(), inbox: [] }
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const [width, rows] of [[84, 60], [160, 45]] as const) {
    const props = { title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: rows } } as never
    const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props })
    const atBottom = async (what: string) => {
      const { lines, problems } = paintPane(await ui.drawn(), width)
      expect(problems).toEqual([])
      expect(`${what}: ${lines.length} rows`).toBe(`${what}: ${rows} rows`)
      expect(`${what}: ${lines.at(-1)}`).toMatch(new RegExp(`^${what}: .*(z undo|f filter|x close|creates it)`))
    }
    for (const tab of ['inbox', 'plan', 'roadmap', 'board', 'releases']) {
      await ui.press({ key: `tab-${tab}` })
      await atBottom(tab)
    }
    // The list's frame and the card fill the pane: the card starts right under the divider and its frame
    // reaches the hints, its spare rows inside it, whatever the split.
    await ui.press({ key: 'tab-board' })
    const first = (await ui.findAll({ type: 'Button' })).map(one => String(one.key)).find(key => key.startsWith('card-'))!
    await ui.press({ key: first })
    for (const move of [null, 'split-down', 'split-up', 'split-up', 'split-up']) {
      if (move) await ui.press({ key: move })
      await atBottom('card')
      // (The painter draws a border as a blank row: the divider, the card's top border, then its title.)
      const drawn = paintPane(await ui.drawn(), width).lines
      const divider = drawn.findIndex(line => /k: ▲ j: ▼/.test(line))
      expect(`${move}: ${drawn[divider + 2]!.trim()}`).toMatch(new RegExp(`^${move}: task `))
    }
    await ui.press({ key: 'close' })
    // Closed, the list keeps its frame and takes the whole area down to the hints.
    expect((await ui.find({ key: 'tab' }))?.props.borderStyle).toBe('round')
    await atBottom('closed')
    await ui.press({ key: 'new' })
    await atBottom('form')
    await ui.press({ key: 'new-cancel' })
    await ui.unmount()
  }
  // Inline, the pane is as tall as what it shows: no padding.
  const inline = await $.ui.mount({
    plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
    props: { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'inline', scroll: { offset: 0, bodyRows: 60 } } as never,
  })
  await inline.press({ key: 'tab-inbox' })
  expect(paintPane(await inline.drawn(), 84).lines.length).toBeLessThan(40)
  // (Inline, the list has no frame: the rows are scarce there.)
  expect((await inline.find({ key: 'tab' }))?.props.borderStyle).toBeUndefined()
  await inline.unmount()
})

test('scrolling moves a line at a time, through wrapped blocks too: a block cut by an edge shows its lines in the window', async ($, on) => {
  const long = 'A description that runs over several lines when the pane is narrow, so that it wraps. '.repeat(5)
  const items = [item('T1', {
    title: 'Wrapped', description: long,
    checklist: [1, 2, 3, 4].map(n => ({ n, text: `criterion ${n} that is long enough to wrap onto a second line in a narrow card`, done: false })),
  })]
  const activity = [1, 2, 3, 4, 5].map(id => ({ id, item_id: 'T1', author: 'claude', type: 'comment', body: `comment ${id}: ${'words that wrap '.repeat(6)}`, at: '2026-10-09T10:00:00Z' }))
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, { items, activity, seen: {} }) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const rows = 24
  const props = { title: 'Roadmap', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: rows } } as never
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props })
  await ui.press({ key: 'card-T1' })
  // The window between the marks, as drawn.
  const window = async () => {
    const lines = paintPane(await ui.drawn(), 60).lines
    const top = lines.findIndex(line => /more lines? above|^ *Description/.test(line))
    const bottom = lines.findIndex(line => /more lines? below/.test(line))
    return { lines: lines.slice(top + 1, bottom), above: Number(/↑ (\d+) more/.exec(lines.join('\n'))?.[1] ?? 0) }
  }
  let before = await window()
  for (let step = 1; step <= 12; step++) {
    await $.ui.scroll({ component: 'Pane', requestId: 'roadmap', offset: 0, by: 1, bodyRows: rows, contentRows: rows, origin: { kind: 'person' } } as never)
    await ui.redraw(props)
    const after = await window()
    // One line further down every time: the count above goes up by one and the lines slide up by one.
    expect(after.above).toBe(step)
    if (step > 1) expect(after.lines.slice(0, -1).map(one => one.trim())).toEqual(before.lines.slice(1).map(one => one.trim()))
    before = after
  }
  await ui.unmount()
})

test('with a card docked, the wheel moves what is under it: the list in its frame above, or the card; the one in use is outlined', async ($, on) => {
  const snap = bigRoadmap()
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const rows = 44
  const props = { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: rows } } as never
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props })
  await ui.press({ key: 'tab-plan' })
  await ui.press({ key: 'row-T5' })
  const wheel = async (row: number, by = 2) => {
    await $.ui.scroll({ component: 'Pane', requestId: 'roadmap', offset: 0, by, bodyRows: rows, contentRows: rows, pointer: { row, column: 10 }, origin: { kind: 'person' } } as never)
    await ui.redraw(props)
  }
  const frames = async () => {
    const drawn = await ui.drawn()
    const top = await ui.find({ key: 'top' })
    const card = await ui.find({ key: 'detail' })
    return { list: top?.props.borderColor, card: card?.props.borderColor, text: paintPane(drawn, 84).lines.join('\n'), problems: paintPane(drawn, 84).problems }
  }
  // Opened, the card is the one in use; the list is framed too, its outline dim.
  let now = await frames()
  expect(now.problems).toEqual([])
  expect([now.list, now.card]).toEqual([undefined, 'cyan'])
  expect(now.text).toMatch(/↓ \d+ more lines below · scroll down/)
  // Both frames dim; the one under the pointer lights up (the surface applies it, no hook runs).
  for (const key of ['top', 'detail']) expect([key, (await ui.find({ key }))?.props.borderDimColor]).toEqual([key, true])
  expect(JSON.stringify(await ui.drawn())).toContain('"hover":{"borderColor":"cyan","borderDimColor":false}')
  // The wheel over the list (a row inside its frame) scrolls it, and lights it.
  await wheel(5)
  now = await frames()
  expect([now.list, now.card]).toEqual(['cyan', undefined])
  expect(now.text).toMatch(/↑ 2 more lines above · scroll up/)
  // Over the card, the card scrolls and is lit again; the list keeps its place.
  await wheel(rows - 6, 3)
  now = await frames()
  expect([now.list, now.card]).toEqual([undefined, 'cyan'])
  expect(now.text).toMatch(/↑ 2 more lines above · scroll up/)
  await ui.unmount()
})

test('docked, the card takes the rows its content needs and the list the rest; the divider (k/j) sets the split until auto', async ($, on) => {
  const snap = bigRoadmap()
  snap.items.push(item('T99', { title: 'Tiny', updated_at: '2026-10-09T23:00:00Z' }))
  snap.items.find(one => one.id === 'T3')!.updated_at = '2026-10-09T23:00:00Z'
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  const rows = 50
  const props = { title: 'Roadmap', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: rows } } as never
  const ui = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props })
  await ui.press({ key: 'tab-board' })
  const listRows = async () => Number((await ui.find({ key: 'top' }))?.props.height)
  const fits = async () => {
    const { lines, problems } = paintPane(await ui.drawn(), 84)
    expect(problems).toEqual([])
    expect(lines.length).toBe(rows)
  }
  // A short card leaves the list most of the pane; a long one takes more, the list keeping at least 8.
  await ui.press({ key: 'card-T99' })
  const short = await listRows()
  await fits()
  await ui.press({ key: 'card-T3' })
  const long = await listRows()
  await fits()
  expect(short).toBeGreaterThan(long)
  expect(long).toBeGreaterThanOrEqual(8)
  // The divider: k moves it up (the card gets more), j down; the split holds across cards until auto.
  expect((await ui.find({ key: 'split-up' }))?.props.hotkey).toBe('k')
  await ui.press({ key: 'split-down' })
  await ui.press({ key: 'split-down' })
  const set = await listRows()
  expect(set).toBe(long + 4)
  await ui.press({ key: 'card-T99' })
  expect(await listRows()).toBe(set)
  await fits()
  await ui.press({ key: 'split-up' })
  expect(await listRows()).toBe(set - 2)
  await ui.press({ key: 'split-auto' })
  expect(await listRows()).toBe(short)
  expect(await ui.find({ key: 'split-auto' })).toBeUndefined()
  await ui.unmount()
})

test('tables: a header over aligned columns in Plan, the Inbox, Releases and the Roadmap list; the narrowest columns go first', async ($, on) => {
  const columns = [
    { key: 'id', label: 'ID', width: 4, drop: 0 },
    { key: 'title', label: 'Title', width: 'fill' as const, drop: 0, most: 50 },
    { key: 'due', label: 'Due', width: 10, drop: 2 },
    { key: 'pri', label: 'Pri', width: 3, drop: 1 },
  ]
  expect(fitColumns(columns, 120).map(one => [one.key, one.width])).toEqual([['id', 4], ['title', 50], ['due', 10], ['pri', 3]])
  expect(fitColumns(columns, 30).map(one => one.key)).toEqual(['id', 'title', 'pri'])
  expect(fitColumns(columns, 20).map(one => one.key)).toEqual(['id', 'title'])
  expect(cellOf('Make the board', 8)).toBe('Make th…')
  expect(cellOf('3/4', 5, 'right')).toBe('  3/4')
  const snap = bigRoadmap()
  on('process.run', ($, e) => ({ value: fake(e.init?.stdin, snap) }))
  on('fs.stat', () => ({ value: { size: 1, mtimeMs: 1 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({}))
  await $.command.run({ command: 'roadmap', args: '' } as never)
  for (const width of WIDTHS) {
    const ui = await $.ui.mount({
      plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap',
      props: { title: 'Roadmap', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } } as never,
    })
    // Each list has its header; in Plan and the Inbox, the rows' ids sit under the header's.
    for (const [tab, row] of [['tab-plan', /^\s*ID\s+Title/], ['tab-inbox', /^ID\s+Title/]] as const) {
      await ui.press({ key: tab })
      const { lines } = unframed(paintPane(await ui.drawn(), width))
      const at = lines.findIndex(line => row.test(line))
      expect(at).toBeGreaterThan(-1)
      const idAt = lines[at]!.indexOf('ID')
      // (An inbox item's note sits indented under it.)
      for (const line of lines.slice(at + 1, at + 6).filter(line => line.trim() && !(tab === 'tab-inbox' && line.startsWith('  ')))) expect(`${tab} ${width}: ${line}`).not.toMatch(new RegExp(`^${tab} ${width}: .{${idAt}} `))
    }
    await ui.press({ key: 'tab-roadmap' })
    if (width < 100) expect(unframed(paintPane(await ui.drawn(), width)).lines.some(line => /^\s*Name\s+Due\s+Progress/.test(line))).toBe(true)
    await ui.unmount()
  }
})
