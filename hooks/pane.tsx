import type { Elements, EventOf, RenderChildren, RenderElement } from 'claude-code'

import type { Item, Priority, Refs, Snapshot, Status, View } from '../types'
import * as db from './db'
import {
  find, GLYPH, isMessage, isStale, LABEL, linksOf, marks, path, progress, refsFor, rows, STATUSES, statusOf, timeline, unread, USER,
  waitingOn,
} from './model'

export const COLOR: Record<Status, string> = { todo: 'gray', in_progress: 'yellow', blocked: 'red', review: 'blue', done: 'green' }
// Urgent priorities stand out on a card; the rest of the marks read dim.
export const PRIORITY_COLOR: Record<Priority, string | undefined> = { p0: 'red', p1: 'yellow', p2: undefined, p3: 'gray' }
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
  handToClaude: (item: Item) => void
  requestChanges: (item: Item, what: string) => void
  setView: (mode: View) => void
  setRequesting: (isOn: boolean) => void
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
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { snap, mode, pick, trouble, known, isIgnoreOffered, isRequesting, now } = state
  const items = snap.items
  const width = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 100
  // Five columns side by side need room for a readable title in each; narrower, they stack.
  const isWide = width >= 100
  // Inline the pane gets about a third of the screen, so an open card there spends as few rows as it can.
  const isCompact = e.surface === 'terminal' && (e.props as { placement?: string }).placement === 'inline'
  const choose = (id: string | null) => () => act.open(id)
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
    const ticks = list.length ? ` ☑${list.filter(c => c.done).length}/${list.length}` : ''
    const tags = marks(item)
    const tag = tags.length ? ` ${tags.join(' ')}` : ''
    const extra = item.id.length + who.length + stale.length + news.length + wait.length + ticks.length + tag.length + 1
    const title = item.title.length + extra > room ? item.title.slice(0, Math.max(4, room - extra - 1)) + '…' : item.title
    return (
      <Button key={`card-${item.id}`} plain onPress={choose(item.id)}>
        <Text dimColor>{item.id}</Text> {title}
        <Text color={PRIORITY_COLOR[item.priority]} bold={item.priority === 'p0'}>
          {tag}
        </Text>
        <Text dimColor>{ticks}</Text>
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

  const unreadTotal = items.reduce((sum, item) => sum + unread(snap, item.id, USER).length, 0)
  const header = (
    <Box flexDirection="row" gap={1}>
      {/* `v` switches to whichever view is not showing: one hotkey, held by the inactive tab alone. */}
      <Button key="tab-board" label="Board" variant={mode === 'board' ? 'primary' : 'secondary'}
        hotkey={mode === 'board' ? undefined : 'v'} onPress={() => act.setView('board')} />
      <Button key="tab-tree" label="Tree" variant={mode === 'tree' ? 'primary' : 'secondary'}
        hotkey={mode === 'tree' ? undefined : 'v'} onPress={() => act.setView('tree')} />
      <Text dimColor>
        {items.filter(i => i.kind === 'task' && i.status === 'done').length}/{items.filter(i => i.kind === 'task').length} tasks done
      </Text>
      {unreadTotal > 0 && (
        <Text color="magenta" bold>
          ● {unreadTotal} unread
        </Text>
      )}
    </Box>
  )

  const tasks = items.filter(item => item.kind === 'task').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const colWidth = Math.floor((width - (STATUSES.length - 1)) / STATUSES.length)
  const board = (
    <Box flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 1 : 0}>
      {STATUSES.map(status => {
        const column = tasks.filter(task => task.status === status)
        const shown = column.slice(0, status === 'done' ? 8 : 15)
        return (
          <Box key={`col-${status}`} flexDirection="column" width={isWide ? colWidth : undefined} marginBottom={isWide ? 0 : 1}>
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

  const tree = (
    <Box flexDirection="column">
      {rows(items).map(({ item, depth }) => {
        const p = progress(items, item)
        const status = statusOf(items, item)
        return (
          <Button key={`row-${item.id}`} plain onPress={choose(item.id)}>
            {'  '.repeat(depth)}
            <Text color={COLOR[status]}>{GLYPH[status]}</Text> <Text dimColor>{item.id}</Text>{' '}
            <Text bold={item.kind === 'milestone'}>{item.title}</Text>
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
  if (item) {
    section('description', 'Description', item.description
      ? wrap(item.description, inner - 2).map((line, i) => ({ key: `desc-${i}`, rows: 1, node: <Text key={`desc-${i}`}>  {line}</Text> }))
      : [])
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
      ...linked.prs.slice(0, 3).map(pr => ({ key: `pr-${pr.number}`, rows: tall(`PR #${pr.number} [${pr.state}] ${pr.title}`), node: (
        <Text key={`pr-${pr.number}`}>
          <Text dimColor>PR </Text>#{pr.number}{' '}
          <Text color={pr.state === 'merged' ? 'magenta' : pr.state === 'open' ? 'green' : undefined}>[{pr.state}]</Text> {pr.title}
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
            <Input key="comment" label="Comment" placeholder="A note for Claude; Enter posts it"
              onSubmit={(value: string) => (value.trim() && act.userAct({ action: 'comment', id: item.id, body: value }))} />
          ) }]
        : []),
      // Comments and handoff notes read as messages, author over body; what the tracker did reads as one dim line.
      ...timeline(snap.activity, item.id)
        .slice(-6)
        .map(one => {
          const when = one.at.slice(5, 16).replace('T', ' ')
          const who = <Text color={one.author === USER ? 'magenta' : 'cyan'}>{one.author}</Text>
          return isMessage(one)
            ? { key: `act-${one.id}`, rows: 1 + tall(one.body, 2), node: (
                <Box key={`act-${one.id}`} flexDirection="column">
                  <Text>
                    {who}
                    {one.type === 'handoff' && <Text color="yellow"> handoff</Text>}
                    <Text dimColor> {when}</Text>
                  </Text>
                  <Text>  {one.body}</Text>
                </Box>
              ) }
            : { key: `act-${one.id}`, rows: tall(`${when} ${one.author} ${one.body}`), node: (
                <Text key={`act-${one.id}`} dimColor>
                  {when} {one.author} {one.body}
                </Text>
              ) }
        }),
    ])
  }
  // On the terminal the window is ours: what fits under the fixed rows, with a mark for what is above or below.
  // Fixed rows: tabs, the panel's two borders, title, two bar rows (more as they wrap), the info line, the
  // footer, and the ↓ mark. The ↑ mark takes a content row only once the card is scrolled.
  const bodyRows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows
  const tagLine = item?.labels?.length ? item.labels.map(one => `#${one}`).join(' ') : ''
  const meta = item ? [item.assignee ? `@${item.assignee}` : 'unassigned', item.kind === 'task' ? `${item.priority} ${item.type}` : '', tagLine, item.due ? `due ${item.due}` : '', where ? `in ${where}` : ''].filter(Boolean).join(' · ') : ''
  const titleRows = tall(`${item?.title ?? ''}${isCompact ? `  ${meta}` : ''}`, item ? item.kind.length + item.id.length + 2 : 0)
  // Tabs (hidden inline), the panel's borders, title, bar, info line (folded into the title inline), footer, ↓ mark.
  // The bar's two rows of buttons, as they wrap at this width ("[ label ]", one column apart).
  const buttonRows = (labels: string[]) => {
    let lines = 1
    let used = 0
    for (const label of labels) {
      const w = label.length + 4
      if (used > 0 && used + 1 + w > inner) (lines++, (used = w))
      else used += (used > 0 ? 1 : 0) + w
    }
    return lines
  }
  const isReview = item?.kind === 'task' && item.status === 'review'
  const barRows = !item
    ? 0
    : (item.kind === 'task' ? buttonRows(STATUSES.map(one => (item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]))) : 1) +
      (isRequesting ? 1 : buttonRows([...(isReview ? ['Approve', 'Request changes'] : []), 'Hand to Claude', 'Assign me', 'Unassign', 'Close']))
  const info = item ? `assignee ${item.assignee ?? 'none'}${item.kind === 'task' ? `  priority ${item.priority}  ${item.type}` : ''}${tagLine ? `  ${tagLine}` : ''}${item.due ? `  due ${item.due}` : ''}${where ? `  in ${where}` : ''}` : ''
  const footer = (item
    ? ['Tab/↑↓ move', item.kind === 'task' ? `1–${STATUSES.length} status` : '', isReview ? 'a approve · c request changes' : '', 'h hand to Claude', 'm/u assign', 'x close']
    : [isIgnoreOffered ? 'g gitignore the db' : '', 'Tab/↑↓ move', 'Enter opens', mode === 'board' ? 't p b r d jump to a column' : '', `v ${mode === 'board' ? 'tree' : 'board'}`]
  )
    .filter(Boolean)
    .join(' · ')
  // The footer is as wide as the pane, not the panel inside it.
  const footerRows = Math.max(1, Math.ceil(footer.length / Math.max(1, width)))
  const fixed = (isCompact ? 0 : 1) + 2 + titleRows + barRows + (isCompact ? 0 : tall(info)) + footerRows + 1
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
      <Text>
        <Text dimColor>
          {item.kind} {item.id}
        </Text>{' '}
        <Text bold>{item.title}</Text>
        {isCompact && <Text dimColor>  {meta}</Text>}
      </Text>
      {/* The bar sits right under the title on every card, so its buttons never move with the content. */}
      <Box key="bar" flexDirection="column">
        {item.kind === 'task' ? (
          <Box key="status-row" flexDirection="row" columnGap={1} flexWrap="wrap">
            {STATUSES.map((one, i) => (
              <Button key={`set-${one}`} label={item.status === one ? `${GLYPH[one]} ${LABEL[one]}` : LABEL[one]}
                hotkey={String(i + 1)} variant={item.status === one ? 'primary' : 'secondary'}
                onPress={() => act.userAct({ action: 'update', id: item.id, status: one })} />
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
        {isRequesting && Input ? (
          <Box key="changes-row" flexDirection="row" gap={1}>
            <Input key="changes" label="Changes" placeholder="What needs changing? Enter sends it back" autoFocus
              submitLabel="send back" onSubmit={(value: string) => act.requestChanges(item, value)} />
            <Button key="changes-cancel" label="Cancel" onPress={() => act.setRequesting(false)} />
          </Box>
        ) : (
        <Box key="action-row" flexDirection="row" columnGap={1} flexWrap="wrap">
          {item.kind === 'task' && item.status === 'review' && (
            <Button key="approve" label="Approve" hotkey="a" variant="primary"
              onPress={() => act.userAct({ action: 'update', id: item.id, status: 'done' })} />
          )}
          {item.kind === 'task' && item.status === 'review' && Input && (
            <Button key="request" label="Request changes" hotkey="c"
              onPress={() => act.setRequesting(true)} />
          )}
          <Button key="hand" label="Hand to Claude" hotkey="h" onPress={() => act.handToClaude(item)} />
          <Button key="mine" label="Assign me" hotkey="m" onPress={() => act.userAct({ action: 'update', id: item.id, assignee: USER })} />
          <Button key="unassign" label="Unassign" hotkey="u" onPress={() => act.userAct({ action: 'update', id: item.id, assignee: '' })} />
          <Button key="close" label="Close" hotkey="x" onPress={() => act.closeDetail(item.id)} />
        </Box>
        )}
      </Box>
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
        {!(isCompact && panel) && header}
        {offer}
        {trouble ? (
          <Text color="red">{trouble}</Text>
        ) : items.length === 0 ? (
          <Text dimColor>No roadmap yet. Ask Claude to plan milestones, epics and tasks.</Text>
        ) : (
          // An open item stands in for the board, so a long board never pushes it off screen.
          panel ?? (mode === 'board' ? board : tree)
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
