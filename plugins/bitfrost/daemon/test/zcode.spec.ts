// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Replay tests for ZCodeAdapter: fake-zcode.mjs prints a recorded run, and
// the events the adapter turns it into are checked.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZCodeAdapter } from '../providers/zcode.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.BITFROST_TEST_FIXTURE = path.join(HERE, 'fixtures', 'zcode', 'flash-basic.jsonl')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(20)
  }
}

async function replay(model: string): Promise<any[]> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-zcode-test-'))
  const adapter = new ZCodeAdapter(
    {
      electron: process.execPath,
      cli: path.join(HERE, 'fake-zcode.mjs'),
      builtinProviderConfig: path.join(runDir, 'builtin.json'),
      runDir,
      sessionDb: path.join(runDir, 'zcode-sessions.sqlite'),
      socket: path.join(runDir, 'bitfrostd.sock'),
      bridgeInstalled: () => true,
    },
    () => {},
  )
  const session = new Session({ id: '', harness: 'zcode', agent: 'test', model, cwd: runDir, state: 'idle' })
  await adapter.spawnSession(session, { model, cwd: runDir, prompt: 'Read f.txt, then run `wc -l f.txt`, then reply with one word.', canAskUser: true })
  await until('the turn to complete', () => session.events.some((e) => e.type === 'turn_completed'))
  assert.ok(fs.existsSync(path.join(runDir, 'zcode-sessions.sqlite')))
  return session.events
}

test('a flash run replays as one completed turn', async () => {
  const events = await replay('GLM-5.3-Flash')
  assert.deepStrictEqual(events.map((e) => e.type), [
    'turn_started',
    'usage',
    'tool_started',
    'tool_completed',
    'usage',
    'tool_started',
    'tool_completed',
    'text',
    'usage',
    'turn_completed',
  ])
  const started = events.filter((e) => e.type === 'tool_started')
  assert.deepStrictEqual(started.map((e) => e.name), ['Read', 'Bash'])
  assert.ok(String(started[0].input.file_path).endsWith('f.txt'))
  assert.deepStrictEqual(started[1].input, { command: 'wc -l f.txt', description: 'Count lines in f.txt' })
  const finished = events.filter((e) => e.type === 'tool_completed')
  assert.deepStrictEqual(finished.map((e) => e.ok), [true, true])
  assert.strictEqual(finished[0].output, '1\ta\n2\tb\n3\t')
  assert.strictEqual(finished[1].output, '2 f.txt')
  // One usage per model request, so never the sum over the whole turn.
  const usage = events.filter((e) => e.type === 'usage')
  assert.deepStrictEqual(usage.map((e) => e.inputTokens), [18250, 18323, 18356])
  assert.ok(usage.every((e) => e.inputTokens !== 54929))
  const done = events[events.length - 1]
  assert.strictEqual(done.type, 'turn_completed')
  assert.strictEqual(done.status, 'completed')
  assert.strictEqual(done.finalText, '2')
})

test('a turn that ran a different model than the one asked for fails', async () => {
  const events = await replay('GLM-5.3')
  const done = events.find((e) => e.type === 'turn_completed')
  assert.strictEqual(done.status, 'failed')
  assert.match(done.error, /GLM-5\.3-Flash/)
  assert.match(done.error, /instead of GLM-5\.3/)
  assert.deepStrictEqual(events.map((e) => e.type), ['turn_started', 'turn_completed'])
})
