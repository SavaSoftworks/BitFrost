// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn as child } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokProvider, grokProvider, grokReadOnlyCommand, grokEndReason } from '../providers/grok.ts'
import { Session } from '../session.ts'

type Json = any
const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'grok', name), 'utf8'))
const events = (s: Session, type: string): Json[] => s.events.filter((e) => e.type === type)
const last = (s: Session): Json => events(s, 'turn_completed').at(-1)
const token = 'test-grok-token'
const update = (u: Json, method = 'session/update') => ({ method, params: { sessionId: '$SESSION', update: u } })
const notification = (u: Json) => update(u, '_x.ai/session_notification')

async function until(ready: () => boolean) {
  const deadline = Date.now() + 8000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Grok')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function fake(t: Json, turns?: Json[][], extra: Json = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-grok-test-'))
  const file = path.join(dir, 'scenario.json')
  const log = path.join(dir, 'sent.jsonl')
  const scenario = { ...fixture('turn.json'), ...(turns ? { turns } : {}), ...extra }
  fs.writeFileSync(file, JSON.stringify(scenario))
  const messages: string[] = []
  const provider = new GrokProvider({ bin: process.execPath, args: [path.join(HERE, 'fake-grok.mjs'), file], env: { BITFROST_GROK_LOG: log, BITFROST_GROK_CWD: dir } }, { log: (s) => messages.push(s), token })
  t.after(() => {
    provider.dispose()
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 100).unref()
  })
  const sent = (): Json[] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []
  const session = new Session({ id: '', harness: 'grok', agent: 'test', model: 'grok-4.5', cwd: dir, state: 'running' })
  const start = (canAskUser = true) => provider.spawnSession(session, { cwd: dir, model: 'grok-4.5', effort: 'low', prompt: 'A tiny test.', canAskUser })
  const hook = (toolName: string, toolInput: Json = {}, extra: Json = {}) => provider.bridge(token, { sessionId: 'grok_session', hookEventName: 'pre_tool_use', toolName, toolInput, cwd: dir, toolUseId: 'tool-1', ...extra })
  return { provider, session, start, hook, sent, dir, messages }
}

test('Grok lists initialization models and efforts without creating a session or exposing other vendors', async (t) => {
  const base = fixture('turn.json')
  base.initialize._meta.modelState.availableModels.push({ modelId: 'anthropic/claude-opus', name: 'Claude' })
  const r = fake(t, [], { initialize: base.initialize })
  const models = await r.provider.listModels()
  assert.equal(models.length, 4)
  assert.ok(models.every((m) => m.provider === 'xAI' && m.harness === 'grok'))
  assert.deepEqual(models.find((m) => m.model === 'grok-4.5')?.efforts, ['high', 'medium', 'low'])
  assert.deepEqual(models[0].efforts, ['xhigh', 'high', 'medium', 'low'])
  assert.equal(models[0].defaultEffort, 'high')
  assert.equal(models[0].isDefault, true)
  assert.match(models[0].description, /256k context/)
  assert.deepEqual(r.sent().map((m) => m.method), ['initialize'])
  assert.equal(r.provider.capabilities.steer, false)
})

test('a recorded turn reports text, command output, file diffs and each request usage once', async (t) => {
  const base = fixture('turn.json')
  const steps = base.turns[0]
  const usage = steps.find((s: Json) => s.params?.update?.sessionUpdate === 'response_completed')
  steps.splice(steps.indexOf(usage) + 1, 0, structuredClone(usage))
  steps.unshift(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } }))
  const r = fake(t, [steps])
  await r.start()
  await until(() => !!last(r.session))
  assert.equal(last(r.session).status, 'completed')
  assert.equal(last(r.session).reason, 'end_turn')
  assert.ok(last(r.session).finalText)
  assert.equal(events(r.session, 'reasoning')[0].text, 'Thinking.')
  assert.equal(events(r.session, 'command_started').length, 1)
  assert.equal(events(r.session, 'command_completed')[0].exitCode, 0)
  assert.equal(events(r.session, 'command_completed')[0].output, 'exit: 0\n')
  assert.equal(events(r.session, 'file_change').length, 1)
  assert.match(events(r.session, 'file_change')[0].changes[0].diff, /\+apple/)
  const used = events(r.session, 'usage')
  assert.equal(used.length, 2)
  assert.equal(new Set(used.map((u) => u.requestId)).size, 2)
  assert.deepEqual(used.map((u) => [u.inputTokens, u.outputTokens, u.cachedInputTokens]), [[17292, 163, 0], [17532, 11, 17280]])
  assert.deepEqual(r.sent().find((m) => m.method === 'session/new').params._meta, { yoloMode: true })
  assert.deepEqual(r.sent().filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]), [['model', 'grok-4.5'], ['reasoning_effort', 'low']])
})

test('the bridge allows reads and workspace writes and gates commands with exact session grants and denial reasons', async (t) => {
  const r = fake(t, [[{ waitCancel: true }]])
  await r.start()
  await until(() => r.sent().some((m) => m.method === 'session/prompt'))
  assert.deepEqual(await r.hook('read_file', { file_path: '/etc/hosts' }), { decision: 'allow' })
  assert.deepEqual(await r.hook('write', { file_path: 'new/file.txt', content: 'ok' }), { decision: 'allow' })
  assert.deepEqual(await r.hook('run_terminal_command', { command: 'ls | wc -l' }), { decision: 'allow' })
  const command = { command: 'npm test' }
  const first = r.hook('run_terminal_command', command)
  let id = r.provider.pendingApprovals(r.session)[0]
  assert.ok(id)
  assert.equal(r.provider.resolveApproval(r.session, id, 'allow_session'), true)
  assert.deepEqual(await first, { decision: 'allow' })
  assert.deepEqual(await r.hook('run_terminal_command', command), { decision: 'allow' })
  const other = r.hook('run_terminal_command', { command: 'npm run deploy' })
  id = r.provider.pendingApprovals(r.session)[0]
  assert.equal(events(r.session, 'approval_requested').at(-1).tool, 'Bash')
  r.provider.resolveApproval(r.session, id, 'deny', 'Do not deploy this branch.')
  assert.deepEqual(await other, { decision: 'deny', reason: 'Do not deploy this branch.' })
  assert.equal(r.provider.resolveApproval(r.session, id, 'allow'), false)
  const outside = r.hook('write', { file_path: '../outside.txt', content: 'no' })
  id = r.provider.pendingApprovals(r.session)[0]
  r.provider.resolveApproval(r.session, id, 'allow')
  assert.deepEqual(await outside, { decision: 'allow' })
  const recorded = fixture('hooks.json').events[0]
  const replay = r.provider.bridge(token, { ...recorded, sessionId: 'grok_session', cwd: r.dir })
  id = r.provider.pendingApprovals(r.session)[0]
  r.provider.resolveApproval(r.session, id, 'deny', 'Recorded denial.')
  assert.deepEqual(await replay, { decision: 'deny', reason: 'Recorded denial.' })
  await r.provider.interrupt(r.session)
  await until(() => !!last(r.session))
})

test('the bridge refuses nested agents, scheduled work, forged calls, symlink escapes and noninteractive actions', async (t) => {
  const r = fake(t, [[{ waitCancel: true }]])
  await r.start(false)
  for (const name of ['task', 'spawn_subagent', 'Agent', 'workflow', 'scheduler_create', 'loop', 'update_goal', 'CronCreate']) assert.equal((await r.hook(name)).decision, 'deny', name)
  for (const name of ['get_command_or_subagent_output', 'kill_command_or_subagent', 'wait_tasks', 'todo_write', 'skills']) assert.equal((await r.hook(name)).decision, 'allow', name)
  assert.match((await r.hook('run_terminal_command', { command: 'rm x' })).reason, /without asking/)
  fs.symlinkSync(os.tmpdir(), path.join(r.dir, 'escape'))
  assert.equal((await r.hook('write', { file_path: 'escape/elsewhere.txt' })).decision, 'deny')
  assert.equal((await r.hook('write', { file_path: 'local' }, { cwd: '/tmp' })).decision, 'deny')
  assert.equal((await r.provider.bridge('forged', {})).decision, 'deny')
  assert.equal((await r.hook('read_file', {}, { sessionId: 'other' })).decision, 'deny')
  assert.equal((await r.hook('write', {}, { toolInputTruncated: true })).decision, 'deny')
  assert.equal((await r.hook('ask_user_question')).decision, 'deny')
  assert.equal(r.provider.pendingApprovals(r.session).length, 0)
})

test('native Grok questions use BitFrost question ids and return answers keyed by question text', async (t) => {
  const q = fixture('question.json')
  const r = fake(t, [[{ ...q, request: true }]])
  await r.start()
  await until(() => r.provider.pendingQuestions(r.session).length > 0)
  const asked = events(r.session, 'question_asked')[0]
  assert.deepEqual(asked.questions[0].options.map((o: Json) => o.label), ['Blue', 'Red'])
  assert.equal(await r.provider.answerQuestion(r.session, asked.questionId, { q0: ['Blue'] }, false), true)
  await until(() => !!last(r.session))
  assert.deepEqual(r.sent().find((m) => m.id === 0 && !m.method).result, { outcome: 'accepted', answers: { 'Which color do you choose?': ['Blue'] } })
  assert.equal(events(r.session, 'question_answered')[0].how, 'answered')
})

test('deferring a question stops the turn and keeps queued lead input', async (t) => {
  const r = fake(t, [[{ ...fixture('question.json'), request: true }, { waitCancel: true }]])
  await r.start()
  await until(() => r.provider.pendingQuestions(r.session).length > 0)
  const receipt = await r.session.deliver(r.provider, 'The lead will answer.')
  const id = r.provider.pendingQuestions(r.session)[0]
  await r.provider.answerQuestion(r.session, id, null, true)
  await until(() => events(r.session, 'turn_completed').length >= 2)
  assert.equal(events(r.session, 'turn_completed')[0].reason, 'interrupted')
  assert.equal(r.session.events.filter((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId).length, 1)
  assert.equal(r.session.events.filter((e) => e.type === 'input_dropped' && e.inputId === receipt.inputId).length, 0)
  assert.equal(r.sent().find((m) => m.id === 0 && !m.method).result.outcome, 'skip_interview')
})

test('questions without a user are declined and ACP permission requests still work', async (t) => {
  const q = fake(t, [[{ ...fixture('question.json'), request: true }]])
  await q.start(false)
  await until(() => !!last(q.session))
  assert.equal(q.sent().find((m) => m.id === 0 && !m.method).result.outcome, 'skip_interview')
  assert.equal(events(q.session, 'question_asked').length, 0)
  const r = fake(t, [[{ request: true, method: 'session/request_permission', params: { sessionId: '$SESSION', toolCall: { toolCallId: 'cmd', kind: 'execute', rawInput: { command: 'npm test' } }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } }]])
  await r.start()
  await until(() => r.provider.pendingApprovals(r.session).length > 0)
  r.provider.resolveApproval(r.session, r.provider.pendingApprovals(r.session)[0], 'allow')
  await until(() => !!last(r.session))
  assert.equal(r.sent().find((m) => m.id === 0 && !m.method).result.outcome.optionId, 'yes')
})

test('interrupt cancels the turn and releases a waiting hook; input while busy is queued', async (t) => {
  const r = fake(t, [[{ waitCancel: true }]])
  await r.start()
  await until(() => r.sent().some((m) => m.method === 'session/prompt'))
  assert.equal(await r.provider.sendInput(r.session, 'Later'), 'queued')
  const pending = r.hook('run_terminal_command', { command: 'npm test' })
  await r.provider.interrupt(r.session)
  assert.equal((await pending).decision, 'deny')
  await until(() => !!last(r.session))
  assert.equal(events(r.session, 'turn_completed')[0].reason, 'interrupted')
  assert.equal(r.provider.pendingApprovals(r.session).length, 0)
  assert.ok(r.sent().some((m) => m.method === 'session/cancel'))
})

test('model drift through both Grok and ACP notifications stops the turn', async (t) => {
  for (const step of [notification({ sessionUpdate: 'model_changed', model_id: 'grok-4.6' }), update({ sessionUpdate: 'config_option_update', configOptions: [{ category: 'model', type: 'select', currentValue: 'grok-4.6' }] })]) {
    const r = fake(t, [[step, { waitCancel: true }]])
    await r.start()
    await until(() => !!last(r.session))
    assert.equal(last(r.session).reason, 'wrong_model')
    assert.match(last(r.session).error, /instead of grok-4.5/)
  }
})

test('resume loads the native session, reapplies model and effort, and closes disposed sessions', async (t) => {
  const r = fake(t, [[]])
  await r.start()
  await until(() => !!last(r.session))
  const ref = r.session.nativeRef
  assert.equal(ref.acpSessionId, 'grok_session')
  const s = new Session({ ...r.session.info, state: 'running' })
  const resumed = fake(t, [[]])
  await resumed.provider.attach(s, ref)
  assert.equal(await resumed.provider.sendInput(s, 'Continue.'), 'started')
  await until(() => !!last(s))
  assert.deepEqual(resumed.sent().find((m) => m.method === 'session/load').params, { sessionId: 'grok_session', cwd: r.dir, mcpServers: [], _meta: { yoloMode: true } })
  assert.deepEqual(resumed.sent().filter((m) => m.method === 'session/set_config_option').map((m) => m.params.value), ['grok-4.5', 'low'])
  resumed.provider.disposeSession(s)
  await until(() => resumed.sent().some((m) => m.method === 'session/close'))
})

test('authentication failures name grok login and prompt errors have useful end reasons', async (t) => {
  const r = fake(t, [], { newSession: { error: { code: -32000, message: 'Not authenticated' } } })
  await assert.rejects(r.start(), /Run grok login/)
  for (const [message, expected] of [['401 unauthorized', 'auth'], ['Rate limited 429', 'rate_limited'], ['Insufficient quota', 'quota_exhausted'], ['context window limit', 'max_tokens'], ['max_turn_requests', 'max_requests'], ['refusal', 'refusal']]) {
    const r = fake(t, [[{ error: { code: -32603, message } }]])
    await r.start()
    await until(() => !!last(r.session))
    assert.equal(last(r.session).reason, expected)
    if (expected === 'auth') assert.match(last(r.session).error, /grok login/)
  }
  for (const reason of ['max_tokens', 'max_turn_requests', 'refusal', 'rate_limited', 'quota_exhausted']) assert.notEqual(grokEndReason(reason, null), 'error')
})

test('a process crash fails the turn and releases pending bridge calls', async (t) => {
  const r = fake(t, [[{ delay: 80 }, { crash: 7 }]])
  await r.start()
  const hook = r.hook('run_terminal_command', { command: 'npm test' })
  await until(() => !!last(r.session))
  assert.equal(last(r.session).reason, 'crashed')
  assert.equal((await hook).decision, 'deny')
  assert.equal(r.provider.pendingApprovals(r.session).length, 0)
})

test('equal-sized requests retain distinct identities and cache creation counts toward inclusive input', async (t) => {
  const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, reasoning_tokens: 2 }
  const r = fake(t, [[
    notification({ sessionUpdate: 'response_completed', signature: 'one', usage }),
    notification({ sessionUpdate: 'response_completed', signature: 'two', usage }),
    notification({ sessionUpdate: 'response_completed', signature: 'two', usage }),
    update({ sessionUpdate: 'usage_update', used: 99999 }),
    { method: '_x.ai/queue/changed', params: {} },
    { method: '_x.ai/models/update', params: {} },
    { result: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 70, outputTokens: 6, modelCalls: 2 } } } },
  ]])
  await r.start()
  await until(() => !!last(r.session))
  const used = events(r.session, 'usage')
  assert.equal(used.length, 2)
  assert.deepEqual(used.map((u) => [u.inputTokens, u.cachedInputTokens, u.outputTokens]), [[35, 20, 3], [35, 20, 3]])
  assert.notEqual(used[0].requestId, used[1].requestId)
  assert.deepEqual(r.messages, [])
})

test('turn usage falls back to reported totals once and Grok stop reasons classify failures', async (t) => {
  const total = { inputTokens: 42, cachedReadTokens: 20, outputTokens: 9, modelCalls: 1, modelUsage: { 'grok-4.5-build': { inputTokens: 42 } } }
  const r = fake(t, [[notification({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: total }), { result: { stopReason: 'end_turn', _meta: { usage: total } } }]])
  await r.start()
  await until(() => !!last(r.session))
  assert.equal(last(r.session).reason, 'end_turn')
  assert.equal(events(r.session, 'usage').length, 1)
  assert.deepEqual(events(r.session, 'usage')[0].billing, { inputTokens: 42, cachedInputTokens: 20, outputTokens: 9, requests: 1 })
  for (const [stop, reason] of [['max_tokens', 'max_tokens'], ['max_turn_requests', 'max_requests'], ['refusal', 'refusal'], ['rate_limited', 'rate_limited'], ['quota_exhausted', 'quota_exhausted'], ['auth', 'auth']]) {
    const r = fake(t, [[{ result: { stopReason: stop } }]])
    await r.start()
    await until(() => !!last(r.session))
    assert.equal(last(r.session).status, 'failed')
    assert.equal(last(r.session).reason, reason)
  }
})

test('wrong model selection is refused before prompting and final model metadata is checked', async (t) => {
  const r = fake(t, [[]], { reportModel: 'grok-4.6' })
  await assert.rejects(r.start(), /instead of grok-4.5/)
  assert.ok(!r.sent().some((m) => m.method === 'session/prompt'))
  const done = fake(t, [[{ result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.6' } } }]])
  await done.start()
  await until(() => !!last(done.session))
  assert.equal(last(done.session).reason, 'wrong_model')
})

test('structured RPC error details and status codes retain failure classification', async (t) => {
  for (const [error, reason] of [[{ code: -32603, message: 'Request failed', data: { detail: 'Not authenticated' } }, 'auth'], [{ code: 429, message: 'Request failed' }, 'rate_limited'], [{ code: -32603, message: 'Request failed', data: { code: 'insufficient_quota' } }, 'quota_exhausted']]) {
    const r = fake(t, [[{ error }]])
    await r.start()
    await until(() => !!last(r.session))
    assert.equal(last(r.session).reason, reason)
  }
})

test('read-only shell recognition rejects mutations, substitutions and executable options', () => {
  for (const command of ['ls', 'cat file | head -10', 'pwd && whoami; rg hello .', 'sort -n file | uniq', 'uniq -c file']) assert.equal(grokReadOnlyCommand(command), true, command)
  for (const command of ['ls > x', 'ls && rm x', 'ls &', 'cat $(touch x)', 'rg --pre=sh x', 'rg --hostname-bin=sh x', 'sort --compress-program=sh x', 'sort -o x file', 'uniq file ../out', 'uniq - out', 'uniq -- -a -b', 'date -s now', 'hostname newname', 'git -c core.fsmonitor=sh status', 'git diff', 'kubectl get pods', 'ls\nrm x']) assert.equal(grokReadOnlyCommand(command), false, command)
})

test('the factory installs a process hook, respects binary precedence and notices symlink updates', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-grok-factory-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'grok')
  fs.symlinkSync(process.execPath, bin)
  const old = process.env.BITFROST_GROK_BIN
  process.env.BITFROST_GROK_BIN = bin
  t.after(() => {
    if (old === undefined) delete process.env.BITFROST_GROK_BIN
    else process.env.BITFROST_GROK_BIN = old
  })
  const env = { runDir: dir, socket: path.join(dir, 'daemon.sock'), log: () => {}, config: { bin: '/missing' }, resolveBinary: () => '/missing', recorder: () => null }
  const p = grokProvider.create(env)!
  assert.equal(p.location, fs.realpathSync(process.execPath))
  assert.equal(grokProvider.optIn, true)
  assert.equal(p.moved!(), false)
  const launch = (p as Json).launch
  assert.deepEqual(launch.args, ['agent', '--no-leader', '--plugin-dir', path.join(dir, 'grok-plugin'), 'stdio'])
  assert.equal(launch.env.GROK_DISABLE_AUTOUPDATER, '1')
  assert.equal(launch.env.BITFROST_NODE, process.execPath)
  const hook = JSON.parse(fs.readFileSync(path.join(dir, 'grok-plugin', 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0]
  assert.match(hook.command, /BITFROST_NODE/)
  assert.ok(hook.timeout >= 86400)
  fs.unlinkSync(bin)
  fs.symlinkSync('/bin/sh', bin)
  assert.equal(p.moved!(), true)
  delete process.env.BITFROST_GROK_BIN
  assert.equal(grokProvider.detect!({ ...env, config: { bin: process.execPath } }), fs.realpathSync(process.execPath))
  assert.equal(grokProvider.detect!({ ...env, config: {}, resolveBinary: () => process.execPath }), fs.realpathSync(process.execPath))
})

test('the hook posts the token and payload and fails closed on unreachable or invalid replies', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-grok-hook-'))
  const socket = path.join(dir, 'hook.sock')
  let reply = JSON.stringify({ decision: 'deny', reason: 'No deployment.' })
  let received: Json
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received = { url: req.url, token: req.headers['x-bitfrost-token'], body: JSON.parse(body) }
      res.end(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  t.after(() => {
    server.close()
    server.closeAllConnections()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const call = (sock: string) => new Promise<Json>((resolve, reject) => {
    const p = child(process.execPath, [path.join(HERE, '..', 'providers', 'grok-hook.mjs')], { env: { ...process.env, BITFROST_SOCKET: sock, BITFROST_GROK_TOKEN: token } })
    let out = ''
    p.stdout.on('data', (c) => { out += c })
    p.on('error', reject)
    p.on('exit', (code) => resolve({ code, reply: JSON.parse(out) }))
    p.stdin.end(JSON.stringify({ toolName: 'write', sessionId: 'native-id' }))
  })
  assert.deepEqual((await call(socket)).reply, JSON.parse(reply))
  assert.deepEqual(received, { url: '/providers/grok/bridge', token, body: { toolName: 'write', sessionId: 'native-id' } })
  reply = ''
  assert.equal((await call(socket)).reply.decision, 'deny')
  const missing = await call(path.join(dir, 'missing.sock'))
  assert.equal(missing.code, 2)
  assert.match(missing.reply.reason, /not reachable/)
})
