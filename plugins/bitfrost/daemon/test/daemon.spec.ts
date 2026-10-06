// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// End-to-end tests for bitfrostd: a real helper with its folders in a temp
// dir, only Codex on, played by fake-codex.mjs; all calls go over the socket.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', 'bitfrostd.ts')
const FAKE = path.join(HERE, 'fake-codex.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-daemon-test-'))
const runDir = path.join(root, 'run')
const configFile = path.join(root, 'config', 'bitfrost', 'config.json')
const profile = path.join(root, 'profile')
const work = path.join(root, 'work')
const sentLog = path.join(root, 'codex-sent.jsonl')
const socket = path.join(runDir, 'bitfrostd.sock')
let daemon: ChildProcess | null = null
let leaseId = ''

const goodConfig = (codex: Record<string, unknown> = {}) => ({
  allowedProfiles: [profile],
  providers: { codex: { bin: FAKE, ...codex }, zcode: { enabled: false } },
})
const writeConfig = (body: unknown) => fs.writeFileSync(configFile, typeof body === 'string' ? body : JSON.stringify(body))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Reply = { status: number; body: any }

// Sent by hand: the helper answers 413 from the header and hangs up, which can
// cut off a client still writing a real 17 MB body (EPIPE on a busy machine).
function oversized(urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket)
    let data = ''
    conn.setEncoding('utf8')
    conn.on('data', (c) => (data += c))
    conn.on('error', () => {})
    conn.on('close', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data)
      if (m) resolve(Number(m[1]))
      else reject(new Error(`no reply to an oversized body: ${JSON.stringify(data)}`))
    })
    conn.write(`POST ${urlPath} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\ncontent-length: ${17 * 1024 * 1024}\r\n\r\n{"host":"`)
  })
}

function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    // No pooled connections: one may still point at a helper that has exited.
    const req = http.request({ socketPath: socket, path: urlPath, method, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        let parsed: any = data
        try {
          parsed = data ? JSON.parse(data) : null
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function until<T>(desc: string, check: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await check().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(50)
  }
}

const daemonLog = () => {
  try {
    return fs.readFileSync(path.join(runDir, 'bitfrostd.log'), 'utf8')
  } catch {
    return ''
  }
}

async function newLease(hostSessionId: string): Promise<string> {
  const r = await call('POST', '/leases', { host: 'test', profile, hostSessionId })
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  return r.body.leaseId
}

async function startSession(lease: string): Promise<{ id: string; approval: any }> {
  const r = await call('POST', '/sessions', { leaseId: lease, agent: 'gpt-test', cwd: work, prompt: 'list the directory', canAskUser: true })
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  const id = r.body.id
  const approval = await until('the approval request', async () => (await call('GET', `/sessions/${id}/approvals`)).body.approvals[0])
  return { id, approval }
}

function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BITFROST_RUNTIME_DIR: runDir,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    BITFROST_TEST_LOG: sentLog,
  }
  for (const key of ['BITFROST_CODEX_BIN', 'BITFROST_ZCODE_DIR', 'BITFROST_RECORD_DIR', 'XDG_RUNTIME_DIR']) delete env[key]
  return env
}

before(async () => {
  for (const dir of [path.dirname(configFile), profile, work]) fs.mkdirSync(dir, { recursive: true })
  writeConfig(goodConfig())
  daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON, 'serve'], { env: daemonEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  daemon.stderr!.on('data', (d) => (stderr += d))
  await until(`the helper to answer (stderr: ${stderr})`, async () => (await call('GET', '/health')).status === 200)
})

after(async () => {
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((r) => daemon!.once('exit', r))
    daemon.kill('SIGTERM')
    await Promise.race([exited, sleep(3000)])
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('health answers, with no config error', async () => {
  const r = await call('GET', '/health')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.body.ok, true)
  assert.strictEqual(r.body.configError, null)
  assert.strictEqual(r.body.busy, false)
})

test('a lease is given only to an allowed profile', async () => {
  const refused = await call('POST', '/leases', { host: 'test', profile: os.tmpdir(), hostSessionId: 'other' })
  assert.strictEqual(refused.status, 403)
  leaseId = await newLease('host-1')
  assert.strictEqual((await call('POST', `/leases/${leaseId}`)).status, 200)
  assert.strictEqual((await call('POST', '/leases/nope')).status, 404)
})

test('the fake Codex model is listed as an agent', async () => {
  const r = await call('GET', '/agents')
  assert.strictEqual(r.status, 200)
  assert.deepStrictEqual(r.body.agents.map((a: any) => a.name), ['gpt-test'])
  assert.match(r.body.agents[0].description, /GPT-Test, OpenAI's model gpt-test/)
  assert.match(r.body.nameTable, /bitfrost:gpt-test/)
})

test('status shows the provider, the lease and no sessions', async () => {
  const r = await call('GET', '/status')
  assert.strictEqual(r.status, 200)
  const s = r.body
  assert.strictEqual(s.socket, socket)
  assert.strictEqual(s.config, configFile)
  assert.strictEqual(s.configError, null)
  assert.strictEqual(typeof s.version, 'string')
  assert.strictEqual(typeof s.pid, 'number')
  assert.deepStrictEqual(s.providers, [{ id: 'codex', location: FAKE, models: 1 }])
  assert.ok(s.registryAt > 0)
  assert.strictEqual(s.leases.length, 1)
  assert.strictEqual(s.leases[0].id, leaseId)
  assert.strictEqual(s.leases[0].profile, fs.realpathSync(profile))
  assert.ok(s.leases[0].expiresInMs > 0)
  assert.deepStrictEqual(s.sessions, [])
})

test('a session runs one turn with an approval, then DELETE lets it go', async () => {
  const { id, approval } = await startSession(leaseId)
  assert.strictEqual(approval.tool, 'Bash')
  assert.strictEqual((await call('GET', '/health')).body.busy, true)

  const answer = await call('POST', `/sessions/${id}/approvals/${approval.approvalId}`, { decision: 'allow', by: 'user' })
  assert.strictEqual(answer.status, 200)
  const events = await until('the turn to complete', async () => {
    const r = await call('GET', `/sessions/${id}/events?after=0&waitMs=500`)
    return r.body.events.some((e: any) => e.type === 'turn_completed') && r.body.events
  })
  assert.strictEqual(events.at(-1).status, 'completed')
  assert.strictEqual(events.at(-1).finalText, 'It listed the directory: 2 entries.')

  const listed = await call('GET', '/sessions')
  assert.deepStrictEqual(listed.body.sessions, [{ id, agent: 'gpt-test', harness: 'codex', model: 'gpt-test', state: 'idle', leaseId }])
  assert.deepStrictEqual((await call('GET', '/status')).body.sessions, listed.body.sessions)

  assert.strictEqual((await call('DELETE', `/sessions/${id}`)).status, 200)
  assert.strictEqual((await call('GET', `/sessions/${id}`)).status, 404)
  assert.strictEqual((await call('DELETE', `/sessions/${id}`)).status, 404)
  assert.deepStrictEqual((await call('GET', '/sessions')).body.sessions, [])
  assert.match(daemonLog(), new RegExp(`session ${id}: let go \\(deleted\\)`))
})

test('releasing a lease stops its running session and lets it go', async () => {
  const lease = await newLease('host-2')
  const { id } = await startSession(lease)
  assert.strictEqual((await call('DELETE', `/leases/${lease}`)).status, 200)
  assert.strictEqual((await call('GET', `/sessions/${id}`)).status, 404)
  await until('the helper to be idle', async () => (await call('GET', '/health')).body.busy === false)
  const sent = fs.readFileSync(sentLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(sent.some((m) => m.result?.decision === 'decline'))
  assert.strictEqual((await call('DELETE', `/leases/${lease}`)).status, 404)
})

test('a config change shows in /agents without ?refresh=1', async () => {
  writeConfig(goodConfig({ models: ['nothing-*'] }))
  const empty = await call('GET', '/agents')
  assert.deepStrictEqual(empty.body.agents, [])
  assert.strictEqual(empty.body.nameTable, '')
  assert.match(empty.body.hint, /providers\.<app>\.models/)

  writeConfig(goodConfig())
  const back = await call('GET', '/agents')
  assert.deepStrictEqual(back.body.agents.map((a: any) => a.name), ['gpt-test'])
})

test('an invalid config.json refuses leases with 503 and shows in /health', async () => {
  for (const [body, reason] of [
    ['{"providers": ', /is invalid: /],
    [{ allowedProfiles: [profile], providers: { codex: { enabled: 'yes' } } }, /providers\.codex\.enabled must be true or false/],
  ] as const) {
    writeConfig(body)
    const health = await call('GET', '/health')
    assert.ok(health.body.configError.startsWith(`${configFile} is invalid: `), health.body.configError)
    assert.match(health.body.configError, reason)
    const lease = await call('POST', '/leases', { host: 'test', profile, hostSessionId: 'host-3' })
    assert.strictEqual(lease.status, 503)
    assert.strictEqual(lease.body.error, health.body.configError)
    assert.strictEqual((await call('GET', '/status')).body.configError, health.body.configError)
    // The last good config stays in use meanwhile.
    assert.deepStrictEqual((await call('GET', '/agents')).body.agents.map((a: any) => a.name), ['gpt-test'])
  }
  assert.strictEqual(daemonLog().match(/config: .*providers\.codex\.enabled must be/g)?.length, 1)

  writeConfig(goodConfig())
  assert.strictEqual((await call('GET', '/health')).body.configError, null)
  leaseId = await newLease('host-1')
})

test('bad request bodies get 400, and oversized ones 413', async () => {
  const bad = await call('POST', '/leases', '{not json')
  assert.strictEqual(bad.status, 400)
  assert.strictEqual(await oversized('/leases'), 413)
  assert.strictEqual((await call('GET', '/health')).status, 200)
})

test('an app updated on disk is restarted and its new models listed', async () => {
  const bin = path.join(root, 'codex')
  const install = (extra: string) =>
    fs.writeFileSync(bin, `#!/bin/sh\nBITFROST_FAKE_EXTRA_MODELS='${extra}' exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 })
  install('')
  writeConfig(goodConfig({ bin }))
  assert.deepStrictEqual((await call('GET', '/agents')).body.agents.map((a: any) => a.name), ['gpt-test'])

  install('gpt-newer')
  await until(
    'the new model to be listed',
    async () => (await call('GET', '/agents')).body.agents.some((a: any) => a.name === 'gpt-newer'),
    15_000,
  )
  assert.match(daemonLog(), /provider codex: its app changed on disk; restarting it/)

  writeConfig(goodConfig())
})

// Last: it replaces the helper this file started with one of its own.
test('restart replaces an idle helper with a new one', async () => {
  const before = (await call('GET', '/health')).body.pid
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON, 'restart'], { env: daemonEnv(), encoding: 'utf8', timeout: 20_000 })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /restarted, pid \d+/)
  const after = (await call('GET', '/health')).body.pid
  assert.notStrictEqual(after, before)
  await until('the old helper to exit', async () => daemon!.exitCode !== null)
  await call('POST', '/shutdown')
})
