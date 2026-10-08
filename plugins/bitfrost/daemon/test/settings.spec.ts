// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findFeature, type Feature } from '../features.ts'
import { NEED_TERMINAL, setupFeatures } from '../settings.ts'
import { fakeTerminal } from './fake-terminal.ts'

const handback = findFeature('handback')!
const DAEMON = fileURLToPath(new URL('../bitfrostd.ts', import.meta.url))

function tempConfig(t: TestContext, contents: string | Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-settings-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode: 0o600 })
  return { dir, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('setupFeatures declines once, skips the model, and --new is quiet thereafter', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t, { providers: { codex: { enabled: true } } })
  const fake = fakeTerminal(t, ['n\r'])
  assert.equal(await setupFeatures({ file: config.file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(config.read(), { providers: { codex: { enabled: true } }, handback: { enabled: false, effort: 'low' } })
  assert.doesNotMatch(fake.plainText(), /Which model/)
  assert.deepEqual(fake.rawModes, [true, false])
  assert.equal(fake.closed(), 1)
  const log = t.mock.method(console, 'log', () => {})
  const error = t.mock.method(console, 'error', () => {})
  assert.equal(await setupFeatures({ file: config.file, newOnly: true, terminal: () => {
    assert.fail('an answered setting must not open a terminal')
  } }), 0)
  assert.equal(log.mock.callCount(), 0)
  assert.equal(error.mock.callCount(), 0)
})

test('setupFeatures saves yes plus arrow-down as the chosen family, preserving keys and mode', { timeout: 2000 }, async (t) => {
  const other = { providers: { codex: { bin: '/custom/codex', models: ['gpt-*'] } }, allowedProfiles: ['/profile'], retention: { eventsDays: 8 }, custom: { keep: true } }
  const config = tempConfig(t, other)
  fs.chmodSync(config.file, 0o640)
  const fake = fakeTerminal(t, ['y\r', '\x1b[B\r'])
  assert.equal(await setupFeatures({ file: config.file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(config.read(), { ...other, handback: { enabled: true, model: 'opus', effort: 'low' } })
  assert.equal(fs.statSync(config.file).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(config.dir), ['config.json'])
  assert.deepEqual(fake.rawModes, [true, false, true, false])
  assert.equal(fake.closed(), 1)
})

test('setupFeatures re-reads before saving and keeps edits made while questions are open', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t, { providers: { codex: { bin: '/old' } } })
  const edited = { providers: { codex: { bin: '/new' }, zcode: { enabled: false } }, retention: { messagesDays: 12 } }
  const fake = fakeTerminal(t, ['y\r', '\r'], (question) => {
    if (question === 1) fs.writeFileSync(config.file, JSON.stringify(edited))
  })
  assert.equal(await setupFeatures({ file: config.file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(config.read(), { ...edited, handback: { enabled: true, model: 'sonnet', effort: 'low' } })
})

test('explicit features re-ask an already declined handback', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t, { handback: { enabled: false }, providers: {} })
  const fake = fakeTerminal(t, ['y\r', '\r'])
  assert.equal(await setupFeatures({ features: [handback], file: config.file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(config.read(), { handback: { enabled: true, model: 'sonnet', effort: 'low' }, providers: {} })
})

test('pending settings without a terminal return NEED_TERMINAL (3), quietly for --new', async (t) => {
  const config = tempConfig(t)
  const original = fs.readFileSync(config.file, 'utf8')
  const log = t.mock.method(console, 'log', () => {})
  const error = t.mock.method(console, 'error', () => {})
  assert.equal(NEED_TERMINAL, 3)
  assert.equal(await setupFeatures({ newOnly: true, file: config.file, terminal: () => null }), 3)
  assert.equal(log.mock.callCount(), 0)
  assert.equal(error.mock.callCount(), 0)
  assert.equal(await setupFeatures({ file: config.file, terminal: () => null }), 3)
  assert.equal(error.mock.callCount(), 1)
  assert.equal(fs.readFileSync(config.file, 'utf8'), original)
})

test('Ctrl+C or Ctrl+D at either question returns 130 and saves nothing for that feature', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t, { providers: { codex: { enabled: true } }, handback: { enabled: false } })
  const original = fs.readFileSync(config.file, 'utf8')
  for (const key of ['\x03', '\x04']) {
    for (const replies of [[key], ['y\r', key]]) {
      const fake = fakeTerminal(t, replies)
      assert.equal(await setupFeatures({ features: [handback], file: config.file, terminal: () => fake.terminal }), 130)
      assert.equal(fs.readFileSync(config.file, 'utf8'), original)
      assert.equal(fake.closed(), 1)
      assert.equal(fake.rawModes.at(-1), false)
      assert.deepEqual(fs.readdirSync(config.dir), ['config.json'])
    }
  }
})

test('cancelling a later feature preserves earlier saved answers', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t)
  const first: Feature = { ...handback, id: 'first', key: 'first', questions: [handback.questions[0]] }
  const fake = fakeTerminal(t, ['n\r', 'y\r', '\x03'])
  assert.equal(await setupFeatures({ features: [first, handback], file: config.file, terminal: () => fake.terminal }), 130)
  assert.deepEqual(config.read(), { first: { enabled: false, effort: 'low' } })
  assert.equal(fake.closed(), 1)
})

test('invalid JSON or a non-object returns 1 before opening a terminal and writes nothing', async (t) => {
  const config = tempConfig(t)
  for (const invalid of ['{"providers":', 'null', '[]', '"text"']) {
    fs.writeFileSync(config.file, invalid)
    assert.equal(await setupFeatures({ file: config.file, terminal: () => {
      assert.fail('invalid config must not open a terminal')
    } }), 1)
    assert.equal(fs.readFileSync(config.file, 'utf8'), invalid)
    assert.deepEqual(fs.readdirSync(config.dir), ['config.json'])
  }
})

test('a config made invalid while asking is not overwritten when saving', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t)
  const invalid = '{"being-edited":'
  const fake = fakeTerminal(t, ['y\r', '\r'], (question) => {
    if (question === 1) fs.writeFileSync(config.file, invalid)
  })
  assert.equal(await setupFeatures({ file: config.file, terminal: () => fake.terminal }), 1)
  assert.equal(fs.readFileSync(config.file, 'utf8'), invalid)
  assert.equal(fake.closed(), 1)
  assert.deepEqual(fs.readdirSync(config.dir), ['config.json'])
})

test('a feature with no choice options remains pending and saves no partial answers', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t)
  const feature: Feature = { ...handback, questions: handback.questions.map((q) => q.type === 'choice' ? { ...q, options: [] } : q) }
  const fake = fakeTerminal(t, ['y\r'])
  assert.equal(await setupFeatures({ features: [feature], file: config.file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(config.read(), {})
  assert.equal(fake.closed(), 1)
})

test('setupFeatures creates a missing config and parent directories with private permissions', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t)
  const file = path.join(config.dir, 'nested', 'bitfrost', 'config.json')
  const fake = fakeTerminal(t, ['\r'])
  assert.equal(await setupFeatures({ file, terminal: () => fake.terminal }), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { handback: { enabled: false, effort: 'low' } })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

function cli(dir: string, args: string[]) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON, ...args], {
    detached: true, stdio: 'ignore', timeout: 10_000,
    env: {
      ...process.env, HOME: dir, NO_COLOR: '1',
      XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'),
      BITFROST_RUNTIME_DIR: path.join(dir, 'run'), BITFROST_DATA_DIR: path.join(dir, 'data', 'bitfrost'),
    },
  })
}

test('CLI setup --new exits 3 in a detached child with no terminal and a temporary XDG_CONFIG_HOME', (t) => {
  const config = tempConfig(t)
  const result = cli(config.dir, ['setup', '--new'])
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 3)
  assert.ok(!fs.existsSync(path.join(config.dir, 'config', 'bitfrost', 'config.json')))
})

test('CLI setup alone handles pending settings and setup handback re-asks an answered feature', (t) => {
  const config = tempConfig(t)
  const pending = cli(config.dir, ['setup'])
  assert.ifError(pending.error)
  assert.equal(pending.status, 3)
  const file = path.join(config.dir, 'config', 'bitfrost', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = '{"handback":{"enabled":false}}\n'
  fs.writeFileSync(file, original)
  for (const [args, expected] of [[['setup'], 0], [['setup', '--new'], 0], [['setup', 'handback'], 3]] as [string[], number][]) {
    const result = cli(config.dir, args)
    assert.ifError(result.error)
    assert.equal(result.status, expected, args.join(' '))
    assert.equal(fs.readFileSync(file, 'utf8'), original)
  }
})

test('CLI setup zcode still runs provider setup in an isolated home', (t) => {
  const config = tempConfig(t)
  const result = cli(config.dir, ['setup', 'zcode'])
  assert.ifError(result.error)
  assert.equal(result.status, 0)
  const bridge = path.join(config.dir, 'data', 'bitfrost', 'zcode-plugin')
  const zcode = JSON.parse(fs.readFileSync(path.join(config.dir, '.zcode', 'cli', 'config.json'), 'utf8'))
  assert.deepEqual(zcode.plugins.dirs, [bridge])
  const sourceHook = fileURLToPath(new URL('../../zcode-plugin/hook.mjs', import.meta.url))
  assert.equal(fs.readFileSync(path.join(bridge, 'hook.mjs'), 'utf8'), fs.readFileSync(sourceHook, 'utf8'))
  assert.ok(!fs.existsSync(path.join(config.dir, 'config', 'bitfrost', 'config.json')))
})

test('saving keeps a group-writable mode the umask would narrow', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t)
  fs.chmodSync(config.file, 0o660)
  const umask = process.umask(0o022)
  t.after(() => process.umask(umask))
  const fake = fakeTerminal(t, ['n\r'])
  assert.equal(await setupFeatures({ file: config.file, terminal: () => fake.terminal }), 0)
  assert.equal(fs.statSync(config.file).mode & 0o777, 0o660)
})

test('saving through a symlinked config writes the linked file and keeps the link', { timeout: 2000 }, async (t) => {
  const config = tempConfig(t, { allowedProfiles: ['/profile'] })
  const link = path.join(config.dir, 'linked.json')
  fs.symlinkSync(config.file, link)
  const fake = fakeTerminal(t, ['n\r'])
  assert.equal(await setupFeatures({ file: link, terminal: () => fake.terminal }), 0)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.deepEqual(config.read(), { allowedProfiles: ['/profile'], handback: { enabled: false, effort: 'low' } })
})
