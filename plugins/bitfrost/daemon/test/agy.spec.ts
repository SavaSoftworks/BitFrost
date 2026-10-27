// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for AgyProvider. fake-agy.mjs stands in for the Antigravity CLI, playing either
// a real agy 1.3.5 run from fixtures/agy/ or scripted steps. The bridge plugin is
// installed into a temporary home and its hook runs for real against a small bridge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgyProvider, agyEndReason, agyProvider, authMethodOf, authRefusal, bridgeCurrent, bridgeDir, bridgeLoaded, foldModels, installBridge, resolveAgy, uninstallBridge } from '../providers/agy.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(HERE, 'fake-agy.mjs')
const FIXTURES = path.join(HERE, 'fixtures', 'agy')
const MODEL = 'gemini-3.8-flash'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(10)
  }
}

type Run = { provider: AgyProvider; dir: string; cwd: string; home: string; log: () => any[]; stop: () => Promise<void>; logs: string[] }

async function fake(t: any, scenario: any, { bridge = true, loaded, authWaitMs }: { bridge?: boolean; loaded?: boolean; authWaitMs?: number } = {}): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfagy-'))
  const home = path.join(dir, 'home')
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(cwd, { recursive: true })
  const pluginDir = bridgeDir(home)
  if (bridge) installBridge(pluginDir)
  const scenarioFile = path.join(dir, 'scenario.json')
  const logFile = path.join(dir, 'log.jsonl')
  fs.writeFileSync(scenarioFile, JSON.stringify({ models: path.join(FIXTURES, 'models.txt'), ...scenario }))
  process.env.BITFROST_AGY_SCENARIO = scenarioFile
  process.env.BITFROST_AGY_LOG = logFile
  process.env.BITFROST_AGY_PLUGIN_DIR = pluginDir
  const socket = path.join(dir, 'bridge.sock')
  const logs: string[] = []
  const provider = new AgyProvider({ bin: process.execPath, args: [FAKE], log: (m) => logs.push(m), runDir: path.join(dir, 'run'), socket, bridgeLoaded: async () => loaded ?? bridge, authWaitMs })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const reply = await provider.bridge(String(req.headers['x-bitfrost-token'] ?? ''), JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(reply ? JSON.stringify(reply) : '')
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const stop = async () => {
    provider.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await sleep(50)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  t.after(stop)
  return { provider, dir, cwd, home, log, stop, logs }
}

async function spawn(run: Run, { effort = 'low', canAskUser = true, prompt = 'Do the task.', developerInstructions }: { effort?: string; canAskUser?: boolean; prompt?: string; developerInstructions?: string } = {}): Promise<Session> {
  const session = new Session({ id: '', harness: 'agy', agent: 'test', model: MODEL, cwd: run.cwd, state: 'idle' })
  await run.provider.spawnSession(session, { model: MODEL, effort, cwd: run.cwd, prompt, canAskUser, developerInstructions })
  return session
}

const types = (s: Session) => s.events.filter((e) => !['user_input', 'input_consumed'].includes(e.type)).map((e) => e.type)
const all = (s: Session, type: string): any[] => s.events.filter((e) => e.type === type)
const find = (s: Session, type: string): any => s.events.find((e) => e.type === type)
const done = (s: Session, n = 1) => until(`${n} finished turn(s)`, () => all(s, 'turn_completed').length >= n)
const asked = (s: Session, type: string, n = 1) => until(`${type} ${n}`, () => all(s, type).length >= n).then(() => all(s, type)[n - 1])
const spawned = (run: Run) => run.log().filter((e) => e.args)
const hookOut = (run: Run, hook: string) => run.log().filter((e) => e.hook === hook).map((e) => (e.out ? JSON.parse(e.out) : null))

test('effort variants fold into one model, with each maker named and the list kept for a few minutes', async (t) => {
  const run = await fake(t, {})
  const models = await run.provider.listModels()
  assert.deepStrictEqual(models.map((m) => [m.model, m.provider, m.displayName, m.efforts, m.defaultEffort, m.isDefault]), [
    ['gemini-3.8-flash', 'Google', 'Gemini 3.8 Flash', ['low', 'medium', 'high'], 'medium', true],
    ['claude-sonnet-4-6', 'Anthropic', 'Claude Sonnet 4.6 (Thinking)', [], null, false],
    ['claude-opus-4-6-thinking', 'Anthropic', 'Claude Opus 4.6 (Thinking)', [], null, false],
    ['gpt-oss-120b', 'OpenAI', 'GPT-OSS 120B', ['medium'], 'medium', false],
  ])
  await run.provider.listModels()
  const again = new AgyProvider({ bin: process.execPath, args: [FAKE], log: () => {}, runDir: path.join(run.dir, 'run'), socket: '' })
  assert.strictEqual((await again.listModels()).length, 4)
  assert.strictEqual(run.log().filter((e) => e.models).length, 1)
  await again.listModels(true)
  assert.strictEqual(run.log().filter((e) => e.models).length, 2)

  // The chosen effort picks the model id Antigravity runs.
  const session = await spawn(run, { effort: 'high' })
  await done(session)
  assert.strictEqual(spawned(run)[0].args[spawned(run)[0].args.indexOf('--model') + 1], 'gemini-3.8-flash-high')
  assert.strictEqual(session.nativeRef.model, 'gemini-3.8-flash-high')
})

test('a listing that fails asks the user to sign in', async (t) => {
  const run = await fake(t, { modelsError: 'Please sign in to view available models. Launch the CLI without arguments to sign in.' })
  await assert.rejects(run.provider.listModels(), /not signed in\. Sign Antigravity in with an API key or a business account/)
  assert.deepStrictEqual(foldModels('Fetching available models...\n').models, [])
})

test('the sign-in method comes from the log lines, and only known API key and business sign-ins run', () => {
  const line = (method: string) => `I1016 13:35:22.977622       1 server_oauth.go:204] applyAuthResult: email=test@example.com, authMethod=${method}, quotaProject=`
  assert.strictEqual(authMethodOf(line('Consumer')), 'consumer')
  assert.strictEqual(authMethodOf(line('gemini_api_key')), 'gemini_api_key')
  assert.strictEqual(authMethodOf(line('business_licensed_enterprise')), 'business_licensed_enterprise')
  assert.strictEqual(authMethodOf(line('')), '')
  assert.strictEqual(authMethodOf('I1016 13:35:22.977622       1 server_oauth.go:204] applyAuthResult: email=test@example.com, authMethod=cons'), null)
  assert.strictEqual(authMethodOf('the log never said'), null)
  assert.match(authRefusal('consumer')!, /personal Google account/)
  assert.match(authRefusal('personal_workspace')!, /personal Google account/)
  assert.match(authRefusal('')!, /couldn't tell how Antigravity is signed in/)
  assert.match(authRefusal(null)!, /couldn't tell how Antigravity is signed in/)
  assert.strictEqual(authRefusal('gemini_api_key'), null)
  assert.strictEqual(authRefusal('business_licensed_enterprise'), null)
  for (const method of ['google_one', 'free_tier', 'individual', 'gca_free']) assert.match(authRefusal(method)!, /doesn't recognize/, method)
  // A later refused sign-in wins over an earlier good one.
  assert.strictEqual(authMethodOf(`${line('gemini_api_key')}\n${line('consumer')}\n`), 'consumer')
  assert.strictEqual(authMethodOf(`${line('consumer')}\n${line('gemini_api_key')}\n`), 'consumer')
})

test('a personal Google account is refused before any prompt is sent', async (t) => {
  const run = await fake(t, { authMethod: 'consumer', authDelayMs: 100, turns: [{ steps: [{ text: 'Should not run.' }] }] })
  const session = await spawn(run)
  await done(session)
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'auth'])
  assert.match(end.error, /personal Google account/)
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined), [])
  const pid = spawned(run)[0].pid
  await until('the process to be killed', () => {
    try { process.kill(pid, 0); return false } catch { return true }
  })
  assert.deepStrictEqual(fs.readdirSync(path.join(run.dir, 'run', 'agy-auth')), [])
})

test('a run that never says how it signed in is refused', async (t) => {
  const run = await fake(t, { authMethod: null, turns: [{ steps: [{ text: 'Should not run.' }] }] }, { authWaitMs: 500 })
  const session = await spawn(run)
  await done(session)
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'auth'])
  assert.match(end.error, /couldn't tell how Antigravity is signed in/)
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined), [])
})

test('api key and business sign-ins run as normal', async (t) => {
  for (const authMethod of ['gemini_api_key', 'business_licensed_enterprise']) {
    const run = await fake(t, { authMethod, turns: [{ steps: [{ text: 'Done.' }] }] })
    const session = await spawn(run)
    await done(session)
    assert.deepStrictEqual([find(session, 'turn_completed').status, find(session, 'turn_completed').finalText], ['completed', 'Done.'])
  }
})

test('a consumer sign-in blocks the model list and clears the cache', async (t) => {
  const run = await fake(t, { authMethod: 'consumer' })
  const cache = path.join(run.dir, 'run', 'agy-models.json')
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  // Fresh, but from before the sign-in check, so it is fetched again.
  fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), models: [], variants: {} }))
  await assert.rejects(run.provider.listModels(), (e: any) => e.blocked === true && /personal Google account/.test(e.message))
  assert.ok(!fs.existsSync(cache))
  assert.strictEqual(run.log().filter((e) => e.models).length, 1)
})

test('a failed listing on a personal sign-in still drops the cached models', async (t) => {
  const run = await fake(t, { authMethod: 'consumer', modelsError: 'error: network unreachable' })
  const cache = path.join(run.dir, 'run', 'agy-models.json')
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), auth: 'gemini_api_key', models: [{ model: 'gemini-3.8-flash' }], variants: {} }))
  await assert.rejects(run.provider.listModels(true), (e: any) => e.blocked === true && /personal Google account/.test(e.message))
  assert.ok(!fs.existsSync(cache))
  await assert.rejects(run.provider.listModels(), (e: any) => e.blocked === true)
})

test('the run log with the account email is removed once the run ends', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ text: 'Done.' }] }] })
  const session = await spawn(run)
  await done(session)
  run.provider.disposeSession(session)
  await until('the log to go', () => fs.readdirSync(path.join(run.dir, 'run', 'agy-auth')).length === 0)
})

test('a run that signs in again with a personal account is stopped before its next prompt', async (t) => {
  const run = await fake(t, { reauth: 'consumer', turns: [{ steps: [{ text: 'First.' }] }, { steps: [{ text: 'Should not run.' }] }] })
  const session = await spawn(run)
  await done(session)
  assert.strictEqual(find(session, 'turn_completed').status, 'completed')
  await until('the second sign-in', () => run.log().some((e) => e.reauth))
  await run.provider.sendInput(session, 'Next.')
  await done(session, 2)
  const end = all(session, 'turn_completed')[1]
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'auth'])
  assert.match(end.error, /personal Google account/)
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined).map((e) => e.input), ['Do the task.'])
})

test('a real run replays with approvals, a denial and its reason, diffs, and usage once per request', async (t) => {
  const fixture = path.join(FIXTURES, 'real-basic.jsonl')
  const run = await fake(t, { turns: [{ fixture, part: 0, writes: { 8: ['notes.txt', 'hi\n'], 10: ['notes.txt', 'bye\n'] } }, { fixture, part: 1 }] })
  fs.writeFileSync(path.join(run.cwd, 'f.txt'), 'a\nb\n')
  const session = await spawn(run, { developerInstructions: 'You are a delegated subagent.' })
  for (let n = 1; n <= 3; n++) {
    const a = await asked(session, 'approval_requested', n)
    if (a.title.includes('b.txt')) run.provider.resolveApproval(session, a.approvalId, 'deny', 'Not b.txt; use c.txt instead')
    else run.provider.resolveApproval(session, a.approvalId, 'allow')
  }
  await done(session)
  assert.deepStrictEqual(types(session), [
    'turn_started',
    'usage', 'command_started', 'approval_requested', 'approval_resolved', 'command_completed',
    'usage', 'command_started', 'approval_requested', 'approval_resolved', 'command_completed',
    'usage', 'command_started', 'approval_requested', 'approval_resolved', 'command_completed',
    'usage', 'file_change',
    'usage', 'file_change',
    'usage', 'tool_started', 'tool_completed',
    'text', 'usage',
    'turn_completed',
  ])
  const approvals = all(session, 'approval_requested')
  assert.deepStrictEqual(approvals.map((a) => [a.kind, a.title, a.tool, a.input.command]), [
    ['command', 'run `touch a.txt`', 'Bash', 'touch a.txt'],
    ['command', 'run `touch b.txt`', 'Bash', 'touch b.txt'],
    ['command', 'run `touch c.txt`', 'Bash', 'touch c.txt'],
  ])
  assert.strictEqual(approvals[0].itemId, 'b4f239ef-7d82-4f89-b06e-a0eb354e0b70:2')
  // The denial reason reaches the model as the tool's error.
  const commands = all(session, 'command_completed')
  assert.deepStrictEqual(commands.map((c) => c.status), ['completed', 'failed', 'completed'])
  assert.match(commands[1].output, /Not b\.txt; use c\.txt instead/)
  assert.deepStrictEqual(hookOut(run, 'PreToolUse')[1], { decision: 'deny', reason: 'Not b.txt; use c.txt instead' })
  assert.deepStrictEqual(all(session, 'file_change').map((f) => [path.basename(f.changes[0].path), f.changes[0].kind, f.changes[0].diff]), [
    ['notes.txt', 'add', '@@ -0,0 +1,1 @@\n+hi'],
    ['notes.txt', 'update', '@@ -1,1 +1,1 @@\n-hi\n+bye'],
  ])
  const read = find(session, 'tool_completed')
  assert.deepStrictEqual([read.name, read.input.file_path, read.ok, read.output], ['Read', path.join(run.cwd, 'f.txt'), true, '3 lines, 4 bytes'])
  // Cached input counts inside input tokens, and each request is reported once.
  const usage = all(session, 'usage')
  assert.deepStrictEqual(usage.map((u) => u.inputTokens), [11903, 12108, 12325, 12530, 12825, 13237, 13581])
  assert.deepStrictEqual(usage.map((u) => u.cachedInputTokens), [0, 0, 0, 10059, 0, 0, 0])
  assert.strictEqual(new Set(usage.map((u) => u.requestId)).size, usage.length)
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['completed', 'end_turn'])
  assert.match(end.finalText, /^DONE\n\nFiles:/)
  assert.ok(end.finalText.includes(run.cwd))
  // The instructions lead the first message only, and the run is gated by the hook.
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined).map((e) => e.input), ['You are a delegated subagent.\n\nDo the task.'])
  const args = spawned(run)[0].args
  assert.deepStrictEqual(args.slice(0, 8), ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model', 'gemini-3.8-flash-low'])
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.strictEqual(spawned(run)[0].env.token, (run.provider as any).states.get(session.info.id).token)
  assert.strictEqual(session.nativeRef.conversationId, 'b4f239ef-7d82-4f89-b06e-a0eb354e0b70')

  // A second message runs on the same process.
  await session.deliver(run.provider, 'Now reply with just the word SECOND.')
  await done(session, 2)
  assert.strictEqual(all(session, 'turn_completed')[1].finalText, 'SECOND')
  assert.strictEqual(spawned(run).length, 1)
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined).map((e) => e.input).slice(1), ['Now reply with just the word SECOND.'])
})

test('allow_session lets the same command through for the rest of the task', async (t) => {
  const cmd = { CommandLine: 'npm test', Cwd: '/elsewhere' }
  const run = await fake(t, { turns: [{ steps: [{ tool: 'run_command', args: cmd }, { tool: 'run_command', args: cmd }, { tool: 'run_command', args: { CommandLine: 'npm run build' } }, { text: 'Done.' }] }] })
  const session = await spawn(run)
  const first = await asked(session, 'approval_requested')
  assert.strictEqual(first.detail.split('\n').at(-1), 'In /elsewhere')
  run.provider.resolveApproval(session, first.approvalId, 'allow_session')
  const third = await asked(session, 'approval_requested', 2)
  assert.strictEqual(third.input.command, 'npm run build')
  run.provider.resolveApproval(session, third.approvalId, 'deny')
  await done(session)
  assert.deepStrictEqual(all(session, 'command_completed').map((c) => c.status), ['completed', 'completed', 'failed'])
  assert.deepStrictEqual(hookOut(run, 'PreToolUse'), [{ decision: 'allow' }, { decision: 'allow' }, { decision: 'deny', reason: 'The user denied this.' }])
  assert.deepStrictEqual(all(session, 'approval_resolved').map((a) => a.decision), ['allow_session', 'deny'])
})

test('subagent and scheduling tools are refused, reads and edits in the folder pass, and the rest is asked', async (t) => {
  const outside = path.join(os.tmpdir(), 'bfagy-outside.txt')
  const steps = [
    ...['invoke_subagent', 'define_subagent', 'manage_subagents', 'browser_subagent', 'send_message', 'run_workflow', 'schedule'].map((tool) => ({ tool, args: { Prompt: 'x' } })),
    { tool: 'ask_permission', args: { Reason: 'x' } },
    { tool: 'view_file', args: { AbsolutePath: '/etc/hostname' } },
    { tool: 'grep_search', args: { Query: 'x' } },
    { tool: 'run_command', args: { CommandLine: 'ls -la' } },
    { tool: 'manage_task', args: { Action: 'status', TaskId: 't1' } },
    { tool: 'write_to_file', args: { TargetFile: 'new.txt', CodeContent: 'hi' }, write: ['new.txt', 'hi'] },
    { tool: 'write_to_file', args: { TargetFile: outside, CodeContent: 'hi' } },
    { tool: 'read_url_content', args: { Url: 'https://example.com' } },
    { text: 'Done.' },
  ]
  const run = await fake(t, { turns: [{ steps }] })
  const session = await spawn(run)
  const write = await asked(session, 'approval_requested')
  assert.deepStrictEqual([write.kind, write.title, write.tool], ['file_change', `create ${outside}`, 'Write'])
  run.provider.resolveApproval(session, write.approvalId, 'deny', 'Stay in the folder.')
  const fetch = await asked(session, 'approval_requested', 2)
  assert.deepStrictEqual([fetch.kind, fetch.title, fetch.tool, fetch.input.url], ['permissions', 'fetch https://example.com', 'WebFetch', 'https://example.com'])
  run.provider.resolveApproval(session, fetch.approvalId, 'allow')
  await done(session)
  const replies = hookOut(run, 'PreToolUse')
  for (const r of replies.slice(0, 7)) assert.match(r.reason, /^BitFrost subagents cannot use \w+: nested subagents/)
  assert.match(replies[7].reason, /Call the tool you need directly/)
  assert.deepStrictEqual(replies.slice(8, 13), Array(5).fill({ decision: 'allow' }))
  assert.deepStrictEqual(replies.slice(13), [{ decision: 'deny', reason: 'Stay in the folder.' }, { decision: 'allow' }])
  assert.strictEqual(all(session, 'approval_requested').length, 2)
  const change = find(session, 'file_change')
  assert.deepStrictEqual([change.changes[0].path, change.changes[0].kind], [path.join(run.cwd, 'new.txt'), 'add'])
})

test('dangling links, git, and a command grant in another folder are all asked about', async (t) => {
  const steps = [
    { tool: 'write_to_file', args: { TargetFile: 'link.txt', CodeContent: 'hi' } },
    { tool: 'run_command', args: { CommandLine: 'git status' } },
    { tool: 'run_command', args: { CommandLine: 'rm -rf build' } },
    { tool: 'run_command', args: { CommandLine: 'rm -rf build', Cwd: '/elsewhere' } },
    { text: 'Done.' },
  ]
  const run = await fake(t, { turns: [{ steps }] })
  fs.symlinkSync(path.join(run.dir, 'missing', 'new.txt'), path.join(run.cwd, 'link.txt'))
  const session = await spawn(run)
  const titles: string[] = []
  for (let n = 1; n <= 4; n++) {
    const a = await asked(session, 'approval_requested', n)
    titles.push(a.title)
    run.provider.resolveApproval(session, a.approvalId, n === 3 ? 'allow_session' : 'deny')
  }
  await done(session)
  assert.match(titles[0], /link\.txt/)
  assert.deepStrictEqual(titles.slice(1), ['run `git status`', 'run `rm -rf build`', 'run `rm -rf build`'])
})

test('a task that cannot ask refuses what needs approval and every question', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'rm -rf build' } }, { tool: 'ask_question', args: { questions: [{ question: 'Which?', options: ['a', 'b'] }] } }, { tool: 'run_command', args: { CommandLine: 'pwd' } }, { text: 'Done.' }] }] })
  const session = await spawn(run, { canAskUser: false })
  await done(session)
  assert.deepStrictEqual(hookOut(run, 'PreToolUse'), [
    { decision: 'deny', reason: 'This BitFrost task runs without asking, so actions that need approval are refused.' },
    { decision: 'deny', reason: 'No one can answer questions in this task; use your best judgment.' },
    { decision: 'allow' },
  ])
  assert.strictEqual(all(session, 'approval_requested').length + all(session, 'question_asked').length, 0)
})

test('ask_question goes to the user and the answer comes back as the hook reason', async (t) => {
  const q = { questions: [{ is_multi_select: false, options: ['red', 'green', 'blue'], question: 'Which color do you want?' }] }
  const run = await fake(t, { turns: [{ steps: [{ tool: 'ask_question', args: q }, { text: 'green' }] }] })
  const session = await spawn(run)
  const asking = await asked(session, 'question_asked')
  assert.deepStrictEqual(asking.questions, [{ id: 'q0', header: '', question: 'Which color do you want?', options: ['red', 'green', 'blue'].map((label) => ({ label, description: '' })), allowOther: true, secret: false }])
  assert.deepStrictEqual(run.provider.pendingQuestions(session), [asking.questionId])
  assert.strictEqual(await run.provider.answerQuestion(session, asking.questionId, { q0: ['green'] }, false), true)
  await done(session)
  assert.deepStrictEqual(hookOut(run, 'PreToolUse'), [{ decision: 'deny', reason: 'The user answered your question.\n\nWhich color do you want?\ngreen' }])
  assert.strictEqual(find(session, 'question_answered').how, 'answered')
  assert.strictEqual(find(session, 'turn_completed').finalText, 'green')
})

test('a deferred question stops the turn, and the answer resumes the conversation', async (t) => {
  const q = { questions: [{ options: [], question: 'Which branch?' }] }
  const run = await fake(t, { turns: [{ steps: [{ tool: 'ask_question', args: q }, { block: true }] }], resumed: [{ steps: [{ text: 'On main.' }] }] })
  const session = await spawn(run)
  const asking = await asked(session, 'question_asked')
  await run.provider.answerQuestion(session, asking.questionId, null, true)
  await done(session)
  assert.deepStrictEqual([find(session, 'turn_completed').status, find(session, 'question_answered').how], ['interrupted', 'deferred'])
  await session.deliver(run.provider, 'Use main.')
  await done(session, 2)
  assert.strictEqual(all(session, 'turn_completed')[1].finalText, 'On main.')
  assert.deepStrictEqual(spawned(run)[1].args.slice(-2), ['--conversation', 'conv-1'])
})

test('a message sent during a turn is injected before the next model request', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'make' } }, { text: 'DONE1 PINEAPPLE' }] }] })
  const session = await spawn(run)
  const a = await asked(session, 'approval_requested')
  const receipt = await session.deliver(run.provider, 'Also end your reply with the word PINEAPPLE.')
  assert.strictEqual(receipt.delivery, 'steered')
  run.provider.resolveApproval(session, a.approvalId, 'allow')
  await done(session)
  assert.deepStrictEqual(run.log().filter((e) => e.injected).map((e) => e.injected), ['Also end your reply with the word PINEAPPLE.'])
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined).length, 1)
  assert.strictEqual(all(session, 'turn_completed').length, 1)
  const steered = session.events.find((e) => e.type === 'user_input' && e.delivery === 'steered') as any
  assert.ok(session.events.some((e) => e.type === 'input_consumed' && e.inputId === steered.inputId))
})

test('a message that arrives after the last model request runs next, in the same turn', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ text: 'ONE' }, { wait: 300 }] }, { steps: [{ text: 'TWO' }] }] })
  const session = await spawn(run)
  await until('the first reply', () => all(session, 'text').length === 1)
  assert.strictEqual((await session.deliver(run.provider, 'Now say TWO.')).delivery, 'steered')
  await done(session)
  await sleep(100)
  assert.strictEqual(all(session, 'turn_completed').length, 1)
  assert.strictEqual(find(session, 'turn_completed').finalText, 'TWO')
  assert.deepStrictEqual(run.log().filter((e) => e.input !== undefined).map((e) => e.input), ['Do the task.', 'Now say TWO.'])
  assert.strictEqual(run.log().filter((e) => e.injected).length, 0)
})

test('an interrupt ends the turn and the next message resumes the conversation in a new process', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'sleep 30' }, block: true }] }], resumed: [{ steps: [{ text: 'sleep 30' }] }] })
  const session = await spawn(run)
  const a = await asked(session, 'approval_requested')
  run.provider.resolveApproval(session, a.approvalId, 'allow')
  await until('the command to run', () => run.log().some((e) => e.hook === 'PreToolUse'))
  assert.strictEqual(await session.stop(run.provider, 'host'), 'graceful')
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['interrupted', 'interrupted'])
  assert.ok(run.log().some((e) => e.signal === 'SIGINT'))
  await session.deliver(run.provider, 'What did I ask?')
  await done(session, 2)
  assert.deepStrictEqual([all(session, 'turn_completed')[1].status, all(session, 'turn_completed')[1].finalText], ['completed', 'sleep 30'])
  const [first, second] = spawned(run)
  assert.ok(!first.args.includes('--conversation'))
  assert.deepStrictEqual(second.args.slice(-2), ['--conversation', 'conv-1'])
  assert.throws(() => process.kill(first.pid, 0))
})

test('an app that ignores the interrupt is killed', async (t) => {
  const run = await fake(t, { ignoreInt: true, turns: [{ steps: [{ block: true }] }] })
  const session = await spawn(run)
  // Wait for the prompt, which goes in only after the sign-in check.
  await until('the prompt', () => run.log().some((e) => e.input !== undefined))
  assert.strictEqual(await session.stop(run.provider, 'host', { graceMs: 200 }), 'forced')
  assert.strictEqual(find(session, 'turn_completed').reason, 'interrupted')
})

test('a different model than the one asked for stops the turn', async (t) => {
  const run = await fake(t, { ranModel: 'gemini-3.8-flash-high', turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'touch x' }, block: true }] }] })
  const session = await spawn(run)
  await done(session)
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'wrong_model'])
  assert.strictEqual(end.error, 'Antigravity started gemini-3.8-flash-high instead of gemini-3.8-flash-low; stopped it')
  assert.strictEqual(all(session, 'approval_requested').length, 0)
})

test('a hook naming a different model is refused and stops the turn', async (t) => {
  const run = await fake(t, { hookModel: 'claude-opus-4-6-thinking', turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'touch x' } }, { block: true }] }] })
  const session = await spawn(run)
  await done(session)
  assert.strictEqual(find(session, 'turn_completed').reason, 'wrong_model')
  assert.ok(hookOut(run, 'PreToolUse').every((r) => r?.decision === 'deny'))
  assert.strictEqual(all(session, 'approval_requested').length, 0)
})

test('attach reopens a saved conversation after a helper restart', async (t) => {
  const run = await fake(t, { resumed: [{ steps: [{ text: 'Still here.' }] }] })
  const session = new Session({ id: 'agy_saved', harness: 'agy', agent: 'test', model: MODEL, effort: 'low', cwd: run.cwd, state: 'detached' })
  session.nativeRef = { conversationId: 'conv-saved', model: 'gemini-3.8-flash-low', canAsk: true }
  await session.attach(run.provider)
  await session.deliver(run.provider, 'Are you there?')
  await done(session)
  assert.strictEqual(find(session, 'turn_completed').finalText, 'Still here.')
  const args = spawned(run)[0].args
  assert.deepStrictEqual([args[args.indexOf('--model') + 1], ...args.slice(-2)], ['gemini-3.8-flash-low', '--conversation', 'conv-saved'])
  await assert.rejects(run.provider.attach!(new Session({ id: 'x', harness: 'agy', agent: 't', model: MODEL, cwd: run.cwd, state: 'detached' }), {}), /no conversation id/)
})

test('the process group is saved with the session, swept by its mark, and forgotten once it is gone', async (t) => {
  const { killOwnedGroup } = await import('../process.ts')
  const run = await fake(t, { turns: [{ steps: [{ text: 'Done.' }] }] })
  const session = await spawn(run)
  await done(session)
  const started = spawned(run)[0]
  const identity = session.nativeRef.process
  assert.deepStrictEqual([identity.pgid, identity.marker, identity.token], [started.pid, 'BITFROST_AGY_PROC', started.env.mark])
  // An unknown mark or token never matches.
  assert.equal(killOwnedGroup({ ...identity, marker: 'PATH' }), false)
  assert.equal(killOwnedGroup({ ...identity, token: 'another process' }), false)
  assert.equal(killOwnedGroup(identity), true)
  await until('the saved group is forgotten', () => !session.nativeRef.process)
})

test('a crash fails the turn with the reason Antigravity gave, and the next turn starts a new process', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ text: 'Working' }, { exit: 3, stderr: 'AGY_ERROR: {"short_error":"Your AI credits balance is too low to continue","retryable":false}' }] }], resumed: [{ steps: [{ text: 'Back.' }] }] })
  const session = await spawn(run)
  await done(session)
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason, end.finalText], ['failed', 'quota_exhausted', 'Working'])
  assert.match(end.error, /AI credits balance is too low/)
  await session.deliver(run.provider, 'Again.')
  await done(session, 2)
  assert.strictEqual(all(session, 'turn_completed')[1].finalText, 'Back.')
})

test('an error result fails the turn but keeps the process for the next one', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ error: 'RESOURCE_EXHAUSTED: 429 Too Many Requests' }] }, { steps: [{ text: 'Fine now.' }] }] })
  const session = await spawn(run)
  await done(session)
  assert.deepStrictEqual([find(session, 'turn_completed').status, find(session, 'turn_completed').reason], ['failed', 'rate_limited'])
  await session.deliver(run.provider, 'Retry.')
  await done(session, 2)
  assert.strictEqual(all(session, 'turn_completed')[1].finalText, 'Fine now.')
  assert.strictEqual(spawned(run).length, 1)
})

test('failures are sorted into end reasons', () => {
  assert.strictEqual(agyEndReason('Your AI credits balance is too low to continue'), 'quota_exhausted')
  assert.strictEqual(agyEndReason('RESOURCE_EXHAUSTED: 429'), 'rate_limited')
  assert.strictEqual(agyEndReason('Please sign in to continue'), 'auth')
  assert.strictEqual(agyEndReason('No valid authentication found (expired). Starting login...'), 'auth')
  assert.strictEqual(agyEndReason('the prompt exceeds the context window'), 'max_tokens')
  assert.strictEqual(agyEndReason('something odd'), 'error')
})

test('without the bridge plugin Antigravity keeps its permission prompts and says why it refused', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ tool: 'run_command', args: { CommandLine: 'touch x' } }, { text: 'Could not.' }] }] }, { bridge: false })
  const session = await spawn(run)
  await done(session)
  assert.ok(!spawned(run)[0].args.includes('--dangerously-skip-permissions'))
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'permission_denied'])
  assert.match(end.error, /bitfrostd setup agy/)
  assert.ok(run.logs.some((m) => /bridge plugin is not loaded/.test(m)))
})

test('a run whose hooks never call BitFrost is stopped before it can act', async (t) => {
  const run = await fake(t, { turns: [{ steps: [{ text: 'Thinking.' }, { wait: 500 }, { tool: 'run_command', args: { CommandLine: 'touch x' }, write: ['x', ''] }, { text: 'Done.' }] }] }, { bridge: false, loaded: true })
  const session = await spawn(run)
  await done(session)
  assert.ok(spawned(run)[0].args.includes('--dangerously-skip-permissions'))
  const end = find(session, 'turn_completed')
  assert.deepStrictEqual([end.status, end.reason], ['failed', 'error'])
  assert.match(end.error, /did not load the BitFrost bridge plugin/)
  assert.ok(!fs.existsSync(path.join(run.cwd, 'x')))
  // Later runs keep the permission prompts on.
  await session.deliver(run.provider, 'Again.')
  await done(session, 2)
  assert.ok(!spawned(run)[1].args.includes('--dangerously-skip-permissions'))
})

test('the hook has no opinion outside BitFrost runs and blocks tool calls BitFrost cannot answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfagy-hook-'))
  try {
    const plugin = bridgeDir(dir)
    installBridge(plugin)
    const hook = (event: string, env: Record<string, string>) => spawnSync('sh', ['-c', `'${plugin}/hook' ${event}`], { cwd: plugin, input: '{"toolCall":{"name":"run_command","args":{}}}', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
    for (const event of ['PreToolUse', 'PreInvocation']) {
      const r = hook(event, {})
      assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', ''])
    }
    const away = { BITFROST_AGY_TOKEN: 't', BITFROST_NODE: process.execPath, BITFROST_SOCKET: path.join(dir, 'missing.sock') }
    const blocked = hook('PreToolUse', away)
    assert.deepStrictEqual([blocked.status, blocked.stdout, blocked.stderr], [2, '', 'BitFrost is not reachable'])
    const quiet = hook('PreInvocation', away)
    assert.deepStrictEqual([quiet.status, quiet.stdout], [0, ''])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the hook blocks a tool call that BitFrost answers without a decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfagy-hook-'))
  const socket = path.join(dir, 'bridge.sock')
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(200); res.end('') })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    const plugin = bridgeDir(dir)
    installBridge(plugin)
    const env = { PATH: process.env.PATH ?? '', BITFROST_AGY_TOKEN: 't', BITFROST_NODE: process.execPath, BITFROST_SOCKET: socket }
    const hook = (event: string) => new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = nodeSpawn('sh', ['-c', `'${plugin}/hook' ${event}`], { cwd: plugin, env })
      let err = ''
      child.stderr.on('data', (d) => (err += d))
      child.on('close', (code) => resolve({ code, err }))
      child.stdin.end('{"toolCall":{"name":"run_command","args":{}}}')
    })
    assert.deepStrictEqual(await hook('PreToolUse'), { code: 2, err: 'BitFrost did not answer the tool call' })
    assert.deepStrictEqual(await hook('PreInvocation'), { code: 0, err: '' })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setup installs the bridge into the plugins folder, and uninstall removes it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bfagy-home-'))
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    const dir = bridgeDir(home)
    assert.strictEqual(bridgeDir(), dir)
    assert.deepStrictEqual(agyProvider.uninstall!(true), [])
    assert.strictEqual(bridgeCurrent(dir), false)
    const quiet = console.log
    console.log = () => {}
    try { agyProvider.setup!({} as any) } finally { console.log = quiet }
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['hook', 'hook.mjs', 'hooks.json', 'plugin.json'])
    assert.strictEqual(fs.statSync(path.join(dir, 'hook')).mode & 0o777, 0o755)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).name, 'bitfrost-bridge')
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'))['bitfrost-bridge']
    assert.strictEqual(hooks.PreToolUse[0].matcher, '*')
    assert.strictEqual(hooks.PreToolUse[0].hooks[0].command, `'${dir}/hook' PreToolUse`)
    assert.strictEqual(hooks.PreInvocation[0].command, `'${dir}/hook' PreInvocation`)
    assert.ok(hooks.PreToolUse[0].hooks[0].timeout >= 24 * 3600)
    assert.strictEqual(bridgeCurrent(dir), true)
    assert.ok(!fs.existsSync(path.join(home, '.gemini', 'config', '.bitfrost-bridge.new')))
    fs.appendFileSync(path.join(dir, 'hook.mjs'), '\n')
    assert.strictEqual(bridgeCurrent(dir), false)
    installBridge(dir)
    assert.strictEqual(bridgeCurrent(dir), true)

    // Antigravity's own plugin list must show it loaded with its hooks.
    const scenarioFile = path.join(home, 'scenario.json')
    process.env.BITFROST_AGY_SCENARIO = scenarioFile
    fs.writeFileSync(scenarioFile, JSON.stringify({ plugins: [{ name: 'bitfrost-bridge', enabled: true, path: dir, hooks: ['bitfrost-bridge'] }] }))
    assert.strictEqual(await bridgeLoaded(process.execPath, dir, undefined, [FAKE]), true)
    fs.writeFileSync(scenarioFile, JSON.stringify({ plugins: [{ name: 'bitfrost-bridge', enabled: false, path: dir, hooks: ['bitfrost-bridge'] }] }))
    assert.strictEqual(await bridgeLoaded(process.execPath, dir, undefined, [FAKE]), false)

    assert.deepStrictEqual(agyProvider.uninstall!(true), [{ label: 'BitFrost bridge plugin in Antigravity', path: dir }])
    assert.ok(fs.existsSync(dir))
    assert.deepStrictEqual(agyProvider.uninstall!(), [{ label: 'BitFrost bridge plugin in Antigravity', path: dir }])
    assert.ok(!fs.existsSync(dir))
    assert.deepStrictEqual(uninstallBridge(dir), [])
  } finally {
    process.env.HOME = saved
    delete process.env.BITFROST_AGY_SCENARIO
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the app is found through the environment, the config, the PATH, then its install folder', () => {
  const env = (bin: string | null, config: any = {}) => ({ config, resolveBinary: () => bin }) as any
  const saved = process.env.BITFROST_AGY_BIN
  delete process.env.BITFROST_AGY_BIN
  try {
    assert.strictEqual(resolveAgy(env('/usr/bin/agy', { bin: '/opt/agy' })), '/opt/agy')
    assert.strictEqual(resolveAgy(env('/usr/bin/agy')), '/usr/bin/agy')
    assert.strictEqual(resolveAgy(env(null), process.execPath), process.execPath)
    assert.strictEqual(resolveAgy(env(null), '/nonexistent/agy'), null)
    process.env.BITFROST_AGY_BIN = '/env/agy'
    assert.strictEqual(resolveAgy(env('/usr/bin/agy')), '/env/agy')
  } finally {
    if (saved === undefined) delete process.env.BITFROST_AGY_BIN
    else process.env.BITFROST_AGY_BIN = saved
  }
})
