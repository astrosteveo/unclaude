#!/usr/bin/env node
// What the mod costs an agent: the same small epic, run headless with the roadmap mod and without it.
//
//   node bench/tokens/run.mjs [--runs 3] [--arms with,without] [--model <model>] [--out <dir>]
//   node bench/tokens/run.mjs --report <dir>     (tabulate a finished run again)
//
// Each run copies template/ into its own git repository. The "with" arm loads this checkout with
// --plugin-dir and gets the epic from seed.sql (no model call); the "without" arm gets epic.md in the
// prompt. Both arms turn off an installed roadmap@unclaude, so the only difference is this checkout.
// Runs go in parallel and spend real tokens on your own credential.

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
  without: () => `Implement this epic. Commit each task separately with its id in the message. ${NO_REMOTE}\n\n${readFileSync(join(HERE, 'epic.md'), 'utf8')}`,
}
const SETTINGS = JSON.stringify({ enabledPlugins: { 'roadmap@unclaude': false } })

const { values: opt } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    arms: { type: 'string', default: 'with,without' },
    model: { type: 'string' },
    out: { type: 'string' },
    report: { type: 'string' },
  },
})

const sh = (cmd, args, cwd, input) => spawnSync(cmd, args, { cwd, input, encoding: 'utf8' })

/** A fresh copy of the template as a git repository, with the epic on its roadmap for the "with" arm. */
function prepare(dir, arm) {
  cpSync(join(HERE, 'template'), dir, { recursive: true })
  sh('git', ['init', '-q', '-b', 'main'], dir)
  sh('git', ['add', '-A'], dir)
  sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'init'], dir)
  if (arm === 'with') {
    mkdirSync(join(dir, '.claude'))
    const seeded = sh('sqlite3', [join(dir, '.claude/roadmap.db')], dir, readFileSync(join(HERE, 'seed.sql'), 'utf8'))
    if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr}`)
  }
}

function launch(out, arm, n) {
  const name = `${arm}-${n}`
  const dir = join(out, name)
  prepare(dir, arm)
  const args = ['-p', '--dangerously-skip-permissions', '--no-session-persistence', '--verbose', '--output-format', 'stream-json', '--settings', SETTINGS]
  if (arm === 'with') args.push('--plugin-dir', REPO)
  if (opt.model) args.push('--model', opt.model)
  args.push(PROMPTS[arm]())
  return new Promise(done => {
    const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    child.stdout.on('data', chunk => lines.push(chunk))
    child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`))
    child.on('close', code => {
      writeFileSync(join(out, `${name}.jsonl`), Buffer.concat(lines))
      console.error(`[${name}] finished (exit ${code})`)
      done()
    })
  })
}

/** One run's numbers, from its transcript and what it left in its repository. */
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
    r.name + (r.loaded === (r.arm === 'with') ? '' : ' (WRONG ARM)'),
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
  const out = resolve(opt.out ?? join(tmpdir(), `roadmap-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  mkdirSync(out, { recursive: true })
  const arms = opt.arms.split(',').map(a => a.trim()).filter(a => a in PROMPTS)
  console.error(`bench: ${arms.join(' + ')} x ${opt.runs} runs in ${out}`)
  const jobs = arms.flatMap(arm => Array.from({ length: Number(opt.runs) }, (_, i) => launch(out, arm, i + 1)))
  await Promise.all(jobs)
  report(out)
}
