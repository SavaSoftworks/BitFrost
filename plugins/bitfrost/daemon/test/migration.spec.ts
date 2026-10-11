// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { migrate as migrateBase, migrationBinary, migrationRoot } from './migrate.ts'
import { Store, hourOf } from '../store.ts'
import { Session } from '../session.ts'
import { DB_VERSION } from '../db-version.ts'

const coreVersions = path.join(migrationRoot, 'versions')
const NEXT = DB_VERSION + 1, LAST = DB_VERSION + 2
const sequence = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i)
let extensionRoot: string, extensionVersions: string, extensionBinary: string
before(() => {
  extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-migration-build-'))
  extensionVersions = path.join(extensionRoot, 'versions')
  fs.cpSync(coreVersions, extensionVersions, { recursive: true })
  for (const version of [NEXT, LAST]) {
    const dir = path.join(extensionVersions, `v${version}`)
    fs.mkdirSync(dir)
    // The manifest sets the target; the build discovers each handler.
    const code = fs.readFileSync(path.join(coreVersions, 'v1', 'main.cob'), 'utf8')
      .replace('MIGRATION-V1.', `MIGRATION-V${version}.`)
    fs.writeFileSync(path.join(dir, 'main.cob'), code)
    fs.writeFileSync(path.join(dir, 'plan'), 'schema.sql\n')
    fs.writeFileSync(path.join(dir, 'schema.sql'), 'SELECT 1;')
    fs.writeFileSync(path.join(dir, 'indexes.sql'), '')
  }
  const manifest = path.join(extensionRoot, 'package.json')
  fs.writeFileSync(manifest, JSON.stringify({ dbVersion: LAST }))
  const build = spawnSync('sh', [path.resolve('release/build-migrations.sh'),
    '--versions', extensionVersions, '--package-json', manifest,
    '--build-dir', path.join(extensionRoot, 'build')], { encoding: 'utf8' })
  assert.ifError(build.error)
  assert.equal(build.status, 0, build.stdout + build.stderr)
  extensionBinary = path.join(extensionRoot, 'build', 'bitfrost-migrate')
})
after(() => { if (extensionRoot) fs.rmSync(extensionRoot, { recursive: true, force: true }) })
function migrate(file: string, versions = coreVersions) {
  return migrateBase(file, versions, versions === coreVersions ? migrationBinary : extensionBinary)
}

function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-migration-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'bitfrost.db') }
}
function run(file: string, versions = coreVersions) {
  const binary = versions === coreVersions ? migrationBinary : extensionBinary
  return spawnSync(binary, ['--db', file, '--migrations', versions,
    '--backup-dir', path.join(path.dirname(file), 'migration-backups')], { encoding: 'utf8' })
}
function versionTree(dir: string, sql: Record<string, string> = {}) {
  const versions = path.join(dir, 'versions')
  fs.cpSync(extensionVersions, versions, { recursive: true })
  for (const [version, body] of Object.entries(sql))
    fs.writeFileSync(path.join(versions, `v${version}`, 'schema.sql'), body)
  return versions
}
function read(file: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { fn(db) } finally { db.close() }
}

test('a fresh installation creates the current schema before any daemon starts; a repeat is a no-op', (t) => {
  const { dir, file } = fixture(t)
  assert.match(migrate(file), /migration complete/)
  read(file, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_hours').get()!.n, 0)
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), sequence(1, DB_VERSION))
  })
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const before = fs.readFileSync(file)
  assert.match(migrate(file), /already current/)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(fs.existsSync(path.join(dir, 'migration-backups')), false)
})

test('a WAL snapshot includes committed events and backfill retains 64-bit token counts', (t) => {
  const { dir, file } = fixture(t)
  const store = new Store(file)
  t.after(() => store.close())
  const s = new Session({ id: 's', harness: 'fake', agent: 'a', model: 'm', state: 'idle', cwd: dir }, store)
  s.push({ type: 'turn_started', turnId: 'one' })
  s.push({ type: 'usage', requestId: 'request', inputTokens: 5_000_000_000, outputTokens: 100, cachedInputTokens: 4_000_000_000 })
  s.push({ type: 'turn_completed', turnId: 'one', status: 'completed', reason: 'end_turn', finalText: '' })
  store.db.exec('PRAGMA user_version=3; DROP TABLE usage_hours')
  assert.ok(fs.statSync(file + '-wal').size > 0)
  migrate(file)
  const backups = fs.readdirSync(path.join(dir, 'migration-backups'))
  assert.equal(backups.length, 1)
  read(path.join(dir, 'migration-backups', backups[0]), (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='usage'").get()!.n, 1)
  })
  read(file, (db) => {
    assert.equal(db.prepare('SELECT SUM(input_tokens) AS n FROM usage_hours').get()!.n, 5_000_000_000)
    assert.equal(db.prepare('SELECT SUM(cached_tokens) AS n FROM usage_hours').get()!.n, 4_000_000_000)
    assert.equal(db.prepare('SELECT input_tokens FROM turns').get()!.input_tokens, 5_000_000_000)
  })
})

test('the actual v1 schema upgrades through each version while preserving history and approval IDs', (t) => {
  const { file } = fixture(t)
  const db = new DatabaseSync(file)
  db.exec(fs.readFileSync(path.join(coreVersions, 'v1', 'schema.sql'), 'utf8'))
  db.exec(`INSERT INTO sessions(id,harness,model,created_at) VALUES ('s','fake','m',1000);
    INSERT INTO turns(id,session_id,seq_start,started_at) VALUES ('t','s',1,1000);
    INSERT INTO messages(session_id,turn_id,seq,kind,item_id,detail)
      VALUES ('s','t',2,'approval','native','{"approvalId":"kept"}'),
        ('s','t',3,'approval','broken','{invalid');
    INSERT INTO inbox(id,session_id,text) VALUES ('receipt','s','kept');
    PRAGMA user_version=1;`)
  db.close()
  migrate(file)
  read(file, (db) => {
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), sequence(2, DB_VERSION))
    assert.equal(db.prepare("SELECT approval_id FROM messages WHERE item_id='native'").get()!.approval_id, 'kept')
    assert.equal(db.prepare("SELECT approval_id FROM messages WHERE item_id='broken'").get()!.approval_id, null)
    assert.equal(db.prepare('SELECT text FROM inbox').get()!.text, 'kept')
    assert.equal(db.prepare('SELECT client_input_id FROM inbox').get()!.client_input_id, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_hours').get()!.n, 1)
  })
})

test('older hourly schemas are replaced before rollups are populated', (t) => {
  for (const source of [5, 6]) {
    const { file } = fixture(t)
    const store = new Store(file)
    store.db.exec(`DROP TABLE usage_hours; CREATE TABLE usage_hours (obsolete INTEGER); PRAGMA user_version=${source}`)
    store.close()
    migrate(file)
    read(file, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(\'usage_hours\')').get()!.n, 16)
    })
  }
})

test('SQL migrations can change structure and process data, in ascending order, exactly once', (t) => {
  const { dir, file } = fixture(t)
  const versions = versionTree(dir, {
    [NEXT]: "CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (20);",
    [LAST]: 'ALTER TABLE sample ADD COLUMN doubled INTEGER; UPDATE sample SET doubled=value*2;',
  })
  migrate(file, versions)
  read(file, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, LAST)
    assert.deepEqual({ ...db.prepare('SELECT * FROM sample').get() }, { value: 20, doubled: 40 })
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), sequence(1, LAST))
  })
  assert.match(migrate(file, versions), /already current/)
  read(file, (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sample').get()!.n, 1))
})

test('usage backfill skips malformed JSON and non-object reports without losing valid history', (t) => {
  const { dir, file } = fixture(t)
  const store = new Store(file)
  const s = new Session({ id: 's', harness: 'fake', agent: 'a', model: 'm', state: 'idle', cwd: dir }, store)
  s.push({ type: 'turn_started', turnId: 'one' })
  s.push({ type: 'usage', requestId: 'request', inputTokens: 150, outputTokens: 25 })
  s.push({ type: 'turn_completed', turnId: 'one', status: 'completed', reason: 'end_turn', finalText: '' })
  const insert = store.db.prepare("INSERT INTO events(session_id,seq,type,ts,body) VALUES ('s',?,'usage',?,?)")
  for (const [i, body] of ['{broken', 'null', '[]', '"text"'].entries())
    insert.run(100 + i, Date.now(), body)
  store.db.exec('PRAGMA user_version=3; DROP TABLE usage_hours')
  store.close()
  migrate(file)
  read(file, (db) => {
    assert.equal(db.prepare('SELECT SUM(input_tokens) AS n FROM usage_hours').get()!.n, 150)
    assert.equal(db.prepare('SELECT SUM(output_tokens) AS n FROM usage_hours').get()!.n, 25)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 7)
  })
})

test('a failed later step rolls the entire pending chain back and retains a usable backup', (t) => {
  const { dir, file } = fixture(t)
  new Store(file).close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version=3')
  db.close()
  const versions = versionTree(dir, {
    [NEXT]: 'CREATE TABLE partial (value INTEGER); INSERT INTO missing_table VALUES (1);',
  })
  const result = run(file, versions)
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing_table/)
  read(file, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('partial','schema_migrations')").get()!.n, 0)
  })
  assert.equal(fs.readdirSync(path.join(dir, 'migration-backups')).length, 1)
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  fs.writeFileSync(path.join(versions, `v${NEXT}`, 'schema.sql'), 'CREATE TABLE partial (value INTEGER);')
  migrate(file, versions)
})

test('SQL steps cannot commit early, modify schema version, or attach another database', (t) => {
  for (const sql of ['COMMIT;', 'PRAGMA user_version=99;', "ATTACH ':memory:' AS other;"]) {
    const { dir, file } = fixture(t)
    const versions = versionTree(dir, { [NEXT]: `CREATE TABLE partial (id); ${sql}` })
    const result = run(file, versions)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    read(file, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()!.n, 0)
    })
  }
})

test('live data locks, invalid plans, future schemas, aliases and unversioned data are refused', (t) => {
  const { dir, file } = fixture(t)
  new Store(file).close()
  const before = fs.readFileSync(file)
  fs.writeFileSync(path.join(dir, 'daemon.lock'), String(process.pid))
  assert.equal(run(file).status, 1)
  assert.deepEqual(fs.readFileSync(file), before)
  fs.rmSync(path.join(dir, 'daemon.lock'))
  const versions = versionTree(dir)
  fs.writeFileSync(path.join(versions, `v${NEXT}`, 'plan'), 'missing.sql\n')
  assert.equal(run(file, versions).status, 1)
  assert.deepEqual(fs.readFileSync(file), before)
  fs.symlinkSync(file, path.join(dir, 'alias.db'))
  assert.equal(run(path.join(dir, 'alias.db')).status, 1)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version=99')
  assert.equal(run(file).status, 1)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 99)
  db.exec('PRAGMA user_version=-1')
  assert.equal(run(file).status, 1)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, -1)
  db.exec('PRAGMA user_version=0')
  assert.equal(run(file).status, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get()!.n, 0)
  db.close()
})

test('interrupting a data migration rolls back and releases the native lock for a retry', async (t) => {
  const { dir, file } = fixture(t)
  migrate(file)
  const versions = versionTree(dir, {
    [NEXT]: 'CREATE TABLE slow(value); WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100000000) INSERT INTO slow SELECT n FROM numbers;',
  })
  const child = spawn(extensionBinary, ['--db', file, '--migrations', versions, '--backup-dir', path.join(dir, 'backups')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
    if (output.includes(`schema ${NEXT}`)) child.kill('SIGTERM')
  })
  child.stderr.resume()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer)
  assert.equal(code, 1)
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  read(file, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='slow'").get()!.n, 0)
  })
  fs.writeFileSync(path.join(versions, `v${NEXT}`, 'schema.sql'), 'CREATE TABLE slow(value);')
  migrate(file, versions)
})

test('migration hour buckets match live writes across repeated hours and unusual time zones', (t) => {
  const original = process.env.TZ
  try {
    for (const zone of ['UTC', 'America/New_York', 'America/Halifax', 'Australia/Lord_Howe', 'Pacific/Chatham']) {
      process.env.TZ = zone
      const times = [-1, 0, Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z'),
        Date.parse('2026-04-04T15:15:00Z'), Date.parse('2026-10-03T15:35:00Z')]
      const { dir, file } = fixture(t)
      const sql = 'CREATE TABLE hours(at INTEGER,hour INTEGER);' + times.map((at) =>
        `INSERT INTO hours VALUES (${at},local_hour(${at}));`).join('')
      const versions = versionTree(dir, { [NEXT]: sql })
      migrate(file, versions)
      read(file, (db) => {
        for (const row of db.prepare('SELECT * FROM hours').all())
          assert.equal(row.hour, hourOf(Number(row.at)), `${zone}: ${row.at}`)
      })
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})


test('a v4 database runs every pending version once without applying the v6-only correction', (t) => {
  const { dir, file } = fixture(t)
  const store = new Store(file)
  const session = new Session({ id: 's', harness: 'fake', agent: 'a', model: 'm', state: 'idle', cwd: dir }, store)
  session.push({ type: 'turn_started', turnId: 'kept' })
  session.push({ type: 'usage', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 900 })
  session.push({ type: 'turn_completed', turnId: 'kept', status: 'completed', reason: 'end_turn', finalText: 'retained' })
  store.db.exec('DELETE FROM events; DROP TABLE usage_hours; DROP TABLE usage_requests; PRAGMA user_version=4')
  store.close()
  const versions = versionTree(dir, {
    [NEXT]: `CREATE TABLE sequence(value); INSERT INTO sequence VALUES (${NEXT});`,
    [LAST]: 'INSERT INTO sequence SELECT value+1 FROM sequence;',
  })
  const output = migrate(file, versions)
  assert.deepEqual([...output.matchAll(/Migrating database to schema (\d+)/g)].map((m) => Number(m[1])), sequence(5, LAST))
  read(file, (db) => {
    assert.equal(db.prepare('SELECT input_tokens FROM turns').get()!.input_tokens, 1000)
    assert.equal(db.prepare('SELECT SUM(input_tokens) AS n FROM usage_hours').get()!.n, 1000)
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), sequence(5, LAST))
    assert.deepEqual(db.prepare('SELECT value FROM sequence').all().map((r) => r.value), [NEXT, LAST])
  })
  assert.match(migrate(file, versions), /already current/)
})

test('a current database skips older handlers and only records new versions', (t) => {
  const { dir, file } = fixture(t)
  new Store(file).close()
  const versions = versionTree(dir)
  const output = migrate(file, versions)
  assert.deepEqual([...output.matchAll(/Migrating database to schema (\d+)/g)].map((m) => Number(m[1])), [NEXT, LAST])
  read(file, (db) => assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), [NEXT, LAST]))
})

test('missing versions, noncanonical names, missing resources and uncompiled versions fail before opening a DB', (t) => {
  for (const mutate of [
    (versions: string) => fs.rmSync(path.join(versions, 'v5'), { recursive: true }),
    (versions: string) => fs.renameSync(path.join(versions, `v${NEXT}`), path.join(versions, `v0${NEXT}`)),
    (versions: string) => fs.rmSync(path.join(versions, `v${NEXT}`, 'schema.sql')),
    (versions: string) => fs.writeFileSync(path.join(versions, `v${NEXT}`, 'plan'), '../escape.sql\n'),
    (versions: string) => fs.writeFileSync(path.join(versions, `v${NEXT}`, 'plan'), 'schema.sql' + 'x'.repeat(4096)),
  ]) {
    const { dir, file } = fixture(t)
    const versions = versionTree(dir)
    mutate(versions)
    const result = run(file, versions)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  }
  const { dir, file } = fixture(t)
  const versions = versionTree(dir)
  const result = spawnSync(migrationBinary, ['--db', file, '--migrations', versions,
    '--backup-dir', path.join(dir, 'backups')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /compiled engine/)
  assert.equal(fs.existsSync(file), false)
})

test('the build refuses a missing intermediate version and mismatched handler name', (t) => {
  for (const mutate of [
    (versions: string) => fs.rmSync(path.join(versions, 'v5'), { recursive: true }),
    (versions: string) => fs.writeFileSync(path.join(versions, `v${NEXT}`, 'main.cob'), 'PROGRAM-ID. WRONG.'),
  ]) {
    const { dir } = fixture(t)
    const versions = versionTree(dir)
    mutate(versions)
    const result = spawnSync(process.execPath, [path.resolve('release/generate-migrations.mjs'),
      path.join(migrationRoot, 'src'), versions, path.join(dir, 'generated')], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
  }
})

test('the build refuses a package dbVersion that differs from the migration tree', (t) => {
  const { dir } = fixture(t)
  const manifest = path.join(dir, 'package.json')
  for (const dbVersion of [DB_VERSION - 1, DB_VERSION + 1]) {
    fs.writeFileSync(manifest, JSON.stringify({ dbVersion }))
    const result = spawnSync(process.execPath, [path.resolve('release/generate-migrations.mjs'),
      path.join(migrationRoot, 'src'), coreVersions, path.join(dir, 'generated'), manifest], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /dbVersion=.*requires migrations/)
    assert.equal(fs.existsSync(path.join(dir, 'generated')), false)
  }
})

test('a stale migration binary is refused before opening the database', (t) => {
  const { dir, file } = fixture(t)
  const result = spawnSync(migrationBinary, ['--db', file, '--migrations', coreVersions,
    '--backup-dir', path.join(dir, 'backups'), '--target-version', String(DB_VERSION + 1)], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /binary does not match package.json dbVersion/)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
})
