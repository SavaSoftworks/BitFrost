// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for bitfrost uninstall, in a throwaway home with a fake claude.
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-uninstall-test-'))
const fakeBin = path.join(home, 'fake-bin')
const calls = path.join(home, 'claude-calls')
Object.assign(process.env, {
  HOME: home,
  PATH: `${fakeBin}:/usr/bin:/bin`,
  SHELL: '/bin/false',
  XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  BITFROST_RUNTIME_DIR: path.join(home, 'run'),
  BITFROST_BIN_DIR: path.join(home, 'bin'),
})
delete process.env.CLAUDE_CONFIG_DIR
// Claude answers "not found" for anything it was already told to remove.
fs.mkdirSync(fakeBin)
fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\necho "\${CLAUDE_CONFIG_DIR:-default} $*" >> '${calls}'\ngrep -qxF "$*" '${calls}.done' 2>/dev/null && { echo "not found"; exit 1; }\necho "$*" >> '${calls}.done'\n`, { mode: 0o755 })

const { uninstall } = await import('../uninstall.ts')

const data = path.join(home, 'data', 'bitfrost')
const link = path.join(home, 'bin', 'bitfrost')
const zcodeConfig = path.join(home, '.zcode', 'cli', 'config.json')
const bridge = path.join(data, 'zcode-plugin')
const other = path.join(home, '.claude-work')
const cacheCopy = (profile: string) => path.join(profile, 'plugins', 'cache', 'bitfrost')
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [])
const write = (f: string, body: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body)
}

beforeEach(() => {
  for (const f of [calls, `${calls}.done`]) fs.rmSync(f, { force: true })
  write(path.join(data, 'versions', '0.8.3', 'plugins', 'bitfrost', 'bin', 'bitfrostd'), '')
  fs.rmSync(path.join(data, 'current'), { force: true })
  fs.symlinkSync('versions/0.8.3', path.join(data, 'current'))
  write(path.join(bridge, 'hook'), '')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.rmSync(link, { force: true })
  fs.symlinkSync(`${data}/current/plugins/bitfrost/bin/bitfrostd`, link)
  write(path.join(home, 'config', 'bitfrost', 'config.json'), JSON.stringify({ allowedProfiles: ['~/.claude', other] }))
  write(path.join(home, 'cache', 'bitfrost', 'agents.json'), '{}')
  write(path.join(home, 'run', 'bitfrostd.log'), '')
  write(zcodeConfig, JSON.stringify({ theme: 'dark', plugins: { dirs: ['/somewhere/else', bridge] } }))
  write(`${zcodeConfig}.bak-bitfrost`, '{}')
  for (const p of [path.join(home, '.claude'), other]) write(path.join(cacheCopy(p), 'bitfrost', '0.8.3', '.orphaned_at'), '')
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }))
})

test('saying no changes nothing, not even the helper', async () => {
  let stopped = false
  assert.strictEqual(await uninstall(async () => ((stopped = true), null), false, async () => false), 1)
  assert.ok(!stopped)
  assert.deepStrictEqual(read(calls), [])
  for (const p of [data, link, path.join(home, 'config', 'bitfrost')]) assert.ok(fs.existsSync(p), p)
})

test('saying yes goes ahead', async () => {
  assert.strictEqual(await uninstall(async () => null, false, async () => true), 0)
  assert.ok(!fs.existsSync(data))
})

test('a busy helper stops it before anything changes', async () => {
  assert.strictEqual(await uninstall(async () => 'agents are running', true), 1)
  assert.deepStrictEqual(read(calls), [])
  for (const p of [data, link, path.join(home, 'config', 'bitfrost'), path.join(home, 'run')]) assert.ok(fs.existsSync(p), p)
  assert.ok(JSON.parse(fs.readFileSync(zcodeConfig, 'utf8')).plugins.dirs.includes(bridge))
})

test('everything BitFrost added is removed, from every allowed profile, and nothing else', async () => {
  assert.strictEqual(await uninstall(async () => null, true), 0)
  assert.deepStrictEqual(read(calls), [
    'default plugin uninstall bitfrost@bitfrost --scope user',
    'default plugin marketplace remove bitfrost',
    `${other} plugin uninstall bitfrost@bitfrost --scope user`,
    `${other} plugin marketplace remove bitfrost`,
  ])
  for (const p of [data, link, path.join(home, 'config', 'bitfrost'), path.join(home, 'cache', 'bitfrost'), path.join(home, 'run'), `${zcodeConfig}.bak-bitfrost`, cacheCopy(path.join(home, '.claude')), cacheCopy(other)]) {
    assert.ok(!fs.existsSync(p), `${p} is gone`)
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(zcodeConfig, 'utf8')), { theme: 'dark', plugins: { dirs: ['/somewhere/else'] } })
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')), 'Claude settings are left alone')
})

test('running it again finds nothing to do and still succeeds', async () => {
  assert.strictEqual(await uninstall(async () => null, true), 0)
  fs.rmSync(calls)
  // The config is gone now, so only the default profile is left to check.
  assert.strictEqual(await uninstall(async () => null, true), 0)
  assert.deepStrictEqual(read(calls), ['default plugin uninstall bitfrost@bitfrost --scope user', 'default plugin marketplace remove bitfrost'])
})

test('a bitfrost command that is not ours is kept', async () => {
  fs.rmSync(link)
  fs.symlinkSync('/opt/someone-elses/bitfrost', link)
  assert.strictEqual(await uninstall(async () => null, true), 0)
  assert.strictEqual(fs.readlinkSync(link), '/opt/someone-elses/bitfrost')
})
