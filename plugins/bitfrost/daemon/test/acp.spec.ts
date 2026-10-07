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
    { bin: process.execPath, args: [FAKE, path.isAbsolute(fixture) ? fixture : path.join(HERE, 'fixtures', 'acp', fixture)], env: { BITFROST_ACP_LOG: log, BITFROST_ACP_MARK: path.join(dir, 'crashed') } },
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

const types = (s: Session) => s.events.filter((e) => !['user_input','input_consumed'].includes(e.type)).map((e) => e.type)
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
    // The close is not awaited, so wait for the fake to see it.
    await until('the throwaway session to close', () => run.sent().some((m) => m.method === 'session/close'))
    const sent = run.sent()
    assert.deepStrictEqual(sent.filter((m) => m.method === 'session/set_config_option').map((m) => m.params.value), ['opencode-go/deepseek-v4-flash', 'opencode-go/glm-5.3'])
    assert.ok(!sent.some((m) => m.method === 'session/prompt'))
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
    const ev = session.events.filter((e) => !['user_input','input_consumed'].includes(e.type)) as any[]
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
    await until('the stopped turn', () => !!find(session, 'turn_completed'))
    assert.equal(find(session, 'turn_completed').reason, 'interrupted')
    assert.deepEqual(run.provider.pendingApprovals(session), [])
  } finally {
    run.stop()
  }
})

test('the app crashing fails the running task, and the next task starts it again', async () => {
  const run = fake('crash.json')
  try {
    const first = await spawn(run, 'fake/model-a')
    await until('the failure', () => !!find(first, 'session_failed'))
    assert.deepStrictEqual(types(first), ['turn_started', 'turn_completed', 'session_failed'])
    assert.match(find(first, 'session_failed').error, /^Fake exited \(code 1/)
    assert.strictEqual(first.info.state, 'detached')
    await assert.rejects(run.provider.sendInput(first, 'Hello?'), /restarted since this task began/)
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


test('a denial followed by end_turn keeps the successful end reason', async () => {
  const run = fake('opencode-reject.json')
  try {
    const s = await spawn(run,'opencode-go/deepseek-v4-flash')
    await until('approval',() => !!find(s,'approval_requested'))
    run.provider.resolveApproval(s,find(s,'approval_requested').approvalId,'deny','Do not run that command.')
    await done(s)
    assert.equal(find(s,'turn_completed').reason,'end_turn')
    assert.equal(find(s,'turn_completed').error,undefined)
  } finally { run.stop() }
})

function scenarioFile(t: any, changes: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bitfrost-acp-phase1-'))
  const scenario = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','acp','gemini-models.json'),'utf8'))
  Object.assign(scenario,changes)
  const file = path.join(dir,'scenario.json')
  fs.writeFileSync(file,JSON.stringify(scenario))
  t.after(() => fs.rmSync(dir,{ recursive:true,force:true }))
  return file
}

test('ACP stop reasons map to end reasons on every turn', async (t) => {
  const reasons = { end_turn:'end_turn',max_tokens:'max_tokens',max_turn_requests:'max_requests',refusal:'refusal',cancelled:'interrupted' }
  const file = scenarioFile(t,{ turns:Object.keys(reasons).map((stopReason) => [{ respond:{ stopReason } }]) })
  const run = fake(file)
  try {
    const s = await spawn(run,'auto-gemini-3')
    await done(s)
    let n = 1
    for (const _ of Object.keys(reasons).slice(1)) { assert.equal(await run.provider.sendInput(s,'again'),'started'); await done(s,++n) }
    const turns: any[] = s.events.filter((e) => e.type === 'turn_completed')
    assert.deepEqual(turns.map((e) => e.reason),Object.values(reasons))
  } finally { run.stop() }
})

test('ACP reopens via session/load only when loadSession was advertised', async (t) => {
  const file = scenarioFile(t,{ initialize:{ protocolVersion:1,agentCapabilities:{ loadSession:true } },turns:[[{ update:{ sessionUpdate:'agent_message_chunk',content:{ type:'text',text:'Resumed.' } } }]] })
  const run = fake(file)
  const s = new Session({ id:'saved',harness:'fake',agent:'test',model:'auto-gemini-3',cwd:run.dir,state:'detached' })
  s.nativeRef = { acpSessionId:'ses_old',canAsk:true }
  try {
    const receipt = await s.deliver(run.provider,'continue')
    assert.equal(receipt.delivery,'started')
    await done(s)
    assert.deepEqual(run.sent().find((m) => m.method === 'session/load').params,{ sessionId:'ses_old',cwd:run.dir,mcpServers:[] })
    assert.equal(run.sent().find((m) => m.method === 'session/prompt').params.sessionId,'ses_old')
    assert.equal(find(s,'turn_completed').finalText,'Resumed.')
  } finally { run.stop() }
  const unsupported = fake('turn.json')
  try { await assert.rejects(unsupported.provider.attach(s,s.nativeRef),/can't reopen.*loadSession/) }
  finally { unsupported.stop() }
})

test('the fake steering wheel cancels ACP and continues in the same app session', async () => {
  const run = fake('cancel.json')
  try {
    const s = await spawn(run,'fake/model-a')
    await until('approval',() => !!find(s,'approval_requested'))
    const receipt = await s.deliver(run.provider,'keep working','interrupt')
    assert.equal(receipt.delivery,'restarted')
    await done(s,2)
    const turns: any[] = s.events.filter((e) => e.type === 'turn_completed')
    assert.deepEqual([turns[0].reason,turns[0].status,turns[0].continues],['restarted','interrupted',true])
    const prompts = run.sent().filter((m) => m.method === 'session/prompt')
    assert.equal(prompts[0].params.sessionId,prompts[1].params.sessionId)
    assert.match(prompts[1].params.prompt[0].text,/lead interrupted.*\nkeep working/)
  } finally { run.stop() }
})


test('an ACP app ignoring cancel is force stopped with an interrupted end reason', async (t) => {
  const scenario = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','acp','cancel.json'),'utf8'))
  scenario.ignoreCancel = true
  const file = scenarioFile(t,scenario)
  const run = fake(file)
  try {
    const s = await spawn(run,'fake/model-a')
    await until('approval',() => !!find(s,'approval_requested'))
    assert.equal(await s.stop(run.provider,'host',{ graceMs:20,killMs:1000 }),'forced')
    assert.equal(find(s,'turn_completed').reason,'interrupted')
    assert.equal(s.activeTurnId,null)
    assert.equal(s.info.state,'detached')
  } finally { run.stop() }
})

test('a denial followed by refusal reports permission_denied and preserves the denial reason', async (t) => {
  const scenario = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'acp', 'opencode-reject.json'), 'utf8'))
  const change = (value: any) => {
    if (!value || typeof value !== 'object') return
    if (value.stopReason === 'end_turn') value.stopReason = 'refusal'
    for (const child of Object.values(value)) change(child)
  }
  change(scenario)
  const run = fake(scenarioFile(t, scenario))
  try {
    const s = await spawn(run, 'opencode-go/deepseek-v4-flash')
    await until('approval', () => !!find(s, 'approval_requested'))
    run.provider.resolveApproval(s, find(s, 'approval_requested').approvalId, 'deny', 'Do not run it.')
    await done(s)
    assert.equal(find(s, 'turn_completed').reason, 'permission_denied')
    assert.equal(find(s, 'turn_completed').error, 'Do not run it.')
  } finally { run.stop() }
})

test('the fake steering wheel survives a forced ACP kill and loads the same native session', async (t) => {
  const file = scenarioFile(t, { initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, ignoreCancel: true,
    turns: [[{ waitCancel: true }]], afterRestart: [[{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued.' } } }]] })
  const run = fake(file)
  try {
    const s = await spawn(run, 'auto-gemini-3')
    await until('first prompt', () => run.sent().some((m) => m.method === 'session/prompt'))
    const kill = run.provider.kill.bind(run.provider)
    run.provider.kill = (session) => { fs.writeFileSync(path.join(run.dir, 'crashed'), 'forced'); return kill(session) }
    const stop = s.stop.bind(s)
    s.stop = (provider, source, options) => stop(provider, source, { ...options, graceMs: 20, killMs: 1000 })
    const receipt = await s.deliver(run.provider, 'Use the correction.', 'interrupt')
    await done(s, 2)
    const ends: any[] = s.events.filter((e) => e.type === 'turn_completed')
    assert.deepEqual([ends[0].reason, ends[0].status, ends[0].continues], ['restarted', 'interrupted', true])
    assert.equal(ends[1].finalText, 'Continued.')
    assert.equal(run.sent().filter((m) => m.method === 'session/load').length, 1)
    const prompts = run.sent().filter((m) => m.method === 'session/prompt')
    assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId)
    assert.match(prompts[1].params.prompt[0].text, /lead interrupted.*\nUse the correction\./)
    const fates: any[] = s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === receipt.inputId)
    assert.equal(fates.length, 1)
    assert.equal(fates[0].type, 'input_consumed')
    assert.ok(fates[0].seq < ends[1].seq)
  } finally { run.stop() }
})

test('ACP app exit detaches idle sessions so the next delivery loads them again', async (t) => {
  const file = scenarioFile(t, { initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, uniqueSessions: true, turns: [[], []] })
  const run = fake(file)
  try {
    const first = await spawn(run, 'auto-gemini-3')
    await done(first)
    const second = await spawn(run, 'auto-gemini-3')
    await done(second)
    run.stop()
    await until('both detached', () => first.info.state === 'detached' && second.info.state === 'detached')
    const receipt = await first.deliver(run.provider, 'continue')
    assert.equal(receipt.delivery, 'started')
    await done(first, 2)
    assert.equal(run.sent().filter((m) => m.method === 'session/load').length, 1)
    assert.equal(second.info.state, 'detached')
  } finally { run.stop() }
})

test('ACP forced stop preserves another session in session/new or session/load', async (t) => {
  for (const loading of [false, true]) {
    const file = scenarioFile(t, { initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, uniqueSessions: true,
      ignoreCancel: true, newDelay: loading ? 0 : 100, loadDelay: 100, turns: [[{ waitCancel: true }], []] })
    const run = fake(file)
    try {
      const first = await spawn(run, 'auto-gemini-3')
      await until('first prompt', () => run.sent().some((m) => m.method === 'session/prompt'))
      const second = newSession(run.dir, 'auto-gemini-3')
      second.info.id = 'loading'
      second.info.state = 'detached'
      second.nativeRef = { acpSessionId: 'saved', canAsk: true }
      const pending = loading ? second.attach(run.provider) : run.provider.spawnSession(second, { model: 'auto-gemini-3', cwd: run.dir, prompt: 'second' })
      await until('opening another session', () => run.sent().filter((m) => m.method === (loading ? 'session/load' : 'session/new')).length === (loading ? 1 : 2))
      assert.equal(run.provider.kill(first), false)
      assert.equal(await first.stop(run.provider, 'host', { graceMs: 5, killMs: 5 }), 'timed_out')
      await pending
      if (loading) await second.deliver(run.provider, 'second')
      await done(second)
      assert.equal(find(second, 'turn_completed').reason, 'end_turn')
    } finally { run.stop() }
  }
})

test('ACP kill refuses to stop another running turn and deferred questions preserve queued lead input', async (t) => {
  const file = scenarioFile(t, { uniqueSessions: true, turns: [[{ waitCancel: true }], [{ waitCancel: true }]] })
  const run = fake(file)
  try {
    const first = await spawn(run, 'auto-gemini-3'), second = await spawn(run, 'auto-gemini-3')
    assert.equal(run.provider.kill(first), false)
    assert.equal(second.info.state, 'running')
  } finally { run.stop() }
  const question = fake('question.json')
  try {
    const s = await spawn(question, 'fake/model-a')
    await until('question', () => !!find(s, 'question_asked'))
    const receipt = await s.deliver(question.provider, 'The lead answer.')
    const began = Date.now()
    assert.equal(await question.provider.answerQuestion(s, find(s, 'question_asked').questionId, null, true), true)
    assert.ok(Date.now() - began < 100)
    await done(s, 2)
    assert.equal(s.events.filter((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId).length, 1)
    assert.equal(s.events.filter((e) => e.type === 'input_dropped' && e.inputId === receipt.inputId).length, 0)
  } finally { question.stop() }
})

test('ACP deferred questions never wait on a hung stop confirmation', async () => {
  const run = fake('question.json')
  try {
    const s = await spawn(run, 'fake/model-a')
    await until('question', () => !!find(s, 'question_asked'))
    let options: any
    s.stop = (_provider, _source, value) => { options = value; return new Promise(() => {}) }
    const answer = await Promise.race([run.provider.answerQuestion(s, find(s, 'question_asked').questionId, null, true), sleep(100).then(() => 'blocked')])
    assert.equal(answer, true)
    assert.equal(options.preserveQueue, true)
  } finally { run.stop() }
})

test('stop_timeout cancels the target load RPC and leaves another running session intact', async (t) => {
  const file = scenarioFile(t, { initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }, ignoreLoad: true, uniqueSessions: true, turns: [[{ waitCancel: true }]] })
  const run = fake(file)
  try {
    const first = await spawn(run, 'auto-gemini-3')
    const target = new Session({ id: 'saved', harness: 'fake', agent: 'test', model: 'auto-gemini-3', cwd: run.dir, state: 'detached' })
    target.nativeRef = { acpSessionId: 'saved-native', canAsk: true }
    const delivery = target.deliver(run.provider, 'load is stuck')
    const failed = assert.rejects(delivery, /session stopped/)
    await until('load request', () => run.sent().some((m) => m.method === 'session/load'))
    const stop = target.stop(run.provider, 'host', { graceMs: 10, killMs: 10 })
    const queued = await target.deliver(run.provider, 'while stopping')
    assert.equal(await stop, 'timed_out')
    await failed
    assert.equal(first.info.state, 'running')
    assert.equal(target.events.filter((e) => e.type === 'input_dropped' && e.inputId === queued.inputId).length, 1)
    const second = target.deliver(run.provider, 'another load')
    const secondFailure = assert.rejects(second, /session stopped/)
    await until('new load request', () => run.sent().filter((m) => m.method === 'session/load').length === 2)
    await target.stop(run.provider, 'host', { graceMs: 10, killMs: 10 })
    await secondFailure
    assert.equal(first.info.state, 'running')
  } finally { run.stop() }
})
