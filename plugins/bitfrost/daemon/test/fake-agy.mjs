// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for the Antigravity CLI in tests. It reads one stream-json user line per
// turn and plays the next turn of the scenario in BITFROST_AGY_SCENARIO: either a
// recorded run from fixtures/agy/, or scripted steps. Hooks run for real, from the
// bridge plugin installed in BITFROST_AGY_PLUGIN_DIR, the way Antigravity runs them.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
// BitFrost points every run at a log file to learn how it signed in; take it out of argv
// so the command checks below keep seeing the arguments they expect.
const logAt = argv.indexOf('--log-file')
const authLog = logAt === -1 ? null : argv.splice(logAt, 2)[1]
const scenario = process.env.BITFROST_AGY_SCENARIO ? JSON.parse(fs.readFileSync(process.env.BITFROST_AGY_SCENARIO, 'utf8')) : {}
const log = (entry) => process.env.BITFROST_AGY_LOG && fs.appendFileSync(process.env.BITFROST_AGY_LOG, JSON.stringify(entry) + '\n')
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The real app says how it signed in within a second of starting, before it reads any input.
const authMethod = scenario.authMethod === undefined ? 'gemini_api_key' : scenario.authMethod
const writeAuth = (method = authMethod) => {
  if (!authLog || method === null) return
  const d = new Date()
  const p = (n, w) => String(n).padStart(w, '0')
  fs.appendFileSync(authLog, `I${p(d.getMonth() + 1, 2)}${p(d.getDate(), 2)} ${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 6)}       1 server_oauth.go:204] applyAuthResult: email=test@example.com, authMethod=${method}, quotaProject=\n`)
}
if (scenario.authDelayMs) setTimeout(() => writeAuth(), scenario.authDelayMs)
else writeAuth()

if (argv[0] === 'models') {
  if (scenario.modelsError) {
    process.stderr.write(scenario.modelsError + '\n')
    process.exit(1)
  }
  log({ models: true })
  process.stdout.write(fs.readFileSync(scenario.models, 'utf8'))
  process.exit(0)
}
if (argv[0] === 'plugin') {
  process.stdout.write(JSON.stringify(scenario.plugins ?? []))
  process.exit(0)
}

const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const resumed = flag('--conversation')
let conversation = resumed ?? scenario.conversation ?? 'conv-1'
const model = scenario.ranModel ?? flag('--model')
const skip = argv.includes('--dangerously-skip-permissions')
const turns = [...((resumed ? scenario.resumed : scenario.turns) ?? [])]
let step = resumed ? 100 : 0
let invocation = 0
let denied = []
log({ args: argv, authLog, pid: process.pid, cwd: process.cwd(), env: { socket: process.env.BITFROST_SOCKET, token: process.env.BITFROST_AGY_TOKEN, mark: process.env.BITFROST_AGY_PROC, node: process.env.BITFROST_NODE } })

process.on('SIGINT', () => {
  log({ signal: 'SIGINT' })
  if (scenario.ignoreInt) return
  process.stderr.write('error: interrupted\n')
  out({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', response: '', error: 'interrupted' } })
  process.exit(1)
})

const hooks = (() => {
  const dir = process.env.BITFROST_AGY_PLUGIN_DIR
  try { return { dir, spec: Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')))[0] } } catch { return null }
})()

// Run the plugin's hook command as Antigravity does: sh -c, from the plugin folder, JSON in and out.
function runHook(event, input) {
  const entry = hooks?.spec?.[event]?.[0]
  const command = entry?.hooks?.[0]?.command ?? entry?.command
  if (!command) return Promise.resolve({ code: 0, out: '' })
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: hooks.dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      log({ hook: event, code, out: stdout, err: stderr })
      resolve({ code, out: stdout, err: stderr })
    })
    child.stdin.end(JSON.stringify({ conversationId: conversation, modelName: scenario.hookModel ?? model, workspacePaths: [process.cwd()], ...input }))
  })
}

async function preInvocation() {
  const r = await runHook('PreInvocation', { invocationNum: invocation++ })
  if (r.code !== 0 || !r.out.trim()) return
  for (const s of JSON.parse(r.out).injectSteps ?? []) {
    log({ injected: s.userMessage })
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, state: 'DONE', step_type: 'user_input' } })
  }
}

// Returns the error text that blocks the call, or null when it may run.
async function preToolUse(index, name, args) {
  const r = await runHook('PreToolUse', { stepIdx: index, toolCall: { name, args } })
  if (r.code !== 0) return `JSON hook failed: exit status ${r.code}, stderr: ${r.err}`
  const reply = r.out.trim() ? JSON.parse(r.out) : null
  if (reply && reply.decision !== 'allow') return `tool call denied by pre-tool hook: ${reply.reason ?? ''}`
  if (!reply && !skip && !['view_file', 'list_dir'].includes(name)) {
    denied.push({ action: 'command', display_name: 'RunCommand' })
    return 'auto-denied'
  }
  return null
}

const usage = (n) => ({ input_tokens: 1000 + n, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: n % 2 ? 500 : 0, total_tokens: 1010 + n })

async function scripted(steps, text) {
  let response = ''
  for (const s of steps) {
    if (s.wait) await sleep(s.wait)
    if (s.text !== undefined) {
      await preInvocation()
      const index = step++
      const parts = s.text.match(/.{1,8}/gs) ?? ['']
      for (const p of parts.slice(0, -1)) out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: p } })
      out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: parts.at(-1), usage: usage(index) } })
      response = s.text
    }
    if (s.tool) {
      await preInvocation()
      const index = step++
      out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, state: 'DONE', step_type: 'agent_response', usage: usage(index) } })
      const tool = step++
      const shown = s.shown ?? s.args
      out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: tool, state: 'ACTIVE', step_type: 'tool', tool_name: s.tool, tool_info: { name: s.tool, parameters: shown } } })
      const blocked = await preToolUse(tool, s.tool, s.args)
      if (!blocked && s.write) fs.writeFileSync(path.resolve(process.cwd(), s.write[0]), s.write[1])
      if (!blocked && s.block) await new Promise(() => {})
      const error = blocked && blocked !== 'auto-denied' ? { type: 'TOOL_ERROR', message: blocked } : undefined
      out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: tool, state: error ? 'ERROR' : 'DONE', step_type: 'tool', tool_name: s.tool, duration_seconds: 0.25, tool_info: { name: s.tool, parameters: shown, ...(s.output ? { output: s.output } : {}), ...(error ? { error } : {}) } } })
    }
    if (s.block) await new Promise(() => {})
    if (s.exit !== undefined) {
      if (s.stderr) process.stderr.write(s.stderr + '\n')
      process.exit(s.exit)
    }
    if (s.error) {
      out({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', response: '', error: s.error } })
      return
    }
  }
  out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: response ? `${response}\n` : '', ...(denied.length ? { denied_actions: denied } : {}) } })
}

// Play a recorded run, calling the hooks where Antigravity would.
async function recorded(lines, turn) {
  const seen = new Set()
  for (const line of lines) {
    const ev = JSON.parse(line.replaceAll('$CWD', process.cwd()))
    if (ev.event === 'init') conversation = ev.conversation_id
    const s = ev.step_update
    if (s?.step_type === 'agent_response' && !seen.has(s.step_index)) {
      seen.add(s.step_index)
      await preInvocation()
    }
    if (s?.step_type === 'tool' && s.state === 'ACTIVE') {
      out(ev)
      await preToolUse(s.step_index, s.tool_name, { ...s.tool_info.parameters, ...(turn.args?.[s.step_index] ?? {}) })
      const write = turn.writes?.[s.step_index]
      if (write) fs.writeFileSync(path.resolve(process.cwd(), write[0]), write[1])
      continue
    }
    out(ev)
  }
}

let busy = Promise.resolve()
let reauthed = false
let initDone = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  log({ input: msg.message?.content })
  busy = busy.then(async () => {
    const turn = turns.shift() ?? { steps: [{ text: 'OK' }] }
    if (!initDone && !turn.fixture) out({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), permission_mode: skip ? 'always-proceed' : 'request-review' } })
    initDone = true
    if (turn.fixture) {
      // A recording holds one chunk per turn, each ending with its result.
      const chunks = [[]]
      for (const l of fs.readFileSync(turn.fixture, 'utf8').split('\n').filter(Boolean)) {
        chunks.at(-1).push(l)
        if (l.startsWith('{"event":"result"')) chunks.push([])
      }
      return recorded(chunks[turn.part ?? 0], turn)
    }
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, state: 'DONE', step_type: 'user_input' } })
    await scripted(turn.steps ?? [], msg.message?.content)
    // A scenario can sign in again after the first turn, as a switched account would.
    if (scenario.reauth && !reauthed) {
      reauthed = true
      writeAuth(scenario.reauth)
      log({ reauth: scenario.reauth })
    }
  })
})
process.stdin.on('end', () => busy.then(() => process.exit(0)))
