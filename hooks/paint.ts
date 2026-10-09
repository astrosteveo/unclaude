/**
 * A rough terminal paint of a drawn tree, for the layout tests: the kit hands back the tree a render
 * hook returned, never the terminal's paint, so this lays it out much as Ink does (boxes in rows and
 * columns, text wrapped at word boundaries) and reports where it can't fit: a row whose children are
 * wider than it, a box whose content is taller than the height it was given, a line wider than the pane.
 * It is a model, not Ink: close enough to catch a column that runs into a card, not a pixel test.
 */

type Node = { type: string; props?: Record<string, unknown>; children?: Child[] } | string | number | null | undefined | boolean
type Child = Node

export type Painted = { lines: string[]; problems: string[] }

/** The cells a string takes: characters, as the terminal counts most of them. */
export const cells = (text: string) => [...text].length

/** `text` wrapped at word boundaries to `width`, a word longer than a line broken across lines. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line === '') line = word
      else if (cells(line) + 1 + cells(word) <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
      while (width > 0 && cells(line) > width) {
        out.push([...line].slice(0, width).join(''))
        line = [...line].slice(width).join('')
      }
    }
    out.push(line)
  }
  return out
}

const num = (value: unknown) => (typeof value === 'number' ? value : 0)
const kids = (node: Node): Child[] => (node && typeof node === 'object' ? (node.children ?? []) : [])
const isInline = (node: Node) =>
  node === null || node === undefined || typeof node !== 'object' || node.type === 'Text' || node.type === 'Link' ||
  (node.type === 'Button' && Boolean(node.props?.plain) && kids(node).length > 0)

/** What an inline node says, flattened. */
function textOf(node: Node): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (node.type === 'Button' && !(node.props?.plain && kids(node).length)) {
    const label = String(node.props?.label ?? '')
    return node.props?.plain ? label : `[ ${label} ]`
  }
  if (node.type === 'Input') return String(node.props?.value || node.props?.placeholder || '').padEnd(10)
  if (node.type === 'Select') {
    const options = (node.props?.options ?? []) as { label?: string; value?: string }[]
    const chosen = options.find(one => one.value === node.props?.value) ?? options[0]
    return `${chosen?.label ?? ''} ▾`
  }
  return kids(node).map(textOf).join('')
}

/** The width a node takes when nothing limits it. */
function natural(node: Node): number {
  if (isInline(node) || (typeof node === 'object' && node && node.type !== 'Box')) return Math.max(0, ...textOf(node).split('\n').map(cells))
  const props = (node as { props?: Record<string, unknown> }).props ?? {}
  if (typeof props.width === 'number') return props.width
  const edge = edges(props)
  const children = kids(node).filter(child => textOf(child) !== '' || (typeof child === 'object' && child?.type === 'Box'))
  const gap = num(props.columnGap ?? props.gap)
  const inner = props.flexDirection === 'row'
    ? children.reduce((sum, child) => sum + natural(child), 0) + gap * Math.max(0, children.length - 1)
    : Math.max(0, ...children.map(natural))
  return inner + edge.x
}

function edges(props: Record<string, unknown>) {
  const border = props.borderStyle ? 1 : 0
  const left = num(props.paddingLeft ?? props.paddingX ?? props.padding) + border + num(props.marginLeft ?? props.marginX ?? props.margin)
  const right = num(props.paddingRight ?? props.paddingX ?? props.padding) + border + num(props.marginRight ?? props.marginX ?? props.margin)
  const top = num(props.paddingTop ?? props.paddingY ?? props.padding) + border + num(props.marginTop ?? props.marginY ?? props.margin)
  const bottom = num(props.paddingBottom ?? props.paddingY ?? props.padding) + border + num(props.marginBottom ?? props.marginY ?? props.margin)
  return { left, right, top, bottom, x: left + right }
}

const keyOf = (node: Node) => (node && typeof node === 'object' ? String(node.props?.key ?? node.type) : String(node))

/** Paints `node` into `width` columns. */
export function paint(node: Node, width: number, problems: string[] = [], path = 'pane'): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (isInline(node) || (typeof node === 'object' && node.type !== 'Box')) {
    const text = textOf(node)
    if (text === '') return []
    const style = typeof node === 'object' ? node.props?.wrap : undefined
    if (typeof style === 'string' && style.startsWith('truncate')) return text.split('\n').map(line => [...line].slice(0, width).join(''))
    return wrap(text, width)
  }
  const props = node.props ?? {}
  const here = `${path} > ${keyOf(node)}`
  const outer = typeof props.width === 'number' ? props.width : width
  if (outer > width) problems.push(`${here} is ${outer} wide in ${width}`)
  const edge = edges(props)
  const inner = Math.max(1, outer - edge.x)
  const children = kids(node).filter(child => child !== '' && child !== null && child !== undefined && typeof child !== 'boolean')
  let body: string[] = []
  if (props.flexDirection === 'row') {
    const gap = num(props.columnGap ?? props.gap)
    const wants = children.map(child => Math.min(natural(child), typeof child === 'object' && child?.props && typeof child.props.width === 'number' ? child.props.width : Infinity))
    const fixed = children.map(child => typeof child === 'object' && child?.props && typeof child.props.width === 'number')
    if (props.flexWrap === 'wrap') {
      // Children flow on to the next line when the row is full.
      let line: { child: Child; width: number }[] = []
      let used = 0
      const flush = () => {
        if (line.length) body.push(...sideBySide(line.map(one => ({ lines: paint(one.child, one.width, problems, here), width: one.width })), gap))
        line = []
        used = 0
      }
      children.forEach((child, i) => {
        const want = Math.min(wants[i]!, inner)
        if (line.length && used + gap + want > inner) flush()
        used += (line.length ? gap : 0) + want
        line.push({ child, width: want })
      })
      flush()
    } else {
      const total = wants.reduce((sum, one) => sum + one, 0) + gap * Math.max(0, children.length - 1)
      const fixedTotal = wants.reduce((sum, one, i) => sum + (fixed[i] ? one : 0), 0) + gap * Math.max(0, children.length - 1)
      if (fixedTotal > inner) problems.push(`${here}: children of fixed width take ${fixedTotal} of ${inner}`)
      // Over the row's width, what isn't fixed shrinks in proportion; under it, grow takes the rest.
      let widths = wants
      if (total > inner) {
        const flexible = wants.reduce((sum, one, i) => sum + (fixed[i] ? 0 : one), 0)
        const room = Math.max(0, inner - fixedTotal)
        widths = wants.map((one, i) => (fixed[i] || flexible === 0 ? one : Math.max(1, Math.floor((one * room) / flexible))))
      } else {
        const grow = children.map(child => num(typeof child === 'object' && child?.props ? child.props.flexGrow : 0))
        const share = grow.reduce((sum, one) => sum + one, 0)
        if (share > 0) widths = wants.map((one, i) => one + Math.floor(((inner - total) * grow[i]!) / share))
      }
      body = sideBySide(children.map((child, i) => ({ lines: paint(child, widths[i]!, problems, here), width: widths[i]! })), gap)
    }
  } else {
    const gap = num(props.rowGap ?? props.gap)
    children.forEach((child, i) => {
      if (i > 0) for (let n = 0; n < gap; n++) body.push('')
      body.push(...paint(child, inner, problems, here))
    })
  }
  if (typeof props.height === 'number') {
    const room = props.height - edge.top - edge.bottom
    if (body.length > room) problems.push(`${here} holds ${body.length} rows in a height of ${room}`)
    while (body.length < room) body.push('')
  }
  const pad = ' '.repeat(edge.left)
  const lines = [
    ...Array<string>(edge.top).fill(''),
    ...body.map(line => (edge.left ? pad + line : line)),
    ...Array<string>(edge.bottom).fill(''),
  ]
  for (const line of lines) if (cells(line) > outer) problems.push(`${here}: a line of ${cells(line)} in ${outer}: "${line.trim().slice(0, 60)}"`)
  return lines
}

function sideBySide(blocks: { lines: string[]; width: number }[], gap: number): string[] {
  const rows = Math.max(0, ...blocks.map(block => block.lines.length))
  const out: string[] = []
  for (let r = 0; r < rows; r++)
    out.push(blocks.map((block, i) => (block.lines[r] ?? '').padEnd(i < blocks.length - 1 ? block.width : 0)).join(' '.repeat(gap)).trimEnd())
  return out
}

/** Paints a drawn pane, with what didn't fit. */
export function paintPane(tree: unknown, width: number): Painted {
  const problems: string[] = []
  const lines = paint(tree as Node, width, problems)
  for (const [i, line] of lines.entries()) if (cells(line) > width) problems.push(`line ${i + 1} is ${cells(line)} wide in ${width}`)
  return { lines, problems: [...new Set(problems)] }
}
