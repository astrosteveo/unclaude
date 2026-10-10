#!/usr/bin/env node
// Measures what the roadmap plugin costs an agent. It runs the same small epic headless, with the plugin and without it.
//
//   node bench/tokens/run.mjs [--scenario small] [--runs 3] [--arms with,without] [--model <model>] [--out <dir>]
//   node bench/tokens/run.mjs --report <dir>     (print the table for a finished run again)
//
// A scenario (scenarios/<name>/) holds a project and an epic for it: template/, epic.md and seed.sql.
// Each run copies template/ into its own git repository. The "with" arm loads this checkout with
// --plugin-dir and gets the epic from seed.sql, which is written straight into the roadmap database
// (no model call). The "without" arm gets epic.md in the prompt. Both arms turn off an installed
// roadmap@unclaude, so the only difference between them is this checkout.
// Each arm first runs a one-word warm-up (see WARM), and the warm-up's cost is left out of the table.
// Runs go in parallel and spend real tokens on your own account.

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const NO_REMOTE = 'This repo has no git remote: commit locally, but skip pushing and opening pull requests.'
const PROMPTS = {
  with: () => `Implement E1 from the roadmap. ${NO_REMOTE}`,
  without: () => `Implement this epic. Commit each task separately with its id in the message. ${NO_REMOTE}\n\n${readFileSync(join(SCENARIO, 'epic.md'), 'utf8')}`,
}
const SETTINGS = JSON.stringify({ enabledPlugins: { 'roadmap@unclaude': false } })

const { values: opt } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    arms: { type: 'string', default: 'with,without' },
    model: { type: 'string' },
    out: { type: 'string' },
    report: { type: 'string' },
    scenario: { type: 'string', default: 'small' },
  },
})
const SCENARIO = join(HERE, 'scenarios', opt.scenario)

const sh = (cmd, args, cwd, input) => spawnSync(cmd, args, { cwd, input, encoding: 'utf8' })

/** Copies the template into a new git repository and, for the "with" arm, puts the epic on its roadmap. */
function prepare(dir, arm) {
  cpSync(join(SCENARIO, 'template'), dir, { recursive: true })
  sh('git', ['init', '-q', '-b', 'main'], dir)
  sh('git', ['add', '-A'], dir)
  sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'init'], dir)
  if (arm === 'with') {
    mkdirSync(join(dir, '.claude'))
    const seeded = sh('sqlite3', [join(dir, '.claude/roadmap.db')], dir, readFileSync(join(SCENARIO, 'seed.sql'), 'utf8'))
    if (seeded.status !== 0) throw new Error(`could not load seed.sql into the roadmap database: ${seeded.stderr}`)
  }
}

// Before the real runs, each arm runs one session that replies with a single word. A session's first turn
// reads the tools and system prompt from the prompt cache when an earlier session put them there. Without
// the warm-up, runs started together would all pay to write them to the cache, and the arm whose tools just
// changed (the one loading this checkout) would pay for that while the other arm doesn't.
const WARM = 'Reply with the single word ok.'

function launch(out, arm, n, prompt = PROMPTS[arm](), file = `${arm}-${n}.jsonl`) {
  const name = `${arm}-${n}`
  const dir = join(out, name)
  prepare(dir, arm)
  const args = ['-p', '--dangerously-skip-permissions', '--no-session-persistence', '--verbose', '--output-format', 'stream-json', '--settings', SETTINGS]
  if (arm === 'with') args.push('--plugin-dir', REPO)
  if (opt.model) args.push('--model', opt.model)
  args.push(prompt)
  return new Promise(done => {
    const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    child.stdout.on('data', chunk => lines.push(chunk))
    child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`))
    child.on('close', code => {
      writeFileSync(join(out, file), Buffer.concat(lines))
      console.error(`[${name}] finished (exit ${code})`)
      done()
    })
  })
}

/** Reads one run's numbers from its transcript and from what it left in its repository. */
function measure(out, name) {
  const dir = join(out, name)
  const events = readFileSync(join(out, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const init = events.find(e => e.type === 'system' && e.subtype === 'init')
  const result = events.find(e => e.type === 'result') ?? {}
  const uses = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content ?? []).filter(c => c.type === 'tool_use')
  const tests = sh('node', ['--test'], dir).stdout ?? ''
  const db = join(dir, '.claude/roadmap.db')
  return {
    name,
    arm: name.replace(/-\d+$/, ''),
    loaded: Boolean(init?.tools?.some(t => /roadmap/.test(t))),
    turns: result.num_turns ?? 0,
    tools: uses.length,
    roadmap: uses.filter(u => /roadmap/.test(u.name)).length,
    input: result.usage?.input_tokens ?? 0,
    output: result.usage?.output_tokens ?? 0,
    cacheRead: result.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: result.usage?.cache_creation_input_tokens ?? 0,
    cost: result.total_cost_usd ?? 0,
    pass: Number(/ℹ pass (\d+)/.exec(tests)?.[1] ?? 0),
    fail: Number(/ℹ fail (\d+)/.exec(tests)?.[1] ?? 0),
    commits: Number(sh('git', ['rev-list', '--count', 'HEAD'], dir).stdout.trim()) - 1,
    state: existsSync(db) ? sh('sqlite3', [db, "SELECT group_concat(id || ':' || status, ' ') FROM items"], dir).stdout.trim() : '',
  }
}

const COLUMNS = ['turns', 'tools', 'roadmap', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost']
const fmt = (key, v) => (key === 'cost' ? `$${v.toFixed(3)}` : String(Math.round(v * 10) / 10))

function report(out) {
  const names = readdirSync(out).filter(f => f.endsWith('.jsonl')).map(f => basename(f, '.jsonl')).sort()
  const rows = names.map(name => measure(out, name))
  const head = ['run', ...COLUMNS, 'tests', 'commits', 'roadmap state']
  const table = [head, ...rows.map(r => [
    r.name + (r.loaded === (r.arm === 'with') ? '' : r.loaded ? ' (WRONG ARM: plugin loaded)' : ' (WRONG ARM: plugin not loaded)'),
    ...COLUMNS.map(k => fmt(k, r[k])),
    `${r.pass}/${r.pass + r.fail}`,
    String(r.commits),
    r.state,
  ])]
  const arms = [...new Set(rows.map(r => r.arm))]
  const mean = arm => {
    const of = rows.filter(r => r.arm === arm)
    return Object.fromEntries(COLUMNS.map(k => [k, of.reduce((sum, r) => sum + r[k], 0) / of.length]))
  }
  const means = Object.fromEntries(arms.map(arm => [arm, mean(arm)]))
  for (const arm of arms) table.push([`mean ${arm}`, ...COLUMNS.map(k => fmt(k, means[arm][k])), '', '', ''])
  if (means.with && means.without) table.push(['with/without', ...COLUMNS.map(k => (means.without[k] ? `${(means.with[k] / means.without[k]).toFixed(2)}x` : '')), '', '', ''])
  const widths = head.map((_, i) => Math.max(...table.map(row => row[i].length)))
  for (const row of table) console.log(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd())
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ rows, means }, null, 2))
}

if (opt.report) {
  report(resolve(opt.report))
} else {
  const out = resolve(opt.out ?? join(tmpdir(), `roadmap-bench-${opt.scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  mkdirSync(out, { recursive: true })
  const arms = opt.arms.split(',').map(a => a.trim()).filter(a => a in PROMPTS)
  if (!existsSync(SCENARIO)) throw new Error(`there is no scenario named ${opt.scenario}. The scenarios are: ${readdirSync(join(HERE, 'scenarios')).join(', ')}`)
  console.error(`bench: scenario ${opt.scenario}, arms ${arms.join(' + ')}, ${opt.runs} runs each, writing to ${out}`)
  await Promise.all(arms.map(arm => launch(out, arm, 'warm', WARM, `${arm}-warm.log`)))
  const jobs = arms.flatMap(arm => Array.from({ length: Number(opt.runs) }, (_, i) => launch(out, arm, i + 1)))
  await Promise.all(jobs)
  report(out)
}
