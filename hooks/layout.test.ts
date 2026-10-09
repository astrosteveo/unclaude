import { expect, test } from 'claude-code/testing'

import type { Activity, Item, Snapshot } from '../types'
import { VERSION } from './db'
import { paintPane } from './paint'

// Layout at the sizes people use: every view, with and without a card docked under it, drawn at narrow
// and wide widths and short and tall heights, then laid out by `paint` and checked for what doesn't fit.

const WIDTHS = [60, 84, 120, 180]
const HEIGHTS = [30, 50]
// Set to, say, 'board 120x30' to see that drawing (in the failure) while working on the layout.
const SHOW = ''

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, kind: id[0] === 'M' ? 'milestone' : id[0] === 'E' ? 'epic' : 'task', title: `${id} title`, status: 'todo', parent: null,
  description: null, assignee: null, due: null, priority: 'p2', type: 'feature', note: null, section: null, lease_at: null,
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
  return { items, activity, seen: {} }
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

/** Each view: the tab that shows it, and the key of a row that opens a card from it. */
const VIEWS = [
  ['board', 'tab-board', 'card-T5'],
  ['tree', 'tab-tree', 'row-T5'],
  ['backlog', 'tab-backlog', 'row-T8'],
  ['timeline', 'tab-timeline', 'time-E2'],
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
        if (!(await ui.find({ key: row }))) {
          found.push(`${view} ${width}x${height}: no ${row} to open`)
          continue
        }
        await ui.press({ key: row })
        const docked = paintPane(await ui.drawn(), width)
        for (const problem of docked.problems) found.push(`${view} + card ${width}x${height}: ${problem}`)
        await ui.press({ key: 'close' })
      }
      await ui.unmount()
    }
  expect(found).toEqual([])
})
