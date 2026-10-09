// Runs the hooks module itself (hooks/register.tsx) against a real sqlite3, in a fresh temporary project
// per test: the roadmap tool as the model calls it, end to end. `claude plugin test` has no processes,
// so this runs under Node instead:
//
//   node --test tests/register.e2e.mjs
//
// Node strips the TypeScript itself. The engine's `claude-code` module and the pane (the module's one
// file with JSX, which Node can't read) are stood in for; everything else is the mod's own code.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

const FAKES = {
  // The engine's state atoms, kept on the stand-in `$`.
  'claude-code': `
    export const atom = (key, init) => ({ key: key.plugin + ':' + key.key, init })
    export const read = async ($, one) => ($.state.has(one.key) ? $.state.get(one.key) : one.init)
    export const update = async ($, one, fn) => { $.state.set(one.key, fn(await read($, one))) }`,
  // Drawing is the UI tests' business (hooks/roadmap.test.ts).
  pane: `
    export const drawPane = () => ({ node: null, scrollMax: 0 })
    export const drawBand = () => null`,
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'claude-code') return { url: 'fake:claude-code', shortCircuit: true }
    if (specifier === './pane') return { url: 'fake:pane', shortCircuit: true }
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw err
    }
  },
  load(url, context, next) {
    if (url.startsWith('fake:')) return { format: 'module', source: FAKES[url.slice(5)], shortCircuit: true }
    // register.tsx holds no JSX, so stripping its types is all it takes.
    if (/\.tsx(\?|$)/.test(url))
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true }
    return next(url, context)
  },
})

const TOOL = 'mcp__roadmap__roadmap'
let loads = 0
let dir
let $
let call

/** A stand-in for the engine handle: real processes and files in the project, the rest recorded or quiet. */
function engine(root) {
  const store = {}
  return {
    state: new Map(),
    toasts: [],
    submitted: [],
    session: { root: async () => root },
    process: {
      run: (argv, init = {}) =>
        new Promise((resolve, reject) => {
          const child = execFile(argv[0], argv.slice(1), { cwd: init.cwd ?? root, encoding: 'utf8', timeout: init.timeoutMs }, (err, stdout, stderr) => {
            if (err && typeof err.code !== 'number') return reject(err)
            resolve({ exitCode: err ? err.code : 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
          })
          // A command that never reads its input (git, gh) may be gone before it is written.
          child.stdin.on('error', () => {})
          child.stdin.end(init.stdin ?? '')
        }),
    },
    fs: {
      stat: async path => {
        const found = statSync(path)
        return { kind: found.isDirectory() ? 'directory' : 'file', size: found.size, mtimeMs: found.mtimeMs, isLink: false }
      },
      read: async path => readFileSync(path, 'utf8'),
      write: async (path, text) => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, text)),
      list: async path => readdirSync(path).map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
      exists: async path => existsSync(path),
    },
    clock: { now: async () => Date.now(), sleep: async () => {}, every: () => ({}) },
    ui: { toast() {}, open: async () => ({ isPlaced: true }), focus: async () => ({}), resolve: () => ({}) },
    store: { get: async key => store[key], set: async (key, value) => void (store[key] = value) },
    prompt: { submit: async ({ text }) => void $.submitted.push(text), fill: async () => ({ isFilled: true }) },
    agent: { list: async () => [], spawn: async () => ({}) },
    // Backups stay out of the person's home.
    env: { get: async name => (name === 'ROADMAP_BACKUP_DIR' ? 'off' : undefined) },
    tool: { register: async () => ({}) },
    command: { register: async () => ({}) },
  }
}

/** Loads the hooks module afresh with the session rooted at `root`, and points `call` at its tool. */
async function load(root) {
  $ = engine(root)
  // A fresh load per test: the module keeps state (schema checked, names learned) for its project.
  const { register } = await import(`../hooks/register.tsx?load=${++loads}`)
  const hooks = []
  register((name, filter, hook) => {
    hooks.push({ name, filter: hook ? filter : undefined, hook: hook ?? filter })
    const chain = { catch: () => chain }
    return chain
  })
  const tool = hooks.find(one => one.name === 'tool.call' && one.filter?.tool === TOOL).hook
  // As the model calls it: the main loop, or a subagent by its id.
  call = async (input, agentId) => {
    const reply = await tool($, { tool: TOOL, tool_use_id: 't', ...(agentId ? { agentId } : {}), ...input })
    return reply.deny === undefined ? { ok: true, text: reply.result } : { ok: false, text: reply.deny }
  }
}

const gitInit = at => (mkdirSync(at, { recursive: true }), execFileSync('git', ['init', '-q', at]))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'roadmap-e2e-'))
  // A roadmap is started only at a repository's top level.
  gitInit(dir)
  await load(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** What the database holds, read straight from it. */
const query = sql => execFileSync('sqlite3', ['-batch', '-noheader', '-list', join(dir, '.claude/roadmap.db'), sql], { encoding: 'utf8' }).trim()
const everything = () => query("SELECT group_concat(id || ' ' || kind || ' ' || status || ' ' || COALESCE(parent, '-') || ' ' || COALESCE(assignee, '-'), '; ') FROM (SELECT * FROM items ORDER BY id);") +
  ` | ${query('SELECT count(*) FROM activity;')} | ${query("SELECT group_concat(blocker || '>' || blocked) FROM links;")}`

const ok = async (input, agentId) => {
  const reply = await call(input, agentId)
  assert.ok(reply.ok, reply.text)
  return reply.text
}

test('add and plan build the tree; show reads it back', async () => {
  assert.equal(await ok({ action: 'add', kind: 'milestone', title: 'v1', due: '2026-12-01' }), `Started a new roadmap at ${dir}/.claude/roadmap.db.\nAdded M1: v1`)
  const planned = await ok({
    action: 'plan', parent: 'M1', tree: [
      { ref: 'auth', kind: 'epic', title: 'Auth', children: [
        { ref: 'login', kind: 'task', title: 'Login', checklist: ['form', 'session'], labels: ['ui'] },
        { ref: 'logout', kind: 'task', title: 'Logout', blocked_by: ['login'], priority: 'p1' },
      ] },
    ],
  })
  assert.match(planned, /^Planned 3 item\(s\): auth → E1, login → T1, logout → T2/)
  assert.equal(everything(), 'E1 epic todo M1 -; M1 milestone todo - -; T1 task todo E1 -; T2 task todo E1 - | 7 | T1>T2')
  assert.equal(query("SELECT group_concat(text, '|') FROM (SELECT text FROM checks WHERE item_id='T1' ORDER BY n);"), 'form|session')
  const shown = await ok({ action: 'show', id: 'T2' })
  assert.match(shown, /^T2 ○ todo Logout {2}\(p1, waiting on T1\)/)
  // A plan that fails anywhere writes nothing.
  const before = everything()
  const failed = await call({ action: 'plan', tree: [{ kind: 'task', title: 'a', blocked_by: ['nowhere'] }] })
  assert.equal(failed.ok, false)
  assert.equal(everything(), before)
})

test('claim starts a task and names its branch; update writes several fields at once; an agent\'s done goes to review with its note', async () => {
  await ok({ action: 'add', kind: 'task', title: 'Parser', checklist: ['works'] })
  const claimed = await ok({ action: 'claim', id: 'T1' })
  assert.match(claimed, /^T1 is yours \(claude\), in progress\.\nWork on branch t1-parser/)
  // A subagent can't take it while the claim is live.
  const taken = await call({ action: 'claim', id: 'T1' }, 'agent-1')
  assert.equal(taken.ok, false)
  assert.match(taken.text, /T1 is held by claude/)
  await ok({ action: 'update', id: 'T1', priority: 'p0', type: 'bug', labels: ['core'], description: 'two\nlines' })
  assert.equal(query("SELECT priority || ' ' || type || ' ' || description FROM items WHERE id='T1';"), 'p0 bug two\nlines')
  // Done with an unchecked criterion, or without a note, is refused and writes nothing.
  assert.match((await call({ action: 'update', id: 'T1', status: 'done', note: 'x' })).text, /unchecked item/)
  await ok({ action: 'check', id: 'T1', items: [1] })
  assert.match((await call({ action: 'update', id: 'T1', status: 'done' })).text, /has no release note/)
  const done = await ok({ action: 'update', id: 'T1', status: 'done', note: 'The parser handles comments' })
  assert.match(done, /status in_progress → review/)
  assert.equal(query("SELECT status || ' ' || note || ' ' || COALESCE(section, '-') FROM items WHERE id='T1';"), 'review The parser handles comments -')
  // A bug's note goes under Fixed by default, in the PR body.
  assert.match(await ok({ action: 'pr', id: 'T1' }), /Fixed:\n- The parser handles comments \(T1\)/)
})

test('batch: every op lands in one transaction, refs naming new items; one failing op writes nothing', async () => {
  await ok({ action: 'add', kind: 'epic', title: 'E' })
  const reply = await ok({ action: 'batch', ops: [
    { action: 'add', kind: 'task', title: 'First', parent: 'E1', ref: 'a' },
    { action: 'add', kind: 'task', title: 'Second', parent: 'E1', ref: 'b', blocked_by: ['a'] },
    { action: 'update', id: 'a', priority: 'p1' },
    { action: 'comment', id: 'b', body: 'after a' },
  ] })
  assert.match(reply, /^1\. Added T1: First\n2\. Added T2: Second, blocked by T1\n3\. T1: priority → p1\n4\. Commented on T2\.$/)
  assert.equal(everything(), 'E1 epic todo - -; T1 task todo E1 -; T2 task todo E1 - | 6 | T1>T2')
  // The trial copy is gone.
  assert.deepEqual(readdirSync(join(dir, '.claude')).filter(name => name.includes('-batch-')), [])
  const before = everything()
  const failed = await call({ action: 'batch', ops: [{ action: 'update', id: 'T1', status: 'blocked' }, { action: 'comment', id: 'T9', body: 'x' }] })
  assert.equal(failed.text, 'op 2 (comment T9): No item T9. Nothing in the batch was written.')
  assert.equal(everything(), before)
  // ids: the same change to several items, as one batch.
  await ok({ action: 'update', ids: ['T1', 'T2'], assignee: 'claude' })
  assert.equal(query("SELECT group_concat(assignee) FROM items WHERE kind='task';"), 'claude,claude')
})

test('remove takes a subtree only with cascade; export, then import into an empty project, gives it all back', async () => {
  await ok({ action: 'plan', tree: [{ kind: 'epic', title: 'E', children: [{ kind: 'task', title: 'a' }, { kind: 'task', title: 'b' }] }] })
  await ok({ action: 'comment', id: 'T1', body: 'kept' })
  assert.match((await call({ action: 'remove', id: 'E1' })).text, /has 2 item\(s\) under it; pass cascade: true/)
  const saved = await ok({ action: 'export', path: 'saved.json' })
  assert.match(saved, /^Exported 3 item\(s\)/)
  assert.equal(await ok({ action: 'remove', id: 'E1', cascade: true }), 'Removed E1, T1, T2')
  assert.equal(query('SELECT count(*) FROM items;'), '0')
  // Into a roadmap holding anything (the removal's log), import is refused; into a fresh one, it lands.
  assert.match((await call({ action: 'import', path: 'saved.json' })).text, /import goes only into an empty one/)
  rmSync(join(dir, '.claude'), { recursive: true, force: true })
  const { register } = await import(`../hooks/register.tsx?load=${++loads}`)
  let tool
  register((name, filter, hook) => {
    if (name === 'tool.call' && hook && filter?.tool === TOOL) tool = hook
    const chain = { catch: () => chain }
    return chain
  })
  const back = await tool($, { tool: TOOL, tool_use_id: 't', action: 'import', path: 'saved.json' })
  assert.match(back.result, /^Started a new roadmap at .*\nImported 3 item\(s\)/)
  assert.equal(everything().split(' | ')[0], 'E1 epic todo - -; T1 task todo E1 -; T2 task todo E1 -')
  assert.equal(query("SELECT body FROM activity WHERE type='comment';"), 'kept')
})

test('a fresh repository starts its roadmap on the first write, and the reply says where', async () => {
  const first = await ok({ action: 'add', kind: 'task', title: 'First' })
  assert.equal(first, `Started a new roadmap at ${dir}/.claude/roadmap.db.\nAdded T1: First`)
  assert.equal(await ok({ action: 'add', kind: 'task', title: 'Second' }), 'Added T2: Second')
})

test('a session in a folder holding repositories is refused a new roadmap, and told where the roadmaps are', async () => {
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  gitInit(join(dir, 'app'))
  gitInit(join(dir, 'tools/cli'))
  gitInit(join(dir, 'empty'))
  for (const project of ['app', 'tools/cli']) {
    await load(join(dir, project))
    await ok({ action: 'add', kind: 'task', title: project })
  }
  await load(dir)
  // Reads find nothing and make nothing.
  assert.match(await ok({ action: 'next' }), /.*/)
  const refused = await call({ action: 'add', kind: 'task', title: 'lost' })
  assert.equal(refused.ok, false)
  assert.match(refused.text, /is not the top of a git repository/)
  assert.match(refused.text, new RegExp(`Roadmaps found below it: ${dir}/app, ${dir}/tools/cli\\.`))
  const batch = await call({ action: 'batch', ops: [{ action: 'add', kind: 'task', title: 'lost' }] })
  assert.equal(batch.ok, false)
  assert.equal(existsSync(join(dir, '.claude')), false)
})

test('a session in a subfolder of a repository writes to the roadmap at its top level', async () => {
  await ok({ action: 'add', kind: 'task', title: 'At the top' })
  mkdirSync(join(dir, 'src/deep'), { recursive: true })
  await load(join(dir, 'src/deep'))
  assert.equal(await ok({ action: 'add', kind: 'task', title: 'From below' }), 'Added T2: From below')
  assert.equal(existsSync(join(dir, 'src/deep/.claude')), false)
  assert.equal(query("SELECT group_concat(title, '|') FROM (SELECT title FROM items ORDER BY id);"), 'At the top|From below')
})

test('a subfolder of a fresh repository starts the roadmap at the top, never in the subfolder', async () => {
  mkdirSync(join(dir, 'sub'))
  await load(join(dir, 'sub'))
  assert.match(await ok({ action: 'add', kind: 'task', title: 'x' }), new RegExp(`^Started a new roadmap at ${dir}/\\.claude/roadmap\\.db\\.`))
  assert.equal(existsSync(join(dir, 'sub/.claude')), false)
})
