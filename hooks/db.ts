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
]

/** The schema version this build of the mod reads and writes. */
export const VERSION = MIGRATIONS.length

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

/** A script's answer: what its last statement printed. */
export const answer = (stdout: string) => stdout.trim().split('\n').at(-1) ?? ''

const activity = (id: string, author: string, type: string, body: string) =>
  `INSERT INTO activity(item_id, author, type, body) VALUES (${q(id)}, ${q(author)}, ${q(type)}, ${q(body)});`

/** Loads the roadmap, with what `reader` has seen of each item. */
export const load = (reader: string) => `SELECT json_object(
      'items', (SELECT json_group_array(json_object('id', id, 'kind', kind, 'title', title, 'status', status,
        'parent', parent, 'description', description, 'assignee', assignee, 'due', due,
        'priority', priority, 'type', type, 'lease_at', lease_at, 'created_at', created_at, 'updated_at', updated_at,
        'labels', json((SELECT json_group_array(label) FROM (SELECT label FROM labels WHERE item_id=items.id ORDER BY label))),
        'relations', json((SELECT json_group_array(json_object('type', type, 'id', b)) FROM relations WHERE a=items.id)),
        'blocked_by', json((SELECT json_group_array(blocker) FROM links WHERE blocked=items.id)),
        'checklist', json((SELECT json_group_array(json_object('n', n, 'text', text, 'done', done))
          FROM checks WHERE item_id=items.id)))) FROM items),
      'activity', (SELECT json_group_array(json_object('id', id, 'item_id', item_id, 'author', author,
        'type', type, 'body', body, 'at', at)) FROM (SELECT * FROM activity ORDER BY id DESC LIMIT 500)),
      'seen', (SELECT json_group_object(item_id, seen) FROM reads WHERE reader=${q(reader)}));`

export function parseLoad(out: string): Snapshot {
  const data = JSON.parse(out) as Snapshot
  // sqlite3 hands back `done` as 0/1, and json_group_array keeps no order of its own.
  const items = data.items.map(item => ({
    ...item,
    labels: item.labels ?? [],
    relations: item.relations ?? [],
    checklist: (item.checklist ?? []).map(c => ({ ...c, done: Boolean(c.done) })).sort((a, b) => a.n - b.n),
  }))
  return { items, activity: data.activity, seen: data.seen ?? {} }
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
  return `BEGIN IMMEDIATE;
INSERT INTO counters(prefix, n) VALUES (${q(prefix)},
  COALESCE((SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) FROM items WHERE SUBSTR(id, 1, 1)=${q(prefix)}), 0) + 1)
  ON CONFLICT(prefix) DO UPDATE SET n = n + 1;
INSERT INTO items(id, kind, title, status, parent, description, assignee, due, priority, type) VALUES (${id}, ${q(item.kind)},
  ${q(item.title)}, ${q(item.status ?? 'todo')}, ${q(item.parent)}, ${q(item.description || null)},
  ${q(item.assignee || null)}, ${q(item.due || null)}, ${q(item.priority ?? 'p2')}, ${q(item.type ?? 'feature')});
INSERT INTO activity(item_id, author, type, body) VALUES (${id}, ${q(actor)}, 'create', ${q(created)});
SELECT ${id};
COMMIT;`
}

export type Changes = Partial<Pick<Item, 'title' | 'status' | 'parent' | 'description' | 'assignee' | 'due' | 'priority' | 'type'>>

/** The script writing the changes, logging one activity entry per field changed, and those entries; none when nothing changes. */
export function change(actor: string, item: Item, changes: Changes): { script: string; notes: string[] } {
  const sets: string[] = []
  const logs: string[] = []
  const notes: string[] = []
  const log = (type: string, body: string) => (logs.push(activity(item.id, actor, type, body)), notes.push(body))
  for (const [field, value] of Object.entries(changes) as [keyof Changes, string | null][]) {
    if (value === undefined || value === item[field]) continue
    sets.push(`${field}=${q(value)}`)
    if (field === 'status') log('status', `status ${item.status} → ${value}`)
    else if (field === 'assignee')
      log('assign', value === null ? `unassigned ${item.assignee}` : value === actor ? 'claimed' : `assigned to ${value}`)
    else if (field === 'parent') log('edit', value === null ? 'moved to top level' : `moved under ${value}`)
    else if (field === 'description') log('edit', value ? 'description updated' : 'description cleared')
    else log('edit', value === null ? `${field} cleared` : `${field} → ${value}`)
  }
  if (sets.length === 0) return { script: '', notes }
  return {
    script: `BEGIN IMMEDIATE;
UPDATE items SET ${sets.join(', ')}, updated_at=${NOW} WHERE id=${q(item.id)};
${logs.join('\n')}
COMMIT;`,
    notes,
  }
}

/**
 * Claims a task for `actor` in one transaction: it takes the task only when no one else holds it
 * (or `force`), and starts it. Answers who holds the task afterwards.
 */
export function claim(actor: string, id: string, force: boolean): string {
  return `BEGIN IMMEDIATE;
UPDATE items SET assignee=${q(actor)}, status=CASE status WHEN 'todo' THEN 'in_progress' ELSE status END, updated_at=${NOW}
  WHERE id=${q(id)} AND (assignee IS NULL OR assignee=${q(actor)} OR ${force ? 1 : 0})
  -- Already theirs (handed over from the board): claiming still starts it.
  AND (assignee IS NOT ${q(actor)} OR status='todo');
INSERT INTO activity(item_id, author, type, body) SELECT ${q(id)}, ${q(actor)}, 'assign', 'claimed' WHERE changes() > 0;
COMMIT;
SELECT assignee FROM items WHERE id=${q(id)};`
}

export const comment = (actor: string, id: string, body: string) =>
  `BEGIN IMMEDIATE;\n${activity(id, actor, 'comment', body)}\nCOMMIT;`

export function remove(ids: string[]): string {
  const list = ids.map(q).join(', ')
  return `BEGIN IMMEDIATE;\nDELETE FROM items WHERE id IN (${list});\nDELETE FROM activity WHERE item_id IN (${list});\nDELETE FROM reads WHERE item_id IN (${list});\nDELETE FROM links WHERE blocker IN (${list}) OR blocked IN (${list});\nDELETE FROM checks WHERE item_id IN (${list});\nDELETE FROM labels WHERE item_id IN (${list});\nDELETE FROM relations WHERE a IN (${list}) OR b IN (${list});\nCOMMIT;`
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
  return {
    script: `BEGIN IMMEDIATE;
${dropped.map(id => `DELETE FROM links WHERE blocker=${q(id)} AND blocked=${q(item.id)};`).join('\n')}
${added.map(id => `INSERT OR IGNORE INTO links(blocker, blocked) VALUES (${q(id)}, ${q(item.id)});`).join('\n')}
${notes.map(note => activity(item.id, actor, 'edit', note)).join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
COMMIT;`,
    notes,
  }
}

/** A label as stored: lowercase, words joined by hyphens, no leading `#`. */
export const label = (text: string) => text.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')

/** The script setting an item's labels to exactly `next`, logging the new set; none when unchanged. */
export function setLabels(actor: string, item: Item, next: string[]): { script: string; notes: string[] } {
  const wanted = [...new Set(next.map(label).filter(Boolean))].sort()
  if (wanted.join('\n') === [...item.labels].sort().join('\n')) return { script: '', notes: [] }
  const notes = [wanted.length ? `labels: ${wanted.join(', ')}` : 'labels cleared']
  return {
    script: `BEGIN IMMEDIATE;
DELETE FROM labels WHERE item_id=${q(item.id)};
${wanted.map(one => `INSERT INTO labels(item_id, label) VALUES (${q(item.id)}, ${q(one)});`).join('\n')}
${activity(item.id, actor, 'edit', notes[0]!)}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
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
  if (closes) notes.push(`status ${item.status} → done (closed as a duplicate)`)
  return {
    script: `BEGIN IMMEDIATE;
${dropped.map(id => `DELETE FROM relations WHERE a=${q(item.id)} AND b=${q(id)} AND type=${q(type)};`).join('\n')}
${added.map(id => `INSERT OR IGNORE INTO relations(a, b, type) VALUES (${q(item.id)}, ${q(id)}, ${q(type)});`).join('\n')}
${notes.map(note => activity(item.id, actor, note.startsWith('status') ? 'status' : 'edit', note)).join('\n')}
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
  return {
    script: `BEGIN IMMEDIATE;
DELETE FROM checks WHERE item_id=${q(item.id)};
${next.map(c => `INSERT INTO checks(item_id, n, text, done) VALUES (${q(item.id)}, ${c.n}, ${q(c.text)}, ${c.done ? 1 : 0});`).join('\n')}
${activity(item.id, actor, 'edit', notes[0]!)}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
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
    script: `BEGIN IMMEDIATE;
UPDATE checks SET done=${done ? 1 : 0} WHERE item_id=${q(item.id)} AND n IN (${changing.map(c => c.n).join(', ')});
${notes.map(note => activity(item.id, actor, 'edit', note)).join('\n')}
UPDATE items SET updated_at=${NOW} WHERE id=${q(item.id)};
COMMIT;`,
    notes,
  }
}
