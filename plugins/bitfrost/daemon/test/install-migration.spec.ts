// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrationBinary, migrationRoot } from './migrate.ts'
import { Store } from '../store.ts'
import { Session } from '../session.ts'

const installer = fileURLToPath(new URL('../../../../release/install.sh', import.meta.url))
const plugin = fileURLToPath(new URL('../../', import.meta.url))
const version = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')).version

function fixture(t: any, corruption?: 'plan' | 'version', releaseVersion = version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-install-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), data = path.join(home, 'custom database')
  const stage = path.join(root, `bitfrost-${releaseVersion}`)
  const installed = path.join(home, '.local', 'share', 'bitfrost')
  fs.mkdirSync(data, { recursive: true })
  const dest = path.join(stage, 'plugins', 'bitfrost')
  fs.cpSync(plugin, dest, { recursive: true, filter: (file) =>
    ![path.join(migrationRoot, 'build'), path.join(plugin, 'daemon', 'test'),
      path.join(plugin, '.claude-plugin', 'types')].some((skip) => file === skip) })
  const manifest = path.join(dest, '.claude-plugin', 'plugin.json')
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: releaseVersion }))
  // Avoid network requests for the optional TUI in these offline installer tests.
  fs.mkdirSync(path.join(stage, 'tui', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'tui', 'bin', 'bitfrost-tui'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (corruption === 'plan') fs.writeFileSync(path.join(dest, 'migrations', 'versions', 'v8', 'plan'), 'missing.sql\n')
  if (corruption === 'version') fs.rmSync(path.join(dest, 'migrations', 'versions', 'v1'), { recursive: true })
  const tarball = path.join(root, `bitfrost-${releaseVersion}.tar.gz`)
  const tar = spawnSync('tar', ['-czf', tarball, '-C', root, `bitfrost-${releaseVersion}`], { encoding: 'utf8' })
  assert.ifError(tar.error)
  assert.equal(tar.status, 0, tar.stderr)
  const platform = process.platform === 'darwin' ? 'darwin-universal' : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const name = `bitfrost-migrate-${releaseVersion}-${platform}`
  fs.copyFileSync(migrationBinary, path.join(root, name))
  fs.writeFileSync(path.join(root, name + '.sha256'), `${createHash('sha256').update(fs.readFileSync(migrationBinary)).digest('hex')}  ${name}\n`)
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'), BITFROST_BIN_DIR: path.join(home, '.local', 'bin'),
    BITFROST_DATA_DIR: data, BITFROST_RUNTIME_DIR: path.join(root, 'run'),
    BITFROST_BACKUP_DIR: path.join(home, 'backups'), BITFROST_NODE: process.execPath }
  delete env.BITFROST_MIGRATOR
  const file = path.join(data, 'bitfrost.db')
  return { root, home, data, file, installed, stage, tarball, env }
}
async function install(run: ReturnType<typeof fixture>) {
  const child = spawn('sh', [installer, '--from', run.tarball, '--no-plugin'], { env: run.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => output += data)
  child.stderr.on('data', (data) => output += data)
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { status, output }
}

test('install.sh replaces a cached version with the explicitly supplied local build', async (t) => {
  const run = fixture(t)
  run.env.BITFROST_DEFER_SETTINGS = '1'
  const first = await install(run)
  assert.equal(first.status, 0, first.output)
  const root = path.join(run.installed, 'current')
  const registry = path.join(root, 'plugins', 'bitfrost', 'daemon', 'features.ts')
  const tui = path.join(root, 'tui', 'bin', 'bitfrost-tui')
  const original = fs.readFileSync(registry, 'utf8')
  fs.appendFileSync(registry, '\n// Cached build from before the settings wizard.\n')
  fs.writeFileSync(tui, '#!/bin/sh\nexit 1\n')
  const repeat = await install(run)
  assert.equal(repeat.status, 0, repeat.output)
  assert.equal(fs.readFileSync(registry, 'utf8'), original, 'local source replaces the cached plugin')
  assert.equal(fs.readFileSync(tui, 'utf8'), '#!/bin/sh\nexit 0\n', 'local TUI replaces the cached binary')
  assert.match(repeat.output, /Reinstalled BitFrost/)
})

test('installer events defer setup even when an older TUI does not set the defer flag', async (t) => {
  const run = fixture(t)
  run.env.BITFROST_INSTALL_EVENTS = '1'
  run.env.BITFROST_DEFER_SETTINGS = '0'
  const entry = path.join(run.stage, 'plugins', 'bitfrost', 'bin', 'bitfrostd')
  fs.renameSync(entry, entry + '.real')
  fs.writeFileSync(entry, `#!/bin/sh
if [ "\${1:-}" = setup ]; then
  printf '%s' "\${BITFROST_DEFER_SETTINGS:-}" > "$HOME/setup-deferred"
fi
exec "$(dirname "$(readlink -f "$0")")/bitfrostd.real" "$@"
`, { mode: 0o755 })
  const tar = spawnSync('tar', ['-czf', run.tarball, '-C', run.root, path.basename(run.stage)], { encoding: 'utf8' })
  assert.ifError(tar.error)
  assert.equal(tar.status, 0, tar.stderr)
  const result = await install(run)
  assert.equal(result.status, 0, result.output)
  assert.equal(fs.readFileSync(path.join(run.home, 'setup-deferred'), 'utf8'), '1')
  assert.match(result.output, /New settings.*configure in the TUI/)
})

test('same-source 0.9.1 -> 0.9.2 install defers four settings and the installed broker confirms them', async (t) => {
  const old = fixture(t, undefined, '0.9.1')
  const configFile = path.join(old.env.XDG_CONFIG_HOME, 'bitfrost', 'config.json')
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, '{"handback":{"enabled":false},"settingsUpToDate":true}')
  old.env.BITFROST_DEFER_SETTINGS = '1'
  old.env.BITFROST_INSTALL_EVENTS = '1'
  const first = await install(old)
  assert.equal(first.status, 0, first.output)
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).settingsUpToDate, true)
  assert.equal(fs.readlinkSync(path.join(old.installed, 'current')), 'versions/0.9.1')
  const current = fixture(t)
  const upgraded = await install({ ...old, tarball: current.tarball })
  assert.equal(upgraded.status, 0, upgraded.output)
  assert.match(upgraded.output, /New settings.*configure in the TUI/)
  const pending = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(pending.settingsUpToDate, false)
  assert.equal(pending.previewAppearance, undefined)
  const daemon = path.join(old.installed, 'current', 'plugins', 'bitfrost', 'daemon', 'bitfrostd.ts')
  const rpc = (method: string, params = {}) => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', daemon, 'tui-rpc'], {
      env: old.env, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ id: 1, method, params }) + '\n',
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const response = result.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((m) => m.id === 1)
    assert.equal(response.error, undefined, JSON.stringify(response))
    return response.result
  }
  const plan = rpc('settings.pending')
  assert.equal(plan.steps.length, 4)
  plan.answers.previewAppearance.choice = 'Compact'
  assert.equal(rpc('settings.configure', { revision: plan.revision, answers: plan.answers }).ok, true)
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(saved.settingsUpToDate, true)
  assert.equal(saved.previewAppearance.choice, 'Compact')
  assert.deepEqual(saved.handback, { enabled: false })
})
function seed(run: ReturnType<typeof fixture>) {
  const store = new Store(run.file)
  const s = new Session({ id: 'kept', harness: 'fake', agent: 'a', model: 'm', state: 'idle', cwd: run.home }, store)
  s.push({ type: 'turn_started', turnId: 'one' })
  s.push({ type: 'usage', inputTokens: 120, outputTokens: 30, cachedInputTokens: 60 })
  s.push({ type: 'turn_completed', turnId: 'one', status: 'completed', reason: 'end_turn', finalText: 'kept' })
  store.db.exec('DROP TABLE usage_hours; DROP TABLE usage_requests; PRAGMA user_version=3')
  store.close()
}

test('install.sh migrates a retained database and builds rollups before activation or first use', async (t) => {
  const run = fixture(t)
  seed(run)
  assert.equal(fs.existsSync(path.join(run.installed, 'current')), false, 'history survives an otherwise uninstalled app')
  const result = await install(run)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Database migration complete/)
  assert.equal(fs.readlinkSync(path.join(run.installed, 'current')), `versions/${version}`)
  assert.equal(fs.existsSync(path.join(run.data, 'daemon.lock')), false, 'installer releases its lock')
  assert.equal(fs.existsSync(path.join(run.env.BITFROST_RUNTIME_DIR, 'bitfrostd.lock')), false, 'installation does not start the daemon')
  const db = new DatabaseSync(run.file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 8)
    assert.equal(db.prepare('SELECT SUM(input_tokens+output_tokens) AS n FROM usage_hours').get()!.n, 150)
    assert.equal(db.prepare('SELECT final_text FROM turns').get()!.final_text, 'kept')
  } finally { db.close() }
  assert.equal(fs.readdirSync(run.env.BITFROST_BACKUP_DIR).length, 1)
  const repeat = await install(run)
  assert.equal(repeat.status, 0, repeat.output)
  assert.match(repeat.output, /already current/)
  assert.equal(fs.readdirSync(run.env.BITFROST_BACKUP_DIR).length, 1)
})

test('a missing migration resource or version leaves the previous install active and its database unchanged', async (t) => {
  for (const corruption of ['plan', 'version'] as const) {
    const run = fixture(t, corruption)
    seed(run)
    fs.mkdirSync(path.join(run.installed, 'versions', '0.9.1'), { recursive: true })
    fs.symlinkSync('versions/0.9.1', path.join(run.installed, 'current'))
    const before = fs.readFileSync(run.file)
    const result = await install(run)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /new version was not activated/)
    assert.equal(fs.readlinkSync(path.join(run.installed, 'current')), 'versions/0.9.1')
    assert.deepEqual(fs.readFileSync(run.file), before)
    assert.equal(fs.existsSync(path.join(run.data, 'daemon.lock')), false)
  }
})

test('installation refuses a busy daemon without activating or migrating anything', async (t) => {
  const run = fixture(t)
  seed(run)
  fs.mkdirSync(run.env.BITFROST_RUNTIME_DIR, { recursive: true })
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') res.end(JSON.stringify({ pid: process.pid, busy: true }))
    else { res.statusCode = 409; res.end(JSON.stringify({ error: 'agents are running' })) }
  })
  await new Promise<void>((resolve) => server.listen(path.join(run.env.BITFROST_RUNTIME_DIR, 'bitfrostd.sock'), resolve))
  t.after(() => server.close())
  const before = fs.readFileSync(run.file)
  const result = await install(run)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /agents are running/)
  assert.equal(fs.existsSync(path.join(run.installed, 'current')), false)
  assert.deepEqual(fs.readFileSync(run.file), before)
})
