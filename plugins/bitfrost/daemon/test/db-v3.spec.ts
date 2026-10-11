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
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { convertToV3 } from '../../../../tools/db-v3.ts'
import { Store } from '../store.ts'
import { migrate } from './migrate.ts'
import { Session } from '../session.ts'
import { summarize } from '../usage.ts'

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-v3-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'bitfrost.db')
  const store = new Store(source)
  const s = new Session({ id: 's', harness: 'fake', agent: 'test', model: 'm', state: 'idle', cwd: dir }, store)
  s.setNativeRef({ threadId: 'native' })
  const receipt = s.acceptInput('keep this input', 'started', 'user', 'client')
  s.push({ type: 'turn_started', turnId: 'one' })
  s.push({ type: 'tool_completed', itemId: 'tool', name: 'Read', output: 'keep this message', ok: true })
  for (const outputTokens of [10, 15]) s.push({ type: 'usage', requestId: 'r1', inputTokens: 100, outputTokens, cachedInputTokens: 20 })
  s.push({ type: 'turn_completed', turnId: 'one', status: 'completed', reason: 'end_turn', finalText: 'Done' })
  s.push({ type: 'turn_started', turnId: 'two' })
  // No request identity: also exercise the legacy migration path.
  s.push({ type: 'usage', inputTokens: 100, outputTokens: 5, cachedInputTokens: 30 })
  s.push({ type: 'turn_completed', turnId: 'two', status: 'failed', reason: 'error', finalText: '' })
  s.detach()
  return { dir, source, store, s, receipt }
}

const read = (file: string, fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try { fn(db) } finally { db.close() }
}
const usage = (store: Store) => summarize('m', store.usageRows('fake', 'm').rows).total

test('v3 fixture includes committed WAL data, exact old columns and legacy billing, leaving the source intact', (t) => {
  const { source, store, s, receipt } = setup(t)
  try {
    assert.ok(fs.statSync(source + '-wal').size > 0)
    const events = store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all()
    const messages = store.db.prepare('SELECT * FROM messages ORDER BY id').all()
    const expected = usage(store)
    const result = convertToV3(source)
    assert.equal(result.targetVersion, 3)
    assert.equal(result.legacyTurns, 2)
    assert.equal(result.partialTurns, 0)
    assert.equal(result.backup, undefined)
    assert.equal(fs.statSync(result.file).mode & 0o777, 0o600)
    read(result.file, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3)
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name), ['events', 'inbox', 'messages', 'sessions', 'turns'])
      assert.equal(db.prepare('PRAGMA table_info(sessions)').all().length, 19)
      assert.equal(db.prepare('PRAGMA table_info(turns)').all().length, 18)
      assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY session_id,seq').all(), events)
      assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), messages)
      assert.equal(db.prepare('SELECT native_ref FROM sessions').get()!.native_ref, JSON.stringify(s.nativeRef))
      assert.equal(db.prepare('SELECT id FROM inbox WHERE client_input_id=?').get('client')!.id, receipt.id)
      assert.deepEqual({ ...db.prepare("SELECT input_tokens,output_tokens,cached_tokens,requests FROM turns WHERE id='one'").get() }, { input_tokens: 200, output_tokens: 25, cached_tokens: 40, requests: 2 })
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    })
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 8)
    assert.deepEqual(usage(store), expected)
    migrate(result.file)
    const upgraded = new Store(result.file)
    try {
      assert.equal(upgraded.degraded, false, upgraded.error ?? '')
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 8)
      assert.deepEqual(usage(upgraded), expected)
      assert.equal(upgraded.subagentsById(['s'])[0].tokens, 220)
      assert.equal(upgraded.subagentsById(['s'])[0].toolCalls, 1)
      assert.deepEqual(upgraded.inputReceipt('s', 'client'), { inputId: receipt.id, delivery: 'started' })
    } finally { upgraded.close() }
    const reopened = new Store(result.file)
    try { assert.deepEqual(usage(reopened), expected, 'rollup rebuild is idempotent') } finally { reopened.close() }
  } finally { store.close() }
})

test('in-place conversion preserves a private v8 backup and releases the daemon lock', (t) => {
  const { source, store } = setup(t)
  const expected = usage(store)
  store.close()
  const result = convertToV3(source, { inPlace: true, backupDir: path.join(path.dirname(source), 'backups') })
  assert.equal(result.file, source)
  assert.ok(result.backup)
  assert.equal(fs.existsSync(path.join(path.dirname(source), 'daemon.lock')), false)
  assert.equal(fs.existsSync(source + '-wal'), false)
  assert.equal(fs.existsSync(source + '-shm'), false)
  assert.equal(fs.statSync(result.backup!).mode & 0o777, 0o600)
  read(source, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3))
  const backup = new Store(result.backup!)
  try { assert.deepEqual(usage(backup), expected) } finally { backup.close() }
  migrate(source)
  const upgraded = new Store(source)
  try { assert.deepEqual(usage(upgraded), expected) } finally { upgraded.close() }
})

test('expired events keep stored turn totals while unrepresentable rollups are omitted', (t) => {
  const { source, store } = setup(t)
  store.db.exec("DELETE FROM events WHERE turn_id='one'; UPDATE turns SET input_tokens=700,output_tokens=70,cached_tokens=60,requests=7 WHERE id='one'")
  store.db.exec("INSERT INTO usage_hours (harness,model,hour,input_tokens,updated_at) VALUES ('fake','m',0,9999,1)")
  store.close()
  const result = convertToV3(source)
  assert.equal(result.legacyTurns, 1)
  assert.ok(result.omittedRollups >= 2)
  migrate(result.file)
  const upgraded = new Store(result.file)
  try {
    const total = usage(upgraded)
    assert.deepEqual([total.inputTokens, total.outputTokens, total.cachedTokens, total.requests], [800, 75, 90, 8])
  } finally { upgraded.close() }
})

test('partial event history is reported and its stored totals survive the conversion', (t) => {
  const { source, store } = setup(t)
  store.db.exec("DELETE FROM events WHERE turn_id='one' AND type='turn_started'")
  store.close()
  const result = convertToV3(source)
  assert.equal(result.partialTurns, 1)
  read(result.file, (db) => assert.equal(db.prepare("SELECT input_tokens FROM turns WHERE id='one'").get()!.input_tokens, 100))
})

test('existing outputs, source aliases and daemon locks are refused without replacing anything', (t) => {
  const { source, store, dir } = setup(t)
  store.close()
  const output = path.join(dir, 'existing.db')
  fs.writeFileSync(output, 'keep')
  assert.throws(() => convertToV3(source, { output }), /Output already exists/)
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep')
  assert.throws(() => convertToV3(source, { output: source }), /is the source/)
  fs.symlinkSync(source, path.join(dir, 'alias.db'))
  assert.throws(() => convertToV3(path.join(dir, 'alias.db'), { inPlace: true }), /symlinks/)
  fs.writeFileSync(path.join(dir, 'daemon.lock'), String(process.pid))
  assert.throws(() => convertToV3(source, { inPlace: true }), /Data lock exists/)
  assert.equal(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8'), String(process.pid))
  read(source, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 8))
})

test('a SQLite lock refuses replacement and cleanup leaves the source usable', (t) => {
  const { source, store, dir } = setup(t)
  store.close()
  const holder = new DatabaseSync(source)
  holder.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT')
  try { assert.throws(() => convertToV3(source, { inPlace: true }), /locked/) } finally { holder.close() }
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  read(source, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 8))
})

test('invalid history leaves the original and completed backup intact and publishes no fixture', (t) => {
  const { source, store, dir } = setup(t)
  store.db.exec("UPDATE events SET body='invalid json' WHERE type='usage'")
  store.close()
  const backupDir = path.join(dir, 'backups')
  assert.throws(() => convertToV3(source, { inPlace: true, backupDir }), /malformed JSON.*Original snapshot kept/)
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  assert.equal(fs.readdirSync(backupDir).filter((f) => f.includes('.before-v3-')).length, 1)
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('.bitfrost-v3-')), false)
  read(source, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 8))
})

test('unsupported versions are refused and deleted message ids are not reused', (t) => {
  const { source, store, dir } = setup(t)
  store.db.exec("INSERT INTO messages (id,session_id,text) VALUES (1000,'s','deleted'); DELETE FROM messages; PRAGMA user_version=99")
  store.close()
  assert.throws(() => convertToV3(source), /Unsupported source schema 99/)
  assert.equal(fs.existsSync(path.join(dir, 'bitfrost-v3.db')), false)
  const db = new DatabaseSync(source)
  db.exec('PRAGMA user_version=8')
  db.close()
  const result = convertToV3(source)
  const old = new DatabaseSync(result.file)
  try {
    old.prepare('INSERT INTO messages (session_id,text) VALUES (?,?)').run('s', 'new')
    assert.equal(old.prepare('SELECT id FROM messages').get()!.id, 1001)
  } finally { old.close() }
})

test('CLI uses the requested data directory, accepts explicit output and rejects conflicting modes', (t) => {
  const { source, store, dir } = setup(t)
  store.close()
  const script = fileURLToPath(new URL('../../../../tools/db-v3.ts', import.meta.url))
  const env: NodeJS.ProcessEnv = { ...process.env, BITFROST_DATA_DIR: dir }
  // A CLI subprocess is not a child of Node's test runner protocol.
  delete env.NODE_TEST_CONTEXT
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
      env, encoding: 'utf8', timeout: 10_000,
    })
    assert.ifError(result.error)
    return result
  }
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Schema 8 -> 3/)
  const output = path.join(dir, 'custom.db')
  result = run(source, '--output', output)
  assert.equal(result.status, 0, result.stderr)
  read(output, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3))
  result = run('--in-place', '--output', path.join(dir, 'invalid.db'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot be combined/)
  read(source, (db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 8))
})

test('empty databases and existing v3 fixtures are accepted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-v3-empty-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'bitfrost.db')
  new Store(source).close()
  const first = convertToV3(source)
  assert.equal(first.counts.sessions, 0)
  const second = convertToV3(first.file, { output: path.join(dir, 'again.db') })
  assert.equal(second.sourceVersion, 3)
  assert.equal(second.legacyTurns, 0)
  migrate(second.file)
  const upgraded = new Store(second.file)
  try { assert.equal(upgraded.degraded, false) } finally { upgraded.close() }
})
