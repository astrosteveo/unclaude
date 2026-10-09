import type { Elements, EventOf, RenderChildren, RenderElement } from 'claude-code'

import type { Checks, Draft, Item, Pr, Priority, Refs, Snapshot, Status, View } from '../types'
import * as db from './db'
import {
  backlog, find, GLYPH, lastChange, stackFrom, stackText, SECTIONS, sectionFor, openPrOf, stackedOn, homesFor, isAgent, KINDS, TYPES, PRIORITIES, isMessage, isStale, LABEL, linksOf, marks, matches, parseQuery, path, progress, refsFor, rows, STATUSES, statusOf, timeline, unread, USER,
  subtree, waitingOn,
} from './model'

export const COLOR: Record<Status, string> = { todo: 'gray', in_progress: 'yellow', blocked: 'red', review: 'blue', done: 'green' }
// Urgent priorities stand out on a card; the rest of the marks read dim.
export const PRIORITY_COLOR: Record<Priority, string | undefined> = { p0: 'red', p1: 'yellow', p2: undefined, p3: 'gray' }
// The views, in the order `v` steps through them.
const VIEWS: [View, string][] = [['board', 'Board'], ['tree', 'Tree'], ['backlog', 'Backlog']]
// A pull request's checks, as marked next to it.
const CHECKS: Record<Checks, string> = { none: '', pending: '… checks running', pass: '✓ checks', fail: '✗ checks failing' }
const CHECKS_COLOR: Record<Checks, string | undefined> = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' }
// Checks as one mark after a PR number on a board row.
const CHECK_MARK: Record<Checks, string> = { none: '', pending: ' …', pass: ' ✓', fail: ' ✗' }
// Docked cards: the fewest body rows that hold a board above a card, and the board's share of them.
const DOCK_MIN_ROWS = 30
const DOCK_SHARE = 0.4

/**
 * How many cards of each column fit in `budget` rows, by column, beside one another (`isWide`) or
 * stacked: work under way and in review first, then blocked, todo and done. A column cut short spends
 * a row on its "… more".
 */
export function columnCaps(lengths: Record<Status, number>, budget: number, isWide: boolean): Record<Status, number> {
  const caps = { todo: 0, in_progress: 0, blocked: 0, review: 0, done: 0 } as Record<Status, number>
  if (isWide) {
    for (const status of STATUSES) caps[status] = lengths[status] <= budget - 1 ? lengths[status] : Math.max(0, budget - 2)
    return caps
  }
  // Each column's heading, and a row kept for each non-empty one's "… more" in case it is cut.
  let left = budget - STATUSES.length - STATUSES.filter(status => lengths[status] > 0).length
  for (const status of ['in_progress', 'review', 'blocked', 'todo', 'done'] as Status[]) {
    caps[status] = Math.max(0, Math.min(lengths[status], left))
    left -= caps[status]
  }
  return caps
}

export const HOTKEY: Record<Status, string> = { todo: 't', in_progress: 'p', blocked: 'b', review: 'r', done: 'd' }

/** What the pane draws from, read by the hooks module. */
export type PaneState = {
  snap: Snapshot
  mode: View
  pick: string | null
  trouble: string | null
  known: Refs
  isIgnoreOffered: boolean
  isRequesting: boolean
  /** The board's filter as typed; empty for none. */
  filter: string
  /** Whether the filter's field is open. */
  isFiltering: boolean
  /** The new-item form, while it is open. */
  draft: Draft | null
  /** Whether the open card shows its fields for editing. */
  isEditing: boolean
  /** The item waiting on a yes before it is handed to Claude. */
  handing: string | null
  /** The item waiting on a yes before it is approved and its pull request merged. */
  merging: string | null
  /** The item whose card asks before merging its stack of PRs. */
  stacking: string | null
  /** What a stack being merged is doing now; empty when none is. */
  stackRun: string
  /** Whether a comment on an agent's card starts a turn at once. */
  commentTurns: boolean
  /** The task whose card asks for its release note, having just been set done. */
  noting: string | null
  /** How far the open card is scrolled, as asked. */
  scrolledTo: number
  /** The clock, for stale claims; 0 when it can't be read. */
  now: number
}

/**
 * What a press does, bound by the hooks module: the pane is drawing only (an engine handle never
 * crosses into another file), and every write or move goes back through these.
 */
export type PaneActions = {
  open: (id: string | null) => void
  closeDetail: (id: string) => void
  userAct: (a: { action: string; [field: string]: unknown }) => void
  /** Asks to confirm approving an item and merging its pull request (null drops the question). */
  askMerge: (id: string | null) => void
  /** Approves an item in review, merging `pr` first when given. */
  approve: (item: Item, pr?: Pr) => void
  /** Asks to confirm handing an item to Claude (null drops the question). */
  askHand: (id: string | null) => void
  handToClaude: (item: Item) => void
  requestChanges: (item: Item, what: string) => void
  setView: (mode: View) => void
  setRequesting: (isOn: boolean) => void
  setFilter: (text: string) => void
  setFiltering: (isOn: boolean) => void
  /** Opens the new-item form (under `parent` when given), changes its choices, or closes it (null). */
  setDraft: (draft: Draft | null) => void
  create: (draft: Draft, title: string) => void
  setEditing: (isOn: boolean) => void
  /** Takes back the person's last change, or the logged entries `ids`. */
  undo: (ids?: number[]) => void
  /** Asks to confirm merging the stack on an item's card (null drops the question). */
  askStack: (id: string | null) => void
  /** Merges a stack of PRs, bottom first. */
  mergeStack: (stack: Pr[]) => void
  /** Posts the person's comment on an item (starting a turn when set to). */
  comment: (item: Item, body: string) => void
  /** Puts a prompt about an item in the prompt box. */
  askClaude: (item: Item) => void
  /** Sets whether comments on an agent's card start a turn. */
  setCommentTurns: (isOn: boolean) => void
  /** Asks for a task's release note on its card (null drops the question). */
  setNoting: (id: string | null) => void
  /** Moves the keyboard ring to an element of the pane. */
  focus: (key: string) => void
  addIgnore: () => void
  dismissIgnore: () => void
}

/** Breaks text into lines of at most `width` cells at spaces, keeping its own line breaks. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/ +/)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = ''
      }
      line = line ? `${line} ${word}` : word
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Draws the board, the tree, or an open card from `els` (the surface's elements), answering the
 * tree and how far the open card can scroll.
 */
export function drawPane(
  els: Elements[keyof Elements], e: EventOf['ui.render'], state: PaneState, act: PaneActions,
): { node: RenderElement; scrollMax: number } {
  const { Box, Text, Button, Link } = els
  const Input = 'Input' in els ? els.Input : undefined
  const Select = 'Select' in els ? els.Select : undefined
  const { snap, mode, pick, trouble, known, isIgnoreOffered, isRequesting, now, filter, isFiltering, draft, isEditing, handing, merging, noting, commentTurns, stacking, stackRun } = state
  // Handing over starts Claude working, so it takes a yes: no key or stray Enter does it in one go.
  const confirmHand = (one: Item) => (
    <Box key={`hand-confirm-${one.id}`} flexDirection="row" columnGap={1}>
      <Text color="yellow">Hand {one.id} to Claude? It starts on it now.</Text>
      <Button key="hand-yes" label="Yes, hand it over" onPress={() => act.handToClaude(one)} />
      <Button key="hand-cancel" label="Cancel" onPress={() => act.askHand(null)} />
    </Box>
  )
  const query = parseQuery(filter)
  // What the filter lets through: everything without one; with one, what matches and, in the tree, what holds it.
  const isShown = (item: Item) => !query || matches(snap, item, query)
  const items = snap.items
  const width = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 100
  // Five columns side by side need room for a readable title in each; narrower, they stack.
  const isWide = width >= 100
  // Inline the pane gets about a third of the screen, so an open card there spends as few rows as it can.
  const isCompact = e.surface === 'terminal' && (e.props as { placement?: string }).placement === 'inline'
  // On the terminal, the rows the pane's body has; elsewhere the tree just grows.
  const bodyRows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows
  // An open card docks under the board when the pane has room for both; the board keeps the top part.
  const isDocked = Boolean(pick) && !isCompact && !draft && bodyRows !== undefined && bodyRows >= DOCK_MIN_ROWS
  const topRows = isDocked ? Math.max(6, Math.floor(bodyRows! * DOCK_SHARE)) : Infinity
  // Pressing the open card again closes it.
  const choose = (id: string | null) => () => (id !== null && id === pick ? act.closeDetail(id) : act.open(id))
  const badge = (item: Item) => {
    const count = unread(snap, item.id, USER).length
    return count ? ` ● ${count}` : ''
  }

  const card = (item: Item, room: number) => {
    const who = item.assignee ? ` @${item.assignee}` : ''
    const stale = isStale(item, now) ? ' ⌛stale' : ''
    const news = badge(item)
    const waits = waitingOn(items, item).map(one => one.id)
    const wait = waits.length ? ` ⧗${waits.join(',')}` : ''
    const list = item.checklist ?? []
    const part = item.kind === 'task' ? undefined : progress(items, item)
    const ticks = part ? ` ${part.done}/${part.total} tasks` : list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : ''
    const tags = marks(item)
    const tag = tags.length ? ` ${tags.join(' ')}` : ''
    // Work in review shows the pull request an Approve would merge.
    const pr = statusOf(items, item) === 'review' ? openPrOf(known, item) : undefined
    const prTag = pr ? ` PR #${pr.number}${CHECK_MARK[pr.checks]}` : ''
    const extra = item.id.length + who.length + stale.length + news.length + wait.length + ticks.length + tag.length + prTag.length + 1
    const title = item.title.length + extra > room ? item.title.slice(0, Math.max(4, room - extra - 1)) + '…' : item.title
    return (
      <Button key={`card-${item.id}`} plain onPress={choose(item.id)}>
        <Text dimColor>{item.id}</Text> {title}
        <Text color={PRIORITY_COLOR[item.priority]} bold={item.priority === 'p0'}>
          {tag}
        </Text>
        <Text dimColor>{ticks}</Text>
        <Text color={pr ? CHECKS_COLOR[pr.checks] ?? 'green' : undefined}>{prTag}</Text>
        <Text color="yellow" dimColor>
          {wait}
        </Text>
        <Text color="cyan">{who}</Text>
        <Text color="red" dimColor>
          {stale}
        </Text>
        <Text color="magenta" bold>
          {news}
        </Text>
      </Button>
    )
  }

  // What Undo would take back: the person's last change still standing.
  const undoable = lastChange(snap, USER)
  const canUndo = undoable.length > 0
  const unreadTotal = items.reduce((sum, item) => sum + unread(snap, item.id, USER).length, 0)
  const nextView = VIEWS[(VIEWS.findIndex(([one]) => one === mode) + 1) % VIEWS.length]![0]
  const doneCount = items.filter(i => i.kind === 'task' && i.status === 'done').length
  const taskCount = items.filter(i => i.kind === 'task').length
  const header = (
    // Wraps rather than squeezing its counts into columns when the filter and buttons crowd it.
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      {/* `v` steps to the next view: one hotkey, held by the tab after the one showing. */}
      {VIEWS.map(([one, label]) => (
        <Button key={`tab-${one}`} label={label} variant={mode === one ? 'primary' : 'secondary'}
          hotkey={one === nextView ? 'v' : undefined} onPress={() => act.setView(one)} />
      ))}
      <Text dimColor>
        {doneCount}/{taskCount} tasks done
      </Text>
      {unreadTotal > 0 && (
        <Text color="magenta" bold>
          ● {unreadTotal} unread
        </Text>
      )}
      {!isFiltering && <Button key="filter" label={filter ? `Filter: ${filter}` : 'Filter'} hotkey="f" variant={filter ? 'primary' : 'secondary'}
        onPress={() => act.setFiltering(true)} />}
      {filter && !isFiltering && <Button key="filter-clear" label="Clear" onPress={() => act.setFilter('')} />}
      {canUndo && <Button key="undo" label="Undo" hotkey="z" onPress={() => act.undo()} />}
      {stackRun && <Text color="yellow">Merging a stack: {stackRun}</Text>}
      {/* With a card open, n adds under it (on the card's bar) instead. */}
      {!draft && !pick && <Button key="new" label="New" hotkey="n" onPress={() => act.setDraft(newDraft(null))} />}
    </Box>
  )
  const filterRow = isFiltering && Input && (
    <Box key="filter-row" flexDirection="row" columnGap={1}>
      <Input key="filter-input" label="Filter" value={filter} autoFocus submitLabel="apply"
        placeholder="@claude #ui p0 bug review under:E3 words…" onSubmit={(value: string) => act.setFilter(value.trim())} />
      <Button key="filter-cancel" label="Cancel" onPress={() => act.setFiltering(false)} />
    </Box>
  )

  const tasks = items.filter(item => item.kind === 'task' && isShown(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  // A milestone or epic handed over whole is reviewed as one: it waits in Review, where its card approves and merges it.
  const scopes = items.filter(item => item.kind !== 'task' && isAgent(item.assignee) && statusOf(items, item) === 'review' && isShown(item))
  const colWidth = Math.floor((width - (STATUSES.length - 1)) / STATUSES.length)
  const columns = Object.fromEntries(STATUSES.map(status =>
    [status, [...(status === 'review' ? scopes : []), ...tasks.filter(task => task.status === status)]])) as Record<Status, Item[]>
  // Docked, the board fits the rows above the card.
  const caps = isDocked
    ? columnCaps(Object.fromEntries(STATUSES.map(status => [status, columns[status].length])) as Record<Status, number>, topRows, isWide)
    : (Object.fromEntries(STATUSES.map(status => [status, status === 'done' ? 8 : 15])) as Record<Status, number>)
  const board = (
    <Box flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 1 : 0}>
      {STATUSES.map(status => {
        const column = columns[status]
        const shown = column.slice(0, caps[status])
        return (
          <Box key={`col-${status}`} flexDirection="column" width={isWide ? colWidth : undefined} marginBottom={isWide || isDocked ? 0 : 1}>
            <Button key={`col-${status}-head`} plain hotkey={HOTKEY[status]}
              onPress={() => column[0] && act.focus(`card-${column[0].id}`)}>
              <Text bold color={COLOR[status]}>
                {GLYPH[status]} {LABEL[status]}
              </Text>{' '}
              <Text dimColor>{column.length}</Text>
            </Button>
            {shown.map(task => card(task, isWide ? colWidth - 1 : width - 2))}
            {column.length > shown.length && <Text dimColor>…{column.length - shown.length} more</Text>}
          </Box>
        )
      })}
    </Box>
  )

  const treeRows = rows(items).filter(({ item }) => !query || subtree(items, item.id).some(id => isShown(find(items, id)!)))
  // Docked, a window of rows that keeps the open item in sight.
  const treeFrom = isDocked && treeRows.length > topRows
    ? Math.max(0, Math.min(treeRows.findIndex(row => row.item.id === pick) - Math.floor(topRows / 2), treeRows.length - (topRows - 1)))
    : 0
  const treeShown = isDocked && treeRows.length > topRows ? treeRows.slice(treeFrom, treeFrom + topRows - 1) : treeRows
  const tree = (
    <Box flexDirection="column">
      {treeShown.map(({ item, depth }) => {
        const p = progress(items, item)
        const status = statusOf(items, item)
        return (
          <Button key={`row-${item.id}`} plain onPress={choose(item.id)}>
            {'  '.repeat(depth)}
            <Text color={COLOR[status]}>{GLYPH[status]}</Text> <Text dimColor>{item.id}</Text>{' '}
            <Text bold={item.kind === 'milestone'}>
              {isDocked && item.title.length > width - depth * 2 - item.id.length - 16 ? `${item.title.slice(0, Math.max(8, width - depth * 2 - item.id.length - 17))}…` : item.title}
            </Text>
            <Text dimColor>
              {item.kind !== 'task' && p.total > 0 ? `  ${p.done}/${p.total}` : ''}
              {item.due ? `  due ${item.due}` : ''}
            </Text>
            <Text color="cyan">{item.assignee ? `  @${item.assignee}` : ''}</Text>
            <Text color="magenta" bold>
              {badge(item)}
            </Text>
          </Button>
        )
      })}
      {treeShown.length < treeRows.length && <Text key="tree-more" dimColor>…{treeRows.length - treeShown.length} more rows (close the card to see them all)</Text>}
    </Box>
  )

  // Triage: what nobody holds yet, a priority picker and a hand-off on every row.
  const triageAll = backlog(items).filter(isShown)
  const triage = isDocked ? triageAll.slice(0, Math.max(1, Math.floor((topRows - 1) / 2))) : triageAll
  const backlogView = (
    <Box flexDirection="column">
      {triage.length === 0 && <Text dimColor>The backlog is empty: every todo task has someone on it.</Text>}
      {triage.length < triageAll.length && <Text key="backlog-more" dimColor>…{triageAll.length - triage.length} more (close the card to see them all)</Text>}
      {triage.map(task => {
        const where = task.parent ? ` [${task.parent}]` : ' (no epic)'
        const tags = [...marks(task).filter(one => !PRIORITIES.includes(one as never)), ...task.labels.map(one => `#${one}`)].join(' ')
        const row = (
          <Box key={`back-${task.id}`} flexDirection="row" columnGap={1}>
            {Select ? (
              <Select key={`prio-${task.id}`} options={PRIORITIES.map(one => ({ value: one }))} value={task.priority}
                onSelect={(value: string) => act.userAct({ action: 'update', id: task.id, priority: value })} />
            ) : (
              <Text key={`prio-${task.id}`} color={PRIORITY_COLOR[task.priority]}>{task.priority}</Text>
            )}
            <Button key={`row-${task.id}`} plain onPress={choose(task.id)}>
              <Text dimColor>{task.id}</Text> {task.title}
              <Text dimColor>
                {where}
                {tags ? ` ${tags}` : ''}
              </Text>
            </Button>
            <Button key={`hand-${task.id}`} label="→ Claude" onPress={() => act.askHand(task.id)} />
          </Box>
        )
        return handing === task.id ? (
          <Box key={`back-wrap-${task.id}`} flexDirection="column">
            {row}
            {confirmHand(task)}
          </Box>
        ) : row
      })}
    </Box>
  )

  const item = find(items, pick ?? undefined)
  const status = item && statusOf(items, item)
  const where = item && path(items, item)
  // The card's sections as rows, so they can scroll under the fixed title and bar.
  type Row = { key: string; node: RenderChildren; rows: number }
  const inner = width - 4
  const tall = (text: string, indent = 0) => Math.max(1, Math.ceil((text.length + indent) / Math.max(1, inner)))
  const sections: Row[] = []
  const section = (key: string, heading: string, rows: Row[]) => {
    if (rows.length === 0) return
    const gap = isCompact && sections.length === 0 ? 0 : 1
    sections.push({ key: `head-${key}`, rows: 1 + gap, node: (
      <Box key={`head-${key}`} marginTop={gap}>
        <Text bold dimColor>{heading}</Text>
      </Box>
    ) })
    sections.push(...rows)
  }
  if (item && isEditing) {
    // Each field saves on its own, on Enter; what isn't submitted stays as it was.
    const save = (fields: Record<string, unknown>) => act.userAct({ action: 'update', id: item.id, ...fields })
    // Labels in a column of their own, so a long value is cut short rather than squeezing its label.
    const field = (key: string, label: string, value: string, onSubmit: (v: string) => void, placeholder = '') => ({
      key, rows: 1, node: Input ? (
        <Box key={`${key}-row`} flexDirection="row">
          <Box width={15} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Input key={key} value={value} placeholder={placeholder} submitLabel="save" onSubmit={(v: string) => onSubmit(v.trim())} />
        </Box>
      ) : <Text key={key}>{label}: {value}</Text>,
    })
    const choice = (key: string, label: string, value: string, options: { value: string; label?: string }[], onSelect: (v: string) => void) => ({
      key, rows: 1, node: Select ? (
        <Box key={`${key}-row`} flexDirection="row">
          <Box width={15} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Select key={key} value={value} options={options} onSelect={onSelect} />
        </Box>
      ) : <Text key={key}>{label}: {value}</Text>,
    })
    const isLong = (item.description ?? '').includes('\n')
    const own = new Set(subtree(items, item.id))
    section('edit', 'Edit  (Enter saves a field)', [
      field('edit-title', 'Title', item.title, v => v && save({ title: v })),
      isLong
        ? { key: 'edit-desc-long', rows: 1, node: <Text key="edit-desc-long" dimColor>Description runs several lines: ask Claude to change it.</Text> }
        : field('edit-desc', 'Description', item.description ?? '', v => save({ description: v }), 'one line; empty clears it'),
      field('edit-due', 'Due', item.due ?? '', v => save({ due: v }), 'YYYY-MM-DD; empty clears it'),
      ...(item.kind === 'task'
        ? [
            field('edit-labels', 'Labels', item.labels.join(', '), v => save({ labels: v ? v.split(',') : [] }), 'ui, auth'),
            choice('edit-priority', 'Priority', item.priority, PRIORITIES.map(one => ({ value: one })), v => save({ priority: v })),
            choice('edit-type', 'Type', item.type, TYPES.map(one => ({ value: one })), v => save({ type: v })),
            field('edit-note', 'Release note', item.note ?? '', v => save({ note: v }), 'one line for the CHANGELOG; - for none; empty clears'),
            choice('edit-section', 'Section', sectionFor(item), SECTIONS.map(one => ({ value: one })), v => save({ section: v })),
            // The checklist as written: reword an entry in place, empty it to drop it, or add one at the end.
            // An entry left as it was keeps its tick.
            ...item.checklist.map(c => field(`edit-check-${c.n}`, `Criterion ${c.n}`, c.text, v => save({
              checklist: v ? item.checklist.map(one => (one.n === c.n ? v : one.text)) : item.checklist.filter(one => one.n !== c.n).map(one => one.text),
            }), 'empty drops it')),
            field('edit-check-new', 'Add criterion', '', v => v && save({ checklist: [...item.checklist.map(one => one.text), v] }), 'what done means'),
            field('edit-blockers', 'Blocked by', item.blocked_by.join(', '), v => save({ blocked_by: v ? v.split(',') : [] }), 'T3, T5; empty clears'),
          ]
        : []),
      ...(item.kind === 'milestone'
        ? []
        : [choice('edit-parent', 'Under', item.parent ?? '', [
            { value: '', label: '(top level)' },
            ...homesFor(items, item.kind).filter(one => !own.has(one.id)).map(one => ({ value: one.id, label: `${one.id} ${one.title}`.slice(0, 40) })),
          ], v => save({ parent: v }))]),
    ])
  }
  if (item) {
    if (!isEditing) section('description', 'Description', item.description
      ? wrap(item.description, inner - 2).map((line, i) => ({ key: `desc-${i}`, rows: 1, node: <Text key={`desc-${i}`}>  {line}</Text> }))
      : [])
    if (!isEditing && item.note && item.note !== '-') section('note', `Release note  (${sectionFor(item)})`, wrap(item.note, inner - 2)
      .map((line, i) => ({ key: `note-${i}`, rows: 1, node: <Text key={`note-${i}`}>  {line}</Text> })))
    const checks = item.checklist ?? []
    section('criteria', `Acceptance criteria  ${checks.filter(c => c.done).length}/${checks.length}`, checks.map(c => ({
      key: `check-${c.n}`, rows: wrap(c.text, inner - 2).length, node: (
        <Button key={`check-${c.n}`} plain
          onPress={() => act.userAct({ action: 'check', id: item.id, items: [c.n], done: !c.done })}>
          <Text color={c.done ? 'green' : undefined}>{c.done ? '☑' : '☐'}</Text>{' '}
          <Text dimColor={c.done}>{wrap(c.text, inner - 2).join('\n  ')}</Text>
        </Button>
      ),
    })))
    section('deps', 'Dependencies', [
      ...(item.blocked_by ?? []).map(id => {
        const before = find(items, id)
        const st = before ? statusOf(items, before) : 'todo'
        return { key: `waits-${id}`, rows: tall(`waits on ${id} ${before?.title ?? ''}`, 2), node: (
          <Text key={`waits-${id}`}>
            <Text dimColor>waits on </Text>
            <Text color={COLOR[st]}>{GLYPH[st]}</Text> {id} {before?.title ?? '(removed)'}
          </Text>
        ) }
      }),
      ...items
        .filter(one => (one.blocked_by ?? []).includes(item.id))
        .map(one => ({ key: `blocks-${one.id}`, rows: tall(`blocks ${one.id} ${one.title}`), node: (
          <Text key={`blocks-${one.id}`}>
            <Text dimColor>blocks </Text>
            {one.id} {one.title}
          </Text>
        ) })),
    ])
    const linked = refsFor(items, known, item)
    const links = linksOf(items, item)
    const linkRow = (key: string, verb: string, id: string) => {
      const other = find(items, id)
      const st = other ? statusOf(items, other) : 'todo'
      return { key: `${key}-${id}`, rows: tall(`${verb} ${id} ${other?.title ?? ''}`), node: (
        <Text key={`${key}-${id}`}>
          <Text dimColor>{verb} </Text>
          <Text color={COLOR[st]}>{GLYPH[st]}</Text> {id} {other?.title ?? '(removed)'}
        </Text>
      ) }
    }
    section('links', 'Links', [
      ...links.duplicateOf.map(id => linkRow('dup', 'duplicate of', id)),
      ...links.duplicatedBy.map(id => linkRow('dupby', 'duplicated by', id)),
      ...links.relates.map(id => linkRow('rel', 'relates to', id)),
      ...linked.prs.slice(0, 3).map(pr => ({ key: `pr-${pr.number}`, rows: tall(`PR #${pr.number} [${pr.state}] ${CHECKS[pr.checks]} ${pr.title}`), node: (
        <Text key={`pr-${pr.number}`}>
          <Text dimColor>PR </Text>#{pr.number}{' '}
          <Text color={pr.state === 'merged' ? 'magenta' : pr.state === 'open' ? 'green' : undefined}>[{pr.state}]</Text>
          {pr.state === 'open' && <Text color={CHECKS_COLOR[pr.checks]}> {CHECKS[pr.checks]}</Text>} {pr.title}
        </Text>
      ) })),
      ...linked.commits.slice(0, 4).map(c => ({ key: `commit-${c.hash}`, rows: tall(`commit ${c.hash} ${c.subject}`), node: (
        <Text key={`commit-${c.hash}`}>
          <Text dimColor>commit </Text>
          <Text color="yellow">{c.hash}</Text> {c.subject}
        </Text>
      ) })),
      ...(linked.commits.length > 4
        ? [{ key: 'commits-more', rows: 1, node: <Text key="commits-more" dimColor>…{linked.commits.length - 4} more commits</Text> }]
        : []),
    ])
    section('activity', 'Activity', [
      ...(Input
        ? [{ key: 'comment', rows: 1, node: (
            <Box key="comment-row" flexDirection="row" columnGap={1}>
              <Input key="comment" label="Comment"
                placeholder={isAgent(item.assignee) && commentTurns ? `${item.assignee} hears it at once; Enter posts it` : 'A note for Claude; Enter posts it'}
                onSubmit={(value: string) => act.comment(item, value)} />
              {/* Held by an agent: whether it hears now, or with the person's next prompt. */}
              {isAgent(item.assignee) && (
                <Button key="comment-turns" label={commentTurns ? 'Tells it now' : 'Waits for your prompt'}
                  variant={commentTurns ? 'primary' : 'secondary'} onPress={() => act.setCommentTurns(!commentTurns)} />
              )}
            </Box>
          ) }]
        : []),
      // Comments and handoff notes read as messages, author over body; what the tracker did reads as one dim line.
      ...timeline(snap.activity, item.id)
        .slice(-6)
        .map(one => {
          const when = one.at.slice(5, 16).replace('T', ' ')
          const who = <Text color={one.author === USER ? 'magenta' : 'cyan'}>{one.author}</Text>
          // A change still standing can be taken back from its line; an undo, made again the same way.
          const revert = one.undoable && !one.undone
            ? <Button key={`revert-${one.id}`} plain onPress={() => act.undo([one.id])}><Text dimColor> {one.type === 'undo' ? '↷ redo' : '↶ undo'}</Text></Button>
            : null
          return isMessage(one)
            ? { key: `act-${one.id}`, rows: 1 + tall(one.body, 2), node: (
                <Box key={`act-${one.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    <Text>
                      {who}
                      {one.type === 'handoff' && <Text color="yellow"> handoff</Text>}
                      <Text dimColor> {when}</Text>
                    </Text>
                    {revert}
                  </Box>
                  <Text>  {one.body}</Text>
                </Box>
              ) }
            : { key: `act-${one.id}`, rows: tall(`${when} ${one.author} ${one.body} ↶ undo`), node: (
                <Box key={`act-${one.id}`} flexDirection="row">
                  <Box flexShrink={1}>
                    <Text dimColor>
                      {when} {one.author} {one.body}
                    </Text>
                  </Box>
                  {revert}
                </Box>
              ) }
        }),
    ])
  }
  // On the terminal the window is ours: what fits under the fixed rows, with a mark for what is above or below.
  // Docked, the board's rows above the card count among the fixed ones.
  // Fixed rows: tabs, the panel's two borders, title, two bar rows (more as they wrap), the info line, the
  // footer, and the ↓ mark. The ↑ mark takes a content row only once the card is scrolled.
  const tagLine = item?.labels?.length ? item.labels.map(one => `#${one}`).join(' ') : ''
  const meta = item ? [item.assignee ? `@${item.assignee}` : 'unassigned', item.kind === 'task' ? `${item.priority} ${item.type}` : '', tagLine, item.due ? `due ${item.due}` : '', where ? `in ${where}` : ''].filter(Boolean).join(' · ') : ''
  // The title, beside the ✕ that closes the card.
  const titleRows = tall(`${item?.title ?? ''}${isCompact ? `  ${meta}` : ''}`, item ? item.kind.length + item.id.length + 2 + 2 : 0)
  // Tabs (hidden inline), the panel's borders, title, bar, info line (folded into the title inline), footer, ↓ mark.
  // The bar's two rows of buttons, as they wrap at this width ("[ label ]", one column apart).
  // How many rows pieces of these widths take, laid one column apart and wrapped at `room`.
  const flowRows = (widths: number[], room: number) => {
    let lines = 1
    let used = 0
    for (const w of widths) {
      if (used > 0 && used + 1 + w > room) (lines++, (used = w))
      else used += (used > 0 ? 1 : 0) + w
    }
    return lines
  }
  // A row of buttons, each drawn as "[ label ]".
  const buttonRows = (labels: string[]) => flowRows(labels.map(label => label.length + 4), inner)
  // The header as it wraps over the whole pane, when it shows above an open card.
  const headerRows = flowRows([
    ...VIEWS.map(([, label]) => label.length + 4),
    `${doneCount}/${taskCount} tasks done`.length,
    ...(unreadTotal > 0 ? [`● ${unreadTotal} unread`.length] : []),
    ...(!isFiltering ? [(filter ? `Filter: ${filter}` : 'Filter').length + 4] : []),
    ...(filter && !isFiltering ? ['Clear'.length + 4] : []),
    ...(canUndo ? ['Undo'.length + 4] : []),
    ...(stackRun ? [`Merging a stack: ${stackRun}`.length] : []),
  ], width)
  // Approve on what is itself up for review: a task, or a milestone or epic handed over whole; not on
  // one that reads review only because a part of it does.
  const isReview = status === 'review' && (item?.kind === 'task' || isAgent(item?.assignee))
  // Work in review waits on the person, not on Claude: its card approves it or asks for changes instead.
  const isHandable = status !== 'done' && status !== 'review'
  // The pull request the item under review ships in, which Approve can merge.
  const reviewPr = isReview && item ? openPrOf(known, item) : undefined
  // The card's pull request, held under the bar with the buttons that act on it; and the one it is stacked on.
  const cardPr = item ? openPrOf(known, item) : undefined
  const under = cardPr && stackedOn(known, cardPr)
  // The bottom of a stack merges the whole of it.
  const stack = cardPr ? stackFrom(known, cardPr) : []
  const isStack = stack.length > 1
  const prText = cardPr
    ? `PR #${cardPr.number} [open] ${CHECKS[cardPr.checks]} ${cardPr.branch} → ${cardPr.base || '?'}${under ? `  stacked on #${under.number}: merge that first` : ''}${isStack ? `  stack ${stackText(stack)} [ Merge the stack ]` : ''}${stackRun ? `  ${stackRun}` : ''}`
    : ''
  const prRows = cardPr ? tall(prText) : 0
  const barRows = !item
    ? 0
    : (item.kind === 'task' ? buttonRows(STATUSES.map(one => (item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]))) : 1) +
      (isRequesting || handing === item.id || merging === item.id || noting === item.id || stacking === item.id ? 1 : buttonRows([...(isReview ? ['Approve', 'Request changes'] : []), ...(isHandable ? ['Hand to Claude'] : []), 'Ask Claude', ...(item.kind !== 'task' ? ['Add item'] : []), isEditing ? 'Done editing' : 'Edit', 'Assign me', 'Unassign', 'Close']))
  const info = item ? `assignee ${item.assignee ?? 'none'}${item.kind === 'task' ? `  priority ${item.priority}  ${item.type}` : ''}${tagLine ? `  ${tagLine}` : ''}${item.due ? `  due ${item.due}` : ''}${where ? `  in ${where}` : ''}` : ''
  const footer = (draft
    ? ['Tab/↑↓ move between fields', 'Enter on Title creates it']
    : item
    ? ['Tab/↑↓ move', item.kind === 'task' ? `1–${STATUSES.length} status` : '', isReview ? 'a approve · c request changes' : '', isEditing ? 'e done editing' : 'e edit', 'x close']
    : [isIgnoreOffered ? 'g gitignore the db' : '', 'Tab/↑↓ move', 'Enter opens', 'n new', 'f filter', canUndo ? 'z undo' : '', mode === 'board' ? 't p b r d jump to a column' : '', `v ${nextView}`]
  )
    .filter(Boolean)
    .join(' · ')
  // The footer is as wide as the pane, not the panel inside it.
  const footerRows = Math.max(1, Math.ceil(footer.length / Math.max(1, width)))
  const fixed = (isCompact ? 0 : headerRows) + (isDocked ? topRows : 0) + 2 + titleRows + barRows + prRows + (isCompact ? 0 : tall(info)) + footerRows + 1
  const space = e.surface === 'terminal' && bodyRows ? Math.max(3, bodyRows - fixed) : Infinity
  const total = sections.reduce((sum, row) => sum + row.rows, 0)
  const isScrolling = space < total
  const scrollMax = isScrolling ? total - (space - 1) : 0
  const want = isScrolling ? Math.min(state.scrolledTo, scrollMax) : 0
  const room = want > 0 ? space - 1 : space
  // Scroll in whole rows of the list: skip rows until the scrolled-to line is reached.
  let first = 0
  for (let skipped = 0; first < sections.length && skipped + sections[first]!.rows <= want; first++) skipped += sections[first]!.rows
  let used = 0
  const shown = sections.slice(first).filter(row => (used += row.rows) <= room)
  // A heading whose first row didn't fit waits for it below.
  while (shown.length > 0 && shown[shown.length - 1]!.key.startsWith('head-') && first + shown.length < sections.length) shown.pop()
  const above = sections.slice(0, first).reduce((sum, row) => sum + row.rows, 0)
  const below = total - above - shown.reduce((sum, row) => sum + row.rows, 0)
  const body = [
    above > 0 ? <Text key="more-above" dimColor>↑ {above} more {above === 1 ? 'line' : 'lines'} above · scroll up</Text> : null,
    ...shown.map(row => row.node),
    below > 0 ? <Text key="more-below" dimColor>↓ {below} more {below === 1 ? 'line' : 'lines'} below · scroll down</Text> : null,
  ]
  // An inline pane is as tall as its tree: hold a scrolling card at one height so the frame doesn't jump.
  if (isScrolling) {
    const drawn = shown.reduce((sum, row) => sum + row.rows, 0) + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0)
    if (drawn < space + 1) body.push(<Box key="pad" height={space + 1 - drawn} />)
  }

  const panel = item && status && (
    <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1}>
      <Box key="title-row" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text dimColor>
            {item.kind} {item.id}
          </Text>{' '}
          <Text bold>{item.title}</Text>
          {isCompact && <Text dimColor>  {meta}</Text>}
        </Text>
        {/* Closing is a press away from wherever the eye is: here, Close in the bar, x, or the card on the board again. */}
        <Button key="close-x" plain onPress={() => act.closeDetail(item.id)}>
          <Text dimColor> ✕</Text>
        </Button>
      </Box>
      {/* The bar sits right under the title on every card, so its buttons never move with the content. */}
      <Box key="bar" flexDirection="column">
        {item.kind === 'task' ? (
          <Box key="status-row" flexDirection="row" columnGap={1} flexWrap="wrap">
            {STATUSES.map((one, i) => (
              <Button key={`set-${one}`} label={item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]}
                hotkey={String(i + 1)} variant={item.status === one ? 'primary' : 'secondary'}
                onPress={() => {
                  act.userAct({ action: 'update', id: item.id, status: one })
                  // Done, and nothing for the CHANGELOG yet: the card asks for its line.
                  if (one === 'done' && !item.note && Input) act.setNoting(item.id)
                }} />
            ))}
          </Box>
        ) : (
          <Box key="status-row">
            <Text>
              <Text color={COLOR[status]}>
                {GLYPH[status]} {LABEL[status]}
              </Text>
              <Text dimColor>
                {'  '}rolled up from its tasks ({progress(items, item).done}/{progress(items, item).total} done)
              </Text>
            </Text>
          </Box>
        )}
        {stacking === item.id && isStack ? (
          <Box key="stack-confirm" flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color="yellow">
              Merge {stack.map(pr => `#${pr.number}`).join(', then ')} into {stack[0]!.base || 'main'}, each once its checks pass there?
            </Text>
            <Button key="stack-yes" label="Merge the stack" onPress={() => act.mergeStack(stack)} />
            <Button key="stack-cancel" label="Cancel" onPress={() => act.askStack(null)} />
          </Box>
        ) : noting === item.id && Input ? (
          <Box key="note-row" flexDirection="row" columnGap={1}>
            <Input key="note" label={`Release note (${sectionFor(item)})`} placeholder="One line for the CHANGELOG; Enter saves it" autoFocus submitLabel="save"
              onSubmit={(value: string) => {
                if (value.trim()) act.userAct({ action: 'update', id: item.id, note: value.trim() })
                act.setNoting(null)
              }} />
            <Button key="note-none" label="None needed" onPress={() => (act.userAct({ action: 'update', id: item.id, note: '-' }), act.setNoting(null))} />
            <Button key="note-skip" label="Later" onPress={() => act.setNoting(null)} />
          </Box>
        ) : handing === item.id ? (
          confirmHand(item)
        ) : merging === item.id && reviewPr ? (
          <Box key="merge-confirm" flexDirection="row" columnGap={1} flexWrap="wrap">
            {under ? (
              // Stacked: merged now it would land in the branch below, not main. That PR goes first.
              <Text color="yellow">PR #{reviewPr.number} is stacked on #{under.number}; merge #{under.number} first.</Text>
            ) : (
              <Text color={reviewPr.checks === 'fail' ? 'red' : 'yellow'}>
                Merge PR #{reviewPr.number} into {reviewPr.base || 'its base'}{reviewPr.checks === 'pass' ? '' : ` (checks: ${reviewPr.checks})`}?
              </Text>
            )}
            {!under && <Button key="merge-yes" label="Approve and merge" onPress={() => act.approve(item, reviewPr)} />}
            <Button key="merge-no" label="Approve only" onPress={() => act.approve(item)} />
            <Button key="merge-cancel" label="Cancel" onPress={() => act.askMerge(null)} />
          </Box>
        ) : isRequesting && Input ? (
          <Box key="changes-row" flexDirection="row" gap={1}>
            <Input key="changes" label="Changes" placeholder="What needs changing? Enter sends it back" autoFocus
              submitLabel="send back" onSubmit={(value: string) => act.requestChanges(item, value)} />
            <Button key="changes-cancel" label="Cancel" onPress={() => act.setRequesting(false)} />
          </Box>
        ) : (
        <Box key="action-row" flexDirection="row" columnGap={1} flexWrap="wrap">
          {isReview && (
            <Button key="approve" label={reviewPr ? `Approve…` : 'Approve'} hotkey="a" variant="primary"
              onPress={() => (reviewPr ? act.askMerge(item.id) : act.approve(item))} />
          )}
          {isReview && Input && (
            <Button key="request" label="Request changes" hotkey="c"
              onPress={() => act.setRequesting(true)} />
          )}
          {isHandable && <Button key="hand" label="Hand to Claude" onPress={() => act.askHand(item.id)} />}
          <Button key="ask" label="Ask Claude" onPress={() => act.askClaude(item)} />
          {item.kind !== 'task' && <Button key="new-under" label="Add item" hotkey="n" onPress={() => act.setDraft(newDraft(item))} />}
          {(Input || Select) && (
            <Button key="edit" label={isEditing ? 'Done editing' : 'Edit'} hotkey="e" variant={isEditing ? 'primary' : 'secondary'}
              onPress={() => act.setEditing(!isEditing)} />
          )}
          <Button key="mine" label="Assign me" onPress={() => act.userAct({ action: 'update', id: item.id, assignee: USER })} />
          <Button key="unassign" label="Unassign" onPress={() => act.userAct({ action: 'update', id: item.id, assignee: '' })} />
          <Button key="close" label="Close" hotkey="x" onPress={() => act.closeDetail(item.id)} />
        </Box>
        )}
      </Box>
      {cardPr && (
        <Box key="pr-line" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text>
          <Link href={cardPr.url}>PR #{cardPr.number}</Link>
          <Text color="green"> [open]</Text>
          <Text color={CHECKS_COLOR[cardPr.checks]}> {CHECKS[cardPr.checks]}</Text>
          <Text dimColor> {cardPr.branch} → </Text>
          <Text>{cardPr.base || '?'}</Text>
          {under && <Text color="yellow">  stacked on #{under.number}: merge that first</Text>}
          {isStack && <Text dimColor>  stack {stackText(stack)}</Text>}
          {stackRun && <Text color="yellow">  {stackRun}</Text>}
        </Text>
        {isStack && !stackRun && <Button key="merge-stack" label="Merge the stack" onPress={() => act.askStack(item.id)} />}
        </Box>
      )}
      {!isCompact && (
        <Text>
          <Text dimColor>assignee </Text>
          <Text color="cyan">{item.assignee ?? 'none'}</Text>
          {isStale(item, now) && <Text color="red"> (claim gone stale)</Text>}
          {item.kind === 'task' && <Text dimColor>  priority </Text>}
          {item.kind === 'task' && <Text color={PRIORITY_COLOR[item.priority]}>{item.priority}</Text>}
          {item.kind === 'task' && <Text dimColor>  {item.type}</Text>}
          {tagLine && <Text color="blue">  {tagLine}</Text>}
          {item.due && <Text dimColor>  due {item.due}</Text>}
          {where && <Text dimColor>  in {where}</Text>}
        </Text>
      )}
      {body}
    </Box>
  )

  // The new-item form: the choices first, the title last (Enter on it creates the item).
  const homes = draft ? homesFor(items, draft.kind) : []
  const form = draft && (
    <Box key="new-form" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>New {draft.kind}</Text>
      {Select ? (
        <Box key="new-choices" flexDirection="row" columnGap={2} flexWrap="wrap">
          <Select key="new-kind" label="Kind" options={KINDS.map(one => ({ value: one }))} value={draft.kind}
            onSelect={(value: string) => act.setDraft(fitDraft({ ...draft, kind: value as Draft['kind'] }))} />
          {draft.kind === 'task' && (
            <Select key="new-priority" label="Priority" options={PRIORITIES.map(one => ({ value: one }))} value={draft.priority}
              onSelect={(value: string) => act.setDraft({ ...draft, priority: value as Draft['priority'] })} />
          )}
          {draft.kind === 'task' && (
            <Select key="new-type" label="Type" options={TYPES.map(one => ({ value: one }))} value={draft.type}
              onSelect={(value: string) => act.setDraft({ ...draft, type: value as Draft['type'] })} />
          )}
          {draft.kind !== 'milestone' && (
            <Select key="new-parent" label="Under" value={draft.parent}
              options={[{ value: '', label: '(top level)' }, ...homes.map(one => ({ value: one.id, label: `${one.id} ${one.title}`.slice(0, 40) }))]}
              onSelect={(value: string) => act.setDraft({ ...draft, parent: value })} />
          )}
        </Box>
      ) : (
        <Text dimColor>{draft.kind}{draft.parent ? ` under ${draft.parent}` : ''}</Text>
      )}
      {Input && (
        <Input key="new-title" label="Title" placeholder="What it is; Enter creates it" autoFocus submitLabel="create"
          onSubmit={(value: string) => value.trim() && act.create(draft, value.trim())} />
      )}
      <Button key="new-cancel" label="Cancel" onPress={() => act.setDraft(null)} />
    </Box>
  )
  // Where a new item goes by default: under the open card, when it can hold one.
  function newDraft(under: Item | null): Draft {
    const kind = under?.kind === 'milestone' ? 'epic' : 'task'
    return fitDraft({ kind, priority: 'p2', type: 'feature', parent: under && under.kind !== 'task' ? under.id : under?.parent ?? '' })
  }
  // A parent the chosen kind can't sit under is dropped.
  function fitDraft(next: Draft): Draft {
    return homesFor(items, next.kind).some(one => one.id === next.parent) ? next : { ...next, parent: '' }
  }

  const offer = isIgnoreOffered && (
    <Box key="ignore-offer" flexDirection="column">
      <Text color="yellow">{db.DB} isn't in .gitignore, so it can be committed by mistake.</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="ignore-add" label="Add to .gitignore" hotkey="g" onPress={() => act.addIgnore()} />
        <Button key="ignore-dismiss" label="Don't ask again" onPress={() => act.dismissIgnore()} />
      </Box>
    </Box>
  )

  return {
    scrollMax,
    node: (
      <Box flexDirection="column">
        {/* The tabs do nothing while a card covers the board, so inline they give their row to the card. */}
        {!(isCompact && (panel || form)) && header}
        {(!panel || isDocked) && !form && filterRow}
        {!panel && !form && query && !items.some(isShown) && <Text key="no-match" dimColor>Nothing matches the filter.</Text>}
        {offer}
        {trouble ? (
          <Text color="red">{trouble}</Text>
        ) : form ? (
          form
        ) : items.length === 0 ? (
          <Text dimColor>No roadmap yet. Ask Claude to plan milestones, epics and tasks, or press n to add one.</Text>
        ) : (
          // Docked, the board keeps its rows on top and the card sits under it; where there is no room for
          // both, the open item stands in for the board, so a long board never pushes it off screen.
          isDocked && panel ? (
            <Box key="docked" flexDirection="column">
              <Box key="top" flexDirection="column" height={topRows}>
                {mode === 'board' ? board : mode === 'tree' ? tree : backlogView}
              </Box>
              {panel}
            </Box>
          ) : (
            panel ?? (mode === 'board' ? board : mode === 'tree' ? tree : backlogView)
          )
        )}
        {items.length > 0 && !trouble && (
          <Text dimColor>
            {footer}
          </Text>
        )}
      </Box>
      ),
  }
}
