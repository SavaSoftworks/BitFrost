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
import { execFileSync } from 'node:child_process'

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
  BITFROST_DATA_DIR: path.join(home, 'persistent'),
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
  write(path.join(home, 'persistent', 'bitfrost.db'), 'database')
  write(path.join(home, 'persistent', 'bitfrost.db-wal'), 'wal')
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

const no = async () => ({ program: false, config: false, history: false })
const up = (why: string | null = null) => ({ stop: async () => why, running: async () => true })
const config = path.join(home, 'config', 'bitfrost')

test('saying no changes nothing, not even the helper', async () => {
  let stopped = false
  assert.strictEqual(await uninstall({ stop: async () => ((stopped = true), null), running: async () => true }, {}, no), 1)
  assert.ok(!stopped)
  assert.deepStrictEqual(read(calls), [])
  for (const p of [data, link, path.join(home, 'config', 'bitfrost')]) assert.ok(fs.existsSync(p), p)
})

test('yes to BitFrost and no to the config keeps the config', async () => {
  assert.strictEqual(await uninstall(up(), {}, async () => ({ program: true, config: false, history: true })), 0)
  assert.ok(!fs.existsSync(data))
  assert.ok(!fs.existsSync(link))
  assert.ok(fs.existsSync(path.join(config, 'config.json')))
})

test('yes to both removes the config too', async () => {
  assert.strictEqual(await uninstall(up(), {}, async () => ({ program: true, config: true, history: true })), 0)
  assert.ok(!fs.existsSync(data))
  assert.ok(!fs.existsSync(config))
})

test('the plan lists what goes in each group, before anything changes', async () => {
  const { planOf } = await import('../uninstall.ts')
  const plan = planOf()
  assert.deepStrictEqual(plan.program.map((i) => i.label), ['Claude Code plugin', 'Claude Code plugin', 'GLM bridge in ZCode', 'App files', 'Command', 'Model list cache', 'Helper runtime files'])
  assert.deepStrictEqual(plan.history.map((i) => [i.label, i.path]), [['Subagent history and stats', path.join(home, 'persistent', 'bitfrost.db')]])
  assert.ok(plan.history[0].size! > 0)
  assert.deepStrictEqual(plan.program.filter((i) => i.label === 'Claude Code plugin').map((i) => i.path), ['bitfrost@bitfrost from ~/.claude', 'bitfrost@bitfrost from ~/.claude-work'])
  assert.deepStrictEqual(plan.config.map((i) => i.path), [config])
  // ZCode's config file stays; only BitFrost's entry leaves it.
  assert.strictEqual(plan.program.find((i) => i.label === 'GLM bridge in ZCode')!.path, 'from ~/.zcode/cli/config.json')
  assert.ok(plan.program.find((i) => i.label === 'App files')!.size! > 0)
  assert.ok(JSON.parse(fs.readFileSync(zcodeConfig, 'utf8')).plugins.dirs.includes(bridge), 'planning changes nothing')
})

test('--yes with --keep-config keeps the config', async () => {
  assert.strictEqual(await uninstall(up(), { yes: true, keepConfig: true, keepHistory: true }), 0)
  assert.ok(!fs.existsSync(data))
  assert.ok(fs.existsSync(path.join(config, 'config.json')))
})

test('a busy helper stops it before anything changes', async () => {
  assert.strictEqual(await uninstall(up('agents are running'), { yes: true }), 1)
  assert.deepStrictEqual(read(calls), [])
  for (const p of [data, link, path.join(home, 'config', 'bitfrost'), path.join(home, 'run')]) assert.ok(fs.existsSync(p), p)
  assert.ok(JSON.parse(fs.readFileSync(zcodeConfig, 'utf8')).plugins.dirs.includes(bridge))
})

test('everything BitFrost added is removed, from every allowed profile, and nothing else', async () => {
  assert.strictEqual(await uninstall(up(), { yes: true }), 0)
  assert.deepStrictEqual(read(calls), [
    'default plugin uninstall bitfrost@bitfrost --scope user',
    'default plugin marketplace remove bitfrost',
    `${other} plugin uninstall bitfrost@bitfrost --scope user`,
    `${other} plugin marketplace remove bitfrost`,
  ])
  for (const p of [data, path.join(home, 'persistent'), link, path.join(home, 'config', 'bitfrost'), path.join(home, 'cache', 'bitfrost'), path.join(home, 'run'), `${zcodeConfig}.bak-bitfrost`, cacheCopy(path.join(home, '.claude')), cacheCopy(other)]) {
    assert.ok(!fs.existsSync(p), `${p} is gone`)
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(zcodeConfig, 'utf8')), { theme: 'dark', plugins: { dirs: ['/somewhere/else'] } })
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')), 'Claude settings are left alone')
  for (const p of [path.join(home, '.claude'), other]) assert.ok(fs.existsSync(p), `${p} stays`)
})

test('running it again finds nothing to do and still succeeds', async () => {
  assert.strictEqual(await uninstall(up(), { yes: true }), 0)
  fs.rmSync(calls)
  // The config is gone now, so only the default profile is left to check.
  assert.strictEqual(await uninstall(up(), { yes: true }), 0)
  assert.deepStrictEqual(read(calls), ['default plugin uninstall bitfrost@bitfrost --scope user', 'default plugin marketplace remove bitfrost'])
})

test('a bitfrost command that is not ours is kept', async () => {
  fs.rmSync(link)
  fs.symlinkSync('/opt/someone-elses/bitfrost', link)
  assert.strictEqual(await uninstall(up(), { yes: true }), 0)
  assert.strictEqual(fs.readlinkSync(link), '/opt/someone-elses/bitfrost')
})

test('a helper that is not running is not stopped', async () => {
  let stopped = false
  assert.strictEqual(await uninstall({ stop: async () => ((stopped = true), null), running: async () => false }, { yes: true }), 0)
  assert.ok(!stopped)
  assert.ok(!fs.existsSync(data))
})

test('with only the config left, the one question is about the config', async () => {
  assert.strictEqual(await uninstall(up(), { yes: true, keepConfig: true }), 0)
  assert.ok(!fs.existsSync(path.join(home, 'persistent', 'bitfrost.db')), '--yes alone removes history too')
  let asked: any = null
  assert.strictEqual(await uninstall(up(), {}, async (plan) => ((asked = plan), { program: false, config: true, history: true })), 0)
  assert.deepStrictEqual(asked.program, [])
  assert.ok(!fs.existsSync(config))
  // Nothing left at all: no question, nothing to do.
  assert.strictEqual(await uninstall(up(), {}, async () => { throw new Error('asked') }), 0)
})

test('saying no to history keeps the database and its stats, and only that', async () => {
  write(path.join(home, 'persistent', 'crush', 'task', 'crush.db'), 'task')
  assert.strictEqual(await uninstall(up(), {}, async () => ({ program: true, config: true, history: false })), 0)
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'persistent')).sort(), ['bitfrost.db', 'bitfrost.db-wal'])
  assert.ok(!fs.existsSync(data))
  // With BitFrost gone, history is what's left to ask about.
  let asked: any = null
  assert.strictEqual(await uninstall(up(), {}, async (plan) => ((asked = plan), { program: false, config: false, history: true })), 0)
  assert.deepStrictEqual([asked.program, asked.config, asked.history.length], [[], [], 1])
  assert.ok(!fs.existsSync(path.join(home, 'persistent')))
})

test('--yes with --keep-history keeps only the history', async () => {
  assert.strictEqual(await uninstall(up(), { yes: true, keepHistory: true }), 0)
  assert.ok(fs.existsSync(path.join(home, 'persistent', 'bitfrost.db')))
  assert.ok(!fs.existsSync(config))
  assert.ok(!fs.existsSync(data))
})

test('history inside the app folder (the Linux default) survives removing the app files', async () => {
  const { spawnSync } = await import('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-uninstall-same-'))
  const shared = path.join(root, 'data', 'bitfrost')
  write(path.join(shared, 'bitfrost.db'), 'database')
  write(path.join(shared, 'versions', '0.9.1', 'x'), '')
  write(path.join(shared, 'zcode-plugin', 'hook'), '')
  const script = `const { uninstall } = await import(${JSON.stringify(new URL('../uninstall.ts', import.meta.url).href)});
    process.exit(await uninstall({ stop: async () => null, running: async () => false }, { yes: true, keepHistory: true }))`
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), BITFROST_RUNTIME_DIR: path.join(root, 'run'), BITFROST_BIN_DIR: path.join(root, 'bin') }
  delete env.BITFROST_DATA_DIR
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env, encoding: 'utf8' })
  try {
    assert.strictEqual(r.status, 0, r.stderr)
    assert.deepStrictEqual(fs.readdirSync(shared), ['bitfrost.db'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test('--keep-history protects a database nested several directories beneath the app files', () => {
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-nested-history-'))
  const app = path.join(nested, 'data', 'bitfrost')
  const persistent = path.join(app, 'state', 'history')
  const cfg = path.join(nested, 'config', 'bitfrost', 'config.json')
  for (const keepConfig of [false, true]) {
    for (const suffix of ['', '-wal', '-shm']) write(path.join(persistent, `bitfrost.db${suffix}`), `history${suffix}`)
    write(path.join(app, 'versions', 'installed'), 'app')
    write(path.join(app, 'state', 'cache'), 'cache')
    write(path.join(persistent, 'other'), 'cache')
    write(cfg, '{}')
    const code = `const {uninstall}=await import(${JSON.stringify(new URL('../uninstall.ts', import.meta.url).href)}); process.exitCode=await uninstall({running:async()=>false,stop:async()=>null},{yes:true,keepHistory:true,keepConfig:${keepConfig}})`
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env: {
      ...process.env, HOME: nested, PATH: '/nonexistent', SHELL: '/bin/false',
      XDG_DATA_HOME: path.join(nested, 'data'), XDG_CONFIG_HOME: path.join(nested, 'config'), XDG_CACHE_HOME: path.join(nested, 'cache'),
      BITFROST_DATA_DIR: persistent, BITFROST_RUNTIME_DIR: path.join(nested, 'run'), BITFROST_BIN_DIR: path.join(nested, 'bin'),
    }, stdio: 'pipe' })
    for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.readFileSync(path.join(persistent, `bitfrost.db${suffix}`), 'utf8'), `history${suffix}`)
    for (const removed of [path.join(app, 'versions'), path.join(app, 'state', 'cache'), path.join(persistent, 'other')]) assert.equal(fs.existsSync(removed), false)
    assert.equal(fs.existsSync(cfg), keepConfig)
  }
  fs.rmSync(nested, { recursive: true, force: true })
})
