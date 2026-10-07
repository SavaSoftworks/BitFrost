// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for config.json checking, the helper's lock file, and the agent
// descriptions registry.ts writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { configKey, loadConfig, takeLock, validateConfig } from '../config.ts'
import { buildAgents, describe } from '../registry.ts'

const KNOWN = ['codex', 'zcode', 'opencode']

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-config-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a well-formed config has no errors or warnings', () => {
  const cfg = {
    allowedProfiles: ['~/.claude'],
    providers: { codex: { bin: '/usr/bin/codex', enabled: true }, zcode: { dir: '/opt/ZCode' }, opencode: { enabled: true, models: ['deepseek/*'] } },
  }
  assert.deepStrictEqual(validateConfig(cfg, KNOWN), { errors: [], warnings: [] })
  assert.deepStrictEqual(validateConfig({}, KNOWN), { errors: [], warnings: [] })
})

test('each wrong shape is an error', () => {
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [null, /JSON object/],
    [{ allowedProfiles: '~/.claude' }, /allowedProfiles must be a list of strings/],
    [{ allowedProfiles: [1] }, /allowedProfiles must be a list of strings/],
    [{ providers: [] }, /providers must be an object/],
    [{ providers: { codex: true } }, /providers\.codex must be an object/],
    [{ providers: { codex: { enabled: 'yes' } } }, /providers\.codex\.enabled must be true or false/],
    [{ providers: { opencode: { models: 'deepseek/*' } } }, /providers\.opencode\.models must be a list of strings/],
    [{ providers: { codex: { bin: 42 } } }, /providers\.codex\.bin must be a string/],
    [{ providers: { zcode: { dir: ['/opt'] } } }, /providers\.zcode\.dir must be a string/],
    [{ codexBin: false }, /codexBin must be a string/],
  ]
  for (const [cfg, expected] of cases) {
    const { errors } = validateConfig(cfg, KNOWN)
    assert.strictEqual(errors.length, 1, JSON.stringify(cfg))
    assert.match(errors[0], expected)
  }
})

test('unknown provider ids and keys are warnings, not errors', () => {
  const r = validateConfig({ allowedProfile: [], providers: { opencod: { enabled: true } } }, KNOWN)
  assert.deepStrictEqual(r.errors, [])
  assert.strictEqual(r.warnings.length, 2)
  assert.match(r.warnings.join('\n'), /unknown key allowedProfile/)
  assert.match(r.warnings.join('\n'), /unknown provider opencod/)
})

test('loadConfig: a missing file is the defaults, a broken one an error naming the file', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'config.json')

  const missing = loadConfig(file)
  assert.strictEqual(missing.error, null)
  assert.deepStrictEqual(missing.providers, {})
  assert.strictEqual(missing.allowedProfiles.length, 1)

  fs.writeFileSync(file, '{"providers": ')
  const broken = loadConfig(file)
  assert.ok(broken.error?.startsWith(`${file} is invalid: `), broken.error ?? '')
  assert.deepStrictEqual(broken.providers, {})

  fs.writeFileSync(file, JSON.stringify({ providers: { codex: { enabled: 'no' } } }))
  assert.match(loadConfig(file).error ?? '', /providers\.codex\.enabled must be true or false/)

  fs.writeFileSync(file, JSON.stringify({ allowedProfiles: [dir], providers: { codex: { bin: '/x' } }, codexBin: '/old' }))
  const good = loadConfig(file)
  assert.strictEqual(good.error, null)
  assert.deepStrictEqual(good.allowedProfiles, [fs.realpathSync(dir)])
  assert.deepStrictEqual(good.providers.codex, { bin: '/x' }) // the newer key wins
})

test('configKey follows the providers part of the config only', () => {
  const base = { allowedProfiles: [], providers: { codex: { enabled: true } }, error: null, warnings: [] }
  assert.strictEqual(configKey(base), configKey({ ...base, allowedProfiles: ['/elsewhere'] }))
  assert.notStrictEqual(configKey(base), configKey({ ...base, providers: { codex: { enabled: true, models: ['gpt-*'] } } }))
})

test('takeLock: one holder at a time, and a lock left empty or by a dead helper is taken over', (t) => {
  const dir = tempDir(t)
  const lock = path.join(dir, 'bitfrostd.lock')

  assert.strictEqual(takeLock(lock), true)
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid))
  assert.strictEqual(takeLock(lock), true) // already ours
  assert.deepStrictEqual(fs.readdirSync(dir), ['bitfrostd.lock']) // no temp file left behind

  fs.writeFileSync(lock, String(process.ppid))
  assert.strictEqual(takeLock(lock), false)
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.ppid))

  // Empty, garbage, 0, -1 and a dead pid are all stale; kill(0, 0) would signal our own group.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!
  for (const left of ['', 'garbage', '0', '-1', String(dead)]) {
    fs.writeFileSync(lock, left)
    assert.strictEqual(takeLock(lock), true, `lock holding ${JSON.stringify(left)}`)
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid))
  }
})

test('describe leaves out the alias sentence when a model has no aliases', () => {
  const [agent] = buildAgents([
    { harness: 'codex', harnessName: 'Codex', provider: 'OpenAI', model: 'gpt-x', displayName: 'GPT-X', description: 'A model.', efforts: [], defaultEffort: null, isDefault: true },
  ])
  assert.ok(agent.aliases.length > 0)
  assert.match(describe(agent, [agent]), /Users may call it "/)

  const bare = { ...agent, aliases: [] }
  const text = describe(bare, [bare])
  assert.doesNotMatch(text, /Users may call it/)
  assert.doesNotMatch(text, /\s\./)
  assert.strictEqual(text, "GPT-X, OpenAI's model gpt-x, running in the real Codex app on this machine. A model. Works in the task's directory and can read, edit and run commands there.")
})


test('retention defaults, overrides and invalid shapes are checked', (t) => {
  const file = path.join(tempDir(t),'config.json')
  assert.deepEqual(loadConfig(file).retention,{ eventsDays:30,messagesDays:180 })
  fs.writeFileSync(file,JSON.stringify({ retention:{ eventsDays:2,messagesDays:10 } }))
  assert.deepEqual(loadConfig(file).retention,{ eventsDays:2,messagesDays:10 })
  for (const value of [[],{ eventsDays:-1 },{ messagesDays:'forever' }]) assert.ok(validateConfig({ retention:value }).errors.length)
  assert.deepEqual(validateConfig({ retention:{ eventsDays:0,messagesDays:180 } }).warnings,[])
})
