import type { Elements, EventOf, RenderChildren, RenderElement } from 'claude-code'

import type { Checks, Draft, Item, Pr, Priority, Refs, Snapshot, Status, View } from '../types'
import * as db from './db'
import {
  backlog, dateOf, daysBetween, find, GLYPH, isLate, lastChange, stackFrom, stackText, SECTIONS, sectionFor, openPrOf, stackedOn, homesFor, isAgent, KINDS, TYPES, PRIORITIES, isMessage, isStale, LABEL, linksOf, marks, matches, parseQuery, path, progress, refsFor, STATUSES, statusOf, timeline, unread, USER,
  subtree, waitingOn, upOf, isDropped, WONTDO_GLYPH, treeRows as treeRowsOf, timelineRows, childrenOf,
} from './model'

export const COLOR: Record<Status, string> = { todo: 'gray', in_progress: 'yellow', blocked: 'red', review: 'blue', done: 'green' }
// Urgent priorities stand out on a card; the rest of the marks read dim.
export const PRIORITY_COLOR: Record<Priority, string | undefined> = { p0: 'red', p1: 'yellow', p2: undefined, p3: 'gray' }
// The views, in the order `v` steps through them.
const VIEWS: [View, string][] = [['board', 'Board'], ['tree', 'Tree'], ['backlog', 'Backlog'], ['timeline', 'Timeline'], ['inbox', 'Inbox']]
// A pull request's checks, as marked next to it.
const CHECKS: Record<Checks, string> = { none: '', pending: '… checks running', pass: '✓ checks', fail: '✗ checks failing' }
const CHECKS_COLOR: Record<Checks, string | undefined> = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' }
// Checks as one mark after a PR number on a board row.
const CHECK_MARK: Record<Checks, string> = { none: '', pending: ' …', pass: ' ✓', fail: ' ✗' }
// Docked cards: the fewest body rows that hold a board above a card, and the board's share of them.
const DOCK_MIN_ROWS = 30
const DOCK_SHARE = 0.4

/**
 * How many cards of each column fit in `budget` rows, given the rows each card takes (a card wraps in a
 * narrow column), by column, beside one another (`isWide`) or stacked: work under way and in review
 * first, then blocked, todo and done. A column cut short spends a row on its "… more".
 */
export function columnCaps(heights: Record<Status, number[]>, budget: number, isWide: boolean): Record<Status, number> {
  const caps = { todo: 0, in_progress: 0, blocked: 0, review: 0, done: 0 } as Record<Status, number>
  // The cards from the top of a column that fit in `room` rows, and the rows they take.
  const fit = (rows: number[], room: number) => {
    let n = 0
    let used = 0
    while (n < rows.length && used + rows[n]! <= room) used += rows[n++]!
    return { n, used }
  }
  const total = (rows: number[]) => rows.reduce((sum, one) => sum + one, 0)
  if (isWide) {
    for (const status of STATUSES)
      caps[status] = total(heights[status]) <= budget - 1 ? heights[status].length : fit(heights[status], Math.max(0, budget - 2)).n
    return caps
  }
  // Each non-empty column's heading and a row for its "… more" in case it is cut; the empty ones share a line.
  const filled = STATUSES.filter(status => heights[status].length > 0).length
  let left = budget - 2 * filled - (filled < STATUSES.length ? 1 : 0)
  for (const status of ['in_progress', 'review', 'blocked', 'todo', 'done'] as Status[]) {
    const { n, used } = fit(heights[status], Math.max(0, left))
    caps[status] = n
    // A column cut short takes what is left: the columns after it wait their turn.
    left = n < heights[status].length ? 0 : left - used
  }
  return caps
}

// Done shows the tasks finished in the last RECENT_DAYS, at least DONE_MIN and at most DONE_MAX of them.
const RECENT_DAYS = 7
const DONE_MIN = 3
const DONE_MAX = 8
// Rows of the pane that aren't the board's: the header, the footer and a spare.
const BOARD_CHROME = 5

// The cells of the header's progress bar.
const PROGRESS_BAR = 8

/** A bar of `cells` cells, filled for `done` of `total`: the filled part and the rest. */
export function progressBar(done: number, total: number, cells: number): { done: string; left: string } {
  const filled = total > 0 ? Math.round((done / total) * cells) : 0
  return { done: '█'.repeat(filled), left: '░'.repeat(cells - filled) }
}

/** The first of `hints` that fit in `rows` rows of `width`, each whole and joined by " · ". */
export function fitHints(hints: string[], width: number, rows: number): string[] {
  for (let n = hints.length; n > 1; n--) {
    let lines = 1
    let used = 0
    for (const [i, hint] of hints.slice(0, n).entries()) {
      const w = hint.length + (i < n - 1 ? 2 : 0)
      if (used > 0 && used + 1 + w > width) (lines++, (used = w))
      else used += (used > 0 ? 1 : 0) + w
    }
    if (lines <= rows) return hints.slice(0, n)
  }
  return hints.slice(0, 1)
}

// An item with nothing above it, for walks that start from one that may be missing.
const EMPTY = { parent: null, milestone: null } as Item

// The space between board columns side by side.
const COLUMN_GAP = 2

/**
 * The width of each board column side by side in `width`: a column with a fixed width (`fixed`, 0 for
 * none: an empty column's heading) takes that, and the others share what is left evenly.
 */
export function columnWidths(fixed: Record<Status, number>, width: number, gap: number): Record<Status, number> {
  const free = STATUSES.filter(status => fixed[status] === 0)
  const taken = STATUSES.reduce((sum, status) => sum + fixed[status], 0) + gap * (STATUSES.length - 1)
  const share = free.length ? Math.floor((width - taken) / free.length) : 0
  return Object.fromEntries(STATUSES.map(status => [status, fixed[status] || share])) as Record<Status, number>
}

/** The first of `list` whose rows (`heights`, one each) fit in `room`. */
export function fitRows<T>(list: T[], heights: number[], room: number): T[] {
  let used = 0
  let n = 0
  while (n < list.length && used + heights[n]! <= room) used += heights[n++]!
  return list.slice(0, Math.max(1, n))
}

// A backlog row's picker, priority and hand-off beside its title, with the gaps between them.
const BACKLOG_EDGES = 1 + 5 + 12 + 3

/** The rows `text` takes wrapped at word boundaries to `width` columns, as the terminal draws it. */
export function rowsOf(text: string, width: number): number {
  if (width < 1) return 1
  let rows = 1
  let col = 0
  for (const word of text.split(' ')) {
    const length = [...word].length
    if (col === 0) col = length
    else if (col + 1 + length <= width) col += 1 + length
    else {
      rows++
      col = length
    }
    // A word longer than the line is broken across rows.
    while (col > width) {
      rows++
      col -= width
    }
  }
  return rows
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
  /** Whether the field filing to the inbox is open. */
  isFiling: boolean
  /** Whether the board's Done column shows all done work, not just the recent. */
  isDoneOpen: boolean
  /** Milestones and epics folded otherwise than by default: a finished one opened, an open one folded. */
  flipped: string[]
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
  /** Backlog rows picked to run in parallel. */
  picked: string[]
  /** The tasks waiting on a yes before they are handed out to run in parallel. */
  parallelAsk: string[] | null
  /** Whether a comment on an agent's card starts a turn at once. */
  commentTurns: boolean
  /** The task whose card asks for its release note, having just been set done. */
  noting: string | null
  /** The task whose card asks why it is dropped (won't do), while it does. */
  dropping: string | null
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
  setFiling: (isOn: boolean) => void
  /** Files `title` to the inbox. */
  file: (title: string) => void
  setDoneOpen: (isOn: boolean) => void
  /** Folds or unfolds a milestone or epic in the tree and the timeline. */
  toggleFold: (id: string) => void
  /** Opens the new-item form (under `parent` when given), changes its choices, or closes it (null). */
  setDraft: (draft: Draft | null) => void
  create: (draft: Draft, title: string) => void
  setEditing: (isOn: boolean) => void
  /** Takes back the person's last change, or the logged entries `ids`. */
  undo: (ids?: number[]) => void
  /** Marks every comment on the board as read by the person. */
  markAllRead: () => void
  /** Asks to confirm merging the stack on an item's card (null drops the question). */
  askStack: (id: string | null) => void
  /** Merges a stack of PRs, bottom first. */
  mergeStack: (stack: Pr[]) => void
  /** Sets which backlog rows are picked to run in parallel. */
  setPicked: (ids: string[]) => void
  /** Asks to confirm handing tasks out to run in parallel (null drops the question). */
  askParallel: (ids: string[] | null) => void
  /** Hands tasks out to run in parallel, each to its own agent in its own worktree. */
  runParallel: (ids: string[]) => void
  /** Posts the person's comment on an item (starting a turn when set to). */
  comment: (item: Item, body: string) => void
  /** Puts a prompt about an item in the prompt box. */
  askClaude: (item: Item) => void
  /** Sets whether comments on an agent's card start a turn. */
  setCommentTurns: (isOn: boolean) => void
  /** Asks for a task's release note on its card (null drops the question). */
  setNoting: (id: string | null) => void
  setDropping: (id: string | null) => void
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
  const { snap, mode, pick, trouble, known, isIgnoreOffered, isRequesting, now, filter, isFiltering, isFiling, isDoneOpen, flipped, draft, isEditing, handing, merging, noting, dropping, commentTurns, stacking, stackRun, picked, parallelAsk } = state
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

  /**
   * How a card is laid out in `room` columns: on one line when it all fits, the details right-aligned in
   * the stacked board; else, in a board column, the title on one line and the details under it (every card
   * of a column so, `isSplit`, when any needs it, so they line up); else, in the stacked board, one line
   * with the title cut. Only the title and a long name are ever cut.
   */
  // What a card says beside its title, each piece led by a space.
  const piecesOf = (item: Item) => {
    const list = item.checklist ?? []
    const part = item.kind === 'task' ? undefined : progress(items, item)
    const tags = marks(item)
    const waits = waitingOn(items, item).map(one => one.id)
    // Work in review shows the pull request an Approve would merge.
    const pr = statusOf(items, item) === 'review' ? openPrOf(known, item) : undefined
    return {
      pr,
      tag: tags.length || isDropped(item) ? ` ${[...(isDropped(item) ? [`${WONTDO_GLYPH} won't do`] : []), ...tags].join(' ')}` : '',
      ticks: part ? ` ${part.done}/${part.total} tasks` : list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : '',
      prTag: pr ? ` PR #${pr.number}${CHECK_MARK[pr.checks]}` : '',
      wait: waits.length ? ` ⧗${waits.join(',')}` : '',
      who: item.assignee ? ` @${item.assignee}` : '',
      stale: isStale(item, now) ? ' ⌛stale' : '',
      // Past when it was due, its own date or one above it.
      late: isLate(items, item, now) ? ' ⚠late' : '',
      news: badge(item),
    }
  }
  type Slots = Record<Exclude<keyof ReturnType<typeof piecesOf>, 'pr'> | 'id', number>
  const SLOT_KEYS = ['tag', 'ticks', 'prTag', 'wait', 'who', 'stale', 'late', 'news'] as const
  // A name is given at most this much of a stacked row's slots; a longer one is cut.
  const WHO_SLOT = 19
  /** The width of each piece's slot over `list`: the widest of each, so stacked rows line them up. */
  const slotsOf = (list: Item[]): Slots => {
    const slots = Object.fromEntries([...SLOT_KEYS, 'id'].map(key => [key, 0])) as Slots
    for (const one of list) {
      slots.id = Math.max(slots.id, one.id.length)
      const pieces = piecesOf(one)
      for (const key of SLOT_KEYS) slots[key] = Math.max(slots[key], key === 'who' ? Math.min(WHO_SLOT, pieces.who.length) : pieces[key].length)
    }
    return slots
  }

  /**
   * How a card is laid out in `room` columns. Stacked, given `slots`, on one line: the title, then each
   * piece in its slot so the rows line up. Else on one line when it all fits; else, in a board column, the
   * title on one line and the details under it (every card of a column so, `isSplit`, when any needs it, so
   * they line up); else one line with the title cut. Only the title and a long name are ever cut.
   */
  const cardLayout = (item: Item, room: number, isStacked: boolean, isSplit = false, slots?: Slots) => {
    const { tag, ticks, pr, prTag, wait, who: fullWho, stale, late, news } = piecesOf(item)
    const others = tag.length + ticks.length + prTag.length + wait.length + stale.length + late.length + news.length
    const head = item.id.length + 1
    const cutWho = (whoRoom: number) => (fullWho.length <= whoRoom ? fullWho : whoRoom >= 5 ? `${fullWho.slice(0, whoRoom - 1)}…` : '')
    const cutTitle = (titleRoom: number) => (item.title.length <= titleRoom ? item.title : `${item.title.slice(0, Math.max(1, titleRoom - 1))}…`)
    const bits = { tag, ticks, pr, prTag, wait, stale, late, news }
    const slotted = slots ? SLOT_KEYS.reduce((sum, key) => sum + slots[key], 0) : 0
    if (isStacked && slots && room - slots.id - 1 - slotted >= 16) {
      const fit = (text: string, key: keyof Slots) => (text.length > slots[key] ? `${text.slice(0, slots[key] - 1)}…` : text).padEnd(slots[key])
      const lead = slots.id + 1
      const title = cutTitle(room - lead - slotted)
      return {
        id: item.id.padEnd(slots.id), tag: fit(tag, 'tag'), ticks: fit(ticks, 'ticks'), pr, prTag: fit(prTag, 'prTag'), wait: fit(wait, 'wait'), who: fit(fullWho, 'who'),
        stale: fit(stale, 'stale'), late: fit(late, 'late'), news: fit(news, 'news'), title, pad: room - lead - title.length - slotted, rows: 1,
      }
    }
    if (!isSplit && head + item.title.length + others + fullWho.length <= room) {
      const pad = isStacked ? room - head - item.title.length - others - fullWho.length : 0
      return { ...bits, title: item.title, who: fullWho, pad, rows: 1 }
    }
    if (isStacked) {
      // A readable title comes first: a long name is cut short to make room for it.
      const who = cutWho(Math.max(0, Math.min(18, room - head - others - 24)))
      const title = cutTitle(room - head - others - who.length)
      return { ...bits, title, who, pad: Math.max(0, room - head - title.length - others - who.length), rows: 1 }
    }
    // A board column: the title, then its details on a line of their own under it.
    return { ...bits, title: cutTitle(room - head), who: cutWho(room - others + 1), pad: 0, rows: 2 }
  }
  const card = (item: Item, room: number, isStacked: boolean, isSplit = false, slots?: Slots) => {
    const laid = cardLayout(item, room, isStacked, isSplit, slots)
    const { title, tag, ticks, pr, prTag, wait, who, stale, late, news, pad, rows } = laid
    const id = 'id' in laid && laid.id ? laid.id : item.id
    const isOpen = pick === item.id
    // A detail line leads with its first detail, its space dropped, under the title.
    let isFirst = rows === 2
    const detail = (text: string) => {
      if (!text || !isFirst) return text
      isFirst = false
      return text.slice(1)
    }
    return (
      <Button key={`card-${item.id}`} plain onPress={choose(item.id)}>
        <Text dimColor={!isOpen} inverse={isOpen} bold={isOpen}>
          {id}
        </Text>{' '}
        <Text bold={isOpen} dimColor={isDropped(item)} strikethrough={isDropped(item)}>
          {title}
        </Text>
        {rows === 2 ? '\n' : ' '.repeat(pad)}
        <Text color={PRIORITY_COLOR[item.priority]} bold={item.priority === 'p0'}>
          {detail(tag)}
        </Text>
        <Text dimColor>{detail(ticks)}</Text>
        <Text color={pr ? CHECKS_COLOR[pr.checks] ?? 'green' : undefined}>{detail(prTag)}</Text>
        <Text color="yellow" dimColor>
          {detail(wait)}
        </Text>
        <Text color="cyan">{detail(who)}</Text>
        <Text color="red" dimColor>
          {detail(stale)}
        </Text>
        <Text color="red">{detail(late)}</Text>
        <Text color="magenta" bold>
          {detail(news)}
        </Text>
      </Button>
    )
  }

  // What Undo would take back: the person's last change still standing.
  const undoable = lastChange(snap, USER)
  const canUndo = undoable.length > 0
  const unreadTotal = items.reduce((sum, item) => sum + unread(snap, item.id, USER).length, 0)
  const nextView = VIEWS[(VIEWS.findIndex(([one]) => one === mode) + 1) % VIEWS.length]![0]
  // Dropped work counts neither way: it is closed, but nothing was done.
  const doneCount = items.filter(i => i.kind === 'task' && i.status === 'done' && !isDropped(i)).length
  const taskCount = items.filter(i => i.kind === 'task' && !isDropped(i)).length
  // The header: the views as tabs with the progress and unread count beside them, then the actions. They
  // share a row where the pane is wide enough; else the actions take a second row of their own.
  const bar = progressBar(doneCount, taskCount, PROGRESS_BAR)
  // What waits in the inbox to be sorted.
  const waiting = (snap.inbox ?? []).filter(one => one.state === 'open')
  // A tab names what waits in it: the inbox its open items.
  const tabLabel = (view: View, label: string) => (view === 'inbox' && waiting.length ? `${label} ${waiting.length}` : label)
  const header = (
    <Box flexDirection="row" columnGap={3} flexWrap="wrap">
      <Box key="views" flexDirection="row" columnGap={2}>
        <Box key="tabs" flexDirection="row" columnGap={1}>
          {/* `v` steps to the next view: one hotkey, held by the tab after the one showing. */}
          {VIEWS.map(([one, label]) => (
            <Button key={`tab-${one}`} plain variant={mode === one ? 'primary' : 'secondary'}
              hotkey={one === nextView ? 'v' : undefined} onPress={() => act.setView(one)}>
              {mode === one ? (
                <Text inverse bold>
                  {` ${tabLabel(one, label)} `}
                </Text>
              ) : (
                <Text dimColor>{` ${tabLabel(one, label)} `}</Text>
              )}
            </Button>
          ))}
        </Box>
        <Text key="progress">
          <Text color="green">{bar.done}</Text>
          <Text dimColor>{bar.left}</Text> <Text dimColor>{doneCount}/{taskCount} done</Text>
        </Text>
        {unreadTotal > 0 && (
          <Text color="magenta" bold>
            ● {unreadTotal} unread
          </Text>
        )}
        {stackRun ? <Text color="yellow">Merging a stack: {stackRun}</Text> : null}
      </Box>
      <Box key="actions" flexDirection="row" columnGap={1}>
        {unreadTotal > 0 && <Button key="mark-read" label="Mark all read" onPress={() => act.markAllRead()} />}
        {!isFiltering && <Button key="filter" label={filter ? `Filter: ${filter}` : 'Filter'} hotkey="f" variant={filter ? 'primary' : 'secondary'}
          onPress={() => act.setFiltering(true)} />}
        {filter && !isFiltering ? <Button key="filter-clear" label="Clear" onPress={() => act.setFilter('')} /> : null}
        {canUndo && <Button key="undo" label="Undo" hotkey="z" onPress={() => act.undo()} />}
        {/* With a card open, n adds under it (on the card's bar) instead. */}
        {!draft && !pick && <Button key="new" label="New" hotkey="n" onPress={() => act.setDraft(newDraft(null))} />}
        {!isFiling && <Button key="file" label="File…" hotkey="i" onPress={() => act.setFiling(true)} />}
      </Box>
    </Box>
  )

  const filterRow = isFiltering && Input && (
    <Box key="filter-row" flexDirection="row" columnGap={1}>
      <Input key="filter-input" label="Filter" value={filter} autoFocus submitLabel="apply"
        placeholder="@claude #ui p0 bug review under:E3 words…" onSubmit={(value: string) => act.setFilter(value.trim())} />
      <Button key="filter-cancel" label="Cancel" onPress={() => act.setFiltering(false)} />
    </Box>
  )

  // Filing to the inbox: a line typed now, sorted later.
  const fileRow = isFiling && Input && (
    <Box key="file-row" flexDirection="row" columnGap={1}>
      <Input key="inbox-input" label="File to the inbox" autoFocus submitLabel="file" placeholder="An idea, a bug, a 'we should…'; Enter files it"
        onSubmit={(value: string) => {
          if (value.trim()) act.file(value.trim())
          act.setFiling(false)
        }} />
      <Button key="file-cancel" label="Cancel" onPress={() => act.setFiling(false)} />
    </Box>
  )
  const inboxView = (
    <Box flexDirection="column">
      {waiting.length === 0 && <Text dimColor>The inbox is empty. Press i to file something to sort later.</Text>}
      {waiting.map(one => {
        const by = ` — ${one.author}, ${one.at.slice(5, 10)}`
        const room = Math.max(8, width - one.id.length - 1 - by.length)
        return (
          <Box key={`inbox-${one.id}`} flexDirection="column">
            <Text>
              <Text dimColor>{one.id}</Text> {one.title.length > room ? `${one.title.slice(0, room - 1)}…` : one.title}
              <Text dimColor>{by}</Text>
            </Text>
            {one.body ? (
              <Text dimColor>
                {'  '}
                {one.body.length > width - 3 ? `${one.body.replace(/\s+/g, ' ').slice(0, width - 4)}…` : one.body.replace(/\s+/g, ' ')}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )

  const tasks = items.filter(item => item.kind === 'task' && isShown(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  // A milestone or epic handed over whole is reviewed as one: it waits in Review, where its card approves and merges it.
  const scopes = items.filter(item => item.kind !== 'task' && isAgent(item.assignee) && statusOf(items, item) === 'review' && isShown(item))
  const columns = Object.fromEntries(STATUSES.map(status =>
    [status, [...(status === 'review' ? scopes : []), ...tasks.filter(task => task.status === status)]])) as Record<Status, Item[]>
  // Side by side, an empty column takes its heading's width and the columns with cards share the rest.
  // A heading is drawn with its jump key: "t: ○ Todo 0".
  const headOf = (status: Status) => `${HOTKEY[status]}: ${GLYPH[status]} ${LABEL[status]} ${columns[status].length}`
  const widths = columnWidths(
    Object.fromEntries(STATUSES.map(status => [status, columns[status].length > 0 ? 0 : headOf(status).length])) as Record<Status, number>,
    width, COLUMN_GAP)
  const roomOf = (status: Status) => (isWide ? widths[status] : width - 2)
  // Side by side, a column whose cards don't all fit on one line gives every card two, so they line up.
  const isSplit = Object.fromEntries(STATUSES.map(status =>
    [status, isWide && columns[status].some(task => cardLayout(task, roomOf(status), false).rows === 2)])) as Record<Status, boolean>
  // Docked, the board fits the rows above the card; side by side, each heading has its rule under it.
  // Done shows the recent (the last week's, at least a few) unless opened; the rest are a press away.
  const recentDone = columns.done.filter(task => now - Date.parse(task.updated_at) < RECENT_DAYS * 86_400_000).length
  const doneClosed = Math.min(columns.done.length, Math.max(DONE_MIN, Math.min(recentDone, DONE_MAX)))
  const doneShown = isDoneOpen ? columns.done.length : doneClosed
  const heights = Object.fromEntries(STATUSES.map(status =>
    [status, columns[status].slice(0, status === 'done' ? doneShown : undefined)
      .map(task => cardLayout(task, roomOf(status), !isWide, isSplit[status]).rows)])) as Record<Status, number[]>
  // Docked, the board fits the rows above the card; Done opened fills what the pane has. Side by side,
  // each heading has its rule under it; stacked, the blocks have a blank row between them.
  const budget = isDocked ? topRows : isDoneOpen && bodyRows ? bodyRows - BOARD_CHROME - (isWide ? 0 : STATUSES.length) : Infinity
  const caps = budget !== Infinity
    ? columnCaps(heights, isWide ? budget - 1 : budget, isWide)
    : (Object.fromEntries(STATUSES.map(status => [status, status === 'done' ? doneShown : 15])) as Record<Status, number>)
  // Stacked, the empty columns fold into one line, and every card's pieces sit in slots shared by the board.
  const empties = isWide ? [] : STATUSES.filter(status => columns[status].length === 0)
  const stackSlots = isWide ? undefined : slotsOf(STATUSES.flatMap(status => columns[status].slice(0, caps[status])))
  const heading = (status: Status) => (
    <Button key={`col-${status}-head`} plain hotkey={HOTKEY[status]}
      onPress={() => columns[status][0] && act.focus(`card-${columns[status][0]!.id}`)}>
      <Text bold color={COLOR[status]}>
        {GLYPH[status]} {LABEL[status]}
      </Text>{' '}
      <Text dimColor>{columns[status].length}</Text>
    </Button>
  )
  const doneToggle = (isDoneOpen || columns.done.length > doneClosed) && (
    <Button key="done-toggle" plain onPress={() => act.setDoneOpen(!isDoneOpen)}>
      <Text dimColor>{isDoneOpen ? '· recent only' : '· show all'}</Text>
    </Button>
  )
  const board = (
    <Box flexDirection={isWide ? 'row' : 'column'} gap={isWide ? COLUMN_GAP : isDocked ? 0 : 1}>
      {empties.length > 0 && (
        <Box key="col-empty" flexDirection="row" columnGap={1} flexWrap="wrap">
          {empties.flatMap((status, i) => [...(i ? [<Text key={`col-empty-${i}`} dimColor>·</Text>] : []), heading(status)])}
        </Box>
      )}
      {STATUSES.filter(status => !empties.includes(status)).map(status => {
        const column = columns[status]
        const shown = column.slice(0, caps[status])
        return (
          <Box key={`col-${status}`} flexDirection="column" width={isWide ? widths[status] : undefined}>
            {status === 'done' && doneToggle ? (
              <Box key="col-done-top" flexDirection="row" columnGap={1}>
                {heading(status)}
                {doneToggle}
              </Box>
            ) : heading(status)}
            {isWide && <Text key={`col-${status}-rule`} color={COLOR[status]} dimColor>{'─'.repeat(widths[status])}</Text>}
            {shown.map(task => card(task, roomOf(status), !isWide, isSplit[status], stackSlots))}
            {column.length > shown.length && (
              <Text dimColor>
                …{column.length - shown.length} {status === 'done' && !isDoneOpen ? 'older' : 'more'}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )


  // A finished milestone or epic is folded to its own line, an open one unfolded, each until pressed;
  // with a filter typed, nothing is folded, so every match shows.
  const hasKids = (item: Item) => item.kind !== 'task' && childrenOf(items, item.id).length > 0
  // What holds the open card stays unfolded, so the card's row is always there to return to.
  const holdsPick = new Set<string>()
  for (let at = upOf(find(items, pick ?? undefined) ?? EMPTY); at; at = upOf(find(items, at) ?? EMPTY)) holdsPick.add(at)
  const isFolded = (item: Item) =>
    !query && hasKids(item) && !holdsPick.has(item.id) && (statusOf(items, item) === 'done') !== flipped.includes(item.id)
  // The timeline shows epics under milestones, not tasks: there, only a milestone with epics folds.
  const foldsInTimeline = (item: Item) => item.kind === 'milestone' && childrenOf(items, item.id).some(one => one.kind === 'epic')
  const foldToggle = (item: Item, canFold = hasKids(item)) =>
    canFold ? (
      <Button key={`fold-${item.id}`} plain onPress={() => act.toggleFold(item.id)}>
        <Text dimColor>{isFolded(item) ? '▸' : '▾'}</Text>
      </Button>
    ) : (
      <Text key={`fold-${item.id}`}> </Text>
    )
  const treeRows = treeRowsOf(items, isFolded).filter(({ item }) => !query || subtree(items, item.id).some(id => isShown(find(items, id)!)))
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
        const facts = `${item.kind !== 'task' && p.total > 0 ? `  ${p.done}/${p.total}` : ''}${item.due ? `  due ${item.due}` : ''}`
        const news = badge(item)
        // A row keeps to one line, so the rows line up and a window of them fits above a docked card: a long
        // name, then the title, is cut.
        const lead = depth * 2 + 2 + 2 + item.id.length + 1
        const fullWho = item.assignee ? `  @${item.assignee}` : ''
        const who = fullWho.length > 20 ? `${fullWho.slice(0, 19)}…` : fullWho
        const room = width - lead - facts.length - who.length - news.length
        const title = item.title.length > room ? `${item.title.slice(0, Math.max(1, room - 1))}…` : item.title
        return (
          <Box key={`tree-${item.id}`} flexDirection="row" columnGap={1} marginLeft={depth * 2}>
            {foldToggle(item)}
            <Button key={`row-${item.id}`} plain onPress={choose(item.id)}>
              {isDropped(item) ? <Text dimColor>{WONTDO_GLYPH}</Text> : <Text color={COLOR[status]}>{GLYPH[status]}</Text>} <Text dimColor>{item.id}</Text>{' '}
              <Text bold={item.kind === 'milestone'} dimColor={isDropped(item)} strikethrough={isDropped(item)}>
                {title}
              </Text>
              <Text dimColor>{facts}</Text>
              <Text color="cyan">{who}</Text>
              <Text color="magenta" bold>
                {news}
              </Text>
            </Button>
          </Box>
        )
      })}
      {treeShown.length < treeRows.length && <Text key="tree-more" dimColor>…{treeRows.length - treeShown.length} more rows (close the card to see them all)</Text>}
    </Box>
  )

  // Handing several out at once takes a yes, naming them and what waits.
  const confirmParallel = (ids: string[], key: string) => {
    const waits = ids.filter(id => { const one = find(items, id); return one && waitingOn(items, one).length > 0 })
    return (
      <Box key={key} flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text color="yellow">
          Run {ids.join(', ')} at once, each by its own agent in its own worktree?{waits.length ? ` ${waits.join(', ')} ${waits.length === 1 ? 'starts' : 'start'} when what ${waits.length === 1 ? 'it waits' : 'they wait'} on is done.` : ''}
        </Text>
        <Button key="parallel-yes" label="Yes, start them" onPress={() => act.runParallel(ids)} />
        <Button key="parallel-cancel" label="Cancel" onPress={() => act.askParallel(null)} />
      </Box>
    )
  }

  // Triage: what nobody holds yet, a priority picker and a hand-off on every row.
  const triageAll = backlog(items).filter(isShown)
  // Docked, as many rows as fit above the card, each as tall as its title wraps beside the picker and hand-off.
  const triageRows = (task: Item) => {
    const where = upOf(task) ? ` [${upOf(task)}]` : ' (no epic)'
    const tags = [...marks(task).filter(one => !PRIORITIES.includes(one as never)), ...task.labels.map(one => `#${one}`)].join(' ')
    return rowsOf(`${task.id} ${task.title}${where}${tags ? ` ${tags}` : ''}`, Math.max(10, width - BACKLOG_EDGES))
  }
  const triage = isDocked ? fitRows(triageAll, triageAll.map(triageRows), topRows - 1) : triageAll
  const backlogView = (
    <Box flexDirection="column">
      {triage.length === 0 && <Text dimColor>The backlog is empty: every todo task has someone on it.</Text>}
      {/* Picked rows run at once: each its own agent, worktree and branch. */}
      {picked.length > 0 && (parallelAsk && !pick ? confirmParallel(parallelAsk, 'parallel-confirm') : (
        <Box key="picked-row" flexDirection="row" columnGap={1}>
          <Button key="run-picked" label={`Run ${picked.length} at once…`} variant="primary" onPress={() => act.askParallel(picked)} />
          <Button key="unpick" label="Clear picks" onPress={() => act.setPicked([])} />
        </Box>
      ))}
      {triage.length < triageAll.length && <Text key="backlog-more" dimColor>…{triageAll.length - triage.length} more (close the card to see them all)</Text>}
      {triage.map(task => {
        const where = upOf(task) ? ` [${upOf(task)}]` : ' (no epic)'
        const tags = [...marks(task).filter(one => !PRIORITIES.includes(one as never)), ...task.labels.map(one => `#${one}`)].join(' ')
        const row = (
          <Box key={`back-${task.id}`} flexDirection="row" columnGap={1}>
            <Button key={`pick-${task.id}`} plain
              onPress={() => act.setPicked(picked.includes(task.id) ? picked.filter(id => id !== task.id) : [...picked, task.id])}>
              <Text color={picked.includes(task.id) ? 'green' : undefined}>{picked.includes(task.id) ? '☑' : '☐'}</Text>
            </Button>
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

  // The timeline: milestones and epics by due date, each with its progress and how it stands against the date.
  const today = now > 0 ? dateOf(now) : undefined
  const timelineAll = timelineRows(items, isFolded).filter(({ item }) => !query || subtree(items, item.id).some(id => isShown(find(items, id)!)))
  const timelineShown = isDocked ? timelineAll.slice(0, Math.max(1, topRows - 1)) : timelineAll
  const BAR = 10
  // The timeline lines up in columns: the name, the date (a dim dash for none), the bar and its count,
  // then how it stands against its date.
  const countWidth = Math.max(0, ...timelineAll.map(({ item }) => { const p = progress(items, item); return `${p.done}/${p.total}`.length }))
  const right = 2 + 10 + 2 + BAR + 1 + countWidth
  // How each stands against its date: room is kept for it, up to a point, before the names take the rest.
  const standing = (one: Item) => {
    const p = progress(items, one)
    const days = one.due && today ? daysBetween(today, one.due) : undefined
    if (days === undefined || statusOf(items, one) === 'done') return ''
    if (isLate(items, one, now)) return `${-days} day${days === -1 ? '' : 's'} late, ${p.total - p.done} open`
    return days === 0 ? 'due today' : `in ${days} day${days === 1 ? '' : 's'}`
  }
  const whenWidth = Math.min(22, Math.max(0, ...timelineAll.map(({ item }) => standing(item).length)))
  const nameWidth = Math.min(
    Math.max(0, ...timelineAll.map(({ item, depth }) => depth * 2 + 2 + 2 + item.id.length + 1 + item.title.length)),
    Math.max(20, width - right - 2 - (whenWidth ? whenWidth + 2 : 0)),
  )
  const timelineView = (
    <Box flexDirection="column">
      {timelineAll.length === 0 && <Text dimColor>No milestones or epics yet.</Text>}
      {timelineShown.map(({ item: one, depth }) => {
        const p = progress(items, one)
        const st = statusOf(items, one)
        const filled = p.total ? Math.round((p.done / p.total) * BAR) : 0
        const late = isLate(items, one, now)
        const when = standing(one)
        const lead = depth * 2 + 2 + 2 + one.id.length + 1
        const title = one.title.length + lead > nameWidth ? `${one.title.slice(0, Math.max(4, nameWidth - lead - 1))}…` : one.title
        const pad = ' '.repeat(Math.max(0, nameWidth - lead - title.length))
        // An epic without a date of its own goes by its milestone's.
        const date = one.due ?? (depth > 0 ? '' : '—')
        // Room left on the line for how it stands: cut rather than wrapped.
        const whenRoom = width - nameWidth - right - 2
        const said = when && whenRoom > 4 ? (when.length > whenRoom ? `${when.slice(0, whenRoom - 1)}…` : when) : ''
        return (
          <Box key={`timeline-${one.id}`} flexDirection="row" columnGap={1} marginLeft={depth * 2}>
            {foldToggle(one, foldsInTimeline(one))}
            <Button key={`time-${one.id}`} plain onPress={choose(one.id)}>
              <Text color={COLOR[st]}>{GLYPH[st]}</Text> <Text dimColor>{one.id}</Text> <Text bold={one.kind === 'milestone'}>{title}</Text>
              {pad}
              <Text dimColor>{`  ${date.padEnd(10)}  `}</Text>
              <Text color="green">{'▓'.repeat(filled)}</Text>
              <Text dimColor>
                {'░'.repeat(BAR - filled)} {`${p.done}/${p.total}`.padStart(countWidth)}
              </Text>
              <Text color={late ? 'red' : undefined} dimColor={!late} bold={late}>{said ? `  ${said}` : ''}</Text>
            </Button>
          </Box>
        )
      })}
      {timelineShown.length < timelineAll.length && <Text key="timeline-more" dimColor>…{timelineAll.length - timelineShown.length} more (close the card to see them all)</Text>}
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
        : [choice('edit-parent', 'Under', upOf(item) ?? '', [
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
  const flowRows = (widths: number[], room: number, gap = 1) => {
    let lines = 1
    let used = 0
    for (const w of widths) {
      if (used > 0 && used + gap + w > room) (lines++, (used = w))
      else used += (used > 0 ? gap : 0) + w
    }
    return lines
  }
  // A row of buttons, each drawn as "[ label ]".
  const buttonRows = (labels: string[]) => flowRows(labels.map(label => label.length + 4), inner)
  // The header as it wraps over the whole pane, when it shows above an open card.
  const headerRows = flowRows([
    VIEWS.reduce((sum, [one, label]) => sum + tabLabel(one, label).length + 2 + (one === nextView ? 3 : 0), 0) + (VIEWS.length - 1) +
      2 + PROGRESS_BAR + ` ${doneCount}/${taskCount} done`.length +
      (unreadTotal > 0 ? 2 + `● ${unreadTotal} unread`.length : 0) + (stackRun ? 2 + `Merging a stack: ${stackRun}`.length : 0),
    [
      ...(unreadTotal > 0 ? ['Mark all read'.length + 4] : []),
      ...(!isFiltering ? [(filter ? `Filter: ${filter}` : 'Filter').length + 4] : []),
      ...(filter && !isFiltering ? ['Clear'.length + 4] : []),
      ...(canUndo ? ['Undo'.length + 4] : []),
      ...(!draft && !pick ? ['New'.length + 4] : []),
      ...(!isFiling ? ['File…'.length + 4] : []),
    ].reduce((sum, one, i) => sum + one + (i ? 1 : 0), 0),
  ].filter(one => one > 0), width, 3)
  // Approve on what is itself up for review: a task, or a milestone or epic handed over whole; not on
  // one that reads review only because a part of it does.
  const isReview = status === 'review' && (item?.kind === 'task' || isAgent(item?.assignee))
  // Work in review waits on the person, not on Claude: its card approves it or asks for changes instead.
  const isHandable = status !== 'done' && status !== 'review'
  // A milestone's or epic's tasks that could run at once: todo, and nobody's yet.
  const openUnder = item && item.kind !== 'task'
    ? subtree(items, item.id).map(id => find(items, id)!).filter(one => one.kind === 'task' && one.status === 'todo' && !one.assignee).map(one => one.id)
    : []
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
    : (item.kind === 'task' ? buttonRows([...STATUSES.map(one => (item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one])), `${WONTDO_GLYPH} Won't do`]) : 1) +
      (isRequesting || handing === item.id || merging === item.id || noting === item.id || dropping === item.id || stacking === item.id ? 1 :
        parallelAsk && item.kind !== 'task' ? tall(`Run ${parallelAsk.join(', ')} at once, each by its own agent in its own worktree? [ Yes, start them ] [ Cancel ]`) : buttonRows([...(isReview ? ['Approve', 'Request changes'] : []), ...(isHandable ? ['Hand to Claude'] : []), 'Ask Claude', ...(item.kind !== 'task' ? ['Add item'] : []), ...(openUnder.length > 1 ? ['Run its tasks at once…'] : []), isEditing ? 'Done editing' : 'Edit', 'Assign me', 'Unassign', 'Close']))
  const info = item ? `assignee ${item.assignee ?? 'none'}${item.kind === 'task' ? `  priority ${item.priority}  ${item.type}` : ''}${tagLine ? `  ${tagLine}` : ''}${item.due ? `  due ${item.due}` : ''}${where ? `  in ${where}` : ''}` : ''
  // Key hints, most useful first: as many as fit in the rows the pane gives them (one wide, two narrow),
  // each whole, the rest dropped from the end. Drawn in that order of usefulness, not of the keys.
  const hints = (draft
    ? ['Tab/↑↓ move between fields', 'Enter on Title creates it']
    : item
    ? ['Tab/↑↓ move', 'x close', isEditing ? 'e done editing' : 'e edit', isReview ? 'a approve · c request changes' : '', item.kind === 'task' ? `1–${STATUSES.length} status` : '']
    : [isIgnoreOffered ? 'g gitignore the db' : '', 'Enter opens', 'Tab/↑↓ move', `v ${nextView}`, mode === 'board' ? 't p b r d jump to a column' : '', 'n new', 'i file to the inbox', 'f filter', canUndo ? 'z undo' : '']
  ).filter(Boolean)
  const footerHints = fitHints(hints, width, width >= 100 ? 1 : 2)
  const footerRows = flowRows(footerHints.map((one, i) => one.length + (i < footerHints.length - 1 ? 2 : 0)), width)
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
            {STATUSES.map((one, i) => {
              // Dropped, the task shows as Won't do rather than Done; any status takes it back to work.
              const isOn = item.status === one && !(one === 'done' && isDropped(item))
              return (
                <Button key={`set-${one}`} label={isOn ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]}
                  hotkey={String(i + 1)} variant={isOn ? 'primary' : 'secondary'}
                  onPress={() => {
                    act.userAct({ action: 'update', id: item.id, status: one })
                    // Done, and nothing for the CHANGELOG yet: the card asks for its line.
                    if (one === 'done' && !item.note && Input) act.setNoting(item.id)
                  }} />
              )
            })}
            {/* No hotkey: dropping work takes a reason, asked for on the next row. */}
            <Button key="set-wontdo" label={isDropped(item) ? `${WONTDO_GLYPH} Won't do` : "Won't do"} variant={isDropped(item) ? 'primary' : 'secondary'}
              onPress={() => (isDropped(item) || !Input ? undefined : act.setDropping(item.id))} />
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
        {parallelAsk && item.kind !== 'task' ? (
          confirmParallel(parallelAsk, 'parallel-confirm')
        ) : stacking === item.id && isStack ? (
          <Box key="stack-confirm" flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color="yellow">
              Merge {stack.map(pr => `#${pr.number}`).join(', then ')} into {stack[0]!.base || 'main'}, each once its checks pass there?
            </Text>
            <Button key="stack-yes" label="Merge the stack" onPress={() => act.mergeStack(stack)} />
            <Button key="stack-cancel" label="Cancel" onPress={() => act.askStack(null)} />
          </Box>
        ) : dropping === item.id && Input ? (
          <Box key="wontdo-row" flexDirection="row" columnGap={1}>
            <Input key="wontdo-reason" label="Won't do, because" placeholder="Why it's dropped; Enter closes it" autoFocus submitLabel="close"
              onSubmit={(value: string) => {
                if (value.trim()) act.userAct({ action: 'update', id: item.id, wontdo: value.trim() })
                act.setDropping(null)
              }} />
            <Button key="wontdo-cancel" label="Cancel" onPress={() => act.setDropping(null)} />
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
          {openUnder.length > 1 && <Button key="run-parallel" label="Run its tasks at once…" onPress={() => act.askParallel(openUnder)} />}
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
    return fitDraft({ kind, priority: 'p2', type: 'feature', parent: under && under.kind !== 'task' ? under.id : (under && upOf(under)) || '' })
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
        {!form && fileRow}
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
                {mode === 'board' ? board : mode === 'tree' ? tree : mode === 'timeline' ? timelineView : mode === 'inbox' ? inboxView : backlogView}
              </Box>
              {panel}
            </Box>
          ) : (
            panel ?? (mode === 'board' ? board : mode === 'tree' ? tree : mode === 'timeline' ? timelineView : mode === 'inbox' ? inboxView : backlogView)
          )
        )}
        {items.length > 0 && !trouble && (
          <Box key="hints" flexDirection="row" columnGap={1} flexWrap="wrap">
            {footerHints.map((one, i) => (
              <Text key={`hint-${i}`} dimColor>
                {i < footerHints.length - 1 ? `${one} ·` : one}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      ),
  }
}

/**
 * The band above the prompt: what the agents are working on right now, pressable to open it. `working`
 * is their tasks under way, the latest first; several (tasks run in parallel) are shown side by side.
 */
export function drawBand(els: Elements[keyof Elements], e: EventOf['ui.render'], snap: Snapshot, working: Item[], show: (id: string) => void): RenderElement {
  const { Box, Button, Text } = els
  const task = working[0]!
  const room = ((e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80) - 1
  // Several agents at once (tasks run in parallel): each one's task and checklist, side by side, as many as fit.
  if (working.length > 1) {
    const ticksOf = (one: Item) => (one.checklist.length ? ` ☑${one.checklist.filter(c => c.done).length}/${one.checklist.length}` : '')
    const head = `◐ ${working.length} agents: `
    let used = head.length
    const shown = working.filter(one => {
      const width = `${one.id}${ticksOf(one)} · `.length
      return (used += width) <= room - 8
    })
    return (
      <Box flexDirection="row">
        <Text color={COLOR.in_progress}>◐</Text>
        <Text dimColor> {working.length} agents:</Text>
        {shown.map((one, i) => (
          <Button key={`agent-${one.id}`} plain onPress={() => show(one.id)}>
            {i ? <Text dimColor> ·</Text> : null} <Text>{one.id}</Text>
            <Text dimColor>{ticksOf(one)}</Text>
          </Button>
        ))}
        {shown.length < working.length && <Text dimColor> +{working.length - shown.length} more</Text>}
      </Box>
    )
  }
  const milestone = (() => {
    let at: Item | undefined = task
    while (at && at.kind !== 'milestone') at = find(snap.items, upOf(at) ?? undefined)
    return at
  })()
  const list = task.checklist ?? []
  const ticks = list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : ''
  const where = milestone ? ` · ${milestone.id} ${progress(snap.items, milestone).done}/${progress(snap.items, milestone).total}` : ''
  const fixed = `◐ ${task.id}  @${task.assignee}${ticks}${where}`.length
  const title = task.title.length + fixed > room ? task.title.slice(0, Math.max(8, room - fixed - 1)) + '…' : task.title

  return (
    <Box>
      <Button key="current" plain onPress={() => show(task.id)}>
        <Text color={COLOR.in_progress}>◐</Text> <Text dimColor>{task.id}</Text> {title}
        <Text color="cyan"> @{task.assignee}</Text>
        <Text dimColor>
          {ticks}
          {where}
        </Text>
      </Button>
    </Box>
  )
}
