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

function start(t: { after: (fn: () => void) => void }) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-codex-test-')), 'sent.jsonl')
  process.env.BITFROST_TEST_LOG = logFile
  const adapter = new CodexAdapter(FAKE, () => {})
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
  const events: any[] = session.events
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

test('threads are ephemeral and never named, so they stay out of the apps\' lists', async (t) => {
  const { adapter, logFile } = start(t)
  await spawn(adapter, { title: 'Review the parser' })
  const [thread] = await untilLogged(logFile, 'thread/start')
  assert.strictEqual(thread.params.ephemeral, true)
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
