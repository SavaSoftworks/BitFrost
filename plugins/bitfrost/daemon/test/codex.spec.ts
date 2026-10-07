// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Replay tests for CodexAdapter against fake-codex.mjs, a scripted
// app-server. What the adapter sends is checked through the fake's log.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAdapter, desktopCodex } from '../providers/codex.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(HERE, 'fake-codex.mjs')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(20)
  }
}

function start(t: { after: (fn: () => void) => void }, log: (text: string) => void = () => {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-codex-test-')), 'sent.jsonl')
  process.env.BITFROST_TEST_LOG = logFile
  const adapter = new CodexAdapter(FAKE, log)
  t.after(() => adapter.dispose())
  return { adapter, logFile }
}

async function spawn(adapter: CodexAdapter, over: Record<string, any> = {}): Promise<Session> {
  const session = new Session({ id: '', harness: 'codex', agent: 'test', model: 'gpt-test', cwd: os.tmpdir(), state: 'idle' })
  await adapter.spawnSession(session, { model: 'gpt-test', cwd: os.tmpdir(), prompt: 'list the directory', canAskUser: true, ...over })
  return session
}

async function firstApproval(session: Session): Promise<any> {
  await until('the approval', () => session.events.some((e) => e.type === 'approval_requested'))
  return (session.events as any[]).find((e) => e.type === 'approval_requested')
}

function readLog(logFile: string): any[] {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

async function untilLogged(logFile: string, method: string, count = 1): Promise<any[]> {
  const found = () => readLog(logFile).filter((e) => e.method === method)
  await until(`${count} ${method} request(s) in the fake's log`, () => found().length >= count)
  return found()
}

async function untilAnswer(logFile: string): Promise<any> {
  await until('the answer to the approval', () => readLog(logFile).some((e) => e.responseTo !== undefined))
  return readLog(logFile).find((e) => e.responseTo !== undefined)
}

test('one turn with a command approval replays as events', async (t) => {
  const { adapter, logFile } = start(t)
  const session = await spawn(adapter)
  const approval = await firstApproval(session)
  assert.strictEqual(approval.kind, 'command')
  assert.strictEqual(approval.tool, 'Bash')
  assert.deepStrictEqual(approval.input, { command: 'ls -la' })
  assert.strictEqual(approval.title, 'run `ls -la`')

  assert.strictEqual(adapter.resolveApproval(session, approval.approvalId, 'allow'), true)
  assert.strictEqual((await untilAnswer(logFile)).result.decision, 'accept')

  await until('the turn to complete', () => session.events.some((e) => e.type === 'turn_completed'))
  const events: any[] = session.events.filter((e) => !['user_input','input_consumed'].includes(e.type))
  assert.deepStrictEqual(events.map((e) => e.type), [
    'turn_started',
    'approval_requested',
    'approval_resolved',
    'command_started',
    'command_completed',
    'usage',
    'text',
    'turn_completed',
  ])
  // The usage comes from tokenUsage.last, not the much larger total.
  assert.strictEqual(events.filter((e) => e.type === 'usage').length, 1)
  const usage = events.find((e) => e.type === 'usage')
  assert.deepStrictEqual([usage.inputTokens, usage.outputTokens, usage.cachedInputTokens], [1200, 45, 300])
  const command = events.find((e) => e.type === 'command_completed')
  assert.strictEqual(command.exitCode, 0)
  assert.strictEqual(command.status, 'completed')
  const done = events.find((e) => e.type === 'turn_completed')
  assert.strictEqual(done.status, 'completed')
  assert.strictEqual(done.finalText, 'It listed the directory: 2 entries.')
})

test('allow_session and deny map onto codex replies', async (t) => {
  const cases: [any, string][] = [
    ['allow_session', 'acceptForSession'],
    ['deny', 'decline'],
  ]
  for (const [decision, reply] of cases) {
    const { adapter, logFile } = start(t)
    const session = await spawn(adapter)
    const approval = await firstApproval(session)
    assert.strictEqual(adapter.resolveApproval(session, approval.approvalId, decision), true)
    assert.strictEqual((await untilAnswer(logFile)).result.decision, reply)
  }
})

test('thread/start carries the approvals reviewer asked for', async (t) => {
  const cases = [
    { autoReview: true, reviewer: 'auto_review' },
    { autoReview: false, reviewer: 'user' },
  ]
  for (const c of cases) {
    const { adapter, logFile } = start(t)
    await spawn(adapter, { autoReview: c.autoReview })
    const [threadStart] = await untilLogged(logFile, 'thread/start')
    assert.strictEqual(threadStart.params.approvalsReviewer, c.reviewer)
  }
})

test('setAutoMode moves the auto reviewer onto the next turn', async (t) => {
  const { adapter, logFile } = start(t)
  const session = await spawn(adapter)
  const approval = await firstApproval(session)
  adapter.resolveApproval(session, approval.approvalId, 'allow')
  await until('the turn to complete', () => session.events.some((e) => e.type === 'turn_completed'))

  adapter.setAutoMode(session)
  await adapter.sendInput(session, 'again')

  const starts = await untilLogged(logFile, 'turn/start', 2)
  assert.strictEqual(starts[0].params.approvalsReviewer, undefined)
  assert.strictEqual(starts[1].params.approvalsReviewer, 'auto_review')
})

test('threads persist for resumption and are never explicitly named', async (t) => {
  const { adapter, logFile } = start(t)
  await spawn(adapter, { title: 'Review the parser' })
  const [thread] = await untilLogged(logFile, 'thread/start')
  assert.strictEqual(thread.params.ephemeral, false)
  await untilLogged(logFile, 'turn/start')
  assert.strictEqual(readLog(logFile).filter((e) => e.method === 'thread/name/set').length, 0)
})

test('without the CLI, the desktop app\'s newest downloaded Codex is used, else its bundled one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-codex-home-'))
  const releases = path.join(home, 'packages', 'app-server-daemon', 'releases')
  const install = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
    return file
  }
  const bundled = path.join(home, 'ChatGPT', 'resources', 'codex')
  assert.strictEqual(desktopCodex(home, [bundled]), null)
  install(bundled)
  assert.strictEqual(desktopCodex(home, [bundled]), bundled)

  install(path.join(releases, '0.99.0-x86_64-unknown-linux-musl', 'bin', 'codex'))
  const newest = install(path.join(releases, '0.160.0-x86_64-unknown-linux-musl', 'bin', 'codex'))
  assert.strictEqual(desktopCodex(home, [bundled]), newest)
  fs.mkdirSync(path.join(releases, '0.161.0-x86_64-unknown-linux-musl'))
  assert.strictEqual(desktopCodex(home, [bundled]), newest)
  fs.rmSync(home, { recursive: true, force: true })
})

test('a desktop Codex counts as moved once a newer copy is installed', (t) => {
  let found = FAKE
  const adapter = new CodexAdapter(FAKE, () => {}, null, () => found)
  t.after(() => adapter.dispose())
  assert.strictEqual(adapter.moved(), false)
  found = '/elsewhere/codex'
  assert.strictEqual(adapter.moved(), true)
  assert.strictEqual(new CodexAdapter(FAKE, () => {}).moved(), false)
})


test('Codex input receipts distinguish successful steering from starting a turn', async (t) => {
  const { adapter } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  assert.equal(await adapter.sendInput(s,'additional guidance'),'steered')
  const receipt = await s.deliver(adapter,'from the lead')
  assert.equal(receipt.delivery,'steered')
  assert.ok(s.events.some((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId))
  assert.equal(await s.stop(adapter,'host'),'graceful')
  assert.equal(await adapter.sendInput(s,'continue'),'started')
})

test('Codex resumes the saved thread and effort with thread/resume', async (t) => {
  const { adapter,logFile } = start(t)
  const s = new Session({ id:'saved-thread',harness:'codex',agent:'test',model:'gpt-test',effort:'high',cwd:os.tmpdir(),state:'detached' })
  s.nativeRef = { threadId:'saved-thread',canAskUser:true,autoReview:true }
  assert.equal((await s.deliver(adapter,'continue')).delivery,'started')
  await firstApproval(s)
  const [resumed] = await untilLogged(logFile,'thread/resume')
  assert.equal(resumed.params.threadId,'saved-thread')
  assert.equal(resumed.params.config.model_reasoning_effort,'high')
  assert.equal(resumed.params.approvalsReviewer,'auto_review')
  assert.equal(readLog(logFile).filter((m) => m.method === 'thread/start').length,0)
})

test('Codex maps interruption and provider errors to end reasons', async () => {
  const { codexEndReason } = await import('../providers/codex.ts')
  for (const [status,error,reason] of [
    ['completed',null,'end_turn'],['interrupted',null,'interrupted'],
    ['failed',{ codexErrorInfo:'usageLimitExceeded' },'quota_exhausted'],
    ['failed',{ codexErrorInfo:'httpConnectionFailed',httpStatusCode:429 },'rate_limited'],
    ['failed',{ message:'Unauthorized 401' },'auth'],
    ['failed',{ codexErrorInfo:'contextWindowExceeded' },'max_tokens'],
    ['failed',{ message:'other' },'error'],
  ] as const) assert.equal(codexEndReason(status,error),reason)
})

test('Codex classifies structured and word-bounded errors without scanning arbitrary digits or author', async () => {
  const { codexEndReason } = await import('../providers/codex.ts')
  for (const [error, expected] of [
    [{ message: 'Request 140129 failed' }, 'error'], [{ message: 'Unknown author' }, 'error'],
    [{ httpStatusCode: 429, message: 'usage limits' }, 'rate_limited'],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, message: 'error' }, 'auth'],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } }, 'rate_limited'],
    [{ codexErrorInfo: 'tooManyDenials' }, 'permission_denied'],
    [{ codexErrorInfo: 'misalignmentPolicyViolation' }, 'refusal'],
  ] as const) assert.equal(codexEndReason('failed', error), expected)
})

test('selftest threads are ephemeral and resumed task threads keep their sandbox and question feature', async (t) => {
  const { adapter, logFile } = start(t)
  const selftest = await spawn(adapter, { ephemeral: true })
  assert.equal((await untilLogged(logFile, 'thread/start'))[0].params.ephemeral, true)
  await firstApproval(selftest)
  await selftest.stop(adapter, 'host')
  const s = await spawn(adapter, { sandbox: 'read-only' })
  assert.equal((await untilLogged(logFile, 'thread/start', 2))[1].params.ephemeral, false)
  await until('task approval', () => adapter.pendingApprovals(s).length > 0)
  await s.stop(adapter, 'host')
  adapter.dispose()
  await until('app exit', () => s.info.state === 'detached')
  await s.deliver(adapter, 'continue')
  const resumed = (await untilLogged(logFile, 'thread/resume'))[0]
  assert.equal(resumed.params.sandbox, 'read-only')
  assert.equal(resumed.params.config['features.default_mode_request_user_input'], true)
})

test('a turn/steer racing completion falls back to one turn/start and consumes its input once', async (t) => {
  process.env.BITFROST_FAKE_STEER_RACE = '1'
  t.after(() => delete process.env.BITFROST_FAKE_STEER_RACE)
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  const receipt = await s.deliver(adapter, 'new task')
  assert.equal(receipt.delivery, 'started')
  assert.equal((await untilLogged(logFile, 'turn/start', 2)).length, 2)
  const fates: any[] = s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === receipt.inputId)
  assert.equal(fates.length, 1)
  assert.equal(fates[0].type, 'input_consumed')
  assert.equal(fates[0].turnId, s.activeTurnId)
})

test('a turn/steer refused before the turn/completed arrives keeps the real completion', async (t) => {
  process.env.BITFROST_FAKE_STEER_RACE = 'late'
  t.after(() => delete process.env.BITFROST_FAKE_STEER_RACE)
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  const first = s.activeTurnId
  assert.equal((await s.deliver(adapter, 'new task')).delivery, 'started')
  await untilLogged(logFile, 'turn/start', 2)
  const ends: any[] = s.events.filter((e) => e.type === 'turn_completed' && e.turnId === first)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].status, 'completed')
  assert.equal(ends[0].reason, 'end_turn')
})

test('Codex app exit detaches idle sessions and delivery resumes their saved thread', async (t) => {
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  await s.stop(adapter, 'host')
  adapter.dispose()
  await until('detached', () => s.info.state === 'detached')
  assert.equal((await s.deliver(adapter, 'continue')).delivery, 'started')
  assert.equal((await untilLogged(logFile, 'thread/resume'))[0].params.threadId, s.info.id)
  await untilLogged(logFile, 'turn/start', 2)
})

test('an instant Codex turn completing before the turn/start reply is never started twice', async (t) => {
  const { adapter, logFile } = start(t)
  const file = path.join(path.dirname(logFile), 'instant.jsonl')
  fs.writeFileSync(file, [
    { method: 'turn/started', params: { threadId: 'thr1', turn: { id: 'turn1' } } },
    { method: 'turn/completed', params: { threadId: 'thr1', turn: { id: 'turn1', status: 'completed' } } },
  ].map((e) => JSON.stringify(e)).join('\n'))
  process.env.BITFROST_FAKE_CODEX_SCRIPT = file
  t.after(() => delete process.env.BITFROST_FAKE_CODEX_SCRIPT)
  const s = await spawn(adapter)
  await until('instant completion', () => s.info.state === 'idle')
  assert.equal(s.events.filter((e) => e.type === 'turn_started').length, 1)
  const input = await s.deliver(adapter, 'next instant turn')
  await until('second completion', () => s.events.filter((e) => e.type === 'turn_completed').length === 2)
  assert.equal(s.info.state, 'idle')
  assert.equal(s.events.filter((e) => e.type === 'turn_started').length, 2)
  const fate = s.events.find((e) => e.type === 'input_consumed' && e.inputId === input.inputId)!
  assert.ok(fate.seq < s.events.at(-1)!.seq)
})

test('a rejected first Codex turn drops its initial input immediately', async (t) => {
  process.env.BITFROST_FAKE_START_ERROR = '1'
  t.after(() => delete process.env.BITFROST_FAKE_START_ERROR)
  const { adapter } = start(t)
  const s = new Session({ id: '', harness: 'codex', agent: 'test', model: 'gpt-test', cwd: os.tmpdir(), state: 'idle' })
  await assert.rejects(adapter.spawnSession(s, { model: 'gpt-test', cwd: os.tmpdir(), prompt: 'first' }), /Turn start rejected/)
  const input = s.events.find((e) => e.type === 'user_input')!
  assert.deepEqual(s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === input.inputId).map((e) => e.type), ['input_dropped'])
  assert.equal(s.events.filter((e) => e.type === 'turn_started').length, 0)
  assert.equal(s.info.state, 'detached')
  assert.ok(s.info.closedAt)
})

test('Codex deferred questions return without waiting for stop and preserve pending lead input', async (t) => {
  const { adapter } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  ;(adapter as any).onMessage({ id: 'question-rpc', method: 'item/tool/requestUserInput', params: { threadId: s.info.id, questions: [{ id: 'q', header: 'Choice', question: 'Which?', options: [] }] } })
  const questionId = adapter.pendingQuestions(s)[0]
  const input = await s.deliver(adapter, 'The lead answer.', 'queue')
  let options: any
  s.stop = (_provider, _source, value) => { options = value; return new Promise(() => {}) }
  const answer = await Promise.race([adapter.answerQuestion(s, questionId, null, true), sleep(100).then(() => 'blocked')])
  assert.equal(answer, true)
  assert.equal(options.preserveQueue, true)
  assert.equal(s.events.filter((e) => e.type === 'input_dropped' && e.inputId === input.inputId).length, 0)
})

test('persistent Codex threads archive at idle and unarchive and resume before the next turn', async (t) => {
  process.env.BITFROST_FAKE_ARCHIVE_DELAY = '60'
  t.after(() => delete process.env.BITFROST_FAKE_ARCHIVE_DELAY)
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter, { sandbox: 'read-only' })
  const first = await firstApproval(s)
  adapter.resolveApproval(s, first.approvalId, 'allow')
  await untilLogged(logFile, 'thread/archive')
  assert.equal(s.info.state, 'idle')
  assert.equal(s.events.at(-1)!.type, 'turn_completed')
  const next = await s.deliver(adapter, 'continue')
  assert.equal(next.delivery, 'started')
  const methods = readLog(logFile).filter((e) => e.method).map((e) => e.method)
  assert.deepEqual(methods.slice(methods.indexOf('thread/archive')), ['thread/archive', 'thread/unarchive', 'thread/resume', 'turn/start'])
  assert.equal(readLog(logFile).find((e) => e.method === 'thread/resume').params.sandbox, 'read-only')
  assert.equal(s.nativeRef.archived, false)
  await until('next approval', () => adapter.pendingApprovals(s).length > 0)
  adapter.resolveApproval(s, adapter.pendingApprovals(s)[0], 'allow')
  await until('second archive acknowledged', () => s.nativeRef.archived === true)
  adapter.disposeSession(s)
  adapter.disposeSession(s)
  await sleep(20)
  assert.equal(readLog(logFile).filter((e) => e.method === 'thread/archive').length, 2)
})

test('Codex unarchives before resuming a detached archived thread', async (t) => {
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  await s.stop(adapter, 'host')
  await until('archive acknowledged', () => s.nativeRef.archived === true)
  adapter.disposeSession(s)
  s.detach()
  await s.deliver(adapter, 'reopen')
  const methods = readLog(logFile).filter((e) => e.method).map((e) => e.method)
  assert.deepEqual(methods.slice(methods.indexOf('thread/archive')), ['thread/archive', 'thread/unarchive', 'thread/resume', 'turn/start'])
})

test('Codex queued continuations stay open until the last turn ends', async (t) => {
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  const queued = await s.deliver(adapter, 'queued continuation', 'queue')
  adapter.resolveApproval(s, adapter.pendingApprovals(s)[0], 'allow')
  await untilLogged(logFile, 'turn/start', 2)
  await until('continuation approval', () => adapter.pendingApprovals(s).length > 0)
  assert.equal(readLog(logFile).filter((e) => ['thread/archive', 'thread/unarchive'].includes(e.method)).length, 0)
  assert.ok(s.events.some((e) => e.type === 'input_consumed' && e.inputId === queued.inputId))
  adapter.resolveApproval(s, adapter.pendingApprovals(s)[0], 'allow')
  await until('archive acknowledged', () => s.nativeRef.archived === true)
  assert.equal(readLog(logFile).filter((e) => e.method === 'thread/archive').length, 1)
})

test('Codex selftest threads stay ephemeral and never archive or unarchive', async (t) => {
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter, { ephemeral: true })
  const approval = await firstApproval(s)
  adapter.resolveApproval(s, approval.approvalId, 'allow')
  await until('selftest completion', () => s.info.state === 'idle')
  adapter.disposeSession(s)
  await sleep(20)
  assert.equal(readLog(logFile).find((e) => e.method === 'thread/start').params.ephemeral, true)
  assert.equal(readLog(logFile).filter((e) => ['thread/archive', 'thread/unarchive'].includes(e.method)).length, 0)
})

test('Codex archives on disposal and logs archive failures without failing completed turns', async (t) => {
  process.env.BITFROST_FAKE_ARCHIVE_ERROR = 'thread/archive'
  t.after(() => delete process.env.BITFROST_FAKE_ARCHIVE_ERROR)
  const logs: string[] = [], { adapter, logFile } = start(t, (text) => logs.push(text))
  const s = await spawn(adapter)
  const approval = await firstApproval(s)
  adapter.resolveApproval(s, approval.approvalId, 'allow')
  await until('archive failure logged', () => logs.some((s) => s.includes('thread/archive') && s.includes('Archive fixture failure')))
  assert.equal(s.info.state, 'idle')
  assert.equal((s.events.find((e) => e.type === 'turn_completed') as any).reason, 'end_turn')
  assert.equal(s.events.filter((e) => e.type === 'session_failed').length, 0)
  adapter.disposeSession(s)
  await untilLogged(logFile, 'thread/archive', 2)
  assert.equal(s.events.filter((e) => e.type === 'session_failed').length, 0)
})

test('Codex tolerates not archived and other unarchive failures before resume', async (t) => {
  process.env.BITFROST_FAKE_ARCHIVE_ERROR = 'thread/unarchive'
  t.after(() => delete process.env.BITFROST_FAKE_ARCHIVE_ERROR)
  const logs: string[] = [], { adapter, logFile } = start(t, (text) => logs.push(text))
  await adapter.listModels()
  const s = new Session({ id: 'saved', harness: 'codex', agent: 'test', model: 'gpt-test', cwd: os.tmpdir(), state: 'detached' })
  s.setNativeRef({ threadId: 'saved', sandbox: 'read-only', canAskUser: true })
  assert.equal((await s.deliver(adapter, 'resume')).delivery, 'started')
  assert.ok(logs.some((s) => s.includes('thread/unarchive') && s.includes('Archive fixture failure')))
  const methods = readLog(logFile).filter((e) => e.method).map((e) => e.method)
  assert.deepEqual(methods.slice(methods.indexOf('thread/unarchive')), ['thread/unarchive', 'thread/resume', 'thread/unarchive', 'turn/start'])
})

test('Codex tolerates not archived without logging and avoids another unarchive before turn startup', async (t) => {
  const logs: string[] = [], { adapter, logFile } = start(t, (text) => logs.push(text))
  const s = new Session({ id: 'saved', harness: 'codex', agent: 'test', model: 'gpt-test', cwd: os.tmpdir(), state: 'detached' })
  s.setNativeRef({ threadId: 'saved', archived: true })
  await s.deliver(adapter, 'continue')
  const methods = readLog(logFile).filter((e) => e.method).map((e) => e.method)
  assert.deepEqual(methods.slice(methods.indexOf('thread/unarchive')), ['thread/unarchive', 'thread/resume', 'turn/start'])
  assert.equal(logs.some((s) => s.includes('not archived')), false)
  assert.equal(s.nativeRef.archived, false)
})

test('stopping during unarchive cancels attach before resume and leaves the next input able to reopen', async (t) => {
  process.env.BITFROST_FAKE_ARCHIVE_DELAY = '100'
  t.after(() => delete process.env.BITFROST_FAKE_ARCHIVE_DELAY)
  const { adapter, logFile } = start(t)
  const s = await spawn(adapter)
  await firstApproval(s)
  await s.stop(adapter, 'host')
  await until('archive acknowledged', () => s.nativeRef.archived === true)
  adapter.disposeSession(s)
  s.detach()
  const delivery = s.deliver(adapter, 'cancel this attach')
  const rejected = assert.rejects(delivery, /session stopped/)
  await untilLogged(logFile, 'thread/unarchive')
  assert.equal(adapter.isBusy(s), true)
  assert.equal(await s.stop(adapter, 'host', { graceMs: 5, killMs: 5 }), 'timed_out')
  await rejected
  assert.equal(readLog(logFile).filter((e) => e.method === 'thread/resume').length, 0)
  assert.equal(s.info.state, 'detached')
  assert.equal((await s.deliver(adapter, 'try again')).delivery, 'started')
  assert.equal(readLog(logFile).filter((e) => e.method === 'thread/resume').length, 1)
  assert.equal(readLog(logFile).filter((e) => e.method === 'turn/start').length, 2)
})
