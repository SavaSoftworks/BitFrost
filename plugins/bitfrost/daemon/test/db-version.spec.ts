// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DB_VERSION, readDbVersion } from '../db-version.ts'
import { Store } from '../store.ts'

test('the source store uses dbVersion from the root package', () => {
  assert.equal(DB_VERSION, JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).dbVersion)
  const store = new Store(':memory:')
  try {
    assert.equal(store.degraded, false, store.error ?? '')
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, DB_VERSION)
  } finally { store.close() }
})

test('invalid or missing dbVersion is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-db-version-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'package.json')
  for (const dbVersion of [undefined, null, '8', 0, -1, 1.5, 257]) {
    fs.writeFileSync(file, JSON.stringify({ dbVersion }))
    assert.throws(() => readDbVersion(file), /dbVersion must be an integer/)
  }
})

test('a standalone plugin uses bundled package metadata to select its schema snapshot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-plugin-version-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plugin = path.join(dir, 'plugins', 'bitfrost')
  const daemon = path.join(plugin, 'daemon')
  const target = DB_VERSION + 1
  const schema = path.join(plugin, 'migrations', 'versions', `v${target}`)
  fs.mkdirSync(daemon, { recursive: true })
  fs.mkdirSync(schema, { recursive: true })
  for (const name of ['store.ts', 'db-version.ts'])
    fs.copyFileSync(new URL(`../${name}`, import.meta.url), path.join(daemon, name))
  for (const name of ['schema.sql', 'indexes.sql'])
    fs.copyFileSync(new URL(`../../migrations/versions/v${DB_VERSION}/${name}`, import.meta.url), path.join(schema, name))
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module', dbVersion: target }))
  const script = `import { Store } from ${JSON.stringify(pathToFileURL(path.join(daemon, 'store.ts')).href)};
const store = new Store(':memory:');
if (store.degraded) throw new Error(store.error);
console.log(store.db.prepare('PRAGMA user_version').get().user_version);
store.close();`
  const run = () => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(Number(result.stdout.trim()), target)
  }
  run()
  // A cache's surrounding package must not override the bundled release.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dbVersion: DB_VERSION }))
  run()
})
