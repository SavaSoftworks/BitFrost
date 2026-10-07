#!/usr/bin/env node
// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for the codex app-server in tests: answers the adapter's calls,
// logs to BITFROST_TEST_LOG, replays fixtures/codex/approval.jsonl per turn.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const logFile = process.env.BITFROST_TEST_LOG
if (!logFile) {
  console.error('fake-codex: BITFROST_TEST_LOG is not set')
  process.exit(2)
}

const script = readFileSync(process.env.BITFROST_FAKE_CODEX_SCRIPT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex', 'approval.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())

// model/list answers one fake model plus any in BITFROST_FAKE_EXTRA_MODELS.
const MODELS = [
  {
    id: 'gpt-test',
    displayName: 'GPT-Test',
    description: 'A fake model.',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    defaultReasoningEffort: 'low',
    isDefault: true,
  },
  ...(process.env.BITFROST_FAKE_EXTRA_MODELS ?? '')
    .split(',')
    .filter(Boolean)
    .map((id) => ({ id, displayName: id, description: 'Another fake model.', supportedReasoningEfforts: [], defaultReasoningEffort: null, isDefault: false })),
]

let awaiting = null // id of the server request the script is blocked on
let threadId = null
let turnId = null
let pos = 0
const archived = new Set()
const loaded = new Set()

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + '\n')

function play() {
  while (pos < script.length && awaiting === null) {
    const msg = JSON.parse(script[pos++].replaceAll('thr1', threadId).replaceAll('turn1', turnId))
    if (msg.id !== undefined) awaiting = msg.id
    write(msg)
  }
}

process.stdin.on('close', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method) {
    log({ method: msg.method, params: msg.params })
    if (msg.id === undefined) return
    if (msg.method === 'initialize') write({ id: msg.id, result: {} })
    else if (msg.method === 'model/list') write({ id: msg.id, result: { data: MODELS, nextCursor: null } })
    else if (msg.method === 'thread/start') {
      threadId = `thr_${randomUUID()}`
      loaded.add(threadId)
      write({ id: msg.id, result: { thread: { id: threadId } } })
    } else if (msg.method === 'thread/resume') {
      if (archived.has(msg.params.threadId)) return write({ id: msg.id, error: { code: -32000, message: 'Cannot resume an archived thread' } })
      threadId = msg.params.threadId
      loaded.add(threadId)
      write({ id: msg.id, result: { thread: { id: threadId } } })
    } else if (msg.method === 'thread/archive' || msg.method === 'thread/unarchive') {
      if (process.env.BITFROST_FAKE_ARCHIVE_ERROR === msg.method) return write({ id: msg.id, error: { code: -32000, message: 'Archive fixture failure' } })
      if (msg.method === 'thread/unarchive' && !archived.has(msg.params.threadId)) return write({ id: msg.id, error: { code: -32000, message: 'Thread is not archived' } })
      const finish = () => {
        if (msg.method === 'thread/archive') { archived.add(msg.params.threadId); loaded.delete(msg.params.threadId) }
        else archived.delete(msg.params.threadId)
        write({ id: msg.id, result: {} })
      }
      if (process.env.BITFROST_FAKE_ARCHIVE_DELAY) setTimeout(finish, Number(process.env.BITFROST_FAKE_ARCHIVE_DELAY))
      else finish()
    } else if (msg.method === 'turn/steer') {
      if (process.env.BITFROST_FAKE_STEER_RACE) {
        awaiting = null
        pos = script.length
        const ended = turnId
        const done = () => write({ method: 'turn/completed', params: { threadId, turn: { id: ended, status: 'completed' } } })
        if (process.env.BITFROST_FAKE_STEER_RACE === 'late') setTimeout(done, 200)
        else done()
        write({ id: msg.id, error: { code: -32602, message: 'Expected turn already completed' } })
      } else write({ id: msg.id, result: { turnId } })
    }
    else if (msg.method === 'turn/interrupt') {
      awaiting = null
      pos = script.length
      const finish = () => {
        write({ id: msg.id, result: {} })
        write({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } })
      }
      if (process.env.BITFROST_FAKE_INTERRUPT_DELAY) setTimeout(finish, Number(process.env.BITFROST_FAKE_INTERRUPT_DELAY))
      else finish()
    }
    else if (msg.method === 'turn/start') {
      if (archived.has(msg.params.threadId)) return write({ id: msg.id, error: { code: -32000, message: 'Cannot start an archived thread' } })
      if (!loaded.has(msg.params.threadId)) return write({ id: msg.id, error: { code: -32000, message: 'Thread must be resumed' } })
      if (process.env.BITFROST_FAKE_START_ERROR) return write({ id: msg.id, error: { code: -32000, message: 'Turn start rejected' } })
      turnId = `turn_${randomUUID()}`
      write({ id: msg.id, result: { turn: { id: turnId } } })
      // Codex titles a new thread itself once its first turn starts.
      write({ method: 'thread/name/updated', params: { threadId: msg.params.threadId, threadName: 'Listing the directory' } })
      pos = 0
      play()
    } else write({ id: msg.id, error: { code: -32601, message: `fake-codex: no ${msg.method}` } })
    return
  }
  log({ responseTo: msg.id, result: msg.result })
  if (msg.id === awaiting) {
    if (process.env.BITFROST_FAKE_INTERRUPT_DELAY && msg.result?.decision === 'decline') { awaiting = null; pos = script.length; return }
    awaiting = null
    play()
  }
})
