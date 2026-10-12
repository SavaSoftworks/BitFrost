// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('missing enabled apps use asynchronous, cached login-shell discovery', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-discovery-'))
  const config = path.join(root, 'config', 'bitfrost', 'config.json')
  const socket = path.join(root, 'run', 'bitfrostd.sock')
  const lookups = path.join(root, 'lookups')
  const shell = path.join(root, 'slow-shell')
  const bin = path.join(root, 'bin')
  const profile = path.join(root, 'profile')
  for (const dir of [path.dirname(config), bin, profile]) fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.writeFileSync(shell, `#!/bin/sh\nprintf 'lookup\n' >> '${lookups}'\n/bin/sleep 0.5\nexit 1\n`, { mode: 0o700 })
  fs.writeFileSync(config, JSON.stringify({ allowedProfiles: [profile], providers: {
    codex: { bin: path.join(HERE, 'fake-codex.mjs') }, zcode: { enabled: false }, gemini: { enabled: true },
  } }))
  const fixture = path.join(root, 'quick.jsonl')
  fs.writeFileSync(fixture, [
    { method: 'turn/started', params: { threadId: 'thr1', turn: { id: 'turn1' } } },
    { method: 'turn/completed', params: { threadId: 'thr1', turn: { id: 'turn1', status: 'completed' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n')
  const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'codex'), PATH: bin, SHELL: shell,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    BITFROST_RUNTIME_DIR: path.join(root, 'run'), BITFROST_DATA_DIR: path.join(root, 'persistent'),
    BITFROST_TEST_LOG: path.join(root, 'sent'), BITFROST_FAKE_CODEX_SCRIPT: fixture,
  }
  for (const key of ['BITFROST_CODEX_BIN', 'BITFROST_ZCODE_DIR', 'BITFROST_RECORD_DIR']) delete env[key]
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, '..', 'bitfrostd.ts'), 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr!.on('data', (c) => errors += c)
  t.after(async () => {
    child.kill('SIGTERM')
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(2000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  })
  const call = (method: string, url: string, body?: unknown) => new Promise<any>((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: url, method, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const until = async (check: () => Promise<any>) => {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      const result = await check().catch(() => null)
      if (result) return result
      await sleep(10)
    }
    throw new Error(`discovery timed out: ${errors}`)
  }
  await until(async () => (await call('GET', '/health')).status === 200)
  const listing = call('GET', '/providers')
  await until(async () => fs.existsSync(lookups))
  const start = performance.now()
  assert.equal((await call('GET', '/health')).status, 200)
  assert.ok(performance.now() - start < 300, 'health must answer while the login shell sleeps')
  assert.equal((await listing).status, 200)
  const count = fs.readFileSync(lookups, 'utf8')
  await call('GET', '/providers')
  assert.equal(fs.readFileSync(lookups, 'utf8'), count, 'negative detection is cached across listings')

  await until(async () => (await call('GET', '/agents')).body.agents?.some((a: any) => a.name === 'gpt-test'))
  const initial = (await call('GET', '/subagents')).body
  const leaseId = (await call('POST', '/leases', { host: 'test', profile, hostSessionId: 'discovery' })).body.leaseId
  const created = await call('POST', '/sessions', { leaseId, agent: 'gpt-test', cwd: root, prompt: 'finish quickly', canAskUser: true })
  assert.equal(created.status, 200)
  await until(async () => (await call('GET', '/subagents')).body.recent.some((a: any) => a.id === created.body.id))
  const changes = (await call('GET', `/subagents/changed?ids=&since=${initial.now}&recent=1&top=0%3A`)).body
  assert.ok(changes.recent.some((a: any) => a.id === created.body.id && !a.running), 'overview receives completed tasks that were never visible')
  assert.ok(changes.newer.some((a: any) => a.id === created.body.id), 'an initially empty history receives its first task')
})
