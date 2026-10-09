import type { Check, IssueType, Item, Kind, Priority, Relation, Snapshot, Status } from '../types'
import { PREFIX } from './model'

export const DB = '.claude/roadmap.db'
const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`

/**
 * The schema's history: MIGRATIONS[i] takes a database from version i to i + 1, and the version a
 * database is at lives in its own `PRAGMA user_version`. Append to this list; never edit an entry that
 * has shipped. A database made before versioning (the tables there, version 0) runs entry 0 harmlessly,
 * every statement of it being IF NOT EXISTS.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
  parent TEXT, description TEXT, assignee TEXT, due TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}), updated_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS counters(prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, author TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT (${NOW}));
CREATE INDEX IF NOT EXISTS activity_item ON activity(item_id);
CREATE TABLE IF NOT EXISTS links(blocker TEXT NOT NULL, blocked TEXT NOT NULL, PRIMARY KEY (blocker, blocked));
CREATE TABLE IF NOT EXISTS checks(item_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_id, n));
CREATE TABLE IF NOT EXISTS reads(reader TEXT NOT NULL, item_id TEXT NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (reader, item_id));`,
  // v2: Jira-style fields, claim leases, labels, and links other than blocked-by. ALTER TABLE is not
  // idempotent, so a session that loses the race to migrate fails here and finds the version current.
  `ALTER TABLE items ADD COLUMN priority TEXT NOT NULL DEFAULT 'p2';
ALTER TABLE items ADD COLUMN type TEXT NOT NULL DEFAULT 'feature';
ALTER TABLE items ADD COLUMN lease_at TEXT;
CREATE TABLE IF NOT EXISTS labels(item_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (item_id, label));
CREATE TABLE IF NOT EXISTS relations(a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (a, b, type));`,
  // v3: a milestone or epic handed to an agent is now reviewed once its tasks are done. Those already
  // finished before that were never asked for review, so they keep reading done.
  `UPDATE items SET status='done' WHERE kind!='task' AND id IN (
  WITH RECURSIVE under(root, id) AS (
    SELECT id, id FROM items WHERE kind!='task'
    UNION ALL SELECT under.root, items.id FROM items JOIN under ON items.parent=under.id)
  SELECT root FROM under JOIN items ON items.id=under.id WHERE items.kind='task'
  GROUP BY root HAVING SUM(items.status!='done')=0);`,
  // v4: undo. Each logged change keeps the script that takes it back (undo) and the one that makes it
  // again (redo); the entries one transaction writes share an op. A reverted entry names the undo that
  // reverted it (undone); an undo names the entry it reverted (reverts).
  `ALTER TABLE activity ADD COLUMN undo TEXT;
ALTER TABLE activity ADD COLUMN redo TEXT;
ALTER TABLE activity ADD COLUMN op INTEGER;
ALTER TABLE activity ADD COLUMN undone INTEGER;
ALTER TABLE activity ADD COLUMN reverts INTEGER;`,
  // v5: release notes. A task's line for the CHANGELOG, and the section it goes under.
  `ALTER TABLE items ADD COLUMN note TEXT;
ALTER TABLE items ADD COLUMN section TEXT;`,
]

/** The schema version this build of the mod reads and writes. */
export const VERSION = MIGRATIONS.length

/**
 * The op a write's log entries share: the id the first of them gets. A line of its own right after
 * BEGIN, so `atomic` can run several scripts as one op.
 */
export const OP = 'CREATE TEMP TABLE IF NOT EXISTS op(n INTEGER); DELETE FROM op; INSERT INTO op SELECT COALESCE(MAX(id), 0) + 1 FROM activity;'

/** How every write that logs begins: its transaction, and its op. */
export const BEGIN = `BEGIN IMMEDIATE;\n${OP}`

/** Answers the database's schema version. */
export const READ_VERSION = 'PRAGMA user_version;'

/**
 * The script taking a database from version `from` to VERSION in one transaction (WAL set first: it
 * cannot change inside one). Two sessions racing here serialize on BEGIN IMMEDIATE; see `isCurrent`.
 */
export const migrate = (from: number) => `PRAGMA journal_mode=WAL;
BEGIN IMMEDIATE;
${MIGRATIONS.slice(from).join('\n')}
PRAGMA user_version=${VERSION};
COMMIT;`

/** Why a database cannot be used by this build, or undefined when it can (after migrating if older). */
export function versionProblem(version: number): string | undefined {
  if (!Number.isInteger(version) || version < 0) return `${DB} reports schema version "${version}", which is not a version`
  if (version > VERSION)
    return `${DB} was written by a newer roadmap mod (schema v${version}; this one reads up to v${VERSION}). Update the mod; nothing was changed.`
  return undefined
}

/** A SQL literal. Newlines are spliced in with char(10) so no line of the script can read as a dot-command. */
export function q(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(Math.trunc(value))
  return value
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map(part => `'${part.replace(/'/g, "''")}'`)
    .join('||char(10)||')
}

/** The sqlite3 command line a script runs under; the script goes on stdin. */
export const ARGV = ['sqlite3', '-batch', '-bail', '-noheader', '-list', '-cmd', '.timeout 5000', DB]

/** The command line for the database at `path` (a batch's trial copy, say) in place of DB. */
export const argvFor = (path: string) => [...ARGV.slice(0, -1), path]

/** What every write moves on: the newest timeline entry. Unchanged, nobody has written since it was read. */
export const STAMP = 'SELECT COALESCE(MAX(id), 0) FROM activity;'

/**
 * A statement that fails, and so (under -bail) rolls back the transaction it is in, unless the database
 * still reads `stamp`: a batch's writes replay only on the database they were tried against.
 */
export const expectStamp = (stamp: string) =>
  guard(`(SELECT COALESCE(MAX(id), 0) FROM activity) = ${Number(stamp) || 0}`, 'the roadmap changed meanwhile; nothing was written. Try again.')

/**
 * A statement that fails the script it is in (under -bail, rolling back its transaction) unless `cond`
 * holds, with `message` in sqlite3's error: an invalid JSON path is the one error SQL lets a script word.
 */
export const guard = (cond: string, message: string) =>
  `SELECT CASE WHEN NOT (${cond}) THEN json_extract('{}', ${q(`!${message}`)}) END;`

/** The message of the guard that failed, read out of sqlite3's error; undefined when no guard failed. */
export function guardReason(error: string): string | undefined {
  const found = /'!([\s\S]*)'\s*$/.exec(error.trim())
  return found ? found[1]!.replace(/''/g, "'") : undefined
}

/** A script's answer: what its last statement printed. */
export const answer = (stdout: string) => stdout.trim().split('\n').at(-1) ?? ''

/** How a logged change is taken back and made again; `reverts` on an undo, the entry it reverted. */
type Back = { undo?: string; redo?: string; reverts?: number }

const activity = (id: string, author: string, type: string, body: string, back: Back = {}) =>
  `INSERT INTO activity(item_id, author, type, body, op, undo, redo, reverts) VALUES (${q(id)}, ${q(author)}, ${q(type)}, ${q(body)}, (SELECT n FROM op), ${q(back.undo)}, ${q(back.redo)}, ${q(back.reverts)});`

const changedSince = (id: string, what: string) => `${id}'s ${what} has changed since; change it directly`

/** Sets an item's `field` from `from` to `to`, failing when it no longer reads `from`. */
const setField = (id: string, field: string, from: string | null, to: string | null) =>
  `${guard(`EXISTS (SELECT 1 FROM items WHERE id=${q(id)} AND ${field} IS ${q(from)})`, changedSince(id, field))}
UPDATE items SET ${field}=${q(to)}, updated_at=${NOW} WHERE id=${q(id)};`

/** A field change both ways. */
const fieldBack = (id: string, field: string, from: string | null, to: string | null): Back =>
  ({ undo: setField(id, field, to, from), redo: setField(id, field, from, to) })

// Lists compared as one text, joined by a character no label or criterion holds.
const SEP = '\u001e'
const labelsAre = (id: string, list: string[]) =>
  `COALESCE((SELECT group_concat(label, char(30)) FROM (SELECT label FROM labels WHERE item_id=${q(id)} ORDER BY label)), '') = ${q([...list].sort().join(SEP))}`
const writeLabels = (id: string, list: string[]) => `DELETE FROM labels WHERE item_id=${q(id)};
${list.map(one => `INSERT INTO labels(item_id, label) VALUES (${q(id)}, ${q(one)});`).join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(id)};`
const checksAre = (id: string, list: Check[]) =>
  `COALESCE((SELECT group_concat(text, char(30)) FROM (SELECT text FROM checks WHERE item_id=${q(id)} ORDER BY n)), '') = ${q(list.map(c => c.text).join(SEP))}`
const writeChecks = (id: string, list: Check[]) => `DELETE FROM checks WHERE item_id=${q(id)};
${list.map(c => `INSERT INTO checks(item_id, n, text, done) VALUES (${q(id)}, ${c.n}, ${q(c.text)}, ${c.done ? 1 : 0});`).join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(id)};`
const link = (blocker: string, blocked: string, isOn: boolean) => isOn
  ? `INSERT OR IGNORE INTO links(blocker, blocked) VALUES (${q(blocker)}, ${q(blocked)});`
  : `DELETE FROM links WHERE blocker=${q(blocker)} AND blocked=${q(blocked)};`
const relation = (a: string, b: string, type: string, isOn: boolean) => isOn
  ? `INSERT OR IGNORE INTO relations(a, b, type) VALUES (${q(a)}, ${q(b)}, ${q(type)});`
  : `DELETE FROM relations WHERE a=${q(a)} AND b=${q(b)} AND type=${q(type)};`
const tick = (id: string, n: number, from: boolean, to: boolean) =>
  `${guard(`EXISTS (SELECT 1 FROM checks WHERE item_id=${q(id)} AND n=${n} AND done=${from ? 1 : 0})`, changedSince(id, `criterion ${n}`))}
UPDATE checks SET done=${to ? 1 : 0} WHERE item_id=${q(id)} AND n=${n};`

/**
 * How much of each item's timeline the snapshot carries: enough for a card and a brief. Its latest
 * handoff note always comes along; the whole of it is read for one item with `history`.
 */
export const RECENT = 20

/** Loads the roadmap, with what `reader` has seen of each item. */
export const load = (reader: string) => `SELECT json_object(
      'items', (SELECT json_group_array(json_object('id', id, 'kind', kind, 'title', title, 'status', status,
        'parent', parent, 'description', description, 'assignee', assignee, 'due', due,
        'priority', priority, 'type', type, 'note', note, 'section', section, 'lease_at', lease_at, 'created_at', created_at, 'updated_at', updated_at,
        'labels', json((SELECT json_group_array(label) FROM (SELECT label FROM labels WHERE item_id=items.id ORDER BY label))),
        'relations', json((SELECT json_group_array(json_object('type', type, 'id', b)) FROM relations WHERE a=items.id)),
        'blocked_by', json((SELECT json_group_array(blocker) FROM links WHERE blocked=items.id)),
        'checklist', json((SELECT json_group_array(json_object('n', n, 'text', text, 'done', done))
          FROM checks WHERE item_id=items.id)))) FROM items),
      'activity', (SELECT json_group_array(json_object('id', id, 'item_id', item_id, 'author', author,
        'type', type, 'body', body, 'at', at, 'op', op, 'undone', undone,
        'undoable', undo IS NOT NULL OR type IN ('comment', 'handoff', 'create'))) FROM (SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY id DESC) AS nth FROM activity)
        WHERE nth <= ${RECENT} OR id IN (SELECT MAX(id) FROM activity WHERE type='handoff' GROUP BY item_id)
        ORDER BY id DESC)),
      'seen', (SELECT json_group_object(item_id, seen) FROM reads WHERE reader=${q(reader)}));`

/** An item's whole timeline, oldest first, as a JSON list. */
export const history = (id: string) =>
  `SELECT json_group_array(json_object('id', id, 'item_id', item_id, 'author', author, 'type', type, 'body', body, 'at', at))
  FROM (SELECT * FROM activity WHERE item_id=${q(id)} ORDER BY id);`

/** Everything written on each item (comments and handoff notes), one text per item id, as a JSON object. */
export const said = `SELECT json_group_object(item_id, body) FROM (SELECT item_id, group_concat(body, char(10)) AS body
  FROM (SELECT * FROM activity WHERE type IN ('comment', 'handoff') ORDER BY id) GROUP BY item_id);`

export function parseLoad(out: string): Snapshot {
  const data = JSON.parse(out) as Snapshot
  // sqlite3 hands back `done` as 0/1, and json_group_array keeps no order of its own.
  const items = data.items.map(item => ({
    ...item,
    labels: item.labels ?? [],
    relations: item.relations ?? [],
    checklist: (item.checklist ?? []).map(c => ({ ...c, done: Boolean(c.done) })).sort((a, b) => a.n - b.n),
  }))
  const activity = data.activity.map(one => ({ ...one, undoable: Boolean(one.undoable) }))
  return { items, activity, seen: data.seen ?? {} }
}

export type NewItem = {
  kind: Kind
  title: string
  parent: string | null
  description?: string
  due?: string
  status?: Status
  assignee?: string
  priority?: Priority
  type?: IssueType
}

/**
 * Inserts an item under a fresh id (ids are never reused); the script answers that id, read inside the
 * transaction: after COMMIT another writer may already have moved the counter on.
 */
export function insert(actor: string, item: NewItem): string {
  const prefix = PREFIX[item.kind]
  const id = `${q(prefix)}||(SELECT n FROM counters WHERE prefix=${q(prefix)})`
  const created = `created ${item.kind} “${item.title}”${item.assignee ? `, assigned to ${item.assignee}` : ''}`
  return `${BEGIN}
INSERT INTO counters(prefix, n) VALUES (${q(prefix)},
  COALESCE((SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) FROM items WHERE SUBSTR(id, 1, 1)=${q(prefix)}), 0) + 1)
  ON CONFLICT(prefix) DO UPDATE SET n = n + 1;
INSERT INTO items(id, kind, title, status, parent, description, assignee, due, priority, type) VALUES (${id}, ${q(item.kind)},
  ${q(item.title)}, ${q(item.status ?? 'todo')}, ${q(item.parent)}, ${q(item.description || null)},
  ${q(item.assignee || null)}, ${q(item.due || null)}, ${q(item.priority ?? 'p2')}, ${q(item.type ?? 'feature')});
INSERT INTO activity(item_id, author, type, body, op) VALUES (${id}, ${q(actor)}, 'create', ${q(created)}, (SELECT n FROM op));
SELECT ${id};
COMMIT;`
}

export type Changes = Partial<Pick<Item, 'title' | 'status' | 'parent' | 'description' | 'assignee' | 'due' | 'priority' | 'type' | 'note' | 'section'>>

/** The script writing the changes, logging one activity entry per field changed, and those entries; none when nothing changes. */
export function change(actor: string, item: Item, changes: Changes): { script: string; notes: string[] } {
  const sets: string[] = []
  const logs: string[] = []
  const notes: string[] = []
  for (const [field, value] of Object.entries(changes) as [keyof Changes, string | null][]) {
    if (value === undefined || value === item[field]) continue
    sets.push(`${field}=${q(value)}`)
    const log = (type: string, body: string) =>
      (logs.push(activity(item.id, actor, type, body, fieldBack(item.id, field, item[field] as string | null, value))), notes.push(body))
    if (field === 'status') log('status', `status ${item.status} → ${value}`)
    else if (field === 'assignee')
      log('assign', value === null ? `unassigned ${item.assignee}` : value === actor ? 'claimed' : `assigned to ${value}`)
    else if (field === 'parent') log('edit', value === null ? 'moved to top level' : `moved under ${value}`)
    else if (field === 'description') log('edit', value ? 'description updated' : 'description cleared')
    else if (field === 'note') log('edit', value === null ? 'release note cleared' : value === NO_NOTE ? 'no release note needed' : `release note: ${value}`)
    else log('edit', value === null ? `${field} cleared` : `${field} → ${value}`)
  }
  if (sets.length === 0) return { script: '', notes }
  return {
    script: `${BEGIN}
UPDATE items SET ${sets.join(', ')}, updated_at=${NOW} WHERE id=${q(item.id)};
${logs.join('\n')}
COMMIT;`,
    notes,
  }
}

// When a lease taken or renewed now runs out, as the SQL compares it.
const LEASE_CUTOFF = `strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 minutes')`

/**
 * Claims a task for `actor` in one transaction: it takes the task only when no one else holds it, the
 * holder's lease has run out (see LEASE_MS), or `force`; starts it, and starts a lease. Answers who
 * holds the task afterwards. `from` is who held it as last read, for the log of a takeover.
 */
export function claim(actor: string, id: string, force: boolean, from?: string | null, was?: Status): string {
  const note = from && from !== actor ? (force ? `took over from ${from}` : `took over stale claim from ${from}`) : 'claimed'
  // Taken back: the holder and status it had. Known only when the caller says what the task was.
  const now = was === 'todo' ? 'in_progress' : was
  const back: Back = was === undefined ? {} : {
    undo: `${guard(`EXISTS (SELECT 1 FROM items WHERE id=${q(id)} AND assignee IS ${q(actor)})`, changedSince(id, 'assignee'))}
UPDATE items SET assignee=${q(from ?? null)}, status=${q(was)}, updated_at=${NOW} WHERE id=${q(id)};`,
    redo: `${guard(`EXISTS (SELECT 1 FROM items WHERE id=${q(id)} AND assignee IS ${q(from ?? null)})`, changedSince(id, 'assignee'))}
UPDATE items SET assignee=${q(actor)}, status=${q(now)}, lease_at=${NOW}, updated_at=${NOW} WHERE id=${q(id)};`,
  }
  return `${BEGIN}
UPDATE items SET assignee=${q(actor)}, status=CASE status WHEN 'todo' THEN 'in_progress' ELSE status END,
  lease_at=${NOW}, updated_at=${NOW}
  WHERE id=${q(id)} AND (assignee IS NULL OR assignee=${q(actor)} OR ${force ? 1 : 0}
    OR (status='in_progress' AND COALESCE(lease_at, updated_at) < ${LEASE_CUTOFF}))
  -- Already theirs (handed over from the board): claiming still starts it.
  AND (assignee IS NOT ${q(actor)} OR status='todo');
INSERT INTO activity(item_id, author, type, body, op, undo, redo)
  SELECT ${q(id)}, ${q(actor)}, 'assign', ${q(note)}, (SELECT n FROM op), ${q(back.undo)}, ${q(back.redo)} WHERE changes() > 0;
COMMIT;
SELECT assignee FROM items WHERE id=${q(id)};`
}

/** Renews the leases on everything `actor` is working on: a heartbeat, so it leaves no trace in the timeline. */
export const renew = (actor: string) =>
  `UPDATE items SET lease_at=${NOW} WHERE assignee=${q(actor)} AND status='in_progress' AND kind='task';`

export const comment = (actor: string, id: string, body: string, type: 'comment' | 'handoff' = 'comment') =>
  `${BEGIN}\n${activity(id, actor, type, body)}\nCOMMIT;`

/**
 * Deletes items and everything on them. Their removals and undos stay in the timeline, so a removal can
 * be taken back, and the taking back undone, under the removed item's id.
 */
export function removeRows(ids: string[]): string {
  const list = ids.map(q).join(', ')
  return `DELETE FROM items WHERE id IN (${list});\nDELETE FROM activity WHERE item_id IN (${list}) AND type NOT IN ('remove', 'undo');\nDELETE FROM reads WHERE item_id IN (${list});\nDELETE FROM links WHERE blocker IN (${list}) OR blocked IN (${list});\nDELETE FROM checks WHERE item_id IN (${list});\nDELETE FROM labels WHERE item_id IN (${list});\nDELETE FROM relations WHERE a IN (${list}) OR b IN (${list});`
}

/**
 * Removes items (a subtree, its root first). With `log`, the removal is logged on the root with what
 * restores it: `rows`, everything on those items as `dump` read it.
 */
export function remove(ids: string[], log?: { actor: string; body: string; rows: Rows }): string {
  const logged = log ? activity(ids[0]!, log.actor, 'remove', log.body, { undo: restore(log.rows), redo: removeRows(ids) }) : ''
  return `${BEGIN}\n${removeRows(ids)}\n${logged}\nCOMMIT;`
}

/** Every table's columns, as `dump` reads and `restore` writes them. */
export const TABLES = {
  items: ['id', 'kind', 'title', 'status', 'parent', 'description', 'assignee', 'due', 'priority', 'type', 'note', 'section', 'lease_at', 'created_at', 'updated_at'],
  activity: ['id', 'item_id', 'author', 'type', 'body', 'at', 'undo', 'redo', 'op', 'undone', 'reverts'],
  links: ['blocker', 'blocked'],
  checks: ['item_id', 'n', 'text', 'done'],
  labels: ['item_id', 'label'],
  relations: ['a', 'b', 'type'],
  reads: ['reader', 'item_id', 'seen'],
  counters: ['prefix', 'n'],
} as const

export type Table = keyof typeof TABLES
/** Rows by table, as `dump` answers them. */
export type Rows = Partial<Record<Table, Record<string, string | number | null>[]>>

/** Which rows of each table belong to the items in `list` (a SQL list of ids). */
const OWNED: Record<Exclude<Table, 'counters'>, (list: string) => string> = {
  items: list => `id IN (${list})`,
  activity: list => `item_id IN (${list})`,
  links: list => `blocker IN (${list}) OR blocked IN (${list})`,
  checks: list => `item_id IN (${list})`,
  labels: list => `item_id IN (${list})`,
  relations: list => `a IN (${list}) OR b IN (${list})`,
  reads: list => `item_id IN (${list})`,
}

/** Reads every row on the items `ids` (all of the roadmap, counters too, when absent) as JSON: Rows. */
export function dump(ids?: string[]): string {
  const list = ids?.map(q).join(', ')
  const tables = (Object.keys(TABLES) as Table[]).filter(table => !ids || table !== 'counters')
  const parts = tables.map(table => {
    const cols = TABLES[table].map(col => `'${col}', ${col}`).join(', ')
    const where = ids && table !== 'counters' ? ` WHERE ${OWNED[table](list!)}` : ''
    return `'${table}', (SELECT json_group_array(json_object(${cols})) FROM ${table}${where})`
  })
  return `SELECT json_object(${parts.join(',\n  ')});`
}

/**
 * Statements writing `rows` back, leaving rows that are already there alone (counters move up to the
 * higher of the two). No BEGIN or COMMIT: they go inside a script of the caller's.
 */
export function restore(rows: Rows): string {
  const out: string[] = []
  for (const table of Object.keys(TABLES) as Table[]) {
    const cols = TABLES[table] as readonly string[]
    for (const row of rows[table] ?? []) {
      // Only the columns the row has: one from an older schema leaves the newer ones to their defaults.
      const has = cols.filter(col => col in row)
      const values = has.map(col => q(row[col] ?? null)).join(', ')
      out.push(table === 'counters'
        ? `INSERT INTO counters(prefix, n) VALUES (${values}) ON CONFLICT(prefix) DO UPDATE SET n=MAX(n, excluded.n);`
        : `INSERT OR IGNORE INTO ${table}(${has.join(', ')}) VALUES (${values});`)
    }
  }
  return out.join('\n')
}

/** What a roadmap export holds: the schema version it was written at, when, and every row. */
export type Export = { roadmap: 'export'; schema: number; exported_at: string; tables: Rows }

/** An export of `rows` (a whole `dump`), as the text written to a file. */
export const exportOf = (rows: Rows, at: string): string =>
  `${JSON.stringify({ roadmap: 'export', schema: VERSION, exported_at: at, tables: rows } satisfies Export)}\n`

/** The rows of an export's text, or throws saying why it can't be imported here. */
export function importOf(text: string): Rows {
  let data: Partial<Export>
  try {
    data = JSON.parse(text) as Partial<Export>
  } catch {
    throw new Error('not a roadmap export: the file is not JSON')
  }
  if (data?.roadmap !== 'export' || typeof data.tables !== 'object' || data.tables === null) throw new Error('not a roadmap export')
  if (!Number.isInteger(data.schema) || data.schema! > VERSION)
    throw new Error(`the export is from a newer roadmap mod (schema v${data.schema}; this one reads up to v${VERSION}). Update the mod first`)
  for (const table of Object.keys(data.tables)) if (!(table in TABLES)) throw new Error(`not a roadmap export: unknown table ${table}`)
  return data.tables
}

/** How many items and log entries a roadmap holds; an import goes only into one holding neither. */
export const COUNT = `SELECT (SELECT count(*) FROM items) || ' ' || (SELECT count(*) FROM activity);`

/** Writes an export's rows into an empty roadmap, in one transaction. */
export const importRows = (rows: Rows) => `BEGIN IMMEDIATE;\n${restore(rows)}\nCOMMIT;`

/** A logged entry as `entries` reads it: what undo needs. */
export type Entry = { id: number; item_id: string; author: string; type: string; body: string; at: string; op: number | null; undo: string | null; redo: string | null; undone: number | null; reverts: number | null }

/** Reads the entries `ids` as a JSON list of Entry. */
export const entries = (ids: number[]) =>
  `SELECT json_group_array(json_object('id', id, 'item_id', item_id, 'author', author, 'type', type, 'body', body, 'at', at,
    'op', op, 'undo', undo, 'redo', redo, 'undone', undone, 'reverts', reverts))
  FROM activity WHERE id IN (${ids.map(id => Math.trunc(id)).join(', ') || 'NULL'});`

/** A comment taken back, and written again as it was, under its own id. */
export const unsay = (one: Entry) => `DELETE FROM activity WHERE id=${Math.trunc(one.id)};`
export const resay = (one: Entry) =>
  `INSERT OR IGNORE INTO activity(id, item_id, author, type, body, at, op) VALUES (${Math.trunc(one.id)}, ${q(one.item_id)}, ${q(one.author)}, ${q(one.type)}, ${q(one.body)}, ${q(one.at)}, ${q(one.op)});`

/**
 * Reverts entries as `actor`, newest first, in one transaction that fails whole when anything changed
 * since (`stamp`) or any of them no longer can be. Each is logged as an undo, which can itself be undone:
 * its undo is the entry's redo, and the other way round.
 */
export function revert(actor: string, list: { entry: Entry; undo: string; redo: string }[], stamp: string): string {
  const parts = [...list].sort((a, b) => b.entry.id - a.entry.id).map(({ entry, undo, redo }) => {
    const body = entry.type === 'undo'
      ? entry.body.replace(/^(undid|redid)/, word => (word === 'undid' ? 'redid' : 'undid'))
      : `undid “${entry.body}”`
    return [
      undo,
      activity(entry.item_id, actor, 'undo', body, { undo: redo, redo: undo, reverts: entry.id }),
      `UPDATE activity SET undone=(SELECT MAX(id) FROM activity) WHERE id=${Math.trunc(entry.id)};`,
      // Redone: what the undo took back stands again, and can be undone again.
      entry.type === 'undo' && entry.reverts ? `UPDATE activity SET undone=NULL WHERE id=${Math.trunc(entry.reverts)};` : '',
    ].filter(Boolean).join('\n')
  })
  return `${BEGIN}\n${expectStamp(stamp)}\n${parts.join('\n')}\nCOMMIT;`
}

/**
 * Scripts built here, run as one transaction: each one's own BEGIN and COMMIT lines dropped (text never
 * makes such a line: `q` splices its newlines in as char(10)). Empty ones are skipped.
 */
export function atomic(scripts: string[]): string {
  const bodies = scripts.filter(Boolean).map(one => one.split('\n').filter(line => line !== 'BEGIN IMMEDIATE;' && line !== OP && line !== 'COMMIT;').join('\n'))
  return bodies.length ? `${BEGIN}\n${bodies.join('\n')}\nCOMMIT;` : ''
}

/** Marks everything on an item as seen by `reader`, up to its newest activity. */
export const markSeen = (reader: string, id: string) =>
  `INSERT INTO reads(reader, item_id, seen) VALUES (${q(reader)}, ${q(id)},
  (SELECT COALESCE(MAX(id), 0) FROM activity WHERE item_id=${q(id)}))
  ON CONFLICT(reader, item_id) DO UPDATE SET seen=excluded.seen;`

/** The script setting what `item` waits on to exactly `next`, logging each link made or dropped; none when unchanged. */
export function setBlockers(actor: string, item: Item, next: string[]): { script: string; notes: string[] } {
  const added = next.filter(id => !item.blocked_by.includes(id))
  const dropped = item.blocked_by.filter(id => !next.includes(id))
  const notes = [...added.map(id => `blocked by ${id}`), ...dropped.map(id => `no longer blocked by ${id}`)]
  if (notes.length === 0) return { script: '', notes }
  const logs = [
    ...added.map(id => activity(item.id, actor, 'edit', `blocked by ${id}`, { undo: link(id, item.id, false), redo: link(id, item.id, true) })),
    ...dropped.map(id => activity(item.id, actor, 'edit', `no longer blocked by ${id}`, { undo: link(id, item.id, true), redo: link(id, item.id, false) })),
  ]
  return {
    script: `${BEGIN}
${dropped.map(id => link(id, item.id, false)).join('\n')}
${added.map(id => link(id, item.id, true)).join('\n')}
${logs.join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
COMMIT;`,
    notes,
  }
}

/** The note of a task whose work needs no line in the CHANGELOG. */
export const NO_NOTE = '-'

/** A label as stored: lowercase, words joined by hyphens, no leading `#`. */
export const label = (text: string) => text.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')

/** The script setting an item's labels to exactly `next`, logging the new set; none when unchanged. */
export function setLabels(actor: string, item: Item, next: string[]): { script: string; notes: string[] } {
  const wanted = [...new Set(next.map(label).filter(Boolean))].sort()
  if (wanted.join('\n') === [...item.labels].sort().join('\n')) return { script: '', notes: [] }
  const notes = [wanted.length ? `labels: ${wanted.join(', ')}` : 'labels cleared']
  const back = (from: string[], to: string[]) => `${guard(labelsAre(item.id, from), changedSince(item.id, 'labels'))}\n${writeLabels(item.id, to)}`
  return {
    script: `${BEGIN}
${writeLabels(item.id, wanted)}
${activity(item.id, actor, 'edit', notes[0]!, { undo: back(wanted, item.labels), redo: back(item.labels, wanted) })}
COMMIT;`,
    notes,
  }
}

const RELATION_NOTE = { relates: ['relates to', 'no longer relates to'], duplicates: ['duplicate of', 'no longer a duplicate of'] }

/**
 * The script setting the links of one `type` that `item` makes to exactly `next`, logging each made or
 * dropped; none when unchanged. Marking a task a duplicate also closes it: the work lives on elsewhere.
 */
export function setRelations(actor: string, item: Item, type: Relation['type'], next: string[]): { script: string; notes: string[] } {
  const now = item.relations.filter(one => one.type === type).map(one => one.id)
  const added = next.filter(id => !now.includes(id))
  const dropped = now.filter(id => !next.includes(id))
  const [made, gone] = RELATION_NOTE[type]
  const notes = [...added.map(id => `${made} ${id}`), ...dropped.map(id => `${gone} ${id}`)]
  if (notes.length === 0) return { script: '', notes }
  const closes = type === 'duplicates' && added.length > 0 && item.kind === 'task' && item.status !== 'done'
  const logs = [
    ...added.map(id => activity(item.id, actor, 'edit', `${made} ${id}`, { undo: relation(item.id, id, type, false), redo: relation(item.id, id, type, true) })),
    ...dropped.map(id => activity(item.id, actor, 'edit', `${gone} ${id}`, { undo: relation(item.id, id, type, true), redo: relation(item.id, id, type, false) })),
  ]
  if (closes) {
    notes.push(`status ${item.status} → done (closed as a duplicate)`)
    logs.push(activity(item.id, actor, 'status', notes.at(-1)!, fieldBack(item.id, 'status', item.status, 'done')))
  }
  return {
    script: `${BEGIN}
${dropped.map(id => relation(item.id, id, type, false)).join('\n')}
${added.map(id => relation(item.id, id, type, true)).join('\n')}
${logs.join('\n')}
UPDATE items SET ${closes ? "status='done', " : ''}updated_at=${NOW} WHERE id=${q(item.id)};
COMMIT;`,
    notes,
  }
}

/**
 * The script replacing an item's checklist with `texts`, in order. An entry whose text was already on the
 * list keeps its tick, so rewording one item or adding another never unchecks the rest.
 */
export function setChecklist(actor: string, item: Item, texts: string[]): { script: string; notes: string[] } {
  const next = setChecklistPreview(item, texts)
  const same = next.length === item.checklist.length && next.every((c, i) => c.text === item.checklist[i]!.text)
  if (same) return { script: '', notes: [] }
  const notes = [next.length ? `checklist set (${next.length} item${next.length === 1 ? '' : 's'})` : 'checklist cleared']
  const back = (from: Check[], to: Check[]) => `${guard(checksAre(item.id, from), changedSince(item.id, 'checklist'))}\n${writeChecks(item.id, to)}`
  return {
    script: `${BEGIN}
${writeChecks(item.id, next)}
${activity(item.id, actor, 'edit', notes[0]!, { undo: back(next, item.checklist), redo: back(item.checklist, next) })}
COMMIT;`,
    notes,
  }
}

/** The checklist `setChecklist` would leave, ticks carried over, without writing it. */
export function setChecklistPreview(item: Item, texts: string[]): Check[] {
  const wasDone = new Set(item.checklist.filter(c => c.done).map(c => c.text))
  return texts.map((text, i) => ({ n: i + 1, text, done: wasDone.has(text) }))
}

/** The script ticking (or unticking) checklist entries `ns`; entries already so are left alone. */
export function check(actor: string, item: Item, ns: number[], done: boolean): { script: string; notes: string[] } {
  const changing = item.checklist.filter(c => ns.includes(c.n) && c.done !== done)
  const notes = changing.map(c => `${done ? 'checked' : 'unchecked'} ${c.n}. ${c.text}`)
  if (notes.length === 0) return { script: '', notes }
  return {
    script: `${BEGIN}
UPDATE checks SET done=${done ? 1 : 0} WHERE item_id=${q(item.id)} AND n IN (${changing.map(c => c.n).join(', ')});
${changing.map((c, i) => activity(item.id, actor, 'edit', notes[i]!, { undo: tick(item.id, c.n, done, c.done), redo: tick(item.id, c.n, c.done, done) })).join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
COMMIT;`,
    notes,
  }
}
