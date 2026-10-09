// Runs the SQL hooks/db.ts generates against a real sqlite3, in a fresh temporary project per test.
// `claude plugin test` has no processes, so this runs under Node instead:
//
//   node --test tests/sql.integration.mjs
//
// Node strips the TypeScript itself; the resolver below adds the `.ts` the mod's imports leave out.
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw err
    }
  },
})
const db = await import('../hooks/db.ts')
const { letGo, nextUp } = await import('../hooks/model.ts')

let dir
beforeEach(() => {
  isMigrated = false
  dir = mkdtempSync(join(tmpdir(), 'roadmap-sql-'))
  execFileSync('mkdir', ['-p', join(dir, '.claude')])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** What the mod's `run()` does, minus `$`: one script through sqlite3, answering its last output. */
const raw = script => db.answer(execFileSync(db.ARGV[0], db.ARGV.slice(1), { cwd: dir, input: script, encoding: 'utf8' }))
const rawAsync = async script => {
  const child = promisify(execFile)(db.ARGV[0], db.ARGV.slice(1), { cwd: dir, encoding: 'utf8' })
  child.child.stdin.end(script)
  return db.answer((await child).stdout)
}
/** What the mod's `sql()` does: the database brought to this build's version first, as on first use. */
let isMigrated = false
const ready = () => {
  if (!isMigrated) raw(db.migrate(Number(raw(db.READ_VERSION))))
  isMigrated = true
}
const sql = script => (ready(), raw(script))
const sqlAsync = async script => (ready(), rawAsync(script))
const load = () => db.parseLoad(sql(db.load('user')))
const item = id => load().items.find(one => one.id === id)
const log = id => load().activity.filter(one => one.item_id === id).sort((a, b) => a.id - b.id).map(one => `${one.author}: ${one.body}`)

test('a fresh database loads empty', () => {
  assert.deepEqual(load(), { items: [], activity: [], seen: {} })
})

test('insert numbers each kind on its own and logs the creation', () => {
  assert.equal(sql(db.insert('claude', { kind: 'milestone', title: 'v1', parent: null, due: '2026-12-01' })), 'M1')
  assert.equal(sql(db.insert('claude', { kind: 'epic', title: 'Auth', parent: 'M1' })), 'E1')
  assert.equal(sql(db.insert('user', { kind: 'task', title: 'Login', parent: 'E1', assignee: 'claude' })), 'T1')
  assert.equal(sql(db.insert('claude', { kind: 'task', title: 'Logout', parent: 'E1' })), 'T2')
  assert.equal(item('M1').due, '2026-12-01')
  assert.equal(item('T1').assignee, 'claude')
  assert.equal(item('T2').status, 'todo')
  assert.deepEqual(log('T1'), ['user: created task “Login”, assigned to claude'])
})

test('ids are never reused after a removal', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: null }))
  sql(db.remove(['T2']))
  assert.equal(sql(db.insert('claude', { kind: 'task', title: 'c', parent: null })), 'T3')
})

test('remove takes the items and their timelines', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.comment('claude', 'T1', 'note'))
  sql(db.remove(['T1']))
  assert.deepEqual(load(), { items: [], activity: [], seen: {} })
})

test('change writes only what changed, one timeline entry per field', () => {
  sql(db.insert('claude', { kind: 'epic', title: 'E', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'old', parent: null, description: 'desc' }))
  const before = item('T1')
  const { script, notes } = db.change('user', before, {
    title: 'new', status: 'blocked', parent: 'E1', description: null, assignee: 'claude', due: before.due,
  })
  sql(script)
  const after = item('T1')
  assert.deepEqual(
    [after.title, after.status, after.parent, after.description, after.assignee],
    ['new', 'blocked', 'E1', null, 'claude'],
  )
  assert.equal(notes.length, 5)
  assert.deepEqual(log('T1').slice(1), notes.map(note => `user: ${note}`))
  assert.deepEqual(db.change('user', after, { title: 'new' }), { script: '', notes: [] })
})

test('claim takes a free task and starts it; someone else is refused unless forced', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  assert.equal(sql(db.claim('explorer', 'T1', false)), 'explorer')
  assert.equal(item('T1').status, 'in_progress')
  assert.equal(sql(db.claim('claude', 'T1', false)), 'explorer')
  assert.equal(sql(db.claim('claude', 'T1', true)), 'claude')
  assert.deepEqual(log('T1').slice(1), ['explorer: claimed', 'claude: claimed'])
})

test('claim starts a task already handed to the claimer (T7 regression)', () => {
  sql(db.insert('user', { kind: 'task', title: 't', parent: null, assignee: 'claude' }))
  assert.equal(sql(db.claim('claude', 'T1', false)), 'claude')
  assert.equal(item('T1').status, 'in_progress')
  // Claiming again changes nothing and logs nothing.
  sql(db.claim('claude', 'T1', false))
  assert.equal(log('T1').length, 2)
})

test('a released task goes back to todo, where next offers it to the next agent', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  sql(db.claim('explorer', 'T1', false))
  sql(db.change('explorer', item('T1'), letGo(item('T1'))).script)
  assert.deepEqual([item('T1').status, item('T1').assignee], ['todo', null])
  assert.deepEqual(log('T1').slice(2), ['explorer: unassigned explorer', 'explorer: status in_progress → todo'])
  assert.deepEqual(nextUp(load().items, 'claude').map(one => one.id), ['T1'])
  // Blocked work keeps its status: it still waits on something.
  sql(db.claim('claude', 'T1', false))
  sql(db.change('claude', item('T1'), { status: 'blocked' }).script)
  sql(db.change('claude', item('T1'), letGo(item('T1'))).script)
  assert.deepEqual([item('T1').status, item('T1').assignee], ['blocked', null])
})

test('atomic runs several scripts as one transaction: all of them land, or none', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'u', parent: null }))
  const t1 = item('T1')
  const both = db.atomic([db.change('claude', t1, { title: 'renamed' }).script, '', db.setBlockers('claude', t1, ['T2']).script])
  assert.equal(both.match(/BEGIN/g).length, 1)
  sql(both)
  assert.deepEqual([item('T1').title, item('T1').blocked_by], ['renamed', ['T2']])
  // A statement that fails part way leaves what came before it unwritten.
  const broken = db.atomic([db.change('claude', item('T1'), { title: 'again' }).script, 'BEGIN IMMEDIATE;\nINSERT INTO nowhere VALUES (1);\nCOMMIT;'])
  assert.throws(() => sql(broken))
  assert.equal(item('T1').title, 'renamed')
  assert.equal(db.atomic(['', '']), '')
})

test("the snapshot carries each item's recent timeline and latest handoff; history and said read all of it", () => {
  sql(db.insert('claude', { kind: 'task', title: 'busy', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'quiet', parent: null }))
  sql(db.comment('claude', 'T1', 'an old finding about zebras'))
  sql(db.comment('claude', 'T1', 'left off at the parser', 'handoff'))
  for (let i = 0; i < db.RECENT + 5; i++) sql(db.comment('claude', 'T1', `note ${i}`))
  const loaded = load().activity
  const busy = loaded.filter(one => one.item_id === 'T1')
  // The newest RECENT, and the handoff note though it is older.
  assert.equal(busy.length, db.RECENT + 1)
  assert.ok(busy.some(one => one.type === 'handoff'))
  assert.ok(!busy.some(one => one.body.includes('zebras')))
  assert.equal(loaded.filter(one => one.item_id === 'T2').length, 1)
  const all = JSON.parse(sql(db.history('T1')))
  assert.equal(all.length, db.RECENT + 8)
  assert.deepEqual(all.map(one => one.id), [...all.map(one => one.id)].sort((a, b) => a - b))
  const said = JSON.parse(sql(db.said))
  assert.ok(said.T1.includes('zebras') && said.T1.includes('left off at the parser'))
  assert.equal(said.T2, undefined)
})

test('a batch replays its writes in one transaction, only on the database it was tried against', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  const stamp = sql(db.STAMP)
  // What a batch tried: a claim (whose script ends in a read), a comment and a new task.
  const writes = [db.claim('claude', 'T1', false), db.comment('claude', 'T1', 'on it'), db.insert('claude', { kind: 'task', title: 'u', parent: null })]
  const script = db.atomic([db.expectStamp(stamp), ...writes])
  assert.equal(script.match(/^BEGIN/gm).length, 1)
  assert.equal(script.match(/^COMMIT;$/gm).length, 1)
  sql(script)
  assert.deepEqual([item('T1').assignee, item('T1').status, item('T2').title], ['claude', 'in_progress', 'u'])
  assert.deepEqual(log('T1').slice(1), ['claude: claimed', 'claude: on it'])
  // Someone wrote since: the replay rolls back whole.
  const old = sql(db.STAMP)
  sql(db.comment('user', 'T1', 'meanwhile'))
  assert.throws(() => sql(db.atomic([db.expectStamp(old), db.comment('claude', 'T1', 'late'), db.insert('claude', { kind: 'task', title: 'v', parent: null })])))
  assert.equal(item('T3'), undefined)
  assert.ok(!log('T1').includes('claude: late'))
})

test('quotes, newlines and dot-command lines round-trip as plain text', () => {
  const nasty = `it's "quoted"\n.tables\n.shell echo pwned\n'); DROP TABLE items; --\nend`
  sql(db.insert('claude', { kind: 'task', title: nasty, parent: null, description: nasty }))
  sql(db.comment('claude', 'T1', nasty))
  assert.equal(item('T1').title, nasty)
  assert.equal(item('T1').description, nasty)
  assert.equal(load().activity.find(one => one.type === 'comment').body, nasty)
  assert.equal(load().items.length, 1)
})

test('parallel writers each get their own id', async () => {
  const ids = await Promise.all(
    Array.from({ length: 12 }, (_, i) => sqlAsync(db.insert(`agent-${i}`, { kind: 'task', title: `t${i}`, parent: null }))),
  )
  assert.deepEqual([...ids].sort(), Array.from({ length: 12 }, (_, i) => `T${i + 1}`).sort())
  assert.equal(load().items.length, 12)
})

test('read marks are per reader, move up to the newest entry, and go with the item', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  sql(db.comment('claude', 'T1', 'first'))
  sql(db.markSeen('user', 'T1'))
  const seen = load().seen.T1
  assert.equal(seen, Math.max(...load().activity.map(one => one.id)))
  sql(db.comment('claude', 'T1', 'second'))
  assert.equal(load().seen.T1, seen)
  assert.deepEqual(db.parseLoad(sql(db.load('someone-else'))).seen, {})
  sql(db.markSeen('user', 'T1'))
  assert.ok(load().seen.T1 > seen)
  sql(db.remove(['T1']))
  assert.deepEqual(load().seen, {})
})

test('blockers load onto the task, change as a set, log each link, and go when either end is removed', () => {
  for (const title of ['a', 'b', 'c']) sql(db.insert('claude', { kind: 'task', title, parent: null }))
  let t3 = item('T3')
  assert.deepEqual(t3.blocked_by, [])
  let { script, notes } = db.setBlockers('claude', t3, ['T1', 'T2'])
  sql(script)
  t3 = item('T3')
  assert.deepEqual([...t3.blocked_by].sort(), ['T1', 'T2'])
  assert.deepEqual(notes, ['blocked by T1', 'blocked by T2'])
  ;({ script, notes } = db.setBlockers('user', t3, ['T2']))
  sql(script)
  assert.deepEqual(item('T3').blocked_by, ['T2'])
  assert.deepEqual(log('T3').slice(-1), ['user: no longer blocked by T1'])
  assert.deepEqual(db.setBlockers('user', item('T3'), ['T2']), { script: '', notes: [] })
  sql(db.remove(['T2']))
  assert.deepEqual(item('T3').blocked_by, [])
})

test('checklists load in order as booleans, keep ticks across rewrites, and go with the item', () => {
  sql(db.insert('claude', { kind: 'task', title: 't', parent: null }))
  let { script, notes } = db.setChecklist('claude', item('T1'), ['a', 'b', 'c'])
  sql(script)
  assert.deepEqual(notes, ['checklist set (3 items)'])
  assert.deepEqual(item('T1').checklist, [
    { n: 1, text: 'a', done: false }, { n: 2, text: 'b', done: false }, { n: 3, text: 'c', done: false },
  ])
  ;({ script, notes } = db.check('user', item('T1'), [1, 3], true))
  sql(script)
  assert.deepEqual(notes, ['checked 1. a', 'checked 3. c'])
  assert.deepEqual(item('T1').checklist.map(c => c.done), [true, false, true])
  assert.deepEqual(db.check('user', item('T1'), [1], true), { script: '', notes: [] })
  // Reworded b, dropped c, added d: a keeps its tick.
  sql(db.setChecklist('claude', item('T1'), ['a', 'b!', 'd']).script)
  assert.deepEqual(item('T1').checklist.map(c => [c.text, c.done]), [['a', true], ['b!', false], ['d', false]])
  assert.deepEqual(db.setChecklist('claude', item('T1'), ['a', 'b!', 'd']), { script: '', notes: [] })
  sql(db.remove(['T1']))
  sql(db.insert('claude', { kind: 'task', title: 'again', parent: null }))
  assert.deepEqual(item('T2').checklist, [])
})

test('a fresh database starts at version 0 and migrates to this build\'s version', () => {
  assert.equal(raw(db.READ_VERSION), '0')
  raw(db.migrate(0))
  assert.equal(Number(raw(db.READ_VERSION)), db.VERSION)
  assert.equal(raw("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('items','counters','activity','links','checks','reads');"), '6')
  assert.equal(raw('PRAGMA journal_mode;'), 'wal')
})

test('a database from before versioning adopts the schema with its data kept', () => {
  // As the mod left databases until now: the tables, data in them, no version recorded.
  raw(db.MIGRATIONS[0])
  raw("INSERT INTO items(id, kind, title) VALUES ('T1', 'task', 'kept');")
  assert.equal(raw(db.READ_VERSION), '0')
  raw(db.migrate(0))
  assert.equal(Number(raw(db.READ_VERSION)), db.VERSION)
  assert.equal(item('T1').title, 'kept')
})

test('a database from a newer build is refused, and an unusable version is named', () => {
  raw(db.migrate(0))
  raw(`PRAGMA user_version=${db.VERSION + 1};`)
  assert.match(db.versionProblem(Number(raw(db.READ_VERSION))), /newer roadmap mod .*Update the mod; nothing was changed/)
  assert.equal(db.versionProblem(db.VERSION), undefined)
  assert.match(db.versionProblem(NaN), /not a version/)
})

test('two sessions migrating at once both come out at the current version', async () => {
  // As ensureSchema: a session that loses the race may fail on a non-idempotent step, and then finds the
  // version current. One must win, and none may leave the database half-migrated.
  const ran = await Promise.allSettled([rawAsync(db.migrate(0)), rawAsync(db.migrate(0)), rawAsync(db.migrate(0))])
  assert.ok(ran.some(one => one.status === 'fulfilled'))
  assert.equal(Number(raw(db.READ_VERSION)), db.VERSION)
})

test('a v1 database migrates to v2 with its data kept and the new fields defaulted', () => {
  raw(`BEGIN IMMEDIATE;\n${db.MIGRATIONS[0]}\nPRAGMA user_version=1;\nCOMMIT;`)
  assert.equal(raw(db.READ_VERSION), '1')
  // Rows as a v1 build wrote them: today's insert names columns v1 doesn't have.
  raw("INSERT INTO items(id, kind, title, assignee) VALUES ('T1', 'task', 'kept', 'claude');")
  raw(db.migrate(1))
  assert.equal(Number(raw(db.READ_VERSION)), db.VERSION)
  isMigrated = true
  const t = item('T1')
  assert.equal(t.title, 'kept')
  assert.equal(t.assignee, 'claude')
  assert.equal(t.priority, 'p2')
  assert.equal(t.type, 'feature')
  assert.equal(t.lease_at, null)
  assert.deepEqual(t.labels, [])
  assert.deepEqual(t.relations, [])
})

test('labels and relations load with their item and go with it on removal', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: null }))
  sql("INSERT INTO labels VALUES ('T1','ui'),('T1','api'); INSERT INTO relations VALUES ('T1','T2','relates'),('T2','T1','duplicates');")
  assert.deepEqual(item('T1').labels, ['api', 'ui'])
  assert.deepEqual(item('T1').relations, [{ type: 'relates', id: 'T2' }])
  sql(db.remove(['T1']))
  assert.equal(sql('SELECT count(*) FROM labels;'), '0')
  assert.equal(sql('SELECT count(*) FROM relations;'), '0')
})

test('priority and type are written on insert and changed like any field', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null, priority: 'p0', type: 'bug' }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: null }))
  assert.equal(item('T1').priority, 'p0')
  assert.equal(item('T1').type, 'bug')
  assert.equal(item('T2').priority, 'p2')
  sql(db.change('user', item('T2'), { priority: 'p1', type: 'chore' }).script)
  assert.equal(item('T2').priority, 'p1')
  assert.deepEqual(log('T2').slice(1), ['user: priority → p1', 'user: type → chore'])
})

test('labels are normalized, replaced as a set and logged; relations link, unlink, and a duplicate closes', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'c', parent: null }))
  sql(db.setLabels('claude', item('T1'), ['#UI', 'auth flow', 'ui']).script)
  assert.deepEqual(item('T1').labels, ['auth-flow', 'ui'])
  assert.deepEqual(db.setLabels('claude', item('T1'), ['ui', 'auth-flow']), { script: '', notes: [] })
  sql(db.setLabels('claude', item('T1'), []).script)
  assert.deepEqual(item('T1').labels, [])
  sql(db.setRelations('claude', item('T1'), 'relates', ['T2', 'T3']).script)
  sql(db.setRelations('claude', item('T1'), 'relates', ['T3']).script)
  assert.deepEqual(item('T1').relations, [{ type: 'relates', id: 'T3' }])
  sql(db.setRelations('user', item('T2'), 'duplicates', ['T3']).script)
  assert.equal(item('T2').status, 'done')
  assert.deepEqual(log('T1').slice(1), ['claude: labels: auth-flow, ui', 'claude: labels cleared', 'claude: relates to T2', 'claude: relates to T3', 'claude: no longer relates to T2'])
  assert.deepEqual(log('T2').slice(1), ['user: duplicate of T3', 'user: status todo → done (closed as a duplicate)'])
})

test('a claim starts a lease; a live one holds, a stale one is taken over and logged, and renew keeps it alive', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  assert.equal(sql(db.claim('explore:a', 'T1', false)), 'explore:a')
  assert.ok(item('T1').lease_at)
  // Live: someone else is refused.
  assert.equal(sql(db.claim('claude', 'T1', false, 'explore:a')), 'explore:a')
  // Gone quiet for 31 minutes: renew only touches the holder's own claims, and the claim goes through.
  sql("UPDATE items SET lease_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-31 minutes');")
  sql(db.renew('someone-else'))
  assert.equal(sql(db.claim('claude', 'T1', false, 'explore:a')), 'claude')
  assert.equal(item('T1').status, 'in_progress')
  assert.deepEqual(log('T1').slice(1), ['explore:a: claimed', 'claude: took over stale claim from explore:a'])
  // The new holder's heartbeat moves the lease on.
  sql("UPDATE items SET lease_at='2000-01-01T00:00:00Z';")
  sql(db.renew('claude'))
  assert.notEqual(item('T1').lease_at, '2000-01-01T00:00:00Z')
  assert.equal(sql(db.claim('explore:a', 'T1', false, 'claude')), 'claude')
})

test('a claim from before leases counts its last change as the heartbeat', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null, assignee: 'old', status: 'in_progress' }))
  assert.equal(item('T1').lease_at, null)
  assert.equal(sql(db.claim('claude', 'T1', false, 'old')), 'old')
  sql("UPDATE items SET updated_at='2000-01-01T00:00:00Z';")
  assert.equal(sql(db.claim('claude', 'T1', false, 'old')), 'claude')
})

test('v3: milestones and epics already finished keep reading done; open ones are left as they were', () => {
  raw(`BEGIN IMMEDIATE;\n${db.MIGRATIONS.slice(0, 2).join('\n')}\nPRAGMA user_version=2;\nCOMMIT;`)
  raw(`INSERT INTO items(id, kind, title, parent, assignee) VALUES ('M1','milestone','m',NULL,'claude'), ('E1','epic','e','M1',NULL),
    ('T1','task','a','E1',NULL), ('M2','milestone','open',NULL,'claude'), ('T2','task','b','M2',NULL);
    UPDATE items SET status='done' WHERE id='T1';`)
  raw(db.migrate(2))
  isMigrated = true
  assert.equal(item('M1').status, 'done')
  assert.equal(item('E1').status, 'done')
  assert.equal(item('M2').status, 'todo')
})

// Undo, as register.tsx's `undo` does it: comments and adds worked out at revert time, the rest stored.
const entries = () => JSON.parse(sql('SELECT json_group_array(json_object(\'id\', id, \'op\', op, \'type\', type, \'body\', body, \'undone\', undone)) FROM (SELECT * FROM activity ORDER BY id);'))
const lastOp = () => {
  const all = entries()
  const op = all.at(-1).op
  return all.filter(one => one.op === op).map(one => one.id)
}
const revert = (ids, actor = 'user') => {
  const stamp = sql(db.STAMP)
  const found = JSON.parse(sql(db.entries(ids)))
  const list = found.map(entry =>
    entry.type === 'comment' || entry.type === 'handoff' ? { entry, undo: db.unsay(entry), redo: db.resay(entry) }
    : entry.type === 'create' ? { entry, undo: db.removeRows([entry.item_id]), redo: db.restore(JSON.parse(sql(db.dump([entry.item_id])))) }
    : { entry, undo: entry.undo, redo: entry.redo })
  return sql(db.revert(actor, list, stamp))
}
const fields = one => one && Object.fromEntries(Object.entries(one).filter(([key]) => key !== 'updated_at' && key !== 'lease_at'))

test('undo: a change of several fields is one op, reverted exactly; the undo is logged, and undone puts it back', () => {
  sql(db.insert('claude', { kind: 'epic', title: 'E', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'old', parent: null, description: 'line one\nline two', due: '2026-12-01' }))
  const before = fields(item('T1'))
  sql(db.change('user', item('T1'), { title: 'new', status: 'blocked', parent: 'E1', description: null, assignee: 'claude', due: null, priority: 'p0', type: 'bug' }).script)
  const changed = fields(item('T1'))
  const op = lastOp()
  assert.equal(op.length, 8)
  revert(op)
  assert.deepEqual(fields(item('T1')), before)
  // Each undo is logged, naming what it took back; the entries it reverted read as undone.
  const undos = entries().filter(one => one.type === 'undo')
  assert.equal(undos.length, 8)
  assert.ok(undos.some(one => one.body === 'undid “title → new”'))
  assert.ok(entries().filter(one => op.includes(one.id)).every(one => one.undone))
  // Undoing the undo makes the change again, and the original can be undone once more.
  revert(lastOp())
  assert.deepEqual(fields(item('T1')), changed)
  assert.ok(entries().some(one => one.body === 'redid “title → new”'))
  assert.ok(entries().filter(one => op.includes(one.id)).every(one => !one.undone))
  revert(op)
  assert.deepEqual(fields(item('T1')), before)
})

test('undo is refused when what the change set has changed since, and writes nothing', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.change('user', item('T1'), { title: 'b' }).script)
  const first = lastOp()
  sql(db.change('claude', item('T1'), { title: 'c' }).script)
  const count = entries().length
  assert.throws(() => revert(first), err => db.guardReason(String(err.stderr ?? err.message)) === "T1's title has changed since; change it directly")
  assert.equal(item('T1').title, 'c')
  assert.equal(entries().length, count)
  // A revert also fails whole when anyone wrote after it was read.
  assert.throws(() => sql(db.revert('user', [], '1')))
})

test('undo of ticks, checklists, labels, blockers, links, a duplicate and a claim restores exactly what was there', () => {
  for (const title of ['a', 'b', 'c']) sql(db.insert('claude', { kind: 'task', title, parent: null }))
  sql(db.setChecklist('claude', item('T1'), ['x', 'y', 'z']).script)
  sql(db.check('claude', item('T1'), [2], true).script)
  sql(db.setLabels('claude', item('T1'), ['ui']).script)
  sql(db.setBlockers('claude', item('T1'), ['T2']).script)
  sql(db.setRelations('claude', item('T1'), 'relates', ['T3']).script)
  const before = fields(item('T1'))
  const steps = [
    () => db.check('user', item('T1'), [1, 3], true).script,
    () => db.check('user', item('T1'), [2], false).script,
    () => db.setChecklist('user', item('T1'), ['x', 'w']).script,
    () => db.setLabels('user', item('T1'), ['api', 'auth']).script,
    () => db.setBlockers('user', item('T1'), ['T3']).script,
    () => db.setRelations('user', item('T1'), 'relates', []).script,
    () => db.setRelations('user', item('T1'), 'duplicates', ['T2']).script,
    () => db.claim('user', 'T1', true, item('T1').assignee, item('T1').status),
  ]
  for (const step of steps) {
    sql(step())
    assert.notDeepEqual(fields(item('T1')), before)
    revert(lastOp())
    assert.deepEqual(fields(item('T1')), before)
  }
})

test('undo of a comment deletes it, and redo writes it back under its own id; undo of an add removes the item', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.comment('user', 'T1', "it's\nfine"))
  const [said] = lastOp()
  revert([said])
  assert.ok(!entries().some(one => one.id === said))
  revert(lastOp())
  assert.equal(entries().find(one => one.id === said).body, "it's\nfine")
  sql(db.insert('user', { kind: 'task', title: 'oops', parent: null }))
  revert(lastOp())
  assert.equal(item('T2'), undefined)
  assert.equal(load().activity.filter(one => one.item_id === 'T2').map(one => one.type).join(), 'undo')
  revert(lastOp())
  assert.equal(item('T2').title, 'oops')
})

test('undo of a removal restores the whole subtree exactly: items, timelines, checklists, labels, links and read marks', () => {
  sql(db.insert('claude', { kind: 'epic', title: 'E', parent: null }))
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: 'E1' }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: 'E1' }))
  sql(db.insert('claude', { kind: 'task', title: 'outside', parent: null }))
  sql(db.setChecklist('claude', item('T1'), ['x']).script)
  sql(db.setLabels('claude', item('T1'), ['ui']).script)
  sql(db.setBlockers('claude', item('T2'), ['T1']).script)
  sql(db.setBlockers('claude', item('T3'), ['T2']).script)
  sql(db.setRelations('claude', item('T3'), 'relates', ['E1']).script)
  sql(db.comment('claude', 'T1', 'note'))
  sql(db.markSeen('user', 'T1'))
  const before = load()
  const ids = ['E1', 'T1', 'T2']
  const rows = JSON.parse(sql(db.dump(ids)))
  sql(db.remove(ids, { actor: 'user', body: 'removed epic “E”', rows }))
  assert.deepEqual(load().items.map(one => one.id), ['T3'])
  assert.deepEqual(item('T3').blocked_by, [])
  revert(lastOp())
  const after = load()
  const strip = snap => ({ ...snap, activity: snap.activity.filter(one => one.type !== 'remove' && one.type !== 'undo').sort((a, b) => a.id - b.id) })
  assert.deepEqual(strip(after).items.sort((a, b) => a.id.localeCompare(b.id)), strip(before).items.sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual(strip(after).activity, { ...before, activity: before.activity.sort((a, b) => a.id - b.id) }.activity)
  assert.deepEqual(after.seen, before.seen)
  // And removed again by undoing the undo.
  revert(lastOp())
  assert.deepEqual(load().items.map(one => one.id), ['T3'])
})

test('export, then import into an empty roadmap, gives back the same roadmap; ids carry on where they left off', () => {
  sql(db.insert('claude', { kind: 'milestone', title: 'v1', parent: null, due: '2026-12-01' }))
  sql(db.insert('claude', { kind: 'epic', title: 'E', parent: 'M1' }))
  sql(db.insert('user', { kind: 'task', title: "it's\n.tables", parent: 'E1', description: 'multi\nline', priority: 'p0', type: 'bug' }))
  sql(db.insert('claude', { kind: 'task', title: 'b', parent: 'E1' }))
  sql(db.insert('claude', { kind: 'task', title: 'gone', parent: null }))
  sql(db.remove(['T3']))
  sql(db.setChecklist('claude', item('T1'), ['x', 'y']).script)
  sql(db.check('claude', item('T1'), [1], true).script)
  sql(db.setLabels('claude', item('T1'), ['ui', 'api']).script)
  sql(db.setBlockers('claude', item('T2'), ['T1']).script)
  sql(db.setRelations('claude', item('T2'), 'relates', ['E1']).script)
  sql(db.claim('explore:a', 'T2', false, null, 'todo'))
  sql(db.comment('user', 'T1', 'a note'))
  sql(db.comment('explore:a', 'T2', 'left off here', 'handoff'))
  sql(db.markSeen('user', 'T1'))
  const before = load()
  const text = db.exportOf(JSON.parse(sql(db.dump())), '2026-10-09T12:00:00.000Z')
  // Another checkout: a fresh database, brought to the current schema, then the import.
  rmSync(join(dir, '.claude'), { recursive: true, force: true })
  execFileSync('mkdir', ['-p', join(dir, '.claude')])
  isMigrated = false
  assert.equal(sql(db.COUNT), '0 0')
  sql(db.importRows(db.importOf(text)))
  const after = load()
  const byId = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  assert.deepEqual(byId(after.items), byId(before.items))
  assert.deepEqual(byId(after.activity), byId(before.activity))
  assert.deepEqual(after.seen, before.seen)
  // The counters came along: T3 was removed, so the next task is T4, never a reused T3.
  assert.equal(sql(db.insert('claude', { kind: 'task', title: 'next', parent: null })), 'T4')
  // Undo works on what was imported.
  assert.ok(JSON.parse(sql(db.entries([load().activity.find(one => one.body === 'checked 1. x').id])))[0].undo)
})

test('an export from an older schema imports, its missing columns taking their defaults', () => {
  const old = JSON.stringify({ roadmap: 'export', schema: 1, exported_at: '', tables: {
    items: [{ id: 'T1', kind: 'task', title: 'old', status: 'todo', parent: null, description: null, assignee: null, due: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
    activity: [{ id: 1, item_id: 'T1', author: 'claude', type: 'create', body: 'created task “old”', at: '2026-01-01T00:00:00Z' }],
    counters: [{ prefix: 'T', n: 1 }],
  } })
  sql(db.importRows(db.importOf(old)))
  assert.equal(item('T1').priority, 'p2')
  assert.equal(item('T1').type, 'feature')
  assert.throws(() => db.importOf(JSON.stringify({ roadmap: 'export', schema: db.VERSION + 1, tables: {} })), /newer roadmap mod/)
  assert.throws(() => db.importOf('{"roadmap":"export","schema":1,"tables":{"secrets":[]}}'), /unknown table secrets/)
})

test('v5: a release note and its section are written, logged and undone like any field', () => {
  sql(db.insert('claude', { kind: 'task', title: 'a', parent: null }))
  sql(db.change('claude', item('T1'), { note: "Cards don't flicker\nany more", section: 'Fixed' }).script)
  assert.deepEqual([item('T1').note, item('T1').section], ["Cards don't flicker\nany more", 'Fixed'])
  assert.deepEqual(log('T1').slice(1), ["claude: release note: Cards don't flicker\nany more", 'claude: section → Fixed'])
  revert(lastOp())
  assert.deepEqual([item('T1').note, item('T1').section], [null, null])
  sql(db.change('claude', item('T1'), { note: db.NO_NOTE }).script)
  assert.deepEqual(log('T1').at(-1), 'claude: no release note needed')
})
