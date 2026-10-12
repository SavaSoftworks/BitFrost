// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for CrushProvider. fake-crush.mjs stands in for "crush server", playing a
// scenario from fixtures/crush/; real-probe.json is a real Crush 0.98.1 run.
// The hook script runs for real against a small stand-in for the helper's bridge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CrushProvider, HOOK_MATCHER, HOOK_SCRIPT, crushProvider, readOnlyCommand, resolveCrush, type CrushOptions } from '../providers/crush.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(HERE, 'fake-crush.mjs')
const FIXTURES = path.join(HERE, 'fixtures', 'crush')
const MODEL = 'opencode-go/deepseek-v4.1-flash'
const INSTRUCTIONS = 'You are a delegated subagent.'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(10)
  }
}

type Run = { provider: CrushProvider; dir: string; cwd: string; log: () => any[]; bridged: any[]; stop: () => Promise<void> }

async function fake(fixture: string, opts: Partial<CrushOptions> = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfcrush-'))): Promise<Run> {
  const logFile = path.join(dir, 'log.jsonl')
  const socket = path.join(dir, 'bridge.sock')
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(cwd, { recursive: true })
  const provider = new CrushProvider(
    { bin: process.execPath, args: [FAKE, path.resolve(FIXTURES, fixture)], env: { BITFROST_CRUSH_LOG: logFile, BITFROST_CRUSH_MARK: path.join(dir, 'crashed') } },
    { log: () => {}, runDir: path.join(dir, 'run'), dataRoot: path.join(dir, 'data'), socket, ...opts },
  )
  const bridged: any[] = []
  const bridge = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      bridged.push({ url: req.url, token: req.headers['x-bitfrost-token'], body: JSON.parse(body) })
      const reply = await provider.bridge(String(req.headers['x-bitfrost-token'] ?? ''), JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(reply ? JSON.stringify(reply) : '')
    })
  })
  await new Promise<void>((resolve) => bridge.listen(socket, resolve))
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return {
    provider,
    dir,
    cwd,
    log,
    bridged,
    stop: async () => {
      provider.dispose()
      bridge.closeAllConnections()
      await new Promise((resolve) => bridge.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function spawn(run: Run, { effort, canAskUser = true, model = MODEL }: { effort?: string; canAskUser?: boolean; model?: string } = {}): Promise<Session> {
  const session = new Session({ id: '', harness: 'crush', agent: 'test', model, cwd: run.cwd, state: 'running' })
  await run.provider.spawnSession(session, { model, effort, cwd: run.cwd, prompt: 'List the files.', developerInstructions: INSTRUCTIONS, canAskUser })
  return session
}

const types = (s: Session) => s.events.filter((e) => !['user_input', 'input_consumed'].includes(e.type)).map((e) => e.type)
const all = (s: Session, type: string): any[] => s.events.filter((e) => e.type === type)
const find = (s: Session, type: string): any => s.events.find((e) => e.type === type)
const done = (s: Session, n = 1) => until(`${n} finished turn(s)`, () => all(s, 'turn_completed').length >= n)
const asked = (s: Session, n: number) => until(`approval ${n}`, () => all(s, 'approval_requested').length >= n).then(() => all(s, 'approval_requested')[n - 1])
const calls = (run: Run, method: string, suffix: string) => run.log().filter((e) => e.method === method && e.path?.endsWith(suffix))
const exited = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

test('the models of each set-up provider are listed with their efforts and real companies, and kept for an hour', async () => {
  const run = await fake('models.json')
  try {
    const models = await run.provider.listModels()
    const by = Object.fromEntries(models.map((m) => [m.model, m]))
    assert.deepStrictEqual(Object.keys(by), [
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/glm-5.3',
      'opencode-go/kimi-k2.7-code',
      'opencode-go/claude-haiku-5-5',
      'neuralwatt/nw-large',
      'openai/gpt-6.1-sol', // signed in with ChatGPT, so only the subscription's models
    ])
    assert.deepStrictEqual(by['opencode-go/deepseek-v4.1-flash'], {
      harness: 'crush',
      provider: 'DeepSeek',
      model: 'opencode-go/deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      description: 'Through OpenCode Go.',
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      isDefault: false,
    })
    assert.strictEqual(by['opencode-go/glm-5.3'].isDefault, true)
    assert.strictEqual(by['opencode-go/glm-5.3'].provider, 'Z.ai')
    assert.deepStrictEqual([by['opencode-go/kimi-k2.7-code'].efforts, by['opencode-go/kimi-k2.7-code'].defaultEffort, by['opencode-go/kimi-k2.7-code'].provider], [[], null, 'Moonshot AI'])
    assert.strictEqual(by['opencode-go/claude-haiku-5-5'].provider, 'Anthropic')
    assert.strictEqual(by['neuralwatt/nw-large'].provider, 'neuralwatt')
    assert.strictEqual(by['openai/gpt-6.1-sol'].provider, 'OpenAI')

    // Discovery never prompts, and its server and folder are gone afterwards.
    const start = run.log().find((e) => e.start)
    await until('the discovery server to stop', () => exited(start.pid))
    const ws = calls(run, 'POST', '/v1/workspaces')[0].body
    assert.ok(!fs.existsSync(ws.path) && !fs.existsSync(ws.data_dir))
    assert.ok(!run.log().some((e) => e.path?.endsWith('/agent')))

    assert.deepStrictEqual(await run.provider.listModels(), models)
    const again = await fake('models.json', { runDir: path.join(run.dir, 'run') })
    try {
      assert.deepStrictEqual(await again.provider.listModels(), models)
    } finally {
      await again.stop()
    }
    assert.strictEqual(run.log().filter((e) => e.start).length, 1, 'later calls and a restarted helper use the cache')
    assert.ok(!fs.readFileSync(path.join(run.dir, 'run', 'crush-models.json'), 'utf8').includes('fake-key'), 'API keys are never kept')
  } finally {
    await run.stop()
  }
})

test('a turn streams text, asks before a command and an edit, reports usage and plans, and grants hold for the task', async () => {
  const run = await fake('turn.json')
  try {
    const session = await spawn(run, { effort: 'low' })
    assert.match(session.info.id, /^crush_/)
    assert.strictEqual(session.info.effort, 'low')
    const dataDir = path.join(run.dir, 'data', session.info.id)
    assert.deepStrictEqual(session.nativeRef, { dataDir, crushSessionId: 'ses_1', canAsk: true })

    const command = await asked(session, 1)
    assert.deepStrictEqual(
      { kind: command.kind, title: command.title, tool: command.tool, input: command.input, itemId: command.itemId },
      { kind: 'command', title: 'run `touch a.txt`', tool: 'Bash', input: { command: 'touch a.txt', description: 'Create a.txt' }, itemId: 'call_1' },
    )
    assert.deepStrictEqual(run.provider.pendingApprovals(session), [command.approvalId])
    assert.ok(run.provider.resolveApproval(session, command.approvalId, 'allow_session'))

    const edit = await asked(session, 2)
    const file = path.join(run.cwd, 'b.txt')
    assert.deepStrictEqual(
      { kind: edit.kind, title: edit.title, tool: edit.tool, input: edit.input, itemId: edit.itemId },
      { kind: 'file_change', title: `edit ${file}`, tool: 'Edit', input: { file_path: file, old_string: 'one', new_string: 'two' }, itemId: 'call_2' },
    )
    assert.match(edit.detail, /-one\n\+two/)
    assert.ok(run.provider.resolveApproval(session, edit.approvalId, 'allow'))
    await done(session)

    // Usage is finalized at a request boundary; the remaining stream keeps its ordering.
    assert.deepStrictEqual(types(session).filter((type) => type !== 'usage'), [
      'turn_started',
      'reasoning',
      'text',
      'command_started',
      'command_started',
      'usage',
      'plan',
      'command_completed',
      'approval_requested',
      'approval_resolved',
      'command_completed',
      'approval_requested',
      'approval_resolved',
      'file_change',
      'usage',
      'plan',
      'text',
      'usage',
      'turn_completed',
    ].filter((type) => type !== 'usage'))
    assert.strictEqual(find(session, 'reasoning').text, 'Looking at the files.')
    assert.strictEqual(find(session, 'text').text, "I'll check, then create a.txt.")
    const [status, touch] = all(session, 'command_completed')
    assert.deepStrictEqual(
      { command: status.command, output: status.output, exitCode: status.exitCode, durationMs: status.durationMs, status: status.status, cwd: status.cwd },
      { command: 'git status', output: 'nothing to commit', exitCode: 0, durationMs: 40, status: 'completed', cwd: run.cwd },
    )
    assert.deepStrictEqual([touch.command, touch.summary, touch.status, touch.durationMs], ['touch a.txt', 'Create a.txt', 'completed', 250])
    assert.deepStrictEqual(find(session, 'file_change').changes, [{ path: file, kind: 'update', movePath: null, diff: '@@ -1,1 +1,1 @@\n-one\n+two' }])
    assert.deepStrictEqual(all(session, 'usage').map((u) => [u.inputTokens, u.outputTokens, u.cachedInputTokens]), [[1200, 40, 0], [1500, 60, 0], [1600, 12, 0]])
    assert.deepStrictEqual(all(session, 'plan').map((p) => p.entries), [[{ content: 'Create a.txt', status: 'in_progress' }], [{ content: 'Create a.txt', status: 'completed' }]])
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason, end.finalText, end.error], ['completed', 'end_turn', 'Done: created a.txt and edited b.txt.', undefined])

    // Crush got the model in both slots, the hook, the instructions and the run id.
    const log = run.log()
    const start = log.find((e) => e.start)
    assert.deepStrictEqual(start.start.slice(0, 2), ['server', '-H'])
    assert.match(start.start[2], /^unix:\/\/.+\/run\/crush\/[0-9a-f]{12}\.sock$/)
    assert.deepStrictEqual(start.start.slice(3), ['-D', path.join(dataDir, 'server')])
    assert.deepStrictEqual([start.env.BITFROST_SOCKET, start.env.CRUSH_CACHE_DIR, start.env.CRUSH_SERVER_IDLE_TIMEOUT], [path.join(run.dir, 'bridge.sock'), path.join(dataDir, 'cache'), '0'])
    assert.deepStrictEqual(calls(run, 'POST', '/v1/workspaces')[0].body.path, run.cwd)
    assert.deepStrictEqual(calls(run, 'POST', '/v1/workspaces')[0].body.data_dir, dataDir)
    assert.strictEqual(calls(run, 'GET', '/events')[0].query.client_id, calls(run, 'POST', '/v1/workspaces')[0].body.client_id)
    const selected = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoning_effort: 'low' }
    assert.deepStrictEqual(calls(run, 'POST', '/config/model').map((e) => e.body), [{ scope: 1, model_type: 'large', model: selected }, { scope: 1, model_type: 'small', model: selected }])
    const prompt = calls(run, 'POST', '/agent')[0].body
    assert.deepStrictEqual([prompt.session_id, prompt.prompt], ['ses_1', `${INSTRUCTIONS}\n\nList the files.`])
    assert.match(prompt.run_id, /^[0-9a-f-]{36}$/)
    assert.strictEqual(calls(run, 'POST', '/permissions/grant').length, 0, 'the hook answered, so Crush never asked')
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'crush.json'), 'utf8'))
    assert.deepStrictEqual(config.hooks, { PreToolUse: [{ name: 'bitfrost', matcher: HOOK_MATCHER, command: `'${process.execPath}' '${HOOK_SCRIPT}'`, timeout: 604800 }] })
    assert.ok(fs.statSync(path.join(dataDir, 'crush.json')).mode & 0o077 ? false : true, 'the task config is private')
    assert.deepStrictEqual(log.filter((e) => e.hook).map((e) => [e.tool, e.decision]), [['bash', 'none'], ['bash', 'allow'], ['edit', 'allow']])
    assert.ok(run.bridged.every((b) => b.url === '/providers/crush/bridge' && b.token === start.env.BITFROST_CRUSH_TOKEN))

    // The task grant covers the same command next turn without asking.
    assert.strictEqual(await run.provider.sendInput(session, 'Again'), 'started')
    await done(session, 2)
    assert.strictEqual(all(session, 'approval_requested').length, 2)
    assert.deepStrictEqual(run.log().filter((e) => e.hook).map((e) => e.decision).slice(3), ['allow'])
    assert.strictEqual(all(session, 'turn_completed')[1].finalText, 'Again.')
    assert.deepStrictEqual(calls(run, 'POST', '/agent')[1].body.prompt, 'Again', 'instructions lead only the first message')
  } finally {
    await run.stop()
  }
})

test('a denied command or write lets the model go on with the reason, and a denied read outside the folder ends the turn', async () => {
  const run = await fake('deny.json')
  try {
    const session = await spawn(run)
    const command = await asked(session, 1)
    assert.strictEqual(command.title, 'run `rm -rf build`')
    assert.ok(run.provider.resolveApproval(session, command.approvalId, 'deny', 'Not that folder.'))
    const write = await asked(session, 2)
    const file = path.join(run.cwd, 'new.txt')
    assert.deepStrictEqual([write.kind, write.title, write.tool, write.input], ['file_change', `create ${file}`, 'Write', { file_path: file, content: 'hello\n' }])
    assert.ok(run.provider.resolveApproval(session, write.approvalId, 'deny', 'No new files.'))
    const read = await asked(session, 3)
    assert.deepStrictEqual([read.kind, read.title, read.tool, read.input, read.itemId], ['permissions', 'read /etc/hosts', 'Read', { file_path: '/etc/hosts', offset: 0, limit: 0 }, 'call_3'])
    assert.ok(run.provider.resolveApproval(session, read.approvalId, 'deny', 'Not outside.'))
    await done(session)

    assert.deepStrictEqual(run.log().filter((e) => e.hook).map((e) => [e.tool, e.decision, e.reason]), [['bash', 'deny', 'Not that folder.'], ['write', 'deny', 'No new files.']])
    const blocked = find(session, 'command_completed')
    assert.deepStrictEqual([blocked.status, blocked.output], ['failed', 'Tool call blocked by hook. Reason: Not that folder.'])
    assert.deepStrictEqual(find(session, 'tool_completed').output, 'Tool call blocked by hook. Reason: No new files.')
    assert.deepStrictEqual(calls(run, 'POST', '/permissions/grant').map((e) => [e.body.permission.id, e.body.action]), [['perm_3', 'deny']])
    assert.deepStrictEqual(all(session, 'approval_resolved').map((e) => e.decision), ['deny', 'deny', 'deny'])
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason, end.error, end.finalText], ['failed', 'permission_denied', 'Not outside.', 'Let me read the hosts file.'])
  } finally {
    await run.stop()
  }
})

test('a task that cannot ask is refused anything that needs approval, without asking', async () => {
  const run = await fake('deny.json')
  try {
    const session = await spawn(run, { canAskUser: false })
    await done(session)
    assert.strictEqual(all(session, 'approval_requested').length, 0)
    assert.deepStrictEqual(run.log().filter((e) => e.hook).map((e) => [e.tool, e.decision]), [['bash', 'deny'], ['write', 'deny']])
    assert.deepStrictEqual(calls(run, 'POST', '/permissions/grant').map((e) => e.body.action), ['deny'])
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason], ['failed', 'permission_denied'])
    assert.match(end.error, /runs without asking/)
  } finally {
    await run.stop()
  }
})

test('stopping a turn cancels it in Crush and withdraws its open approval', async () => {
  const run = await fake('interrupt.json')
  try {
    const session = await spawn(run)
    const fetch = await asked(session, 1)
    assert.deepStrictEqual([fetch.kind, fetch.title, fetch.tool, fetch.input, fetch.itemId], ['permissions', 'fetch https://example.com', 'WebFetch', { url: 'https://example.com', prompt: '' }, 'call_1'])
    assert.strictEqual(await session.stop(run.provider, 'host'), 'graceful')
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason, end.finalText], ['interrupted', 'interrupted', 'Fetching the page.'])
    assert.deepStrictEqual(all(session, 'approval_resolved').map((e) => [e.approvalId, e.decision]), [[fetch.approvalId, 'deny']])
    assert.deepStrictEqual(run.provider.pendingApprovals(session), [])
    assert.strictEqual(calls(run, 'POST', '/agent/sessions/ses_1/cancel').length, 1)
    assert.strictEqual(calls(run, 'POST', '/permissions/grant').length, 0)
  } finally {
    await run.stop()
  }
})

test('a crashed server fails the turn, and the task reopens on a new server with its history', async () => {
  const run = await fake('crash.json')
  try {
    const session = await spawn(run)
    await until('the crash', () => !!find(session, 'session_failed'))
    assert.match(find(session, 'session_failed').error, /^Crush exited \(code 3/)
    assert.strictEqual(session.info.state, 'detached')
    await assert.rejects(run.provider.sendInput(session, 'Hello?'), /can't reopen this session/)

    await session.attach(run.provider)
    assert.strictEqual(await run.provider.sendInput(session, 'Go on'), 'started')
    await until('the reopened turn', () => all(session, 'turn_completed').some((e) => e.finalText === 'Back.'))
    const starts = run.log().filter((e) => e.start)
    assert.strictEqual(starts.length, 2)
    assert.deepStrictEqual(starts[1].start.slice(3), starts[0].start.slice(3), 'the same task folder')
    assert.deepStrictEqual(calls(run, 'GET', '/sessions/ses_1').length, 1)
    // Usage Crush already reported before the restart is not counted again.
    assert.deepStrictEqual(all(session, 'usage').map((u) => [u.inputTokens, u.outputTokens]), [[1000, 8]])
  } finally {
    await run.stop()
  }
})

test('a turn that Crush answers with another model is stopped', async () => {
  const run = await fake('wrong-model.json')
  try {
    const session = await spawn(run)
    await done(session)
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason], ['failed', 'wrong_model'])
    assert.match(end.error, /switched to opencode-go\/glm-5\.3 instead of opencode-go\/deepseek-v4\.1-flash/)
    assert.strictEqual(calls(run, 'POST', '/agent/sessions/ses_1/cancel').length, 1)
  } finally {
    await run.stop()
  }
})

test('a task does not start when Crush keeps another model, or does not know the chosen one', async () => {
  const run = await fake('stuck-model.json')
  try {
    await assert.rejects(spawn(run), /Crush chose opencode-go\/glm-5\.3 instead of opencode-go\/deepseek-v4\.1-flash/)
    await assert.rejects(spawn(run, { model: 'opencode-go/nope' }), /Crush has no model opencode-go\/nope/)
    await assert.rejects(spawn(run, { model: 'no-slash' }), /named provider\/model/)
    assert.deepStrictEqual(fs.readdirSync(path.join(run.dir, 'data')), [], 'failed tasks leave no folder')
    for (const s of run.log().filter((e) => e.start)) await until('the server to stop', () => exited(s.pid))
    assert.ok(!run.log().some((e) => e.path?.endsWith('/agent') && e.method === 'POST'))
  } finally {
    await run.stop()
  }
})

test('a task stopped while its server starts never runs', async () => {
  const run = await fake('turn.json')
  try {
    const session = new Session({ id: '', harness: 'crush', agent: 'test', model: MODEL, cwd: run.cwd, state: 'running' })
    const spawning = run.provider.spawnSession(session, { model: MODEL, cwd: run.cwd, prompt: 'List the files.', canAskUser: true })
    await until('the server to start', () => run.log().some((e) => e.start))
    assert.strictEqual(run.provider.isBusy(session), true)
    await run.provider.interrupt(session)
    await assert.rejects(spawning)
    assert.strictEqual(session.info.id, '')
    assert.ok(!run.log().some((e) => e.method === 'POST' && e.path?.endsWith('/agent')))
    assert.deepStrictEqual(fs.readdirSync(path.join(run.dir, 'data')), [])
  } finally {
    await run.stop()
  }
})

test('a finish reason that arrives just after run_complete still counts', async () => {
  const run = await fake('late-finish.json')
  try {
    const session = await spawn(run)
    await done(session)
    const end = find(session, 'turn_completed')
    assert.deepStrictEqual([end.status, end.reason, end.finalText], ['failed', 'max_tokens', 'Partial answer'])
  } finally {
    await run.stop()
  }
})

test("Crush's questions reach the lead agent and the answers go back by choice id", async () => {
  const run = await fake('question.json')
  try {
    const session = await spawn(run)
    await until('the question', () => !!find(session, 'question_asked'))
    const q = find(session, 'question_asked')
    assert.deepStrictEqual(q.questions, [
      { id: 'color', header: 'Color', question: 'Pick a color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: '' }], allowOther: false, secret: false },
      { id: 'sure', header: 'Question 2', question: 'Are you sure?', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], allowOther: false, secret: false },
      { id: 'why', header: 'Question 3', question: 'Why?\nOne line is enough.', options: [], allowOther: true, secret: false },
    ])
    assert.deepStrictEqual(run.provider.pendingQuestions(session), [q.questionId])
    assert.ok(await run.provider.answerQuestion(session, q.questionId, { color: ['Blue'], sure: ['Yes'], why: ['Because'] }, false))
    await done(session)
    assert.deepStrictEqual(calls(run, 'POST', '/questions/answer')[0].body, {
      batch_request_id: 'batch_1',
      responses: [
        { request_id: 'color', selected_ids: ['b'] },
        { request_id: 'sure', yes: true },
        { request_id: 'why', fill_in_text: 'Because' },
      ],
    })
    assert.strictEqual(find(session, 'turn_completed').finalText, 'Thanks.')
  } finally {
    await run.stop()
  }
})

test('a real Crush run replays: text, usage, a blocked command and a denied permission', async () => {
  const run = await fake('real-probe.json')
  try {
    const session = await spawn(run, { effort: 'low' })
    await done(session)
    const first = find(session, 'turn_completed')
    assert.deepStrictEqual([first.status, first.finalText], ['completed', 'ok'])
    assert.deepStrictEqual(all(session, 'usage').map((u) => [u.inputTokens, u.outputTokens]), [[18412, 3]])

    await run.provider.sendInput(session, 'Run two commands.')
    const echo = await asked(session, 1)
    assert.strictEqual(echo.title, 'run `echo hi > probe1.txt`', "Crush counts echo as safe, so the hook asks")
    run.provider.resolveApproval(session, echo.approvalId, 'deny', 'Probe says no.')
    const touch = await asked(session, 2)
    assert.deepStrictEqual([touch.kind, touch.title, touch.tool, touch.itemId], ['command', 'run `touch probe2.txt`', 'Bash', 'call_081b6a55407c43a0b1a737ed'])
    run.provider.resolveApproval(session, touch.approvalId, 'deny')
    await done(session, 2)
    const second = all(session, 'turn_completed')[1]
    assert.deepStrictEqual([second.status, second.reason, second.error], ['failed', 'permission_denied', 'The user denied permission.'])
    assert.deepStrictEqual(all(session, 'command_completed').map((c) => [c.command, c.status, c.output]), [
      ['echo hi > probe1.txt', 'failed', 'Tool call blocked by hook. Reason: Probe says no.'],
      ['touch probe2.txt', 'failed', 'User denied permission'],
    ])
    assert.deepStrictEqual(all(session, 'usage').map((u) => [u.inputTokens, u.outputTokens]), [[18412, 3], [18582, 567], [18457, 124]])
    // The final message update and agent event arrive after run_complete; they add nothing.
    await sleep(100)
    assert.strictEqual(session.events.at(-1)!.type, 'turn_completed')
  } finally {
    await run.stop()
  }
})

test('only commands that cannot change anything skip asking', () => {
  for (const c of ['ls', 'ls -la src', 'pwd', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'git diff src/a..b', 'git log main..HEAD', 'git show HEAD:src/x.ts', 'which node', 'echo hello', 'date']) assert.ok(readOnlyCommand(c), c)
  for (const c of [
    'echo hi > file',
    'timeout 5 rm -rf build',
    'env rm -rf x',
    'nice make',
    'kill 1',
    'git branch -D main',
    'git diff --output=x',
    'git diff --no-index /etc/passwd /dev/null',
    'git diff /etc/passwd x',
    'git diff ../other/file x',
    'git show HEAD:../x',
    'git blame --contents=/etc/passwd x',
    'git log -- ~/notes',
    'git -c core.pager=sh log',
    'ls; rm x',
    'ls && rm x',
    'ls | sh',
    'echo $(rm x)',
    'date -s 2020-01-01',
    'cat secrets',
    "git diff '--output=x'",
    'git log "--output=x"',
    'echo "hi"',
    'printenv',
    '',
  ]) assert.ok(!readOnlyCommand(c), c)
})

test('the hook denies when it cannot reach BitFrost', () => {
  const input = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm -rf x' } })
  const missing = spawnSync(process.execPath, [HOOK_SCRIPT], { input, env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.deepStrictEqual([missing.status, missing.stderr], [2, 'this Crush server was not started by BitFrost'])
  const down = spawnSync(process.execPath, [HOOK_SCRIPT], { input, env: { PATH: process.env.PATH, BITFROST_SOCKET: path.join(os.tmpdir(), 'no-such-bitfrost.sock'), BITFROST_CRUSH_TOKEN: 'x' }, encoding: 'utf8' })
  assert.deepStrictEqual([down.status, down.stderr], [2, 'BitFrost is not reachable'])
})

test('the factory finds the real binary behind the npm launcher', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfcrush-bin-')))
  const pkg = path.join(dir, 'lib', 'node_modules', '@charmland', 'crush')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'run-crush.js'), '')
  fs.writeFileSync(path.join(pkg, 'bin', 'crush'), '')
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.symlinkSync(path.join(pkg, 'run-crush.js'), path.join(dir, 'bin', 'crush'))
  const env = (config: any, found: string | null) => ({ runDir: dir, socket: '', log: () => {}, config, resolveBinary: () => found, recorder: () => null })
  assert.strictEqual(resolveCrush(env({}, path.join(dir, 'bin', 'crush'))), path.join(pkg, 'bin', 'crush'))
  assert.strictEqual(resolveCrush(env({ bin: '/opt/crush/crush' }, null)), '/opt/crush/crush')
  assert.strictEqual(resolveCrush(env({}, null)), null)
  assert.strictEqual(crushProvider.detect!(env({}, null)), null)
  assert.deepStrictEqual([crushProvider.id, crushProvider.displayName, crushProvider.vendor, crushProvider.optIn], ['crush', 'Crush', undefined, true])
  fs.rmSync(dir, { recursive: true, force: true })
})


test('Crush bills equal-sized model requests separately and collapses duplicate session updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfcrush-equal-'))
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'turn.json'), 'utf8'))
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return
    if ('prompt_tokens' in value) { value.prompt_tokens = 100; value.completion_tokens = 10 }
    for (const child of Object.values(value)) visit(child)
  }
  visit(fixture)
  const file = path.join(dir, 'equal.json')
  fs.writeFileSync(file, JSON.stringify(fixture))
  const run = await fake(file, {}, dir)
  try {
    const s = await spawn(run, { canAskUser: false })
    await done(s)
    const reports = all(s, 'usage')
    // The fixture has three assistant responses and a duplicate final session update.
    assert.deepEqual(reports.map((u) => [u.inputTokens, u.outputTokens]), [[100, 10], [100, 10], [100, 10]])
    assert.equal(new Set(reports.map((u) => u.requestId)).size, 3)
  } finally { await run.stop() }
})
