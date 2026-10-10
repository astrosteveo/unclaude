import type { Elements, EventOf, RenderChildren, RenderElement } from 'claude-code'

import type { Checks, Draft, Item, Pr, Priority, Refs, Snapshot, Status, View } from '../types'
import * as db from './db'
import { kids, paint } from './paint'
import {
  backlog, dateOf, daysBetween, find, GLYPH, isLate, lastChange, stackFrom, stackBelow, stackText, SECTIONS, sectionFor, openPrOf, stackedOn, homesFor, isAgent, KINDS, TYPES, PRIORITIES, isMessage, isStale, LABEL, linksOf, marks, matches, parseQuery, path, progress, refsFor, STATUSES, statusOf, timeline, unread, USER,
  subtree, waitingOn, upOf, tasksIn, spanOf, targetOf, releaseOf, unreleased, shipNote, releasesOf, nextVersion, isDropped, WONTDO_GLYPH, treeRows as treeRowsOf, timelineRows, childrenOf,
} from './model'

export const COLOR: Record<Status, string> = { todo: 'gray', in_progress: 'yellow', blocked: 'red', review: 'blue', done: 'green' }
// Urgent priorities are drawn in color on a card; the other priorities are drawn dim.
export const PRIORITY_COLOR: Record<Priority, string | undefined> = { p0: 'red', p1: 'yellow', p2: undefined, p3: 'gray' }
// The tabs, in the order `v` steps through them. This is the order work moves through: filed, planned,
// scheduled, done, shipped.
const VIEWS: [View, string][] = [['inbox', 'Inbox'], ['plan', 'Plan'], ['roadmap', 'Roadmap'], ['board', 'Board'], ['releases', 'Releases']]
// A pull request's checks, as marked next to it.
const CHECKS: Record<Checks, string> = { none: '', pending: '… checks running', pass: '✓ checks', fail: '✗ checks failing' }
const CHECKS_COLOR: Record<Checks, string | undefined> = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' }
// Checks as one mark after a PR number on a board row.
const CHECK_MARK: Record<Checks, string> = { none: '', pending: ' …', pass: ' ✓', fail: ' ✗' }
// Docked cards: the fewest body rows that hold a board above a card.
const DOCK_MIN_ROWS = 30

/**
 * How many cards of each column fit in `budget` rows, given the rows each card takes (a card wraps in a
 * narrow column), by column, beside one another (`isWide`) or stacked: work under way and in review
 * first, then blocked, todo and done. A column that doesn't fit whole uses one row for its "… more" line.
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
    // A column that doesn't fit whole takes all the rows left, so the columns after it get none.
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

/**
 * A table's column: its header, its width (or `fill`: what the others leave), and when it is dropped as the
 * room runs short (the highest `drop` first; 0 never). `align: 'right'` for counts; `most`: the widest a fill column needs.
 */
export type TableColumn = { key: string; label: string; width: number | 'fill'; drop: number; align?: 'right'; most?: number }
// A wide board card's title wraps to this many lines at most.
const TITLE_LINES = 2
// The fewest columns a table's fill column keeps.
const FILL_MIN = 16

/** The columns that fit in `room`, one apart, each with its width: the fill column takes what is left. */
export function fitColumns(columns: TableColumn[], room: number): (TableColumn & { width: number })[] {
  let kept = [...columns]
  // The fill column (a title) keeps at least two fifths of the room.
  const least = Math.max(FILL_MIN, Math.floor(room * 0.4))
  const need = (list: TableColumn[]) => list.reduce((sum, one) => sum + (one.width === 'fill' ? least : one.width), 0) + list.length - 1
  while (need(kept) > room) {
    const next = kept.filter(one => one.drop > 0).sort((a, b) => b.drop - a.drop)[0]
    if (!next) break
    kept = kept.filter(one => one !== next)
  }
  const fixed = kept.reduce((sum, one) => sum + (one.width === 'fill' ? 0 : one.width), 0) + kept.length - 1
  return kept.map(one => ({ ...one, width: one.width === 'fill' ? Math.max(least, Math.min(room - fixed, one.most ?? Infinity)) : one.width }))
}

/** `text` in a cell `width` wide: cut with … when longer, padded (on the left when `right`) when shorter. */
export const cellOf = (text: string, width: number, align?: 'right') =>
  [...text].length > width ? `${[...text].slice(0, Math.max(0, width - 1)).join('')}…` : align === 'right' ? text.padStart(width) : text.padEnd(width)

// The outline of the frame in use, when a card is docked under the list.
const ACTIVE = 'cyan'
// Docked, the frame the wheel and keys scroll is outlined in ACTIVE, dimmed. The frame under the pointer is
// outlined in bright ACTIVE, so the bright outline follows the mouse (the divider's arrows also turn bright
// under it).
// The background of a board card under the pointer: a grey one shade lighter than the pane's (a 256-colour
// grey, which most terminals draw the same way).
const LIT_CARD = 'ansi256(237)'
const LIT = { borderColor: ACTIVE, borderDimColor: false } as const
const LIT_TEXT = { color: ACTIVE, dimColor: false, bold: true } as const
// Docked: the list's fewest rows (its frame included), the divider's row, and how far one press moves it.
const LIST_MIN = 8
const DIVIDER_ROWS = 1
const SPLIT_STEP = 2

// The space between board columns side by side, and what a column's frame (border and padding) takes across.
const COLUMN_GAP = 1
const FRAME = 4

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

// The widths of a backlog row's checkbox, priority and hand-to-Claude button beside its title, with the gaps between them.
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
  /** Whether the Releases tab shows the field for the version to release. */
  isReleasing: boolean
  /** The roadmap's zoom: 0 shows all the dated work; each step zooms in closer around today. */
  zoom: number
  /** The inbox item whose row shows a field for where it goes or why it's dropped. */
  triaging: { id: string; mode: 'into' | 'drop' } | null
  /** Whether the board's Done column shows all done work, not just the recent. */
  isDoneOpen: boolean
  /** Milestones and epics collapsed or expanded against the default: a finished one expanded, an open one collapsed. */
  flipped: string[]
  /** The new-item form, while it is open. */
  draft: Draft | null
  /** Whether the open card shows its fields for editing. */
  isEditing: boolean
  /** The item the person must confirm before it is handed to Claude. */
  handing: string | null
  /** The item the person must confirm before it is approved and its pull request merged. */
  merging: string | null
  /** The item whose card shows the question confirming the merge of its stack of PRs. */
  stacking: string | null
  /** What a stack being merged is doing now; empty when none is. */
  stackRun: string
  /** Backlog rows picked to run in parallel. */
  picked: string[]
  /** The tasks the person must confirm before they are handed out to run in parallel. */
  parallelAsk: string[] | null
  /** Whether a comment on an agent's card starts a turn at once. */
  commentTurns: boolean
  /** The task whose card shows a field for its release note because it was just set done. */
  noting: string | null
  /** The task whose card shows a field for why it is dropped (won't do), while that field is open. */
  dropping: string | null
  /** How far the open card is scrolled, as asked. */
  scrolledTo: number
  /** Where the tab showing is scrolled to, in rows from its top. */
  viewScrolledTo: number
  /** When a card has just opened, the docked list keeps the open item's row visible (until the wheel scrolls it). */
  isRevealing?: boolean
  /** With a card docked under the list, which of the two the wheel last scrolled (the card when it opens). */
  region: 'list' | 'card'
  /** The list's rows with a card docked, as the person set them with the divider; null sizes by the card. */
  split: number | null
  /** The current time, for marking inactive claims; 0 when it can't be read. */
  now: number
}

/**
 * What each press does, set up by the hooks module. The pane only draws (it never passes an engine handle
 * to another file), and every write or move goes through these.
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
  setReleasing: (isOn: boolean) => void
  setZoom: (zoom: number) => void
  /** Sets the list's rows over a docked card (the divider); null to size them by the card again. */
  setSplit: (rows: number | null) => void
  setTriaging: (one: { id: string; mode: 'into' | 'drop' } | null) => void
  /** Opens the Releases tab on `version`, expanded. */
  showRelease: (version: string) => void
  /** Runs ship from the board: the release PR for `version`, or (`publish`, once it has merged) its tag and release. */
  release: (version: string, publish: boolean) => void
  /** Files `title` to the inbox. */
  file: (title: string) => void
  setDoneOpen: (isOn: boolean) => void
  /** Collapses or expands a milestone or epic in the tree and the timeline. */
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
 * Draws the board, the tree, or an open card from `els` (the surface's elements), and returns the
 * tree and how far the open card can scroll.
 */
export function drawPane(
  els: Elements[keyof Elements], e: EventOf['ui.render'], state: PaneState, act: PaneActions,
): { node: RenderElement; scrollMax: number; viewScrollMax: number; viewScrollAt: number; listEnd: number } {
  const { Box, Text, Button, Link } = els
  const Input = 'Input' in els ? els.Input : undefined
  /**
   * A window `room` lines tall over `blocks`, from line `at`: blocks wholly inside it as they are, and of a
   * block cut by the top or bottom edge (a wrapped description, an activity entry), the lines of it inside,
   * drawn plain. This way scrolling moves one line at a time. Blocks are measured as drawn, `width` wide.
   */
  const windowOf = (blocks: { key: string; node: unknown }[], at: number, room: number, width: number) => {
    const measured = blocks.map(one => ({ ...one, lines: Math.max(1, paint(one.node as never, width).length) }))
    const total = measured.reduce((sum, one) => sum + one.lines, 0)
    const nodes: unknown[] = []
    let line = 0
    for (const one of measured) {
      const top = line
      const bottom = line + one.lines
      line = bottom
      if (bottom <= at || top >= at + room) continue
      if (top >= at && bottom <= at + room) nodes.push(one.node)
      else
        // Cut by an edge: the lines of it in the window, drawn as the painter lays them out.
        paint(one.node as never, width)
          .slice(Math.max(0, at - top), Math.min(one.lines, at + room - top))
          .forEach((text, i) => nodes.push(<Text key={`${one.key}-cut-${i}`}>{text.replace(/^ +/, lead => '\u00a0'.repeat(lead.length)) || ' '}</Text>))
    }
    const above = Math.min(at, total)
    const below = Math.max(0, total - at - room)
    return { nodes, total, above, below }
  }
  const Select = 'Select' in els ? els.Select : undefined
  const { snap, mode, pick, trouble, known, isIgnoreOffered, isRequesting, now, filter, isFiltering, isFiling, isReleasing, zoom, triaging, region, split, isDoneOpen, flipped, draft, isEditing, handing, merging, noting, dropping, commentTurns, stacking, stackRun, picked, parallelAsk } = state
  // Handing over starts Claude working, so the person must confirm it: no single key or stray Enter does it.
  const confirmHand = (one: Item) => (
    <Box key={`hand-confirm-${one.id}`} flexDirection="row" columnGap={1}>
      <Text color="yellow">Hand {one.id} to Claude? It starts on it now.</Text>
      <Button key="hand-yes" label="Yes, hand it over" onPress={() => act.handToClaude(one)} />
      <Button key="hand-cancel" label="Cancel" onPress={() => act.askHand(null)} />
    </Box>
  )
  const query = parseQuery(filter)
  // What the filter lets through: everything without one; with one, what matches and, in the tree, the items above a match.
  const isShown = (item: Item) => !query || matches(snap, item, query)
  const items = snap.items
  const paneWidth = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 100
  // Inline, the pane gets about a third of the screen, so an open card there uses as few rows as it can.
  const isCompact = e.surface === 'terminal' && (e.props as { placement?: string }).placement === 'inline'
  // On the terminal, the rows the pane's body has; elsewhere the tree just grows.
  const bodyRows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows
  // An open card docks under the board when the pane has room for both; the board keeps the top part.
  // (Only a card for an item that is there: one removed meanwhile docks nothing.)
  const isDocked = Boolean(pick && find(items, pick)) && !isCompact && !draft && bodyRows !== undefined && bodyRows >= DOCK_MIN_ROWS
  // Docked in the terminal, the list is framed like a card, whether a card is open under it or not (with
  // none open, the list takes the whole area). Its border and padding take four columns and two rows.
  const isFramed = isDocked || (e.surface === 'terminal' && (e.props as { placement?: string }).placement === 'dock' &&
    bodyRows !== undefined && !draft && !(pick && find(items, pick)))
  const width = isFramed ? paneWidth - 4 : paneWidth
  // Five columns side by side need room for a readable title in each; narrower, they stack.
  const isWide = width >= 100
  // A tab longer than its room scrolls (the wheel moves it): under the header, or docked, in its frame over a card.
  const canScroll = e.surface === 'terminal' && bodyRows !== undefined && !draft && !isCompact && (!(pick && find(items, pick)) || isDocked)
  // Pressing the open card again closes it.
  const choose = (id: string | null) => () => (id !== null && id === pick ? act.closeDetail(id) : act.open(id))
  // A row's button key; the open item's row gets its own key. The terminal tracks the focus ring by the button's
  // place among the buttons, so closing a docked card moves focus to `card-<id>` only once the whole list is drawn
  // (the pane waits for that key).
  const rowKey = (kind: 'card' | 'row' | 'time', id: string) => (id === pick ? `${kind}-${id}-open` : `${kind}-${id}`)
  const badge = (item: Item) => {
    const count = unread(snap, item.id, USER).length
    return count ? ` ● ${count}` : ''
  }

  // What a card shows beside its title, each piece starting with a space.
  // Merged work the next release would ship, for the cards that show it.
  const unreleasedIds = new Set(unreleased(snap, known).map(one => one.id))
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
      // A milestone's or epic's tasks done (a bare count), a task's checklist ticked (☑).
      ticks: part ? ` ${part.done}/${part.total}` : list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : '',
      prTag: pr ? ` PR #${pr.number}${CHECK_MARK[pr.checks]}` : '',
      wait: waits.length ? ` ⧗${waits.join(',')}` : '',
      who: item.assignee ? ` @${item.assignee}` : '',
      stale: isStale(item, now) ? ' ⌛inactive' : '',
      // Past when it was due, its own date or one above it.
      late: isLate(items, item, now) ? ' ⚠late' : '',
      news: badge(item),
      // Done work shows where it shipped: the version it shipped in, or that the next release will include it.
      ship: item.kind === 'task' && item.status === 'done' ? (releaseOf(snap, item.id) ? ` v${releaseOf(snap, item.id)!.version}` : unreleasedIds.has(item.id) ? ' unreleased' : '') : '',
    }
  }
  type Slots = Record<Exclude<keyof ReturnType<typeof piecesOf>, 'pr'> | 'id', number>
  const SLOT_KEYS = ['tag', 'ticks', 'prTag', 'wait', 'who', 'stale', 'late', 'ship', 'news'] as const
  // A name gets at most this many columns in a stacked row's slots; a longer one is cut.
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
   * piece in its slot so the rows line up; else on one line, the title cut when it all doesn't fit. In a
   * board column side by side, a card of its own: the title on up to TITLE_LINES lines, then its details
   * on a line under it. Only the title and a long name are ever cut.
   */
  const cardLayout = (item: Item, room: number, isStacked: boolean, slots?: Slots) => {
    const { tag, ticks, pr, prTag, wait, who: fullWho, stale, late, ship, news } = piecesOf(item)
    // (⌛ takes two cells.)
    const others = tag.length + ticks.length + prTag.length + wait.length + stale.length + (stale ? 1 : 0) + late.length + ship.length + news.length
    const head = item.id.length + 1
    const cutWho = (whoRoom: number) => (fullWho.length <= whoRoom ? fullWho : whoRoom >= 5 ? `${fullWho.slice(0, whoRoom - 1)}…` : '')
    const cutTitle = (titleRoom: number) => (item.title.length <= titleRoom ? item.title : `${item.title.slice(0, Math.max(1, titleRoom - 1))}…`)
    const bits = { tag, ticks, pr, prTag, wait, stale, late, ship, news }
    const slotted = slots ? SLOT_KEYS.reduce((sum, key) => sum + slots[key], 0) : 0
    if (isStacked && slots && room - slots.id - 1 - slotted >= 16) {
      const fit = (text: string, key: keyof Slots) => (text.length > slots[key] ? `${text.slice(0, slots[key] - 1)}…` : text).padEnd(slots[key])
      const lead = slots.id + 1
      const title = cutTitle(room - lead - slotted)
      return {
        id: item.id.padEnd(slots.id), tag: fit(tag, 'tag'), ticks: fit(ticks, 'ticks'), pr, prTag: fit(prTag, 'prTag'), wait: fit(wait, 'wait'), who: fit(fullWho, 'who'),
        stale: fit(stale, 'stale'), late: fit(late, 'late'), ship: fit(ship, 'ship'), news: fit(news, 'news'), title, pad: room - lead - title.length - slotted, rows: 1,
      }
    }
    if (!isStacked) {
      // The title wraps at word boundaries, indented past the id; its last line is cut short if needed.
      const lines = wrap(item.title, Math.max(4, room - head)).slice(0, TITLE_LINES + 1)
      const kept = lines.slice(0, TITLE_LINES)
      if (lines.length > TITLE_LINES) kept[TITLE_LINES - 1] = cellOf(`${kept[TITLE_LINES - 1]} ${lines[TITLE_LINES]}`, room - head).trimEnd()
      // The details go on a line under the title, also indented past the id.
      const who = cutWho(Math.max(0, room - head - others + 1))
      const details = others + who.length - 1
      // Every line is padded out to the column's width, so the card is one solid block when highlighted.
      const across = Math.max(1, room - head)
      const fill = (text: string) => `${text}${'\u00a0'.repeat(Math.max(0, across - [...text].length))}`
      return {
        ...bits, title: kept.map(fill).join(`\n${'\u00a0'.repeat(head)}`), who, pad: 0, isSplit: details > 0,
        tail: details > 0 && details % across ? across - (details % across) : 0,
        rows: kept.length + (details > 0 ? Math.ceil(details / across) : 0),
      }
    }
    // When there is no room for the title beside its details, the line shows only the title.
    if (room - head - others < 6 && head + item.title.length + others + fullWho.length > room)
      return { tag: '', ticks: '', pr: undefined, prTag: '', wait: '', stale: '', late: '', ship: '', news: '', title: cutTitle(room - head), who: '', pad: 0, rows: 1 }
    if (head + item.title.length + others + fullWho.length <= room) {
      const pad = isStacked ? room - head - item.title.length - others - fullWho.length : 0
      return { ...bits, title: item.title, who: fullWho, pad, rows: 1 }
    }
    // A readable title matters most: a long name is cut short to make room for it.
    const who = cutWho(Math.max(0, Math.min(18, room - head - others - 24)))
    const title = cutTitle(room - head - others - who.length)
    return { ...bits, title, who, pad: Math.max(0, room - head - title.length - others - who.length), rows: 1 }
  }
  const card = (item: Item, room: number, isStacked: boolean, slots?: Slots) => {
    const laid = cardLayout(item, room, isStacked, slots)
    const { title, tag, ticks, pr, prTag, wait, who, stale, late, ship, news, pad } = laid
    const isSplit = 'isSplit' in laid && laid.isSplit
    const tail = 'tail' in laid ? laid.tail : 0
    const head = item.id.length + 1
    const id = 'id' in laid && laid.id ? laid.id : item.id
    // Under the pointer the button inverts, swapping each piece's colour and background. So on hover each piece
    // gets its own colour as its background and a faint grey as its colour, and the inverted card shows its
    // pieces in their colours on one faint block.
    const lit = (colour = 'text') => ({ color: LIT_CARD, backgroundColor: colour, dimColor: false })
    const isOpen = pick === item.id
    // On the details line under the title, the first detail drops its leading space.
    let isFirst = isSplit
    const detail = (text: string) => {
      if (!text || !isFirst) return text
      isFirst = false
      return text.slice(1)
    }
    return (
      // The card gets a keyed box of its own, which sets the area the hover applies to.
      <Box key={`card-box-${item.id}`}>
        <Button key={rowKey('card', item.id)} plain onPress={choose(item.id)}>
          <Text hover={lit('inactive')} dimColor={!isOpen} inverse={isOpen} bold={isOpen}>
            {id}
          </Text>
          <Text hover={lit()}> </Text>
          {/* Each line starts a Text of its own (a line break, then its indent): the inversion under the
              pointer applies only to a Text's first line, so this way every line is highlighted in full. */}
          {title.split('\n').map((line, n) => [
            ...(n ? [<Text key={`br-${n}`} hover={lit()}>{'\n'}</Text>, <Text key={`in-${n}`} hover={lit()}>{line.slice(0, head)}</Text>] : []),
            <Text key={`title-${n}`} hover={lit(isDropped(item) ? 'inactive' : undefined)} bold={isOpen} dimColor={isDropped(item)} strikethrough={isDropped(item)}>
              {n ? line.slice(head) : line}
            </Text>,
          ])}
          {isSplit ? [
            <Text key="br-details" hover={lit()}>{'\n'}</Text>,
            <Text key="in-details" hover={lit()}>{'\u00a0'.repeat(head)}</Text>,
          ] : <Text hover={lit()}>{' '.repeat(pad)}</Text>}
          <Text hover={lit(PRIORITY_COLOR[item.priority])} color={PRIORITY_COLOR[item.priority]} bold={item.priority === 'p0'}>
            {detail(tag)}
          </Text>
          <Text hover={lit('inactive')} dimColor>{detail(ticks)}</Text>
          <Text hover={lit(pr ? CHECKS_COLOR[pr.checks] ?? 'green' : undefined)} color={pr ? CHECKS_COLOR[pr.checks] ?? 'green' : undefined}>{detail(prTag)}</Text>
          <Text hover={lit('yellow')} color="yellow" dimColor>
            {detail(wait)}
          </Text>
          <Text hover={lit('cyan')} color="cyan">{detail(who)}</Text>
          <Text hover={lit('red')} color="red" dimColor>
            {detail(stale)}
          </Text>
          <Text hover={lit('red')} color="red">{detail(late)}</Text>
          <Text hover={lit(ship.trim() === 'unreleased' ? 'yellow' : 'green')} color={ship.trim() === 'unreleased' ? 'yellow' : 'green'} dimColor>
            {detail(ship)}
          </Text>
          <Text hover={lit('magenta')} color="magenta" bold>
            {detail(news)}
          </Text>
          {tail > 0 && <Text hover={lit()}>{'\u00a0'.repeat(tail)}</Text>}
        </Button>
      </Box>
    )
  }

  // What Undo would revert: the person's last change that hasn't been undone yet.
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
  // Inbox items that haven't been sorted yet.
  const waiting = (snap.inbox ?? []).filter(one => one.state === 'open')
  // Items that need the person's decision, each listed once with every reason: work in review (the same as
  // the Board's Review column), comments they haven't read, inactive claims (no update in a while), and work
  // past its date.
  const needs = items
    .map(item => {
      const why: string[] = []
      if ((item.kind === 'task' && item.status === 'review') || (item.kind !== 'task' && isAgent(item.assignee) && statusOf(items, item) === 'review')) why.push('review')
      const notRead = unread(snap, item.id, USER).length
      if (notRead) why.push(`${notRead} unread`)
      if (isStale(item, now)) why.push('inactive claim')
      if (isLate(items, item, now)) why.push('late')
      return { item, why }
    })
    .filter(one => one.why.length > 0)
  // The Inbox tab shows a count: its open items plus the items that need the person.
  const tabLabel = (view: View, label: string) => (view === 'inbox' && waiting.length + needs.length ? `${label} ${waiting.length + needs.length}` : label)
  const header = (
    <Box flexDirection="row" columnGap={3} flexWrap="wrap">
      <Box key="views" flexDirection="row" columnGap={2}>
        <Box key="tabs" flexDirection="row" columnGap={1}>
          {/* `v` steps to the next view. The hotkey is on a hidden Button, so the tabs show no key hint. */}
          <Box key="tab-next-key" display="none">
            <Button key="tab-next" plain hotkey="v" label={nextView} onPress={() => act.setView(nextView)} />
          </Box>
          {VIEWS.map(([one, label]) => (
            <Button key={`tab-${one}`} plain variant={mode === one ? 'primary' : 'secondary'} onPress={() => act.setView(one)}>
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
  // The items to sort, as a table: as room runs short, the least needed columns are dropped first.
  const inboxColumns = fitColumns([
    { key: 'id', label: 'ID', width: Math.max(2, ...waiting.map(one => one.id.length)), drop: 0 },
    { key: 'title', label: 'Title', width: 'fill', drop: 0, most: Math.max(5, ...waiting.map(one => one.title.length)) },
    { key: 'by', label: 'Filed by', width: Math.min(16, Math.max(8, ...waiting.map(one => one.author.length))), drop: 2 },
    { key: 'at', label: 'When', width: 10, drop: 1 },
  ], width - 2)
  const inboxView = (
    <Box flexDirection="column">
      {needs.length > 0 && (
        <Box key="needs" flexDirection="column" marginBottom={1}>
          <Text bold>Needs you  <Text dimColor>{needs.length}</Text></Text>
          {needs.map(({ item, why }) => {
            // The reasons in a column of their own, so the titles line up.
            const reasons = why.join(' · ').padEnd(Math.min(24, Math.max(...needs.map(one => one.why.join(' · ').length))))
            const room = Math.max(8, width - item.id.length - 1 - reasons.length - 2)
            return (
              <Button key={`need-${item.id}`} plain onPress={choose(item.id)}>
                <Text color={why.includes('late') ? 'red' : why.includes('review') ? 'blue' : 'magenta'}>{reasons}</Text>{'  '}
                <Text dimColor>{item.id}</Text> {item.title.length > room ? `${item.title.slice(0, room - 1)}…` : item.title}
              </Button>
            )
          })}
        </Box>
      )}
      {needs.length > 0 && waiting.length > 0 && <Text bold>To sort  <Text dimColor>{waiting.length}</Text></Text>}
      {waiting.length === 0 && <Text dimColor>Nothing filed to sort. Press i to file something for later.</Text>}
      {waiting.length > 0 && (
        <Text key="inbox-head" dimColor bold>{inboxColumns.map(one => cellOf(one.label, one.width)).join(' ')}</Text>
      )}
      {waiting.map(one => {
        const value: Record<string, string> = { id: one.id, title: one.title, by: one.author, at: one.at.slice(0, 10) }
        const asking = triaging?.id === one.id ? triaging.mode : null
        return (
          <Box key={`inbox-${one.id}`} flexDirection="column">
            <Text>
              {inboxColumns.map((column, i) => (
                <Text key={`c-${column.key}`} dimColor={column.key !== 'title'}>
                  {i ? ' ' : ''}
                  {cellOf(value[column.key] ?? '', column.width)}
                </Text>
              ))}
            </Text>
            {/* Sorting it: into a new task or epic (the form, its title filled in), into existing work, or dropped. */}
            {asking && Input ? (
              <Box key={`triage-row-${one.id}`} flexDirection="row" columnGap={1}>
                <Input key="triage-input" label={asking === 'into' ? 'Into' : "Drop, because"} autoFocus
                  placeholder={asking === 'into' ? "an id for a comment, or 'T12 checklist' for an entry" : 'why it won’t be done'}
                  submitLabel={asking === 'into' ? 'join' : 'drop'}
                  onSubmit={(value: string) => {
                    const text = value.trim()
                    const into = /^(\S+)(\s+checklist)?$/i.exec(text)
                    if (asking === 'into' && into)
                      act.userAct({ action: 'triage', id: one.id, into: into[1], ...(into[2] ? { fold: 'checklist' } : {}) })
                    else if (asking === 'drop' && text) act.userAct({ action: 'triage', id: one.id, wontdo: text })
                    act.setTriaging(null)
                  }} />
                <Button key="triage-cancel" label="Cancel" onPress={() => act.setTriaging(null)} />
              </Box>
            ) : (
              <Box key={`triage-${one.id}`} flexDirection="row" columnGap={1} flexWrap="wrap">
                <Button key={`to-task-${one.id}`} label="→ Task"
                  onPress={() => act.setDraft({ kind: 'task', priority: 'p2', type: 'feature', parent: '', from: one.id, title: one.title })} />
                <Button key={`to-epic-${one.id}`} label="→ Epic"
                  onPress={() => act.setDraft({ kind: 'epic', priority: 'p2', type: 'feature', parent: '', from: one.id, title: one.title })} />
                <Button key={`into-${one.id}`} label="Into…" onPress={() => act.setTriaging({ id: one.id, mode: 'into' })} />
                <Button key={`drop-${one.id}`} label="Drop…" onPress={() => act.setTriaging({ id: one.id, mode: 'drop' })} />
              </Box>
            )}
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

  // Releases: what the next release would include, then each version shipped, newest first. The newest is
  // expanded and older ones are collapsed.
  const shippedVersions = releasesOf(snap)
  const pendingNotes = unreleased(snap, known)
  const suggested = nextVersion(shippedVersions[0]?.version, pendingNotes)
  // A release under way: its PR open, or merged and waiting to be tagged and published.
  const releasePrs = known.prs.filter(pr => pr.branch.startsWith('release-v'))
  const openRelease = releasePrs.find(pr => pr.state === 'open')
  const toPublish = releasePrs.find(pr => pr.state === 'merged' && !shippedVersions.some(one => `release-v${one.version}` === pr.branch))
  const releaseLine = (text: string, key: string) => (
    <Text key={key} dimColor={!/^\s*- /.test(text)}>
      {text.length > width - 2 ? `${text.slice(0, width - 3)}…` : text || ' '}
    </Text>
  )
  const releaseColumns = fitColumns([
    { key: 'version', label: 'Version', width: Math.max(7, ...shippedVersions.map(one => one.version.length + 1)), drop: 0 },
    { key: 'at', label: 'Date', width: 10, drop: 3 },
    { key: 'tasks', label: 'Tasks', width: 5, drop: 2, align: 'right' },
    { key: 'pr', label: 'PR', width: 6, drop: 1 },
    { key: 'stable', label: '', width: 8, drop: 4 },
  ], width - 4)
  const releasesView = (
    <Box flexDirection="column">
      <Box key="unreleased-head" flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold>Unreleased</Text>
        <Text dimColor>{pendingNotes.length ? `${pendingNotes.length} note${pendingNotes.length === 1 ? '' : 's'} merged since the last release` : 'nothing merged since the last release'}</Text>
        {openRelease ? (
          <Text color="yellow">Release PR #{openRelease.number} is open; merge it, then Tag and publish</Text>
        ) : toPublish ? (
          <Button key="publish" label={`Tag and publish ${toPublish.branch.slice('release-'.length)}`} variant="primary"
            onPress={() => act.release(toPublish.branch.slice('release-v'.length), true)} />
        ) : (
          pendingNotes.length > 0 && !isReleasing && <Button key="release" label="Release…" onPress={() => act.setReleasing(true)} />
        )}
      </Box>
      {isReleasing && Input && (
        <Box key="release-row" flexDirection="row" columnGap={1}>
          <Input key="release-version" label="Version" value={suggested} autoFocus submitLabel="open its PR"
            onSubmit={(value: string) => (value.trim() ? act.release(value.trim(), false) : act.setReleasing(false))} />
          <Button key="release-cancel" label="Cancel" onPress={() => act.setReleasing(false)} />
        </Box>
      )}
      {SECTIONS.map(section => {
        const some = pendingNotes.filter(task => sectionFor(task) === section)
        return some.length ? (
          <Box key={`pending-${section}`} flexDirection="column">
            <Text dimColor>{section}</Text>
            {some.map(task => releaseLine(`- ${task.note} (${task.id})`, `pending-${task.id}`))}
          </Box>
        ) : null
      })}
      {shippedVersions.length > 0 && (
        <Text key="releases-head" dimColor bold>{`\u00a0\u00a0${releaseColumns.map(one => cellOf(one.label, one.width, one.align)).join(' ')}`}</Text>
      )}
      {shippedVersions.length === 0 && <Text dimColor>No releases yet. Running ship records each release; older ones come from CHANGELOG.md.</Text>}
      {shippedVersions.map((one, i) => {
        const key = `v${one.version}`
        const isOpen = (i === 0) !== flipped.includes(key)
        return (
          <Box key={`release-${one.version}`} flexDirection="column">
            <Button key={`fold-${key}`} plain onPress={() => act.toggleFold(key)}>
              <Text dimColor>{isOpen ? '▾' : '▸'}</Text>{' '}
              {releaseColumns.map((column, n) => {
                const value: Record<string, string> = {
                  version: `v${one.version}`, at: one.at ?? '', tasks: one.tasks.length ? String(one.tasks.length) : '',
                  pr: one.pr ? `#${one.pr}` : '', stable: known.stable === one.version ? 'stable ●' : '',
                }
                return (
                  <Text key={`c-${column.key}`} bold={column.key === 'version'} color={column.key === 'stable' ? 'green' : undefined}
                    dimColor={column.key !== 'version' && column.key !== 'stable'}>
                    {n ? ' ' : ''}
                    {cellOf(value[column.key] ?? '', column.width, column.align)}
                  </Text>
                )
              })}
            </Button>
            {isOpen && one.notes.split('\n').filter(text => text.trim()).map((text, n) => releaseLine(`  ${text.replace(/^### /, '')}`, `${key}-${n}`))}
          </Box>
        )
      })}
    </Box>
  )

  const tasks = items.filter(item => item.kind === 'task' && isShown(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  // A milestone or epic handed over whole is reviewed as one unit: it stays in Review, and its card's buttons approve and merge it.
  const scopes = items.filter(item => item.kind !== 'task' && isAgent(item.assignee) && statusOf(items, item) === 'review' && isShown(item))
  const columns = Object.fromEntries(STATUSES.map(status =>
    [status, [...(status === 'review' ? scopes : []), ...tasks.filter(task => task.status === status)]])) as Record<Status, Item[]>
  // Side by side, an empty column takes its heading's width and the columns with cards share the rest.
  // A heading is drawn with its jump key: "t: ○ Todo 0".
  const headOf = (status: Status) => `${HOTKEY[status]}: ${GLYPH[status]} ${LABEL[status]} ${columns[status].length}`
  const widths = columnWidths(
    Object.fromEntries(STATUSES.map(status => [status, columns[status].length > 0 ? 0 : headOf(status).length + FRAME])) as Record<Status, number>,
    width, COLUMN_GAP)
  // Side by side, each column is framed: its border and padding take FRAME of its width.
  const roomOf = (status: Status) => (isWide ? widths[status] - FRAME : width - 2)
  // Docked, the board fits the rows above the card; side by side, each heading has a rule under it.
  // Done shows the recent cards (the last week's, at least a few) unless expanded; one press shows the rest.
  const recentDone = columns.done.filter(task => now - Date.parse(task.updated_at) < RECENT_DAYS * 86_400_000).length
  const doneClosed = Math.min(columns.done.length, Math.max(DONE_MIN, Math.min(recentDone, DONE_MAX)))
  const doneShown = isDoneOpen ? columns.done.length : doneClosed
  // Each card's rows; side by side and short of rows, on one line each (`isOneLine`).
  const heightsOf = (isOneLine: boolean) => Object.fromEntries(STATUSES.map(status =>
    [status, columns[status].slice(0, status === 'done' ? doneShown : undefined)
      .map(task => cardLayout(task, roomOf(status), !isWide || isOneLine).rows)
      // Done cut to its recent cards still needs room for its "…N older" row: an entry too tall to fit is added in its place.
      .concat(status === 'done' && columns.done.length > doneShown ? [Infinity] : [])])) as Record<Status, number[]>
  const heights = heightsOf(false)
  // Docked, the board fits the rows above the card; an expanded Done column fills the pane's rows. Side by
  // side, each heading has a rule under it; stacked, the blocks have a blank row between them.
  const budget = !isDocked && isDoneOpen && bodyRows ? bodyRows - BOARD_CHROME - (isWide ? 0 : STATUSES.length) : Infinity
  const caps = budget !== Infinity
    ? columnCaps(heights, isWide ? budget - 3 : budget, isWide)
    : (Object.fromEntries(STATUSES.map(status => [status, status === 'done' ? doneShown : canScroll ? Infinity : 15])) as Record<Status, number>)
  // Stacked, the empty columns share one line, and every card's pieces go in slots of one width across the board.
  const empties = isWide ? [] : STATUSES.filter(status => columns[status].length === 0)
  const stackSlots = isWide ? undefined : slotsOf(STATUSES.flatMap(status => columns[status].slice(0, caps[status])))
  const heading = (status: Status) => (
    <Button key={`col-${status}-head`} plain hotkey={HOTKEY[status]}
      onPress={() => columns[status][0] && act.focus(rowKey('card', columns[status][0]!.id))}>
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
  // Side by side, the card the open card's column starts from so the open card is visible; the wheel scrolls on from there.
  let revealedFrom: number | null = null
  // Drawn once the room it has is known (see viewSpace).
  const drawBoard = () => (
    <Box flexDirection={isWide ? 'row' : 'column'} gap={isWide ? COLUMN_GAP : isDocked ? 0 : 1}>
      {empties.length > 0 && (
        <Box key="col-empty" flexDirection="row" columnGap={1} flexWrap="wrap">
          {empties.flatMap((status, i) => [...(i ? [<Text key={`col-empty-${i}`} dimColor>·</Text>] : []), heading(status)])}
        </Box>
      )}
      {STATUSES.filter(status => !empties.includes(status)).map(status => {
        const column = columns[status]
        // When a docked card has just opened, its column shows it, even in Done past the recent cards.
        const at = isDocked && state.isRevealing && pick ? column.findIndex(task => task.id === pick) : -1
        const capped = column.slice(0, Math.max(caps[status], at + 1))
        // Side by side and scrolling, each column shows the cards from the scrolled-to one that fit.
        let from = isWide && canScroll ? Math.min(wideFrom, lastFrom(status, capped.length)) : 0
        if (isWide && canScroll && at >= 0) {
          if (at < from) from = at
          while (from < at && at >= from + cardsFrom(status, from)) from++
          revealedFrom = from
        }
        const shown = isWide && canScroll ? capped.slice(from, from + cardsFrom(status, from)) : capped
        return (
          <Box key={`col-${status}`} flexDirection="column" width={isWide ? widths[status] : undefined}
            // Side by side and scrolling, every column's frame extends to the bottom of the list.
            height={isWide && canScroll && viewSpace !== Infinity ? viewSpace : undefined}
            {...(isWide ? { borderStyle: 'round', borderColor: COLOR[status], borderDimColor: true, paddingX: 1, hover: { borderDimColor: false } } : {})}>
            {status === 'done' && doneToggle ? (
              <Box key="col-done-top" flexDirection="row" columnGap={1}>
                {heading(status)}
                {doneToggle}
              </Box>
            ) : heading(status)}
            {from > 0 && <Text key={`col-${status}-above`} dimColor>↑ {from} above</Text>}
            {shown.map(task => card(task, roomOf(status), !isWide || isOneLine, stackSlots))}
            {column.length > from + shown.length && (
              <Text dimColor>
                …{column.length - from - shown.length} {status === 'done' && !isDoneOpen ? 'older' : 'more'}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )


  // A finished milestone or epic is collapsed to its own line and an open one is expanded, until the person
  // presses its toggle. With a filter typed, nothing is collapsed, so every match shows.
  const hasKids = (item: Item) => item.kind !== 'task' && childrenOf(items, item.id).length > 0
  // The milestone and epic above the open card stay expanded, so the card's row is always visible.
  const holdsPick = new Set<string>()
  for (let at = upOf(find(items, pick ?? undefined) ?? EMPTY); at; at = upOf(find(items, at) ?? EMPTY)) holdsPick.add(at)
  const isFolded = (item: Item) =>
    !query && hasKids(item) && !holdsPick.has(item.id) && (statusOf(items, item) === 'done') !== flipped.includes(item.id)
  // The timeline shows epics under milestones, not tasks, so there only a milestone with epics can collapse.
  const foldsInTimeline = (item: Item) => item.kind === 'milestone' && childrenOf(items, item.id).some(one => one.kind === 'epic')
  const foldToggle = (item: Item, canFold = hasKids(item)) =>
    canFold ? (
      <Button key={`fold-${item.id}`} plain onPress={() => act.toggleFold(item.id)}>
        <Text dimColor>{isFolded(item) ? '▸' : '▾'}</Text>
      </Button>
    ) : (
      <Text key={`fold-${item.id}`}> </Text>
    )
  // Handing several tasks out at once needs the person to confirm. The question names the tasks and which
  // of them are blocked by unfinished work.
  const confirmParallel = (ids: string[], key: string) => {
    const waits = ids.filter(id => { const one = find(items, id); return one && waitingOn(items, one).length > 0 })
    return (
      <Box key={key} flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text color="yellow">
          Run {ids.join(', ')} at once, each by its own agent in its own worktree?{waits.length ? ` ${waits.join(', ')} ${waits.length === 1 ? 'starts once its' : 'start once their'} blockers are done.` : ''}
        </Text>
        <Button key="parallel-yes" label="Yes, start them" onPress={() => act.runParallel(ids)} />
        <Button key="parallel-cancel" label="Cancel" onPress={() => act.askParallel(null)} />
      </Box>
    )
  }

  // The plan: milestones (by date, open first) with what targets them, then Unplanned: epics and tasks not
  // under any milestone. There, a task nobody has claimed yet gets the backlog's controls: a checkbox for
  // running several at once, a priority picker and a → Claude button.
  // Finished tasks not under any epic or milestone are collapsed into one line at the bottom of Unplanned,
  // as finished epics are. They expand with its toggle (or with a filter, or when a card is open on one of them).
  const LOOSE = '_loose'
  const isLooseDone = ({ item, depth }: { item: Item; depth: number }) => depth === 0 && item.kind === 'task' && item.status === 'done' && item.id !== pick
  const showsLoose = Boolean(query) || flipped.includes(LOOSE)
  const everyRow = treeRowsOf(items, isFolded).filter(({ item }) => !query || subtree(items, item.id).some(id => isShown(find(items, id)!)))
  const looseDone = everyRow.filter(isLooseDone)
  const allRows = showsLoose ? everyRow : everyRow.filter(row => !isLooseDone(row))
  // Merged work the next release would ship.
  const waitingRelease = new Set(unreleased(snap, known).map(one => one.id))
  const firstUnplanned = allRows.findIndex(({ item, depth }) => depth === 0 && item.kind !== 'milestone')
  const isTriage = (item: Item) => item.kind === 'task' && item.status === 'todo' && !item.assignee && !targetOf(items, item)
  const unheld = allRows.filter(({ item }) => isTriage(item)).length
  // The plan's rows: scrolled in the tab's window (docked over a card, in the list's frame).
  const treeShown = allRows
  // The plan as a table: a collapse toggle and (in Unplanned) a checkbox in columns of their own, then the
  // item's columns, the least needed dropped first as room runs short. A task nobody has claimed gets a
  // priority picker and a → Claude button after its row.
  // What an item shows in a column of the plan's table.
  const planValue = (item: Item, key: string) => {
    const p = progress(items, item)
    const release = item.kind === 'task' ? releaseOf(snap, item.id) : undefined
    const list = item.checklist ?? []
    if (key === 'news') return badge(item).trim()
    if (key === 'ship') return release ? `v${release.version}` : waitingRelease.has(item.id) ? 'unreleased' : ''
    if (key === 'due') return item.due ?? ''
    if (key === 'type') return item.kind === 'task' ? item.type : item.kind
    if (key === 'done') return item.kind !== 'task' ? (p.total ? `${p.done}/${p.total}` : '') : list.length ? `${list.filter(c => c.done).length}/${list.length}` : ''
    if (key === 'who') return item.assignee ? `@${item.assignee}` : ''
    if (key === 'pri') return item.kind === 'task' ? item.priority : ''
    return ''
  }
  const hasTriage = allRows.some(({ item }) => isTriage(item))
  const TRIAGE_TAIL = hasTriage ? 1 + 6 + 1 + 12 : 0
  const idWidth = 2 + Math.max(2, ...allRows.map(({ item }) => item.id.length))
  const planColumns = fitColumns([
    { key: 'id', label: 'ID', width: idWidth, drop: 0 },
    { key: 'title', label: 'Title', width: 'fill', drop: 0, most: Math.max(5, ...allRows.map(({ item, depth }) => depth * 2 + item.title.length)) },
    { key: 'news', label: '', width: 3, drop: 8 },
    { key: 'ship', label: 'Release', width: 10, drop: 4 },
    { key: 'due', label: 'Due', width: 10, drop: 6 },
    { key: 'type', label: 'Type', width: 9, drop: 7 },
    { key: 'done', label: 'Done', width: 5, drop: 3, align: 'right' },
    { key: 'who', label: 'Assignee', width: Math.min(14, Math.max(8, ...allRows.map(({ item }) => (item.assignee ?? '').length + 1))), drop: 5 },
    { key: 'pri', label: 'Pri', width: 3, drop: 2 },
  ].filter(one => one.drop === 0 || allRows.some(({ item }) => planValue(item, one.key))) as TableColumn[], width - 2 - (hasTriage ? 2 : 0) - TRIAGE_TAIL)
  const planHead = (
    <Text key="plan-head" dimColor bold>
      {'\u00a0\u00a0'}
      {hasTriage ? '\u00a0\u00a0' : ''}
      {planColumns.map(one => cellOf(one.label, one.width, one.align)).join(' ')}
    </Text>
  )
  const planRow = ({ item, depth }: { item: Item; depth: number }) => {
    const status = statusOf(items, item)
    const controls = isTriage(item)
    const color: Record<string, string | undefined> = { ship: waitingRelease.has(item.id) ? 'yellow' : 'green', who: 'cyan', news: 'magenta', pri: PRIORITY_COLOR[item.priority] }
    const row = (
      <Box key={`tree-${item.id}`} flexDirection="row" columnGap={1}>
        {foldToggle(item)}
        {hasTriage && (controls ? (
          <Button key={`pick-${item.id}`} plain
            onPress={() => act.setPicked(picked.includes(item.id) ? picked.filter(id => id !== item.id) : [...picked, item.id])}>
            <Text color={picked.includes(item.id) ? 'green' : undefined}>{picked.includes(item.id) ? '☑' : '☐'}</Text>
          </Button>
        ) : <Text key={`pick-${item.id}`}> </Text>)}
        <Button key={rowKey('row', item.id)} plain onPress={choose(item.id)}>
          {planColumns.map((one, i) => {
            const gap = i ? ' ' : ''
            if (one.key === 'id')
              return (
                <Text key={`c-${one.key}`}>
                  {isDropped(item) ? <Text dimColor>{WONTDO_GLYPH}</Text> : <Text color={COLOR[status]}>{GLYPH[status]}</Text>}{' '}
                  <Text dimColor>{cellOf(item.id, one.width - 2)}</Text>
                </Text>
              )
            if (one.key === 'title')
              return (
                <Text key={`c-${one.key}`} bold={item.kind === 'milestone'} dimColor={isDropped(item)} strikethrough={isDropped(item)}>
                  {gap}
                  {cellOf(`${'\u00a0\u00a0'.repeat(depth)}${item.title}`, one.width)}
                </Text>
              )
            return (
              <Text key={`c-${one.key}`} color={color[one.key]} dimColor={!color[one.key] || one.key === 'ship'} bold={one.key === 'news'}>
                {gap}
                {cellOf(planValue(item, one.key), one.width, one.align)}
              </Text>
            )
          })}
        </Button>
        {controls && (Select ? (
          <Select key={`prio-${item.id}`} options={PRIORITIES.map(one => ({ value: one }))} value={item.priority}
            onSelect={(value: string) => act.userAct({ action: 'update', id: item.id, priority: value })} />
        ) : (
          <Text key={`prio-${item.id}`} color={PRIORITY_COLOR[item.priority]}>{item.priority}</Text>
        ))}
        {controls && <Button key={`hand-${item.id}`} label="→ Claude" onPress={() => act.askHand(item.id)} />}
      </Box>
    )
    return handing === item.id ? (
      <Box key={`tree-wrap-${item.id}`} flexDirection="column">
        {row}
        {confirmHand(item)}
      </Box>
    ) : row
  }

  const tree = (
    <Box flexDirection="column">
      {allRows.length === 0 && <Text dimColor>Nothing planned yet. Press n to add a milestone, an epic or a task.</Text>}
      {allRows.length > 0 && planHead}
      {treeShown.map((one, i) => {
        const isHead = allRows.indexOf(one) === firstUnplanned
        return isHead ? (
          <Box key={`unplanned-${one.item.id}`} flexDirection="column">
            <Box key="unplanned-head" flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text bold dimColor>
                Unplanned{unheld ? `  ${unheld} for anyone to take` : ''}
              </Text>
              {/* Picked rows run at once, each with its own agent, worktree and branch. */}
              {picked.length > 0 && !(parallelAsk && !pick) && (
                <Button key="run-picked" label={`Run ${picked.length} at once…`} variant="primary" onPress={() => act.askParallel(picked)} />
              )}
              {picked.length > 0 && !(parallelAsk && !pick) && <Button key="unpick" label="Clear picks" onPress={() => act.setPicked([])} />}
            </Box>
            {picked.length > 0 && parallelAsk && !pick && confirmParallel(parallelAsk, 'parallel-confirm')}
            {planRow(one)}
          </Box>
        ) : (
          planRow(one)
        )
      })}
      {treeShown.length < allRows.length && <Text key="tree-more" dimColor>…{allRows.length - treeShown.length} more rows (close the card to see them all)</Text>}
      {looseDone.length > 0 && !query && treeShown.length === allRows.length && (
        <Button key="fold-loose" plain onPress={() => act.toggleFold(LOOSE)}>
          <Text dimColor>
            {showsLoose ? '▾' : '▸'} {looseDone.length} finished task{looseDone.length === 1 ? '' : 's'} in no epic
          </Text>
        </Button>
      )}
    </Box>
  )

  // The timeline: milestones and epics by due date, each with its progress and whether it is on track for its date.
  const today = now > 0 ? dateOf(now) : undefined
  const timelineAll = timelineRows(items, isFolded).filter(({ item }) => !query || subtree(items, item.id).some(id => isShown(find(items, id)!)))
  const timelineShown = timelineAll
  const BAR = 10
  // The timeline is laid out in columns: the name, the date (a dim dash for none), the bar and its count,
  // then whether it is on track for its date.
  const countWidth = Math.max(0, ...timelineAll.map(({ item }) => { const p = progress(items, item); return `${p.done}/${p.total}`.length }))
  const right = 2 + 10 + 2 + BAR + 1 + countWidth
  // Whether each is on track for its date. This column gets its room first (up to a limit), and the names
  // take the rest.
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
  // The roadmap on a time axis, in a pane wide enough for one: a label column, then each milestone as a
  // marker on its date and each epic as a bar from its start to its end, filled as far as its tasks are
  // done; a line for today; late work in red. Work without dates is listed under it. A narrow pane shows
  // the list (timelineView) below instead.
  const isAxis = width >= 100
  const DAY = 86_400_000
  const ZOOMS = [0, 120, 45] as const
  const dayOf = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY)
  const todayDay = now > 0 ? Math.floor(now / DAY) : undefined
  // An epic without a due date is still drawn: up to when it finished (its last task's change), or, if it
  // is still in progress, up to today with an open end (▸). A milestone without one is shown when any of its
  // epics is.
  const todayDate = now > 0 ? dateOf(now) : undefined
  const spans = new Map(timelineAll.map(({ item }) => {
    const span = spanOf(snap, item)
    if (span.end || item.kind !== 'epic') return [item.id, { ...span, isOpenEnded: false }]
    const isDone = statusOf(items, item) === 'done'
    const finished = tasksIn(items, item).map(one => one.updated_at.slice(0, 10)).sort().at(-1)
    const end = isDone ? finished : todayDate
    return [item.id, { ...span, end: end && end < span.start ? span.start : end, isOpenEnded: !isDone && Boolean(end) }]
  }))
  const isPlaced = (item: Item) => spans.get(item.id)!.end !== undefined || (item.kind === 'milestone' && Boolean(item.due))
  const dated = timelineAll.filter(({ item }) => isPlaced(item) ||
    (item.kind === 'milestone' && timelineAll.some(({ item: one }) => upOf(one) === item.id && isPlaced(one))))
  const undated = timelineAll.filter(row => !dated.includes(row))
  const days = [
    ...dated.flatMap(({ item }) => { const one = spans.get(item.id)!; return [dayOf(one.start), ...(one.end ? [dayOf(one.end)] : [])] }),
    // The releases too, so each has its place on the axis.
    ...(dated.length ? shippedVersions.filter(one => one.at).map(one => dayOf(one.at)) : []),
  ]
  // With nothing dated, the axis spans just today (not drawn); with no clock either, it spans day 0.
  const fitFrom = days.length || todayDay !== undefined ? Math.min(...days, todayDay ?? Infinity) : 0
  const fitTo = days.length || todayDay !== undefined ? Math.max(...days, todayDay ?? -Infinity) : 0
  const zoomDays = ZOOMS[zoom % ZOOMS.length]!
  // Zoomed in, the window centres on today; at fit it spans all the dated work (and today), a little padded.
  const [from, to] = zoomDays && todayDay !== undefined
    ? [todayDay - Math.floor(zoomDays / 3), todayDay + zoomDays - Math.floor(zoomDays / 3)]
    : [fitFrom - 2, Math.max(fitTo + 2, fitFrom + 14)]
  const labelWidth = Math.min(34, Math.max(18, Math.floor(width * 0.3)))
  const chart = Math.max(10, width - labelWidth - 1)
  const colOf = (day: number) => Math.round(((day - from) / Math.max(1, to - from)) * (chart - 1))
  const inChart = (col: number) => col >= 0 && col < chart
  // Ticks: weeks when they're far enough apart to label, else months.
  const isWeekly = chart / Math.max(1, (to - from) / 7) >= 7
  const ticks: { col: number; label: string }[] = []
  // At most ten years of days are checked, whatever dates were typed.
  for (let d = from; d <= Math.min(to, from + 3660); d++) {
    const date = new Date(d * DAY)
    const isTick = isWeekly ? date.getUTCDay() === 1 : date.getUTCDate() === 1
    if (isTick) ticks.push({ col: colOf(d), label: isWeekly ? date.toISOString().slice(5, 10) : date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }) })
  }
  const scale = Array<string>(chart).fill(' ')
  let last = -2
  for (const tick of ticks) {
    if (tick.col <= last + 1 || tick.col + tick.label.length > chart) continue
    for (const [i, ch] of [...tick.label].entries()) scale[tick.col + i] = ch
    last = tick.col + tick.label.length
  }
  const todayCol = todayDay === undefined ? -1 : colOf(todayDay)
  type Cell = { ch: string; color?: string; isDim?: boolean }
  /** A row of the chart: the today line, then a milestone's marker or an epic's bar over it. */
  const chartCells = (item: Item): Cell[] => {
    const cells: Cell[] = Array.from({ length: chart }, (_, col) => (col === todayCol ? { ch: '│', color: 'yellow', isDim: true } : { ch: ' ' }))
    const span = spans.get(item.id)!
    const st = statusOf(items, item)
    const late = isLate(items, item, now)
    if (item.kind === 'milestone') {
      if (!item.due) return cells
      const col = colOf(dayOf(item.due))
      if (inChart(col)) cells[col] = { ch: '◆', color: late ? 'red' : st === 'done' ? 'green' : 'blue' }
      return cells
    }
    if (!span.end) return cells
    // A start after the end (work begun past its date) draws from the end: the bar is at least its last day.
    const a = Math.max(0, colOf(Math.min(dayOf(span.start), dayOf(span.end))))
    const b = Math.min(chart - 1, colOf(dayOf(span.end)))
    const p = progress(items, item)
    const filled = p.total ? Math.round(((b - a + 1) * p.done) / p.total) : 0
    for (let col = a; col <= b; col++)
      cells[col] = col - a < filled ? { ch: '█', color: late ? 'red' : 'green' } : { ch: '░', color: late ? 'red' : undefined, isDim: !late }
    // Still in progress with no end date: its bar runs to today and ends in an open-end marker.
    if (span.isOpenEnded && inChart(b + 1)) cells[b + 1] = { ch: '▸', isDim: true }
    return cells
  }
  /** Cells drawn as runs of one style each. */
  const runs = (cells: Cell[], key: string) => {
    const out: { text: string; cell: Cell }[] = []
    for (const cell of cells) {
      const prev = out.at(-1)
      if (prev && prev.cell.color === cell.color && prev.cell.isDim === cell.isDim) prev.text += cell.ch
      else out.push({ text: cell.ch, cell })
    }
    return out.map((run, i) => (
      <Text key={`${key}-${i}`} color={run.cell.color} dimColor={run.cell.isDim}>
        {run.text}
      </Text>
    ))
  }
  const axisLabel = (item: Item, depth: number) => {
    // Indented with no-break spaces: a line's leading spaces are trimmed, and the bars must line up.
    const text = `${'\u00a0\u00a0'.repeat(depth)}${item.id} ${item.title}`
    return text.length > labelWidth - 1 ? `${text.slice(0, labelWidth - 2)}…` : text.padEnd(labelWidth - 1)
  }
  const axisRows = dated
  // Releases as ticks on the axis at their dates, labelled with their versions. Several on one day (or too
  // close to label separately) share one tick, labelled with the newest version and how many more there are.
  const releaseTicks: { col: number; end: number; version: string; label: string }[] = []
  for (const one of [...shippedVersions].reverse()) {
    if (!one.at) continue
    const col = colOf(dayOf(one.at))
    if (!inChart(col)) continue
    const prev = releaseTicks.at(-1)
    if (prev && col <= prev.end) {
      const more = Number(/\+(\d+)$/.exec(prev.label)?.[1] ?? 0) + 1
      prev.version = one.version
      prev.label = `${one.version} +${more}`
      prev.end = prev.col + 1 + prev.label.length
      continue
    }
    const label = one.version
    releaseTicks.push({ col, end: col + 1 + label.length, version: one.version, label })
  }
  // A label that would go past the chart's edge is dropped, leaving only its tick.
  for (const tick of releaseTicks) if (tick.end > chart) (tick.label = ''), (tick.end = tick.col + 1)
  const axisView = (
    <Box flexDirection="column">
      {timelineAll.length === 0 && <Text dimColor>No milestones or epics yet.</Text>}
      {dated.length > 0 && (
        <Box key="axis-head" flexDirection="row" columnGap={1}>
          <Button key="zoom" plain hotkey="w" onPress={() => act.setZoom(zoom + 1)}>
            <Text dimColor>{(zoomDays ? `zoom ${zoomDays}d` : 'zoom: all').padEnd(labelWidth - 4)}</Text>
          </Button>
          <Text dimColor>{scale.join('')}</Text>
        </Box>
      )}
      {releaseTicks.length > 0 && (
        <Box key="axis-releases" flexDirection="row">
          <Text dimColor>{'Releases'.padEnd(labelWidth - 1).replace(/ /g, '\u00a0')}{'\u00a0'}</Text>
          {releaseTicks.flatMap((tick, i) => [
            // No-break spaces keep each tick at its date's column, since plain spaces would be collapsed.
            <Text key={`tick-gap-${i}`}>{'\u00a0'.repeat(Math.max(0, tick.col - (i ? releaseTicks[i - 1]!.end : 0)))}</Text>,
            <Button key={`release-tick-${tick.version}`} plain onPress={() => act.showRelease(tick.version)}>
              <Text color="green">▲{tick.label}</Text>
            </Button>,
          ])}
        </Box>
      )}
      {axisRows.map(({ item, depth }) => (
        <Button key={rowKey('time', item.id)} plain onPress={choose(item.id)}>
          <Text bold={item.kind === 'milestone'} color={item.kind === 'milestone' ? undefined : undefined} dimColor={statusOf(items, item) === 'done'}>
            {axisLabel(item, depth)}
          </Text>{' '}
          {runs(chartCells(item), `cells-${item.id}`)}
        </Button>
      ))}
      {axisRows.length < dated.length && <Text key="axis-more" dimColor>…{dated.length - axisRows.length} more (close the card to see them all)</Text>}
      {undated.length > 0 && (
        <Box key="undated" flexDirection="column">
          <Text dimColor>No dates yet: {undated.map(({ item }) => item.id).join(', ')}</Text>
        </Box>
      )}
    </Box>
  )

  const timelineView = (
    <Box flexDirection="column">
      {timelineAll.length === 0 && <Text dimColor>No milestones or epics yet.</Text>}
      {timelineAll.length > 0 && (
        <Text key="timeline-head" dimColor bold>
          {`\u00a0\u00a0${'Name'.padEnd(nameWidth - 2)}  ${'Due'.padEnd(10)}  ${'Progress'.padEnd(BAR + 1 + countWidth)}`}
          {width - nameWidth - right - 2 > 4 ? '  Standing' : ''}
        </Text>
      )}
      {timelineShown.map(({ item: one, depth }) => {
        const p = progress(items, one)
        const st = statusOf(items, one)
        const filled = p.total ? Math.round((p.done / p.total) * BAR) : 0
        const late = isLate(items, one, now)
        const when = standing(one)
        const lead = depth * 2 + 2 + 2 + one.id.length + 1
        const title = one.title.length + lead > nameWidth ? `${one.title.slice(0, Math.max(4, nameWidth - lead - 1))}…` : one.title
        const pad = ' '.repeat(Math.max(0, nameWidth - lead - title.length))
        // An epic without its own date uses its milestone's, so its date is left blank.
        const date = one.due ?? (depth > 0 ? '' : '-')
        // Room left on the line for whether it is on track, which is cut rather than wrapped.
        const whenRoom = width - nameWidth - right - 2
        const said = when && whenRoom > 4 ? (when.length > whenRoom ? `${when.slice(0, whenRoom - 1)}…` : when) : ''
        return (
          <Box key={`timeline-${one.id}`} flexDirection="row" columnGap={1} marginLeft={depth * 2}>
            {foldToggle(one, foldsInTimeline(one))}
            <Button key={rowKey('time', one.id)} plain onPress={choose(one.id)}>
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
  const inner = paneWidth - 4
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
        ? { key: 'edit-desc-long', rows: 1, node: <Text key="edit-desc-long" dimColor>Description has several lines: ask Claude to change it.</Text> }
        : field('edit-desc', 'Description', item.description ?? '', v => save({ description: v }), 'one line; empty clears it'),
      ...(item.kind === 'task' ? [] : [field('edit-start', 'Start', item.start ?? '', v => save({ start: v }), 'YYYY-MM-DD; empty: from its work')]),
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
        return { key: `waits-${id}`, rows: tall(`blocked by ${id} ${before?.title ?? ''}`, 2), node: (
          <Text key={`waits-${id}`}>
            <Text dimColor>blocked by </Text>
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
              {/* When the item is assigned to an agent: whether the agent gets the comment now or with the person's next prompt. */}
              {isAgent(item.assignee) && (
                <Button key="comment-turns" label={commentTurns ? 'Tells it now' : 'With your next prompt'}
                  variant={commentTurns ? 'primary' : 'secondary'} onPress={() => act.setCommentTurns(!commentTurns)} />
              )}
            </Box>
          ) }]
        : []),
      // Comments and handoff notes are drawn as messages, author above body; changes the tracker made are drawn as one dim line.
      ...timeline(snap.activity, item.id)
        .slice(-6)
        .map(one => {
          const when = one.at.slice(5, 16).replace('T', ' ')
          const who = <Text color={one.author === USER ? 'magenta' : 'cyan'}>{one.author}</Text>
          // A change that hasn't been undone can be undone from its line; an undo can be redone the same way.
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
  // On the terminal the pane does its own scrolling: it shows what fits under the fixed rows, with a mark for what is above or below.
  // Docked, the board's rows above the card count among the fixed ones.
  // Fixed rows: tabs, the panel's two borders, title, two bar rows (more as they wrap), the info line, the
  // footer, and the ↓ mark. The ↑ mark takes a content row only once the card is scrolled.
  const tagLine = item?.labels?.length ? item.labels.map(one => `#${one}`).join(' ') : ''
  // Its release status: shipped in a version, or merged and not released yet.
  const shipped = item ? shipNote(snap, item, known) : undefined
  const meta = item ? [item.assignee ? `@${item.assignee}` : 'unassigned', item.kind === 'task' ? `${item.priority} ${item.type}` : '', tagLine, item.due ? `due ${item.due}` : '', where ? `in ${where}` : ''].filter(Boolean).join(' · ') : ''
  // The title, beside the ✕ that closes the card.
  const titleRows = tall(`${item?.title ?? ''}${isCompact ? `  ${meta}` : ''}`, item ? item.kind.length + item.id.length + 2 + 2 : 0)
  // Tabs (hidden inline), the panel's borders, title, bar, info line (shown on the title line inline), footer, ↓ mark.
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
  ].filter(one => one > 0), paneWidth, 3)
  // Approve on what is itself up for review: a task, or a milestone or epic handed over whole; not on
  // one whose status is review only because part of it is.
  const isReview = status === 'review' && (item?.kind === 'task' || isAgent(item?.assignee))
  // Work in review needs the person, not Claude: its card offers Approve and Request changes instead.
  const isHandable = status !== 'done' && status !== 'review'
  // A milestone's or epic's tasks that could run at once: in todo and not assigned yet.
  const openUnder = item && item.kind !== 'task'
    ? tasksIn(items, item).filter(one => one.status === 'todo' && !one.assignee).map(one => one.id)
    : []
  // The pull request the item under review ships in, which Approve can merge.
  const reviewPr = isReview && item ? openPrOf(known, item) : undefined
  // The card's pull request, shown under the bar with the buttons that act on it; and the one it is stacked on.
  const cardPr = item ? openPrOf(known, item) : undefined
  const under = cardPr && stackedOn(known, cardPr)
  // From the bottom PR of a stack, the person can merge the whole stack.
  const stack = cardPr ? stackFrom(known, cardPr) : []
  const isStack = stack.length > 1
  // From a PR stacked on another, the person can merge the PRs below it and then this one, in order.
  const down = cardPr && under ? stackBelow(known, cardPr) : []
  const DOWN = `down:${item?.id ?? ''}`
  const prText = cardPr
    ? `PR #${cardPr.number} [open] ${CHECKS[cardPr.checks]} ${cardPr.branch} → ${cardPr.base || '?'}${under ? `  [ stacked on #${under.number}: merge ${down.slice(0, -1).map(pr => `#${pr.number}`).join(', ')}, then this ]` : ''}${isStack ? `  stack ${stackText(stack)} [ Merge the stack ]` : ''}${stackRun ? `  ${stackRun}` : ''}`
    : ''
  const prRows = cardPr ? tall(prText) : 0
  const barRows = !item
    ? 0
    : (item.kind === 'task' ? buttonRows([...STATUSES.map(one => (item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one])), `${WONTDO_GLYPH} Won't do`]) : 1) +
      (isRequesting || handing === item.id || merging === item.id || noting === item.id || dropping === item.id || stacking === item.id || stacking === DOWN ? 1 :
        parallelAsk && item.kind !== 'task' ? tall(`Run ${parallelAsk.join(', ')} at once, each by its own agent in its own worktree? [ Yes, start them ] [ Cancel ]`) : buttonRows([...(isReview ? ['Approve', 'Request changes'] : []), ...(isHandable ? ['Hand to Claude'] : []), 'Ask Claude', ...(item.kind !== 'task' ? ['Add item'] : []), ...(openUnder.length > 1 ? ['Run its tasks at once…'] : []), isEditing ? 'Done editing' : 'Edit', 'Assign me', 'Unassign', 'Close']))
  const info = item ? `assignee ${item.assignee ?? 'none'}${item.kind === 'task' ? `  priority ${item.priority}  ${item.type}` : ''}${tagLine ? `  ${tagLine}` : ''}${item.due ? `  due ${item.due}` : ''}${where ? `  in ${where}` : ''}${shipped ? `  ${shipped}` : ''}` : ''
  // Key hints, most useful first: as many as fit in the rows the pane gives them (one wide, two narrow),
  // each whole, the rest dropped from the end. Drawn in that order of usefulness, not of the keys.
  const hints = (draft
    ? ['Tab/↑↓ move between fields', 'Enter on Title creates it']
    : item
    ? ['Tab/↑↓ move', 'x close', isEditing ? 'e done editing' : 'e edit', isReview ? 'a approve · c request changes' : '', item.kind === 'task' ? `1–${STATUSES.length} status` : '']
    : [isIgnoreOffered ? 'g gitignore the db' : '', 'Enter opens', 'Tab/↑↓ move', `v ${nextView}`, mode === 'board' ? 't p b r d jump to a column' : '', mode === 'roadmap' && isAxis ? 'w zoom' : '', 'n new', 'i file to the inbox', 'f filter', canUndo ? 'z undo' : '']
  ).filter(Boolean)
  const footerHints = fitHints(hints, paneWidth, paneWidth >= 100 ? 1 : 2)
  const footerRows = flowRows(footerHints.map((one, i) => one.length + (i < footerHints.length - 1 ? 2 : 0)), paneWidth)
  // Docked, the list's frame and the card share the rows between the header and the hints, a divider between
  // them. The card takes what its content needs (its borders, title, bars and sections, measured as drawn),
  // leaving the list at least LIST_MIN; or, once the person moves the divider, the split they set (`split`,
  // the list's rows).
  const overList = headerRows + (filterRow ? 1 : 0) + (fileRow ? 1 : 0) + (isIgnoreOffered ? 2 : 0)
  const cardChrome = 2 + titleRows + barRows + prRows + (isCompact ? 0 : tall(info))
  const sectionsRows = sections.reduce((sum, row) => sum + Math.max(1, paint(row.node as never, inner).length), 0)
  const shared = isDocked ? bodyRows! - overList - footerRows - 1 - DIVIDER_ROWS : 0
  const cardFloor = cardChrome + 4
  const topRows = !isDocked
    ? Infinity
    : split !== null
      ? Math.max(LIST_MIN, Math.min(split, shared - cardFloor))
      : Math.max(LIST_MIN, shared - Math.min(cardChrome + sectionsRows, shared - LIST_MIN))
  // The rows a tab has under the header and above the hints, when it can scroll.
  const viewSpace = !canScroll
    ? Infinity
    : isDocked
      ? topRows - 2
      : Math.max(4, bodyRows! - headerRows - footerRows - (filterRow ? 1 : 0) - (fileRow ? 1 : 0) - (isIgnoreOffered ? 2 : 0) - (query && !items.some(isShown) ? 1 : 0) - 1 - (isFramed ? 1 : 0))
  // Side by side, scrolling moves every column a card at a time: as many as fit under the headings.
  // (Under each heading, inside the frame's two borders, with a line for each mark.)
  const wideRoom = viewSpace - 5
  // When there is no room for two cards of three rows, a side-by-side column puts each card on one line.
  const isOneLine = isWide && wideRoom < 6
  const wideHeights = isOneLine ? heightsOf(true) : heights
  // The cards of a column from the `from`th that fit (one at least), and the first `from` that shows its last.
  const cardsFrom = (status: Status, from: number) => {
    let n = 0
    for (let used = 0; from + n < wideHeights[status].length && wideHeights[status][from + n]! !== Infinity && (n === 0 || used + wideHeights[status][from + n]! <= wideRoom); n++)
      used += wideHeights[status][from + n]!
    return Math.max(1, n)
  }
  const lastFrom = (status: Status, count: number) => {
    let from = count
    for (let used = 0; from > 0 && (from === count || used + (wideHeights[status][from - 1] ?? 1) <= wideRoom); from--) used += wideHeights[status][from - 1] ?? 1
    return Math.max(0, Math.min(from, count - 1))
  }
  const wideMax = isWide && canScroll
    ? Math.max(0, ...STATUSES.map(status => lastFrom(status, Math.min(columns[status].length, caps[status]))))
    : 0
  const wideFrom = Math.min(state.viewScrolledTo, wideMax)
  const fixed = (isCompact ? 0 : headerRows) + (isDocked ? overList - headerRows + topRows + DIVIDER_ROWS : 0) + cardChrome + footerRows + 1
  const space = e.surface === 'terminal' && bodyRows ? Math.max(3, bodyRows - fixed) : Infinity
  // The card's sections, measured as drawn, in a window a line at a time; the marks take a line each.
  const total = sectionsRows
  const isScrolling = space < total
  const scrollMax = isScrolling ? total - (space - 2) : 0
  const want = isScrolling ? Math.min(state.scrolledTo, scrollMax) : 0
  const cardWindow = windowOf(sections, want, isScrolling ? space - (want > 0 ? 1 : 0) - (want < scrollMax ? 1 : 0) : Infinity, inner)
  const above = cardWindow.above
  const below = cardWindow.below
  const body = [
    above > 0 ? <Text key="more-above" dimColor>↑ {above} more {above === 1 ? 'line' : 'lines'} above · scroll up</Text> : null,
    ...(cardWindow.nodes as never[]),
    below > 0 ? <Text key="more-below" dimColor>↓ {below} more {below === 1 ? 'line' : 'lines'} below · scroll down</Text> : null,
  ]
  // An inline pane is as tall as its tree: keep a scrolling card at one height so the frame doesn't change size.
  if (isScrolling) {
    const drawn = Math.min(total - above - below, Infinity) + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0)
    if (drawn < space + 1) body.push(<Box key="pad" height={space + 1 - drawn} />)
  }

  // The card. Docked, `grow` blank rows at its bottom make the two frames fill the pane, whatever the split.
  const panelWith = (grow: number) => item && status && (
    <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1}
      borderColor={!isDocked || region === 'card' ? ACTIVE : undefined} borderDimColor={isDocked} hover={LIT}>
      <Box key="title-row" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text dimColor>
            {item.kind} {item.id}
          </Text>{' '}
          <Text bold>{item.title}</Text>
          {isCompact && <Text dimColor>  {meta}</Text>}
        </Text>
        {/* The card can be closed from several places: this ✕, Close in the bar, x, or pressing the card on the board again. */}
        <Button key="close-x" plain onPress={() => act.closeDetail(item.id)}>
          <Text dimColor> ✕</Text>
        </Button>
      </Box>
      {/* The bar is right under the title on every card, so its buttons never move with the content. */}
      <Box key="bar" flexDirection="column">
        {item.kind === 'task' ? (
          <Box key="status-row" flexDirection="row" columnGap={1} flexWrap="wrap">
            {STATUSES.map((one, i) => {
              // A dropped task shows Won't do rather than Done; pressing any status reopens it.
              const isOn = item.status === one && !(one === 'done' && isDropped(item))
              return (
                <Button key={`set-${one}`} label={isOn ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]}
                  hotkey={String(i + 1)} variant={isOn ? 'primary' : 'secondary'}
                  onPress={() => {
                    act.userAct({ action: 'update', id: item.id, status: one })
                    // Done, with no CHANGELOG line yet: the card shows a field for one.
                    if (one === 'done' && !item.note && Input) act.setNoting(item.id)
                  }} />
              )
            })}
            {/* No hotkey: dropping work needs a reason, typed in a field on the next row. */}
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
                {'  '}based on its tasks ({progress(items, item).done}/{progress(items, item).total} done)
              </Text>
            </Text>
          </Box>
        )}
        {parallelAsk && item.kind !== 'task' ? (
          confirmParallel(parallelAsk, 'parallel-confirm')
        ) : stacking === DOWN && down.length > 1 ? (
          <Box key="stack-confirm" flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color="yellow">
              Merge {down.map(pr => `#${pr.number}`).join(', then ')} into {down[0]!.base || 'main'}, each once its checks pass there?
            </Text>
            <Button key="stack-yes" label={`Merge ${down.length}`} onPress={() => act.mergeStack(down)} />
            <Button key="stack-cancel" label="Cancel" onPress={() => act.askStack(null)} />
          </Box>
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
              // Stacked: merged now, it would merge into the branch below, not main. That PR must be merged first.
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
          {under && stackRun && <Text color="yellow">  stacked on #{under.number}</Text>}
          {isStack && <Text dimColor>  stack {stackText(stack)}</Text>}
          {stackRun && <Text color="yellow">  {stackRun}</Text>}
        </Text>
        {/* Stacked: one press merges the PRs below it, then this one (after the person confirms). */}
        {under && !stackRun && (
          <Button key="merge-down" label={`stacked on #${under.number}: merge ${down.slice(0, -1).map(pr => `#${pr.number}`).join(', ')}, then this`}
            onPress={() => act.askStack(DOWN)} />
        )}
        {isStack && !stackRun && <Button key="merge-stack" label="Merge the stack" onPress={() => act.askStack(item.id)} />}
        </Box>
      )}
      {!isCompact && (
        <Text>
          <Text dimColor>assignee </Text>
          <Text color="cyan">{item.assignee ?? 'none'}</Text>
          {isStale(item, now) && <Text color="red"> (inactive claim)</Text>}
          {item.kind === 'task' && <Text dimColor>  priority </Text>}
          {item.kind === 'task' && <Text color={PRIORITY_COLOR[item.priority]}>{item.priority}</Text>}
          {item.kind === 'task' && <Text dimColor>  {item.type}</Text>}
          {tagLine && <Text color="blue">  {tagLine}</Text>}
          {item.due && <Text dimColor>  due {item.due}</Text>}
          {where && <Text dimColor>  in {where}</Text>}
          {shipped && <Text color={shipped.startsWith('merged') ? 'yellow' : 'green'}>  {shipped}</Text>}
        </Text>
      )}
      {body}
      {grow > 0 && <Box key="detail-grow" height={grow} />}
    </Box>
  )
  const panel = panelWith(0)

  // The new-item form: the choices first, the title last (Enter on it creates the item).
  const homes = draft ? homesFor(items, draft.kind) : []
  const form = draft && (
    <Box key="new-form" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>New {draft.kind}{draft.from ? ` from ${draft.from}` : ''}</Text>
      {Select ? (
        <Box key="new-choices" flexDirection="row" columnGap={2} flexWrap="wrap">
          <Select key="new-kind" label="Kind" options={KINDS.filter(one => !draft.from || one !== 'milestone').map(one => ({ value: one }))} value={draft.kind}
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
        <Input key="new-title" label="Title" placeholder="What it is; Enter creates it" autoFocus submitLabel="create" value={draft.title}
          onSubmit={(value: string) => value.trim() && act.create(draft, value.trim())} />
      )}
      <Button key="new-cancel" label="Cancel" onPress={() => act.setDraft(null)} />
    </Box>
  )
  // Where a new item goes by default: under the open card, when that card can contain one.
  function newDraft(under: Item | null): Draft {
    const kind = under?.kind === 'milestone' ? 'epic' : 'task'
    return fitDraft({ kind, priority: 'p2', type: 'feature', parent: under && under.kind !== 'task' ? under.id : (under && upOf(under)) || '' })
  }
  // A parent the chosen kind can't go under is cleared.
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

  // The current tab, shown in a scrolling window under the header when it is longer than the pane: its rows
  // (a stacked board's columns line by line, blank rows between them), measured as drawn, from where it is
  // scrolled to.
  const theView = mode === 'board' ? drawBoard() : mode === 'roadmap' ? (isAxis ? axisView : timelineView) : mode === 'inbox' ? inboxView : mode === 'releases' ? releasesView : tree
  const viewRows: { node: unknown; rows: number }[] = []
  if (!(mode === 'board' && isWide)) {
    const top = kids(theView as never)
    top.forEach((child, i) => {
      if (mode === 'board' && i > 0) viewRows.push({ node: <Text key={`gap-${i}`}> </Text>, rows: 1 })
      const key = String((child as { props?: { key?: unknown } } | null)?.props?.key ?? (child as { key?: unknown } | null)?.key ?? '')
      // A stacked board's columns and Releases' sections and versions are added line by line, so the window's
      // edge cuts off as little as possible (a block cut by an edge is drawn plain).
      const isSplit = mode === 'board' ? key.startsWith('col-') && key !== 'col-empty' : mode === 'releases' && /^(pending|release)-/.test(key)
      const parts = isSplit ? kids(child as never) : [child]
      for (const part of parts) if (part !== null && part !== undefined && part !== false && part !== '') viewRows.push({ node: part, rows: Math.max(1, paint(part as never, width).length) })
    })
  }
  const viewTotal = viewRows.reduce((sum, row) => sum + row.rows, 0)
  const isViewScrolling = canScroll && !(mode === 'board' && isWide) && viewTotal > viewSpace
  const viewMax = isViewScrolling ? viewTotal - (viewSpace - 2) : mode === 'board' && isWide ? wideMax : 0
  // When a docked card has just opened, the open item's row is kept visible, scrolling the window as little as
  // needed. Its button has a separate key while open (rowKey).
  const isRow = (node: unknown): boolean => {
    const key = String((node as { props?: { key?: unknown } } | null)?.props?.key ?? '')
    return (pick !== null && /^(card|row|time|need)-/.test(key) && (key.endsWith(`-${pick}`) || key.endsWith(`-${pick}-open`)))
      || kids(node as never).some(isRow)
  }
  const pickRow = isDocked && state.isRevealing && isViewScrolling ? viewRows.findIndex(row => isRow(row.node)) : -1
  const viewAt = !isViewScrolling
    ? 0
    : pickRow < 0
      ? Math.min(state.viewScrolledTo, viewMax)
      : (() => {
          const top = viewRows.slice(0, pickRow).reduce((sum, row) => sum + row.rows, 0)
          const bottom = top + viewRows[pickRow]!.rows
          const room = viewSpace - 2
          return Math.max(0, Math.min(viewMax, Math.min(top - 1, Math.max(state.viewScrolledTo, bottom + 1 - room))))
        })()
  // Scrolled one line at a time; a row cut by an edge shows only its lines inside the window.
  const viewWindow = windowOf(viewRows.map((row, i) => ({ key: `view-${i}`, node: row.node })), viewAt,
    isViewScrolling ? viewSpace - (viewAt > 0 ? 1 : 0) - (viewAt < viewMax ? 1 : 0) : Infinity, width)
  const viewAbove = viewWindow.above
  const viewBelow = viewWindow.below
  const scrolledView = isViewScrolling ? (
    <Box key="view-window" flexDirection="column">
      {viewAbove > 0 && <Text key="view-above" dimColor>↑ {viewAbove} more {viewAbove === 1 ? 'line' : 'lines'} above · scroll up</Text>}
      {viewWindow.nodes as never[]}
      {viewBelow > 0 && <Text key="view-below" dimColor>↓ {viewBelow} more {viewBelow === 1 ? 'line' : 'lines'} below · scroll down</Text>}
    </Box>
  ) : theView

  // Everything above the key hints. `pad` blank rows move the rest down to them: above an open card, so it
  // fills from the bottom up, else under the tab.
  const overHints = (pad: number) => (
    <Box key="above-hints" flexDirection="column">
        {/* The tabs do nothing while a card covers the board, so inline they are hidden and the card gets their row. */}
        {!(isCompact && (panel || form)) && header}
        {(!panel || isDocked) && !form && filterRow}
        {!form && fileRow}
        {!panel && !form && query && !items.some(isShown) && <Text key="no-match" dimColor>Nothing matches the filter.</Text>}
        {offer}
        {trouble ? (
          <Text color="red">{trouble}</Text>
        ) : form ? (
          <Box key="form-at" flexDirection="column">
            {form}
            {pad > 0 && <Box key="form-pad" height={pad} />}
          </Box>
        ) : items.length === 0 ? (
          <Text dimColor>No roadmap yet. Ask Claude to plan milestones, epics and tasks, or press n to add one.</Text>
        ) : (
          // Docked, the board keeps the top rows and the card goes under it. Where there is no room for both,
          // the open card replaces the board, so a long board never pushes it off screen.
          isDocked && panel ? (
            <Box key="docked" flexDirection="column">
              <Box key="top" flexDirection="column" height={topRows} borderStyle="round" paddingX={1}
                borderColor={region === 'list' ? ACTIVE : undefined} borderDimColor hover={LIT}>
                {scrolledView}
              </Box>
              {/* The divider: ▲ gives the card more room, ▼ the list; auto goes back to sizing by the card. */}
              <Box key="divider" flexDirection="row" columnGap={1} justifyContent="center">
                <Button key="split-up" plain hotkey="k" onPress={() => act.setSplit(Math.max(LIST_MIN, topRows - SPLIT_STEP))}>
                  <Text dimColor hover={LIT_TEXT}>▲</Text>
                </Button>
                <Button key="split-down" plain hotkey="j" onPress={() => act.setSplit(topRows + SPLIT_STEP)}>
                  <Text dimColor hover={LIT_TEXT}>▼</Text>
                </Button>
                {split !== null && (
                  <Button key="split-auto" plain onPress={() => act.setSplit(null)}>
                    <Text dimColor hover={LIT_TEXT}>auto</Text>
                  </Button>
                )}
              </Box>
              {panelWith(pad)}
            </Box>
          ) : (
            panel ? (
              <Box key="card-alone" flexDirection="column">
                {pad > 0 && <Box key="card-pad" height={pad} />}
                {panel}
              </Box>
            ) : (
              <Box key="tab" flexDirection="column"
                {...(isFramed ? { borderStyle: 'round', borderDimColor: true, paddingX: 1, hover: LIT } : {})}>
                {scrolledView}
                {pad > 0 && <Box key="tab-pad" height={pad} />}
              </Box>
            )
          )
        )}
    </Box>
  )
  // Docked, the key hints are on the pane's last rows, whatever is showing: what is above them is padded down.
  const isDock = (e.props as { placement?: string }).placement === 'dock'
  const hintsPad = isDock && e.surface === 'terminal' && bodyRows !== undefined && items.length > 0 && !trouble
    ? Math.max(0, bodyRows - paint(overHints(0) as never, paneWidth).length - footerRows)
    : 0

  // Docked, where the list's frame ends, in body rows: the wheel above it moves the list, below it the card.
  const listEnd = isDocked
    ? headerRows + (filterRow ? 1 : 0) + (fileRow ? 1 : 0) + (isIgnoreOffered ? 2 : 0) + topRows
    : 0

  return {
    scrollMax,
    viewScrollMax: viewMax,
    viewScrollAt: mode === 'board' && isWide ? (revealedFrom ?? wideFrom) : viewAt,
    listEnd,
    node: (
      <Box flexDirection="column">
        {overHints(hintsPad)}
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
 * The band above the prompt: what the agents are working on right now, which the person can press to open. `working`
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
