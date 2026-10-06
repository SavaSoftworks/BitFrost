// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for AcpProvider. fake-acp.mjs stands in for the app, playing a
// scenario from fixtures/acp/; opencode-reject.json is a real opencode run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProvider, type AcpAgentSpec, type AcpOptions } from '../providers/acp.ts'
import { claudeTool, unifiedDiff, vendorOf } from '../providers/acp-shapes.ts'
import { geminiProvider, ompProvider, opencodeProvider } from '../providers/acp-agents.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(HERE, 'fake-acp.mjs')
const INSTRUCTIONS = 'You are a delegated subagent.'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(10)
  }
}

type Run = { provider: AcpProvider; sent: () => any[]; dir: string; stop: () => void }

function fake(fixture: string, spec: Partial<AcpAgentSpec> = {}, opts: Partial<AcpOptions> = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-acp-test-'))): Run {
  const log = path.join(dir, 'sent.jsonl')
  const provider = new AcpProvider(
    { id: 'fake', displayName: 'Fake', vendor: null, binary: 'fake', args: [], loginCommand: 'fake login', optIn: true, gates: 'all', note: '', ...spec },
    { bin: process.execPath, args: [FAKE, path.join(HERE, 'fixtures', 'acp', fixture)], env: { BITFROST_ACP_LOG: log, BITFROST_ACP_MARK: path.join(dir, 'crashed') } },
    { log: () => {}, ...opts },
  )
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { provider, sent, dir, stop: () => (provider as any).proc?.kill() }
}

function newSession(cwd: string, model: string): Session {
  return new Session({ id: '', harness: 'fake', agent: 'test', model, cwd, state: 'running' })
}

async function spawn(run: Run, model: string, effort?: string): Promise<Session> {
  const session = newSession(run.dir, model)
  await run.provider.spawnSession(session, { model, effort, cwd: run.dir, prompt: 'List the files.', developerInstructions: INSTRUCTIONS, canAskUser: true })
  return session
}

const types = (s: Session) => s.events.map((e) => e.type)
const find = (s: Session, type: string): any => s.events.find((e) => e.type === type)
const done = (s: Session, n = 1) => until(`${n} finished turn(s)`, () => s.events.filter((e) => e.type === 'turn_completed').length >= n)
const answerTo = (sent: any[], id: unknown) => sent.find((m) => m.id === id && m.method === undefined)

test('the handshake offers only form questions and never signs in', async () => {
  const run = fake('turn.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the prompt', () => run.sent().some((m) => m.method === 'session/prompt'))
    const sent = run.sent()
    assert.strictEqual(sent[0].method, 'initialize')
    assert.strictEqual(sent[0].jsonrpc, '2.0')
    assert.strictEqual(sent[0].params.protocolVersion, 1)
    assert.deepStrictEqual(sent[0].params.clientCapabilities, { elicitation: { form: {} } })
    assert.ok(!sent.some((m) => m.method === 'authenticate'))
    assert.deepStrictEqual(sent[1].params, { cwd: run.dir, mcpServers: [] })
    // The instructions lead the first prompt; ACP has no system prompt.
    const prompt = sent.find((m) => m.method === 'session/prompt').params
    assert.strictEqual(prompt.sessionId, 'ses_1')
    assert.deepStrictEqual(prompt.prompt, [{ type: 'text', text: INSTRUCTIONS }, { type: 'text', text: 'List the files.' }])
    assert.match(session.info.id, /^fake_/)
    assert.deepStrictEqual(run.provider.capabilities, { steer: false, autoReview: false, questions: true, gates: 'all' })
  } finally {
    run.stop()
  }
})

test('models on the allowlist are listed with their own thought levels and real vendors, without a prompt', async () => {
  const run = fake('models.json', {}, { models: ['OPENCODE-GO/*'] })
  try {
    const models = await run.provider.listModels()
    const by = Object.fromEntries(models.map((m) => [m.model, m]))
    assert.deepStrictEqual(Object.keys(by), ['opencode-go/deepseek-v4-flash', 'opencode-go/glm-5.3', 'anthropic/claude-opus-5', 'opencode/big-pickle', 'openrouter/acme/widget-1'])
    assert.deepStrictEqual(by['opencode-go/deepseek-v4-flash'], {
      harness: 'fake',
      provider: 'DeepSeek',
      model: 'opencode-go/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      description: 'Through opencode-go.',
      efforts: ['low', 'high', 'max'], // opencode's "default" is not a level
      defaultEffort: 'low',
      isDefault: false,
    })
    assert.strictEqual(by['opencode-go/glm-5.3'].provider, 'Z.ai')
    assert.strictEqual(by['opencode-go/glm-5.3'].defaultEffort, 'high')
    assert.strictEqual(by['anthropic/claude-opus-5'].provider, 'Anthropic')
    assert.deepStrictEqual([by['anthropic/claude-opus-5'].efforts, by['anthropic/claude-opus-5'].defaultEffort], [[], null])
    assert.strictEqual(by['opencode/big-pickle'].provider, 'opencode')
    assert.strictEqual(by['opencode/big-pickle'].isDefault, true)
    assert.strictEqual(by['openrouter/acme/widget-1'].provider, 'acme')
    const sent = run.sent()
    assert.deepStrictEqual(sent.filter((m) => m.method === 'session/set_config_option').map((m) => m.params.value), ['opencode-go/deepseek-v4-flash', 'opencode-go/glm-5.3'])
    assert.ok(!sent.some((m) => m.method === 'session/prompt'))
    assert.ok(sent.some((m) => m.method === 'session/close'), 'the throwaway session is closed')
    assert.ok(!fs.existsSync(sent.find((m) => m.method === 'session/new').params.cwd), 'the throwaway folder is removed')
  } finally {
    run.stop()
  }
})

test('with no allowlist no model is switched', async () => {
  const run = fake('models.json')
  try {
    const models = await run.provider.listModels()
    assert.strictEqual(models.length, 5)
    assert.ok(models.every((m) => m.efforts.length === 0))
    assert.ok(!run.sent().some((m) => m.method === 'session/set_config_option'))
  } finally {
    run.stop()
  }
})

test('the model list is kept for a day, also across a helper restart', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-acp-cache-'))
  const first = fake('models.json', {}, { runDir, models: ['opencode-go/*'] })
  try {
    const listed = await first.provider.listModels()
    const sessions = () => first.sent().filter((m) => m.method === 'session/new').length
    assert.strictEqual(sessions(), 1)
    assert.deepStrictEqual(await first.provider.listModels(), listed)
    assert.strictEqual(sessions(), 1, 'the second call is served from memory')
    const second = fake('models.json', {}, { runDir, models: ['opencode-go/*'] })
    assert.deepStrictEqual(await second.provider.listModels(), listed)
    assert.deepStrictEqual(second.sent(), [])
    const third = fake('models.json', {}, { runDir, models: ['opencode-go/glm-*'] })
    await third.provider.listModels()
    assert.strictEqual(third.sent().filter((m) => m.method === 'session/new').length, 1)
    third.stop()
  } finally {
    first.stop()
  }
})

test('an app that can delete sessions has the throwaway one deleted, not just closed', async () => {
  const run = fake('models-delete.json', {}, { models: ['opencode-go/*'] })
  try {
    await run.provider.listModels()
    await until('the delete', () => run.sent().some((m) => m.method === 'session/delete'))
    assert.deepStrictEqual(run.sent().find((m) => m.method === 'session/delete').params, { sessionId: 'ses_1' })
    assert.ok(!run.sent().some((m) => m.method === 'session/close'))
  } finally {
    run.stop()
  }
})

test('the model and effort are set through config options', async () => {
  const run = fake('models.json')
  try {
    await spawn(run, 'opencode-go/deepseek-v4-flash', 'high')
    const sets = () => run.sent().filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value])
    assert.deepStrictEqual(sets(), [['model', 'opencode-go/deepseek-v4-flash'], ['effort', 'high']])
    await spawn(run, 'opencode-go/glm-5.3', 'high')
    assert.deepStrictEqual(sets().slice(2), [['model', 'opencode-go/glm-5.3']])
  } finally {
    run.stop()
  }
})

test('older apps list models in `models` and take session/set_model', async () => {
  const run = fake('gemini-models.json', { vendor: 'Google' })
  try {
    const models = await run.provider.listModels()
    assert.deepStrictEqual(
      models.map((m) => [m.model, m.provider, m.displayName, m.efforts, m.defaultEffort, m.isDefault]),
      [
        ['auto-gemini-3', 'Google', 'Auto (Gemini 3)', [], null, true],
        ['gemini-3-pro-preview', 'Google', 'gemini-3-pro-preview', [], null, false],
      ],
    )
    assert.strictEqual(run.provider.vendor, 'Google')
    const session = await spawn(run, 'gemini-3-pro-preview')
    await done(session)
    const set = run.sent().find((m) => m.method === 'session/set_model')
    assert.deepStrictEqual(set.params, { sessionId: 'ses_1', modelId: 'gemini-3-pro-preview' })
  } finally {
    run.stop()
  }
})

test('a turn becomes text, a thought, tools, a command with permission, file changes, a plan and usage', async () => {
  const run = fake('turn.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the permission request', () => !!find(session, 'approval_requested'))
    const asked = find(session, 'approval_requested')
    assert.deepStrictEqual(
      { kind: asked.kind, title: asked.title, tool: asked.tool, input: asked.input, itemId: asked.itemId },
      { kind: 'command', title: 'run `ls -a`', tool: 'Bash', input: { command: 'ls -a', description: 'List files' }, itemId: 'call_ls' },
    )
    assert.deepStrictEqual(run.provider.pendingApprovals(session), [asked.approvalId])
    await run.provider.sendInput(session, 'And again.')
    assert.ok(run.provider.resolveApproval(session, asked.approvalId, 'allow'))
    await done(session, 2)

    assert.deepStrictEqual(types(session), [
      'turn_started',
      'reasoning',
      'text',
      'tool_started',
      'tool_completed',
      'command_started',
      'approval_requested',
      'approval_resolved',
      'command_completed',
      'file_change',
      'file_change',
      'plan',
      'usage',
      'text',
      'usage',
      'turn_completed',
      'turn_started',
      'text',
      'turn_completed',
    ])
    const ev = session.events as any[]
    assert.strictEqual(ev[1].text, 'Let me look.')
    assert.strictEqual(ev[2].text, "I'll list the files.")
    assert.deepStrictEqual([ev[3].name, ev[3].input], ['Read', { file_path: '/w/hello.txt' }])
    assert.deepStrictEqual([ev[4].name, ev[4].ok, ev[4].output], ['Read', true, 'hello'])
    assert.deepStrictEqual([ev[5].command, ev[5].summary, ev[5].cwd], ['ls -a', 'List files', '/w'])
    assert.deepStrictEqual([ev[8].output, ev[8].exitCode, ev[8].status], ['.\n..\nhello.txt\n', 0, 'completed'])
    assert.deepStrictEqual(ev[9].changes, [{ path: '/w/hello.txt', kind: 'update', movePath: null, diff: '@@ -1,1 +1,1 @@\n-hello\n+hello world' }])
    assert.deepStrictEqual(ev[10].changes, [{ path: '/w/new.txt', kind: 'add', movePath: null, diff: '@@ -0,0 +1,2 @@\n+a\n+b' }])
    assert.deepStrictEqual(ev[11].entries, [{ content: 'List the files', status: 'completed' }, { content: 'Report back', status: 'in_progress' }])
    // The context size, never the turn's total (50000) from the prompt's answer.
    assert.deepStrictEqual(ev.filter((e) => e.type === 'usage').map((e) => [e.inputTokens, e.outputTokens, e.cachedInputTokens]), [[12000, 0, 0], [12000, 42, 0]])
    assert.deepStrictEqual([ev[15].status, ev[15].finalText, ev[15].error], ['completed', 'Done.', undefined])
    assert.strictEqual(ev[17].text, 'Again.')

    const sent = run.sent()
    const permission = sent.find((m) => m.result?.outcome)
    assert.deepStrictEqual(permission.result, { outcome: { outcome: 'selected', optionId: 'proceed_once' } })
    const prompts = sent.filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt)
    assert.deepStrictEqual(prompts[1], [{ type: 'text', text: 'And again.' }])
  } finally {
    run.stop()
  }
})

test('denying a command answers with the reject option and the command fails', async () => {
  const run = fake('turn.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the permission request', () => !!find(session, 'approval_requested'))
    run.provider.resolveApproval(session, find(session, 'approval_requested').approvalId, 'deny', 'not now')
    await done(session)
    const permission = run.sent().find((m) => m.result?.outcome)
    assert.deepStrictEqual(permission.result, { outcome: { outcome: 'selected', optionId: 'cancel' } })
    assert.strictEqual(find(session, 'approval_resolved').decision, 'deny')
    const failed = find(session, 'command_completed')
    assert.deepStrictEqual([failed.status, failed.output], ['failed', 'The user rejected permission to use this specific tool call.'])
  } finally {
    run.stop()
  }
})

test('allow for this task is kept by bitfrost for the exact action; the app only hears allow once', async () => {
  const run = fake('repeat.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    const asked = () => session.events.filter((e) => e.type === 'approval_requested') as any[]
    await until('the first request', () => asked().length === 1)
    assert.strictEqual(asked()[0].title, 'run `ls -a`')
    run.provider.resolveApproval(session, asked()[0].approvalId, 'allow_session')
    await until('the second request', () => asked().length === 2)
    assert.strictEqual(asked()[1].title, 'run `ls -la`')
    run.provider.resolveApproval(session, asked()[1].approvalId, 'deny')
    await until('the form', () => asked().length === 3)
    run.provider.resolveApproval(session, asked()[2].approvalId, 'allow_session')
    await done(session)
    assert.strictEqual(asked().length, 3)
    const answers = run.sent().filter((m) => m.method === undefined && m.result).map((m) => m.result.outcome?.optionId ?? m.result.content?.value)
    assert.deepStrictEqual(answers, ['proceed_once', 'proceed_once', 'cancel', 'Approve', 'Approve'])
    assert.ok(!run.sent().some((m) => m.result?.outcome?.optionId === 'proceed_always'))
    const completed = session.events.filter((e) => e.type === 'command_completed') as any[]
    assert.deepStrictEqual(completed.map((e) => [e.command, e.status]), [['ls -a', 'completed'], ['ls -a', 'completed'], ['ls -la', 'failed']])
  } finally {
    run.stop()
  }
})

test('a real opencode run: the reject answer, the command it was about, and the context size', async () => {
  const run = fake('opencode-reject.json', { loginCommand: 'opencode auth login' })
  try {
    const session = await spawn(run, 'opencode-go/deepseek-v4-flash', 'low')
    assert.deepStrictEqual(run.sent().filter((m) => m.method === 'session/set_config_option').map((m) => m.params.configId), ['model'])
    await until('the permission request', () => !!find(session, 'approval_requested'))
    const asked = find(session, 'approval_requested')
    assert.deepStrictEqual([asked.title, asked.tool, asked.input], ['run `ls -a`', 'Bash', { command: 'ls -a' }])
    run.provider.resolveApproval(session, asked.approvalId, 'deny')
    await done(session)
    assert.deepStrictEqual(types(session), ['turn_started', 'command_started', 'approval_requested', 'approval_resolved', 'command_completed', 'usage', 'usage', 'turn_completed'])
    assert.deepStrictEqual(run.sent().find((m) => m.result?.outcome).result, { outcome: { outcome: 'selected', optionId: 'reject' } })
    const started = find(session, 'command_started')
    assert.deepStrictEqual([started.command, started.cwd], ['ls -a', '/tmp/acp-probe'])
    assert.strictEqual(find(session, 'command_completed').status, 'failed')
    const usage = session.events.filter((e) => e.type === 'usage') as any[]
    assert.deepStrictEqual(usage.map((e) => [e.inputTokens, e.outputTokens]), [[10388, 0], [10388, 46]])
    assert.strictEqual(find(session, 'turn_completed').status, 'completed')
  } finally {
    run.stop()
  }
})

test('the app picking another model on set fails the start', async () => {
  const run = fake('wrong-model-start.json')
  try {
    await assert.rejects(spawn(run, 'fake/model-b'), /Fake chose fake\/fallback instead of fake\/model-b/)
    assert.ok(!run.sent().some((m) => m.method === 'session/prompt'))
  } finally {
    run.stop()
  }
})

test('the app switching model mid-turn stops the turn', async () => {
  const run = fake('wrong-model-turn.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await done(session)
    const end = find(session, 'turn_completed')
    assert.strictEqual(end.status, 'failed')
    assert.strictEqual(end.error, 'Fake switched to fake/fallback instead of fake/model-a; stopped it')
    assert.ok(run.sent().some((m) => m.method === 'session/cancel'))
  } finally {
    run.stop()
  }
})

test('stopping answers a waiting permission request "cancelled", then cancels the turn', async () => {
  const run = fake('cancel.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the permission request', () => !!find(session, 'approval_requested'))
    assert.strictEqual(find(session, 'approval_requested').title, 'run `rm -rf build`')
    await run.provider.interrupt(session)
    await done(session)
    const sent = run.sent()
    const answer = sent.findIndex((m) => m.result?.outcome?.outcome === 'cancelled')
    const cancel = sent.findIndex((m) => m.method === 'session/cancel')
    assert.ok(answer >= 0 && cancel > answer, 'the request is answered before the cancel')
    assert.deepStrictEqual(sent[cancel].params, { sessionId: 'ses_1' })
    assert.strictEqual(find(session, 'approval_resolved').decision, 'deny')
    assert.strictEqual(find(session, 'turn_completed').status, 'interrupted')
    assert.deepStrictEqual(run.provider.pendingApprovals(session), [])
  } finally {
    run.stop()
  }
})

test('a form question is asked, and the answers go back in its fields; a yes/no form is an approval', async () => {
  const run = fake('question.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the question', () => !!find(session, 'question_asked'))
    const q = find(session, 'question_asked')
    assert.deepStrictEqual(q.questions, [
      { id: 'name', header: 'File name', question: 'How should I name the file?\nFile name', options: [{ label: 'Short', description: '' }, { label: 'Long', description: 'A longer name' }], allowOther: false, secret: false },
      { id: 'count', header: 'How many', question: 'How many', options: [], allowOther: true, secret: false },
      { id: 'force', header: 'Overwrite', question: 'Overwrite', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], allowOther: false, secret: false },
    ])
    assert.deepStrictEqual(run.provider.pendingQuestions(session), [q.questionId])
    assert.ok(await run.provider.answerQuestion(session, q.questionId, { name: ['Long'], count: ['3'], force: ['Yes'] }, false))
    await until('the yes/no form', () => !!find(session, 'approval_requested'))
    const form = run.sent().find((m) => m.result?.action)
    assert.deepStrictEqual(form.result, { action: 'accept', content: { name: 'b.txt', count: 3, force: true } })

    const asked = find(session, 'approval_requested')
    assert.deepStrictEqual([asked.itemId, asked.kind, asked.title, asked.tool, asked.input], ['call_write', 'file_change', 'write notes.md', 'Write', { file_path: 'notes.md', content: 'x\n' }])
    assert.match(asked.detail, /^It asks: Allow tool: write\nPath: notes.md\n/)
    run.provider.resolveApproval(session, asked.approvalId, 'allow')
    await done(session)
    const approval = run.sent().filter((m) => m.result?.action).at(-1)
    assert.deepStrictEqual(approval.result, { action: 'accept', content: { value: 'Approve' } })
    assert.deepStrictEqual(types(session), [
      'turn_started',
      'question_asked',
      'question_answered',
      'text',
      'approval_requested',
      'approval_resolved',
      'file_change',
      'text',
      'turn_completed',
    ])
    assert.strictEqual(find(session, 'file_change').changes[0].kind, 'add')
    assert.strictEqual(find(session, 'turn_completed').finalText, 'Wrote it.')
  } finally {
    run.stop()
  }
})

test('a question handed to the lead agent declines the form and stops the turn', async () => {
  const run = fake('question.json')
  try {
    const session = await spawn(run, 'fake/model-a')
    await until('the question', () => !!find(session, 'question_asked'))
    await run.provider.answerQuestion(session, find(session, 'question_asked').questionId, null, true)
    await until('the cancel', () => run.sent().some((m) => m.method === 'session/cancel'))
    assert.deepStrictEqual(run.sent().find((m) => m.result?.action).result, { action: 'decline' })
    assert.strictEqual(find(session, 'question_answered').how, 'deferred')
  } finally {
    run.stop()
  }
})

test('the app crashing fails the running task, and the next task starts it again', async () => {
  const run = fake('crash.json')
  try {
    const first = await spawn(run, 'fake/model-a')
    await until('the failure', () => !!find(first, 'session_failed'))
    assert.deepStrictEqual(types(first), ['turn_started', 'session_failed'])
    assert.match(find(first, 'session_failed').error, /^Fake exited \(code 1/)
    assert.strictEqual(first.info.state, 'failed')
    await run.provider.sendInput(first, 'Hello?')
    assert.match((first.events.at(-1) as any).error, /restarted since this task began/)
    const second = await spawn(run, 'fake/model-a')
    await done(second)
    assert.strictEqual(find(second, 'turn_completed').finalText, 'Starting.Still here.')
    assert.strictEqual(run.sent().filter((m) => m.method === 'initialize').length, 2)
  } finally {
    run.stop()
  }
})

test('an app that is not signed in names its own login command', async () => {
  const run = fake('auth.json')
  try {
    await assert.rejects(spawn(run, 'fake/model-a'), /Authentication required\..*run `fake login` in a terminal/)
    assert.ok(!run.sent().some((m) => m.method === 'authenticate'))
  } finally {
    run.stop()
  }
})

test('the agent table: overlays, env and vendors', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-acp-agents-'))
  const env = (bin: string | null) => ({ runDir, socket: '', log: () => {}, config: bin ? { bin } : {}, resolveBinary: () => null, recorder: () => null })
  assert.strictEqual(opencodeProvider.create(env(null)), null, 'not installed')
  const opencode = opencodeProvider.create({ ...env('/opt/opencode'), config: { bin: '/opt/opencode', models: ['deepseek/*'] } }) as AcpProvider
  assert.deepStrictEqual((opencode as any).allow, ['deepseek/*'])
  assert.strictEqual((opencode as any).cacheFile, path.join(runDir, 'acp-opencode-models.json'))
  const launch = (p: AcpProvider) => (p as any).launch
  assert.deepStrictEqual(launch(opencode).args, ['acp'])
  const permission = JSON.parse(launch(opencode).env.OPENCODE_PERMISSION)
  assert.deepStrictEqual([permission.bash, permission.edit, permission.webfetch, permission.task], ['ask', 'ask', 'ask', 'deny'])
  assert.deepStrictEqual(JSON.parse(launch(opencode).env.OPENCODE_CONFIG_CONTENT), { permission })
  assert.strictEqual(opencode.vendor, undefined)

  const omp = ompProvider.create(env('/opt/omp')) as AcpProvider
  const args: string[] = launch(omp).args
  assert.deepStrictEqual(args.slice(0, 3), ['acp', '--approval-mode', 'always-ask'])
  const overlay = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'))
  assert.deepStrictEqual([overlay.advisor.enabled, overlay.task.maxRecursionDepth], [false, 0])
  assert.deepStrictEqual(overlay.tools, { approvalMode: 'always-ask' })
  assert.strictEqual(omp.capabilities.gates, 'destructive')

  const gemini = geminiProvider.create(env('/opt/gemini')) as AcpProvider
  assert.deepStrictEqual(launch(gemini).args, ['--acp', '--approval-mode', 'default'])
  assert.strictEqual(gemini.vendor, 'Google')
  assert.ok([opencodeProvider, ompProvider, geminiProvider].every((f) => f.optIn))
})

test('unifiedDiff', () => {
  assert.strictEqual(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n'), '')
  assert.strictEqual(unifiedDiff(null, 'x\ny\n'), '@@ -0,0 +1,2 @@\n+x\n+y')
  assert.strictEqual(unifiedDiff('x\n', ''), '@@ -1,1 +0,0 @@\n-x')
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n')
  const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9'].join('\n')
  assert.strictEqual(unifiedDiff(before, after), '@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8')
})

test('vendorOf reads the model line, not the route', () => {
  assert.strictEqual(vendorOf('opencode-go/deepseek-v4-pro'), 'DeepSeek')
  assert.strictEqual(vendorOf('google-antigravity/claude-opus-4-6'), 'Anthropic')
  assert.strictEqual(vendorOf('openai-codex/gpt-5.5'), 'OpenAI')
  assert.strictEqual(vendorOf('neuralwatt/glm-5.3'), 'Z.ai')
  assert.strictEqual(vendorOf('ollama/hf.co/someone/Qwen3.5-9B:Q8_0'), 'Alibaba')
  assert.strictEqual(vendorOf('opencode/big-pickle'), 'opencode')
  assert.strictEqual(vendorOf('mystery'), 'unknown')
})

test('claudeTool maps the apps\' spellings to Claude Code tools', () => {
  assert.deepStrictEqual(claudeTool('read', 'read', { absolute_path: '/a' }), { name: 'Read', input: { file_path: '/a' } })
  assert.deepStrictEqual(claudeTool('edit', 'replace', { file_path: '/a', old_string: 'x', new_string: 'y' }), { name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } })
  assert.deepStrictEqual(claudeTool('search', 'grep', { pattern: 'foo', path: 'src', include: '*.ts' }), { name: 'Grep', input: { pattern: 'foo', path: 'src', glob: '*.ts' } })
  assert.deepStrictEqual(claudeTool('search', 'glob', { pattern: '**/*.ts' }), { name: 'Glob', input: { pattern: '**/*.ts' } })
  assert.deepStrictEqual(claudeTool('fetch', 'webfetch', { url: 'https://x.test' }), { name: 'WebFetch', input: { url: 'https://x.test', prompt: '' } })
  assert.deepStrictEqual(claudeTool('fetch', 'google_web_search', { query: 'acp' }), { name: 'WebSearch', input: { query: 'acp' } })
  assert.strictEqual(claudeTool('other', 'todowrite', { todos: [] }), null)
  assert.strictEqual(claudeTool('execute', 'bash', { cwd: '/w' }), null)
})
