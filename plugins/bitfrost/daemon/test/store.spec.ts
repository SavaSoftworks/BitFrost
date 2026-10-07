// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../store.ts'
import { Session } from '../session.ts'

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-store-test-'))
  const file = path.join(dir, 'bitfrost.db')
  const store = new Store(file)
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const session = (id = 's') => new Session({ id, harness: 'fake', agent: 'test', model: 'm', effort: 'high', title: 'Title', cwd: dir, state: 'idle', claudeSession: 'lead', claudeAgent: 'agent', parentMode: 'auto', leaseId: 'lease' }, store)
  return { store, file, session }
}

const finish = (s: Session, id: string, text = 'Done.') => s.push({ type: 'turn_completed', turnId: id, status: 'completed', reason: 'end_turn', finalText: text })

test('push writes sessions, native refs, turns, events, messages and usage through SQLite', (t) => {
  const { store, file, session } = setup(t)
  const s = session()
  s.setNativeRef({ threadId: 'native' })
  const input = s.acceptInput('do the task', 'started')
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'reasoning', itemId: 'r', text: 'Thinking.' })
  s.push({ type: 'command_started', itemId: 'cmd', command: 'ls', summary: 'List files', cwd: s.info.cwd })
  s.push({ type: 'tool_started', itemId: 'tool', name: 'Read', input: { path: 'f' } })
  s.push({ type: 'command_completed', itemId: 'cmd', command: 'ls', summary: 'List files', cwd: s.info.cwd, output: 'f', exitCode: 0, durationMs: 5, status: 'completed' })
  s.push({ type: 'tool_completed', itemId: 'tool', name: 'Read', input: { path: 'f' }, output: 'contents', ok: false })
  s.push({ type: 'file_change', itemId: 'file', changes: [{ path: 'f', kind: 'add', diff: '+x' }], status: 'completed' })
  s.push({ type: 'plan', entries: [{ content: 'Finish', status: 'completed' }] })
  s.push({ type: 'question_asked', questionId: 'q', questions: [{ id: 'name', header: 'Name', question: 'Which?', options: [], secret: false, allowOther: true }] })
  s.push({ type: 'approval_requested', approvalId: 'a', itemId: null, kind: 'permissions', title: 'Network', detail: 'Needs access' })
  s.push({ type: 'approval_resolved', approvalId: 'a', decision: 'deny' })
  s.push({ type: 'auto_reviewed', itemId: 'cmd', action: 'Run ls', decision: 'allow', reason: 'Read only' })
  s.push({ type: 'text', itemId: 'text', text: 'Done.' })
  s.push({ type: 'usage', inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 })
  s.push({ type: 'usage', inputTokens: 200, outputTokens: 30, cachedInputTokens: 80 })
  finish(s, 't')
  const reader = new Store(file)
  try {
    assert.equal(reader.db.prepare('PRAGMA user_version').get()!.user_version, 3)
    assert.equal(reader.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal')
    assert.equal(reader.db.prepare('PRAGMA busy_timeout').get()!.timeout, 5000)
    assert.equal(reader.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    const restored = Session.load('s', reader)!
    assert.equal(restored.info.state, 'detached')
    assert.deepEqual(restored.nativeRef, { threadId: 'native' })
    assert.equal(restored.events.length, s.events.length)
    assert.deepEqual(reader.summary(restored).usage, { inputTokens: 300, outputTokens: 50, cachedTokens: 130, requests: 2 })
    const rows = reader.db.prepare('SELECT * FROM messages WHERE session_id=?').all('s')
    assert.equal(rows.filter((m) => m.item_id === 'cmd' && m.kind === 'command').length, 1)
    assert.equal(reader.message('s', 'cmd')!.status, 'ok')
    assert.equal(reader.message('s', 'tool')!.status, 'error')
    assert.equal(reader.message('s', 'a')!.status, 'declined')
    assert.equal(reader.pending('s').length, 0)
    const inbox = reader.db.prepare('SELECT * FROM inbox WHERE id=?').get(input.id)!
    assert.equal(inbox.state, 'consumed')
    assert.equal(inbox.consumed_turn, 't')
    assert.equal(reader.messages('s').turns[0].finalText, 'Done.')
  } finally { reader.close() }
})

test('details are capped with a truncation marker and completion-only tools are retained', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'tool_completed', itemId: 'large', name: 'Read', input: {}, ok: true, output: '🙂'.repeat(70_000) })
  const message = store.message('s', 'large')!
  assert.equal(message.detail.truncated, true)
  assert.ok(message.detail.originalBytes > 65536)
  assert.ok(Buffer.byteLength(String(store.db.prepare('SELECT detail FROM messages').get()!.detail)) <= 65536)
  assert.equal(message.text.length, 140_000)
})

test('summary and messages select recent turns, bound text and paginate by event sequence', (t) => {
  const { store, session } = setup(t)
  const s = session()
  for (const id of ['t1', 't2']) {
    s.push({ type: 'turn_started', turnId: id })
    s.push({ type: 'text', itemId: `${id}-text`, text: 'x'.repeat(500) })
    finish(s, id, 'x'.repeat(500))
  }
  s.push({ type: 'turn_started', turnId: 't3' })
  s.push({ type: 'tool_started', itemId: 'active', name: 'Read', input: {} })
  s.acceptInput('q'.repeat(300), 'queued')
  s.live = { activity: 'reading', partialText: 'partial', updatedAt: Date.now() }
  const summary = store.summary(s, 2)
  assert.deepEqual(summary.turns.map((t) => t.id), ['t2', 't3'])
  assert.equal(summary.latestText!.text.length, 400)
  assert.equal(summary.inbox.items[0].text.length, 200)
  assert.equal(summary.inbox.queued, 1)
  assert.equal(summary.activeTool!.name, 'Read')
  assert.equal(summary.live!.partialText, 'partial')
  const page = store.messages('s', { all: true, limit: 1 })
  assert.equal(page.truncated, true)
  const next = store.messages('s', { all: true, since: page.nextSince, limit: 20 })
  assert.equal(next.truncated, false)
  assert.ok(next.turns.flatMap((t) => t.messages).every((m) => m.seq > page.nextSince))
  assert.deepEqual(store.messages('s').turns.map((t) => t.id), ['t3'])
})

test('retention drops old events first, all older session data later, and preserves open sessions', (t) => {
  const { store, session } = setup(t)
  const now = Date.now(), day = 86400_000
  for (const [id, age] of [['recent', 10], ['old-events', 40], ['old-all', 200], ['open', 400]] as const) {
    const s = session(id)
    s.acceptInput('hello', 'started')
    s.push({ type: 'turn_started', turnId: `${id}-t` })
    s.push({ type: 'text', itemId: `${id}-text`, text: 'hello' })
    finish(s, `${id}-t`)
    if (id !== 'open') { s.info.closedAt = now-age*day; s.info.updatedAt = s.info.closedAt; s.save() }
  }
  store.retain(undefined, now)
  assert.ok(store.load('recent')!.events.length)
  assert.deepEqual(store.load('old-events')!.events, [])
  assert.ok(store.messages('old-events').turns[0].messages.length)
  assert.equal(store.load('old-all'), null)
  for (const table of ['events', 'turns', 'messages', 'inbox']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id='old-all'`).get()!.n, 0)
  assert.ok(store.load('open')!.events.length)
  const restored = Session.load('old-events', store)!
  const seq = restored.lastSeq
  restored.push({ type: 'interrupt_requested', source: 'host' })
  assert.equal(restored.events[0].seq, seq+1)
})

test('a failed store transaction keeps in-memory events and degrades to memory', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  const seq = s.lastSeq
  store.db.exec('DROP TABLE events')
  assert.doesNotThrow(() => s.push({ type: 'text', itemId: 'last', text: 'Kept.' }))
  assert.equal(s.lastSeq, seq + 1)
  assert.equal(s.events.at(-1)!.type, 'text')
  assert.equal(store.degraded, true)
  assert.match(store.error!, /store degraded/)
  assert.equal(store.message('s', 'last')!.text, 'Kept.')
  finish(s, 't', 'Kept.')
  assert.equal(store.messages('s').turns[0].finalText, 'Kept.')
})

test('undefined tool fields bind as null and events are capped while tool output remains readable', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'tool_started', itemId: 'missing', name: undefined as any, input: {} })
  s.push({ type: 'tool_completed', itemId: 'missing', name: undefined as any, input: {}, output: 'x'.repeat(400_000), ok: true })
  assert.equal(store.degraded, false)
  assert.equal(store.message('s', 'missing')!.name, null)
  assert.equal(store.message('s', 'missing')!.text.length, 400_000)
  const events = store.db.prepare('SELECT body FROM events').all()
  assert.ok(events.every((e) => Buffer.byteLength(String(e.body)) <= 256 * 1024))
  const restored = Session.load('s', store)!.events.at(-1) as any
  assert.equal(restored.truncated, true)
  assert.equal(restored.itemId, 'missing')
  assert.match(restored.output, /truncated/)
})

test('retention zero keeps history and recent updates protect old closed sessions', (t) => {
  const { store, session } = setup(t)
  const s = session(), now = Date.now()
  s.push({ type: 'turn_started', turnId: 't' })
  finish(s, 't')
  s.info.closedAt = now - 400 * 86400_000
  s.info.updatedAt = s.info.closedAt
  s.save()
  store.retain({ eventsDays: 0, messagesDays: 0 }, now)
  assert.equal(store.load('s')!.events.length, s.events.length)
  s.info.updatedAt = now
  s.save()
  store.retain(undefined, now)
  assert.equal(store.load('s')!.events.length, s.events.length)
})

test('pending inputs are paged without a turn and approval updates appear after their original sequence', (t) => {
  const { store, session } = setup(t)
  const s = session()
  const pending = s.acceptInput('waiting', 'queued')
  assert.equal(store.messages('s').pending[0].itemId, pending.id)
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'approval_requested', approvalId: 'a', itemId: null, kind: 'permissions', title: 'Access', detail: 'Network' })
  const since = s.lastSeq
  s.push({ type: 'approval_resolved', approvalId: 'a', decision: 'deny' })
  const updated = store.messages('s', { since }).turns[0].messages[0]
  assert.equal(updated.itemId, 'a')
  assert.equal(updated.status, 'declined')
  assert.ok(updated.seq > since)
})

test('summary bounds pending inbox items and counts all states', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.acceptInput('first', 'started')
  s.push({ type: 'turn_started', turnId: 't' })
  for (let n = 0; n < 25; n++) s.acceptInput(`pending ${n}`, 'queued')
  const summary = store.summary(s)
  assert.equal(summary.inbox.queued, 25)
  assert.equal(summary.inbox.items.length, 10)
  assert.equal(summary.inbox.counts.consumed, 1)
  assert.ok(summary.inbox.items.every((i) => i.state === 'pending'))
  const index = store.db.prepare("PRAGMA index_info('messages_turn')").all()
  assert.deepEqual(index.map((r) => r.name), ['session_id', 'turn_id', 'seq'])
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE session_id=? AND turn_id IS ? AND kind IN ('tool','command') AND status='running' ORDER BY seq DESC LIMIT 1").all('s', 't')
  assert.match(plan.map((r) => r.detail).join('\n'), /USING INDEX messages_active/)
})

test('SQLite uses private files, normal synchronous writes and cached statements with small session updates', (t) => {
  const old = process.umask(0o022)
  t.after(() => process.umask(old))
  const { store, file, session } = setup(t)
  // Agents inherit the daemon's umask, so opening the store must leave it alone.
  assert.equal(process.umask(0o022), 0o022)
  for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.statSync(file + suffix).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(store.db.prepare('PRAGMA synchronous').get()!.synchronous, 1)
  const sql: string[] = [], prepare = store.db.prepare.bind(store.db)
  store.db.prepare = (statement: string) => { sql.push(statement); return prepare(statement) }
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  for (let n = 0; n < 10; n++) s.push({ type: 'text', itemId: String(n), text: 'Hello' })
  assert.equal(sql.filter((s) => s.startsWith('INSERT INTO events')).length, 1)
  const updates = sql.filter((s) => s.startsWith('UPDATE sessions'))
  assert.ok(updates.length > 0)
  assert.ok(updates.every((s) => !s.includes('native_ref=') && !s.includes('model=') && !s.includes('title=')))
})

test('newer schema versions disable persistence without changing the database', (t) => {
  const { store, file } = setup(t)
  store.db.exec('PRAGMA user_version=99')
  const messages: string[] = [], newer = new Store(file, (message) => messages.push(message))
  try {
    assert.equal(newer.degraded, true)
    assert.match(messages[0], /version 99.*persistence disabled/)
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 99)
    const s = new Session({ id: 'new', harness: 'fake', agent: 'test', model: 'm', cwd: '/tmp', state: 'idle' }, newer)
    s.push({ type: 'turn_started', turnId: 'new-turn' })
    finish(s, 'new-turn')
    assert.equal(newer.messages('new').turns.length, 1)
    assert.equal(store.load('new'), null)
  } finally { newer.close() }
})

test('concurrent first-time schema creation is transactional and does not degrade either writer', async (t) => {
  const { spawn } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-schema-race-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'bitfrost.db')
  const module = new URL('../store.ts', import.meta.url).href
  const source = `import { Store } from ${JSON.stringify(module)}; const s = new Store(process.argv[1]); if (s.degraded) process.exitCode=1; s.close()`
  const writers = [0, 1].map(() => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source, file], { stdio: 'pipe' })
    let error = ''
    child.stderr.on('data', (chunk) => error += chunk)
    child.once('exit', (code) => resolve({ code, error }))
  }))
  for (const result of await Promise.all(writers) as any[]) assert.equal(result.code, 0, result.error)
  const store = new Store(file)
  try { assert.equal(store.degraded, false) } finally { store.close() }
})

test('an unreadable SQLite schema degrades instead of aborting startup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-corrupt-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'bitfrost.db'), log: string[] = []
  fs.writeFileSync(file, 'not a SQLite database')
  const store = new Store(file, (message) => log.push(message))
  try {
    assert.equal(store.degraded, true)
    assert.match(log[0], /not a database/)
    assert.deepEqual(store.unfinished(), [])
  } finally { store.close() }
})

test('approvals for a native tool keep their item id and resolve by approval id with visible paging updates', (t) => {
  const { store, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'approval_requested', approvalId: 'approval', itemId: 'native-tool', kind: 'command', title: 'Run', detail: 'ls' })
  const since = s.lastSeq
  s.push({ type: 'approval_resolved', approvalId: 'approval', decision: 'allow' })
  const row = store.messages('s', { since }).turns[0].messages[0]
  assert.equal(row.itemId, 'native-tool')
  assert.equal(row.status, 'ok')
  assert.equal(row.seq, since + 1)
  finish(s, 't')
  assert.equal(store.message('s', 'native-tool')!.status, 'ok')
})

test('since paging never skips tool status updates that share a completion sequence', (t) => {
  const { store, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  for (const itemId of ['one', 'two', 'three']) s.push({ type: 'tool_started', itemId, name: 'Read', input: {} })
  const since = s.lastSeq
  finish(s, 't')
  const page = store.messages('s', { since, limit: 1 })
  assert.equal(page.turns[0].messages.length, 3)
  assert.equal(page.truncated, false)
  assert.ok(page.turns[0].messages.every((m) => m.status === 'error'))
  assert.equal(store.messages('s', { since: page.nextSince, limit: 1 }).turns[0].messages.length, 0)
})

test('read and retention errors degrade safely and summary still uses the live event stream', (t) => {
  const { store, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'text', itemId: 'text', text: 'Kept in memory.' })
  store.db.exec('DROP TABLE messages')
  assert.equal(store.summary(s).latestText!.text, 'Kept in memory.')
  assert.equal(store.degraded, true)
  const second = new Store(':memory:', () => {})
  second.close()
  assert.doesNotThrow(() => second.retain())
  assert.equal(second.degraded, true)
  second.close()
})

test('version one schema upgrades and backfills approvals without native item id changes', (t) => {
  const { store, file, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'approval_requested', approvalId: 'approval', itemId: 'native', kind: 'command', title: 'Run', detail: 'ls' })
  store.db.exec('DROP INDEX messages_approval; ALTER TABLE messages DROP COLUMN approval_id; ALTER TABLE turns DROP COLUMN pgid; ALTER TABLE turns DROP COLUMN process_identity; PRAGMA user_version=1')
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    const restored = Session.load('s', upgraded)!
    restored.activeTurnId = 't'
    restored.push({ type: 'approval_resolved', approvalId: 'approval', decision: 'deny' })
    assert.equal(upgraded.message('s', 'native')!.status, 'declined')
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 3)
  } finally { upgraded.close() }
})

test('version two adds per-session client input ids and keeps legacy receipts', (t) => {
  const { store, file, session } = setup(t), s = session()
  const legacy = s.acceptInput('legacy', 'queued')
  store.db.exec('DROP INDEX inbox_client_input; ALTER TABLE inbox DROP COLUMN client_input_id; PRAGMA user_version=2')
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 3)
    assert.equal(upgraded.pending('s')[0].id, legacy.id)
    assert.equal(upgraded.pending('s')[0].client_input_id, null)
    const restored = Session.load('s', upgraded)!
    const input = restored.acceptInput('new', 'queued', 'claude', 'client')
    assert.deepEqual(upgraded.inputReceipt('s', 'client'), { inputId: input.id, delivery: 'queued' })
    assert.equal(upgraded.inputReceipt('other', 'client'), null)
    const other = new Session({ ...restored.info, id: 'other' }, upgraded).acceptInput('other session', 'queued', 'claude', 'client')
    assert.deepEqual(upgraded.inputReceipt('other', 'client'), { inputId: other.id, delivery: 'queued' })
    assert.throws(() => upgraded.db.prepare('INSERT INTO inbox (id,session_id,client_input_id) VALUES (?,?,?)').run('duplicate', 's', 'client'), /UNIQUE/)
  } finally { upgraded.close() }
})

test('client input receipts survive event retention and a store reopen', async (t) => {
  const { store, file, session } = setup(t), s = session()
  const input = s.acceptInput('once', 'started', 'user', 'client')
  s.push({ type: 'turn_started', turnId: 't' })
  finish(s, 't')
  const now = Date.now()
  s.info.closedAt = now - 40 * 86400_000
  s.info.updatedAt = s.info.closedAt
  s.save()
  store.retain(undefined, now)
  const reader = new Store(file)
  try {
    const restored = Session.load('s', reader)!
    assert.deepEqual(restored.events, [])
    const provider = { sendInput: () => { throw new Error('must not deliver') }, attach: () => { throw new Error('must not attach') } } as any
    assert.deepEqual(await restored.deliver(provider, 'retry', 'interrupt', 'claude', 'client'), { inputId: input.id, delivery: 'started' })
    assert.equal(restored.lastSeq, s.lastSeq)
  } finally { reader.close() }
})
