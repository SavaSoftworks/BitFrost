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
import { Store, hourOf } from '../store.ts'
import { DB_VERSION } from '../db-version.ts'
import { migrate } from './migrate.ts'
import { summarize } from '../usage.ts'
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
    assert.equal(reader.db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
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

test('the startup sweep lists each owned session process once, then forgets closed ones', (t) => {
  const { store, session } = setup(t)
  const owner = { store: '/data/bitfrost.db', pid: 1234, startTime: '1' }
  const open = session('open')
  open.setNativeRef({ conversationId: 'c1', process: { pgid: 501, startTime: '9', token: 'a', marker: 'BITFROST_AGY_PROC', owner } })
  // Records without an owner may come from a copied store, so they are skipped.
  session('old').setNativeRef({ process: { pgid: 502, startTime: '9', token: 'b' } })
  const closed = session('closed')
  closed.info.closedAt = Date.now()
  closed.setNativeRef({ conversationId: 'c3', process: { pgid: 503, startTime: '9', token: 'c', owner } })
  const tokens = () => store.processes().map((r) => [r.pgid, JSON.parse(r.process_identity).token])
  assert.deepStrictEqual(tokens().sort(), [[501, 'a'], [503, 'c']])
  store.forgetProcesses()
  assert.deepStrictEqual(tokens(), [[501, 'a']])
  const saved = store.db.prepare("SELECT native_ref FROM sessions WHERE id='closed'").get() as any
  assert.deepStrictEqual(JSON.parse(saved.native_ref), { conversationId: 'c3' })
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
  migrate(file)
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    const restored = Session.load('s', upgraded)!
    restored.activeTurnId = 't'
    restored.push({ type: 'approval_resolved', approvalId: 'approval', decision: 'deny' })
    assert.equal(upgraded.message('s', 'native')!.status, 'declined')
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
  } finally { upgraded.close() }
})

test('version two adds per-session client input ids and keeps legacy receipts', (t) => {
  const { store, file, session } = setup(t), s = session()
  const legacy = s.acceptInput('legacy', 'queued')
  store.db.exec('DROP INDEX inbox_client_input; ALTER TABLE inbox DROP COLUMN client_input_id; PRAGMA user_version=2')
  migrate(file)
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
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

const usageOf = (store: Store, model = 'm', harness = 'fake') => summarize(model, store.usageRows(harness, model).rows)

test('usage rolls up by hour, sums into the periods, and outlives retention', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't1' })
  s.push({ type: 'usage', inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 })
  finish(s, 't1')
  s.push({ type: 'turn_started', turnId: 't2' })
  // A new request bills its whole input; a repeated report of it only adds output not yet counted.
  s.push({ type: 'usage', inputTokens: 105, outputTokens: 5, cachedInputTokens: 100 })
  s.push({ type: 'usage', inputTokens: 105, outputTokens: 7, cachedInputTokens: 100 })
  s.push({ type: 'turn_completed', turnId: 't2', status: 'failed', reason: 'error', finalText: '' })
  const row = usageOf(store)
  assert.deepEqual({ ...row.total, turnMs: 0 }, { sessions: 1, closedSessions: 0, sessionMs: 0, turns: 2, failedTurns: 1, turnMs: 0, requests: 2, inputTokens: 205, outputTokens: 27, cachedTokens: 110 })
  assert.deepEqual([row.today, row.week, row.month], [row.total, row.total, row.total])
  assert.equal(row.hourly[new Date().getHours()].tokens, 232)
  assert.equal(row.daily.length, 30)
  assert.equal(row.daily.at(-1)!.tokens, 232)
  assert.equal(store.subagentsById([s.info.id])[0].tokens, 232)
  const now = Date.now()
  s.info.closedAt = now - 400 * 86400_000
  s.info.updatedAt = s.info.closedAt
  s.save()
  store.retain(undefined, now)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0)
  assert.equal(usageOf(store).total.inputTokens, 205)
  assert.deepEqual(store.usageRows('other', 'm').rows, [])
})

test('usage outside the last week counts toward the month and total only', (t) => {
  const { store } = setup(t)
  const old = Date.now() - 20 * 86400_000
  store.db.prepare('INSERT INTO usage_hours (harness,model,hour,sessions,input_tokens,output_tokens,first_at,last_at,updated_at) VALUES (?,?,?,3,10,10,?,?,1)').run('fake', 'm', hourOf(old), old, old)
  const row = usageOf(store)
  assert.deepEqual([row.total.sessions, row.month.sessions, row.week.sessions, row.today.sessions], [3, 3, 0, 0])
  assert.equal(row.daily.reduce((n, d) => n + d.sessions, 0), 3)
})

test('asking for usage since a stamp returns only rows changed after it', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'usage', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 })
  const first = store.usageRows('fake', 'm')
  assert.equal(first.rows.length, 1)
  assert.deepEqual(store.usageRows('fake', 'm', first.stamp).rows, [])
  s.push({ type: 'usage', inputTokens: 2, outputTokens: 0, cachedInputTokens: 0 })
  const next = store.usageRows('fake', 'm', first.stamp)
  assert.equal(next.rows.length, 1)
  assert.ok(next.stamp > first.stamp)
  assert.equal(next.rows[0].input_tokens, 3)
})

test('a version 6 store gets back the cached input it took off turns whose events are gone', (t) => {
  const { store, file, session } = setup(t)
  const old = session('old'), recent = session('recent')
  old.push({ type: 'turn_started', turnId: 'o' })
  old.push({ type: 'usage', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 900 })
  finish(old, 'o')
  recent.push({ type: 'turn_started', turnId: 'r' })
  for (const input of [200, 300]) recent.push({ type: 'usage', inputTokens: input, outputTokens: 5, cachedInputTokens: input - 100 })
  finish(recent, 'r')
  // As version 6 left them: uncached input on the old turn, context growth on the recent one.
  store.db.exec(`DELETE FROM events WHERE session_id='old'; UPDATE turns SET input_tokens=100 WHERE id='o'; UPDATE turns SET input_tokens=300 WHERE id='r';
    ALTER TABLE sessions ADD COLUMN context INTEGER DEFAULT 0; PRAGMA user_version=6`)
  migrate(file)
  const upgraded = new Store(file)
  try {
    const turns = upgraded.db.prepare("SELECT id, input_tokens FROM turns ORDER BY id").all().map((r: any) => [r.id, r.input_tokens])
    assert.deepEqual(turns, [['o', 1000], ['r', 500]])
    const byId = new Map(upgraded.subagentsById(['old', 'recent']).map((r) => [r.id, r.tokens]))
    assert.deepEqual([byId.get('old'), byId.get('recent')], [1050, 510])
    assert.ok(!(upgraded.db.prepare('PRAGMA table_info(sessions)').all() as any[]).some((c) => c.name === 'context'))
  } finally { upgraded.close() }
})

test('a version 5 store counts repeated usage reports once, from the events it still has', (t) => {
  const { store, file, session } = setup(t)
  const s = session('kept'), gone = session('gone')
  s.push({ type: 'turn_started', turnId: 'k' })
  for (const input of [100, 150, 150]) s.push({ type: 'usage', inputTokens: input, outputTokens: 10, cachedInputTokens: 0 })
  finish(s, 'k')
  gone.push({ type: 'turn_started', turnId: 'g' })
  gone.push({ type: 'usage', inputTokens: 80, outputTokens: 4, cachedInputTokens: 0 })
  finish(gone, 'g')
  // As version 5 counted: every report in full, and no request columns.
  store.db.exec(`UPDATE turns SET input_tokens=400, output_tokens=30, requests=3 WHERE id='k'; UPDATE turns SET input_tokens=500 WHERE id='g';
    DELETE FROM events WHERE session_id='gone'; ALTER TABLE sessions DROP COLUMN request_input; ALTER TABLE sessions DROP COLUMN request_output;
    UPDATE usage_hours SET input_tokens=input_tokens*9; PRAGMA user_version=5`)
  migrate(file)
  const upgraded = new Store(file)
  try {
    const byId = new Map(upgraded.subagentsById(['kept', 'gone']).map((r) => [r.id, r]))
    assert.deepEqual([byId.get('kept')!.tokens, byId.get('gone')!.tokens], [250 + 20, 500 + 4])
    const turn = upgraded.db.prepare("SELECT input_tokens, output_tokens, requests FROM turns WHERE id='k'").get() as any
    assert.deepEqual([turn.input_tokens, turn.output_tokens, turn.requests], [250, 20, 2])
    assert.equal(summarize('m', upgraded.usageRows('fake', 'm').rows).total.inputTokens, 750)
    // A new turn bills its request even if its input is identical to the previous turn.
    const again = Session.load('kept', upgraded)!
    again.push({ type: 'turn_started', turnId: 'k2' })
    again.push({ type: 'usage', inputTokens: 150, outputTokens: 10, cachedInputTokens: 0 })
    assert.equal(upgraded.subagentsById(['kept'])[0].tokens, 430)
    again.push({ type: 'usage', inputTokens: 170, outputTokens: 0, cachedInputTokens: 0 })
    assert.equal(upgraded.subagentsById(['kept'])[0].tokens, 600)
  } finally { upgraded.close() }
})

test('a store from before hourly usage rebuilds it from the sessions and turns it still has', (t) => {
  const { store, file, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'usage', inputTokens: 40, outputTokens: 2, cachedInputTokens: 0 })
  finish(s, 't')
  store.db.exec('DROP TABLE usage_hours; CREATE TABLE model_usage (day TEXT); PRAGMA user_version=4')
  migrate(file)
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='model_usage'").get()!.n, 0)
    const row = usageOf(upgraded)
    assert.deepEqual([row.total.sessions, row.total.turns, row.total.inputTokens, row.total.requests], [1, 1, 40, 1])
    assert.equal(row.hourly[new Date().getHours()].tokens, 42)
  } finally { upgraded.close() }
})

test('session time counts when a session closes, and a reopen takes it back', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.info.createdAt = Date.now() - 60_000
  s.save()
  s.info.closedAt = Date.now()
  s.save()
  let total = usageOf(store).total
  assert.equal(total.closedSessions, 1)
  assert.ok(total.sessionMs >= 59_000 && total.sessionMs <= 61_000, String(total.sessionMs))
  s.info.closedAt = null
  s.save()
  total = usageOf(store).total
  assert.deepEqual([total.closedSessions, total.sessionMs, total.sessions], [0, 0, 1])
})

test('startup uses the installed rollups without rebuilding an empty table', (t) => {
  const { store, file, session } = setup(t), s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'usage', inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 })
  finish(s, 't')
  store.db.exec('DELETE FROM usage_hours')
  const reopened = new Store(file)
  try {
    assert.equal(usageOf(reopened).total.inputTokens, 0, 'startup must not backfill historical data')
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM usage_hours').get()!.n, 0)
  } finally { reopened.close() }
})

test('the daily series reaches back to first use, up to a year', (t) => {
  const { store } = setup(t)
  const put = (daysAgo: number, model: string) => {
    const at = Date.now() - daysAgo * 86400_000
    store.db.prepare('INSERT INTO usage_hours (harness,model,hour,sessions,input_tokens,first_at,last_at,updated_at) VALUES (?,?,?,1,5,?,?,1)').run('fake', model, hourOf(at), at, at)
  }
  put(90, 'old')
  put(800, 'ancient')
  const old = usageOf(store, 'old')
  assert.ok(old.daily.length >= 90 && old.daily.length <= 92, String(old.daily.length))
  assert.equal(old.daily[0].tokens, 5)
  const ancient = usageOf(store, 'ancient')
  assert.equal(ancient.daily.length, 366)
  assert.equal(ancient.total.inputTokens, 5)
})

test('sessions keep their own totals as events arrive, and old stores fill them once', (t) => {
  const { store, file, session } = setup(t)
  const s = session('worker')
  s.push({ type: 'turn_started', turnId: 't' })
  s.push({ type: 'tool_started', itemId: 'a', name: 'Read', input: {} })
  s.push({ type: 'tool_completed', itemId: 'a', name: 'Read', input: {}, output: 'x', ok: true })
  s.push({ type: 'command_started', itemId: 'b', command: 'ls', summary: 'List', cwd: s.info.cwd })
  s.push({ type: 'usage', inputTokens: 30, outputTokens: 5, cachedInputTokens: 10 })
  finish(s, 't')
  const totals = () => (store.db.prepare('SELECT tokens,cached_tokens,turns,tool_calls FROM sessions WHERE id=?').get('worker') as any)
  assert.deepEqual({ ...totals() }, { tokens: 35, cached_tokens: 10, turns: 1, tool_calls: 2 })
  store.db.exec('ALTER TABLE sessions DROP COLUMN tokens; ALTER TABLE sessions DROP COLUMN tool_calls')
  store.db.exec('PRAGMA user_version=3')
  migrate(file)
  const reopened = new Store(file)
  try {
    const [row] = reopened.subagentsById(['worker'])
    assert.deepEqual([row.tokens, row.cachedTokens, row.turns, row.toolCalls], [35, 10, 1, 2])
  } finally { reopened.close() }
})

test('subagent pages go newest first by position, and only changed rows come back', (t) => {
  const { store, session } = setup(t)
  for (const [id, ago] of [['a', 50], ['b', 40], ['c', 30], ['d', 20], ['e', 10]] as const) {
    const s = session(id)
    s.info.createdAt = Date.now() - ago * 1000
    s.save()
  }
  const first = store.subagentPage({ limit: 2, count: true })
  assert.deepEqual([first.rows.map((r) => r.id), first.more, first.total], [['e', 'd'], true, 5])
  assert.equal(store.subagentPage({ limit: 2 }).total, null)
  const last = first.rows.at(-1)!
  const second = store.subagentPage({ before: [last.createdAt, last.id], limit: 2 })
  assert.deepEqual(second.rows.map((r) => r.id), ['c', 'b'])
  const oldest = store.subagentPage({ oldest: true, limit: 2 })
  assert.deepEqual(oldest.rows.map((r) => r.id), ['b', 'a'])
  const up = store.subagentPage({ after: [second.rows[0].createdAt, second.rows[0].id], limit: 5 })
  assert.deepEqual([up.rows.map((r) => r.id), up.more], [['e', 'd'], false])
  const seen = store.subagentsChanged(['a', 'b', 'c'], 0)
  assert.equal(seen.rows.length, 3)
  assert.deepEqual(store.subagentsChanged(['a', 'b', 'c'], seen.stamp).rows, [])
  const b = session('b')
  b.push({ type: 'turn_started', turnId: 'tb' })
  const changed = store.subagentsChanged(['a', 'b', 'c'], seen.stamp)
  assert.deepEqual(changed.rows.map((r) => r.id), ['b'])
  assert.ok(changed.rows[0].turnStartedAt)
})


test('request identities bill identical calls separately and repeated reports only by their growth', (t) => {
  const { store, file, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 'first' })
  const report = (requestId: string, outputTokens = 10, cachedInputTokens = 20) =>
    s.push({ type: 'usage', requestId, inputTokens: 100, outputTokens, cachedInputTokens })
  report('one')
  report('one', 15, 25)
  report('two')
  report('one', 12) // A late, smaller report cannot undo or duplicate a bill.
  finish(s, 'first')
  s.push({ type: 'turn_started', turnId: 'second' })
  report('three')
  assert.deepEqual(store.summary(s).usage, { inputTokens: 300, outputTokens: 35, cachedTokens: 65, requests: 3 })
  const reopened = new Store(file)
  try {
    const restored = Session.load('s', reopened)!
    restored.push({ type: 'turn_started', turnId: 'resumed' })
    restored.push({ type: 'usage', requestId: 'one', inputTokens: 100, outputTokens: 15, cachedInputTokens: 25 })
    assert.deepEqual(reopened.summary(restored).usage, { inputTokens: 300, outputTokens: 35, cachedTokens: 65, requests: 3 })
    restored.push({ type: 'usage', requestId: 'zero', inputTokens: 0, outputTokens: 3, cachedInputTokens: 0 })
    assert.equal(reopened.summary(restored).usage.requests, 4, 'zero input is still a request')
  } finally { reopened.close() }
})

test('context snapshots do not bill prompt-wide ACP usage repeatedly', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  const billing = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0 }
  for (const inputTokens of [100, 200]) s.push({ type: 'usage', requestId: 't', inputTokens, outputTokens: 0, cachedInputTokens: 0, billing })
  assert.equal(store.summary(s).usage.requests, 0)
  s.push({ type: 'usage', requestId: 't', inputTokens: 200, outputTokens: 10, cachedInputTokens: 0,
    billing: { inputTokens: 300, outputTokens: 10, cachedInputTokens: 50, requests: 2 } })
  assert.deepEqual(store.summary(s).usage, { inputTokens: 300, outputTokens: 10, cachedTokens: 50, requests: 2 })
})

test('version 7 migration corrects repeated input across turns without losing expired usage', (t) => {
  const { store, file, session } = setup(t)
  const s = session()
  for (const id of ['one', 'two']) {
    s.push({ type: 'turn_started', turnId: id })
    s.push({ type: 'usage', inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 })
    finish(s, id)
  }
  // Version 7 suppressed the second turn because the input count matched.
  store.db.exec("UPDATE turns SET input_tokens=0,output_tokens=0,cached_tokens=0,requests=0 WHERE id='two'; UPDATE sessions SET tokens=110,cached_tokens=20; UPDATE usage_hours SET input_tokens=100,output_tokens=10,cached_tokens=20,requests=1; PRAGMA user_version=7")
  const ancient = hourOf(Date.now() - 400 * 86400_000)
  store.db.prepare('INSERT INTO usage_hours (harness,model,hour,input_tokens,output_tokens,requests,first_at,last_at,updated_at) VALUES (?,?,?,700,70,7,?,?,1)').run('fake', 'm', ancient, ancient, ancient)
  migrate(file)
  const upgraded = new Store(file)
  try {
    assert.equal(upgraded.degraded, false)
    const restored = Session.load('s', upgraded)!
    assert.deepEqual(upgraded.summary(restored).usage, { inputTokens: 200, outputTokens: 20, cachedTokens: 40, requests: 2 })
    const total = summarize('m', upgraded.usageRows('fake', 'm').rows).total
    assert.deepEqual([total.inputTokens, total.outputTokens, total.requests], [900, 90, 9])
    assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM usage_requests').get()!.n, 2)
  } finally { upgraded.close() }
})


test('version 7 migration preserves the expired prefix of a turn and corrects a later retained turn', (t) => {
  for (const removeWholeTurn of [false, true]) {
    const { store, file, session } = setup(t)
    const s = session()
    s.push({ type: 'turn_started', turnId: 'first' })
    for (const inputTokens of [1000, 1200]) s.push({ type: 'usage', inputTokens, outputTokens: inputTokens === 1000 ? 10 : 20, cachedInputTokens: 0 })
    finish(s, 'first')
    s.push({ type: 'turn_started', turnId: 'second' })
    s.push({ type: 'usage', inputTokens: 1200, outputTokens: 20, cachedInputTokens: 0 })
    finish(s, 'second')
    store.db.exec("UPDATE turns SET input_tokens=0,output_tokens=0,requests=0 WHERE id='second'; UPDATE sessions SET tokens=2230; UPDATE usage_hours SET input_tokens=2200,output_tokens=30,requests=2; PRAGMA user_version=7")
    store.db.exec(removeWholeTurn ? "DELETE FROM events WHERE turn_id='first'" : "DELETE FROM events WHERE seq<=2")
    migrate(file)
    const upgraded = new Store(file)
    try {
      assert.equal(upgraded.degraded, false)
      const usage = upgraded.summary(Session.load('s', upgraded)!).usage
      assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.requests], [3400, 50, 3])
      const total = summarize('m', upgraded.usageRows('fake', 'm').rows).total
      assert.deepEqual([total.inputTokens, total.outputTokens, total.requests], [3400, 50, 3])
    } finally { upgraded.close() }
  }
})

test('legacy usage groups only adjacent equal reports within a turn', (t) => {
  const { store, session } = setup(t)
  const s = session()
  s.push({ type: 'turn_started', turnId: 't' })
  for (const inputTokens of [100, 200, 100, 100]) s.push({ type: 'usage', inputTokens, outputTokens: 10, cachedInputTokens: 0 })
  assert.deepEqual(store.summary(s).usage, { inputTokens: 400, outputTokens: 30, cachedTokens: 0, requests: 3 })
})


test('an older persisted schema refuses startup without changing structure or data', (t) => {
  const { store, file } = setup(t)
  store.db.exec('PRAGMA user_version=3')
  const before = store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
  assert.throws(() => new Store(file), /schema 3 needs migration.*bitfrost migrate/)
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 3)
  assert.deepEqual(store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before)
})
