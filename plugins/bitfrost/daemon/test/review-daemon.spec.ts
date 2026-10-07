// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store } from '../store.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', 'bitfrostd.ts')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(ready: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await ready().catch(() => false))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon')
    await sleep(20)
  }
}

function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-review-daemon-'))
  const runDir = path.join(root, 'run'), dataDir = path.join(root, 'data'), profile = path.join(root, 'profile')
  const configDir = path.join(root, 'config', 'bitfrost'), logFile = path.join(root, 'sent.jsonl')
  for (const dir of [profile, configDir, dataDir]) fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dataDir, 0o755)
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ allowedProfiles: [profile], retention: { eventsDays: 1, messagesDays: 1 }, providers: { codex: { bin: path.join(HERE, 'fake-codex.mjs') }, zcode: { enabled: false } } }))
  const env = { ...process.env, BITFROST_RUNTIME_DIR: runDir, BITFROST_DATA_DIR: dataDir, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), BITFROST_TEST_LOG: logFile }
  delete env.BITFROST_INSIDE
  const children: ChildProcess[] = []
  const launch = (extra: string[] = [], over: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...extra, DAEMON, 'serve'], { env: { ...env, ...over }, stdio: 'ignore' })
    children.push(child)
    return child
  }
  const call = (method: string, route: string, body?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(runDir, 'bitfrostd.sock'), path: route, method, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.on('data', (chunk) => text += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode) continue
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      await exited
      clearTimeout(timer)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const ready = () => until(async () => (await call('GET', '/health')).status === 200)
  const lease = async () => (await call('POST', '/leases', { host: 'test', profile, hostSessionId: 'review' })).body.leaseId
  const sent = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []
  return { root, dataDir, runDir, launch, call, ready, lease, sent }
}

function saved(store: Store, id: string, state: 'idle' | 'running' = 'idle') {
  const s = new Session({ id, harness: 'codex', agent: 'gpt-test', model: 'gpt-test', cwd: '/tmp', state }, store)
  s.setNativeRef({ threadId: id, canAskUser: true, sandbox: 'workspace-write' })
  return s
}

test('concurrent input to a restored session shares one cached Session, one attach and one native turn', async (t) => {
  const run = setup(t), store = new Store(path.join(run.dataDir, 'bitfrost.db'))
  saved(store, 'saved').save()
  store.close()
  run.launch()
  await run.ready()
  assert.equal((await run.call('POST', '/sessions/saved/input', { text: 'unleased' })).status, 403)
  const leaseId = await run.lease()
  assert.equal((await run.call('POST', '/sessions/saved/attach', { leaseId })).status, 200)
  const replies = await Promise.all([run.call('POST', '/sessions/saved/input', { text: 'first' }), run.call('POST', '/sessions/saved/input', { text: 'second' })])
  assert.ok(replies.every((r) => r.status === 200))
  assert.deepEqual(replies.map((r) => r.body.delivery).sort(), ['started', 'steered'])
  assert.equal(run.sent().filter((r) => r.method === 'thread/resume').length, 1)
  assert.equal(run.sent().filter((r) => r.method === 'turn/start').length, 1)
  assert.equal((await run.call('GET', '/health')).body.store.degraded, false)
  assert.equal((await run.call('GET', '/sessions/saved/messages')).body.turns.length, 1)
})

test('a second daemon with a different runtime cannot rehydrate or write the owned data directory', async (t) => {
  const run = setup(t)
  run.launch()
  await run.ready()
  const leaseId = await run.lease()
  await until(async () => (await run.call('GET', '/agents')).body.agents.length > 0)
  const id = (await run.call('POST', '/sessions', { leaseId, agent: 'gpt-test', cwd: run.root, prompt: 'first', canAskUser: true })).body.id
  await until(async () => (await run.call('GET', `/sessions/${id}/approvals`)).body.approvals.length > 0)
  const before = (await run.call('GET', `/sessions/${id}/events`)).body.events
  const otherRun = path.join(run.root, 'other-run'), second = run.launch([], { BITFROST_RUNTIME_DIR: otherRun })
  const code = await new Promise((r) => second.once('exit', r))
  assert.equal(code, 0)
  assert.match(fs.readFileSync(path.join(otherRun, 'bitfrostd.log'), 'utf8'), /another bitfrostd owns/)
  const after = (await run.call('GET', `/sessions/${id}/events`)).body
  assert.equal(after.state, 'running')
  assert.equal(after.events.length, before.length)
  assert.equal(after.events.filter((e: any) => e.type === 'turn_completed').length, 0)
})

test('HTTP client input ids deduplicate concurrently and survive a daemon restart', async (t) => {
  const run = setup(t), store = new Store(path.join(run.dataDir, 'bitfrost.db'))
  saved(store, 'saved').save()
  store.close()
  const daemon = run.launch()
  await run.ready()
  const leaseId = await run.lease()
  await run.call('POST', '/sessions/saved/attach', { leaseId })
  assert.equal((await run.call('POST', '/sessions/saved/input', { text: 'bad', clientInputId: 1 })).status, 400)
  const replies = await Promise.all([run.call('POST', '/sessions/saved/input', { text: 'once', clientInputId: 'client' }), run.call('POST', '/sessions/saved/input', { text: 'retry', clientInputId: 'client' })])
  assert.equal(replies[0].status, 200)
  assert.deepEqual(replies[1], replies[0])
  const queued = await run.call('POST', '/sessions/saved/input', { text: 'queued', mode: 'queue', clientInputId: 'queued-client' })
  assert.equal(queued.body.delivery, 'queued')
  const events = (await run.call('GET', '/sessions/saved/events')).body.events
  assert.equal(events.filter((e: any) => e.type === 'user_input' && e.clientInputId === 'client').length, 1)
  assert.equal(run.sent().filter((r) => r.method === 'turn/start').length, 1)
  const exited = new Promise((r) => daemon.once('exit', r))
  daemon.kill('SIGKILL')
  await exited
  run.launch()
  await run.ready()
  const deliveries = () => run.sent().filter((r) => ['thread/resume', 'turn/start', 'turn/steer'].includes(r.method)).length
  const before = deliveries()
  assert.deepEqual(await run.call('POST', '/sessions/saved/input', { text: 'after restart', clientInputId: 'client' }), replies[0])
  assert.deepEqual(await run.call('POST', '/sessions/saved/input', { text: 'dropped retry', clientInputId: 'queued-client' }), queued)
  assert.equal(deliveries(), before)
  const after = (await run.call('GET', '/sessions/saved/events')).body.events
  assert.equal(after.filter((e: any) => e.type === 'user_input').length, 2)
})

test('startup closes idle and unfinished sessions, keeps them resumable and drops pending input before recovery completion', async (t) => {
  const run = setup(t), store = new Store(path.join(run.dataDir, 'bitfrost.db'))
  const s = saved(store, 'recover')
  s.push({ type: 'turn_started', turnId: 'earlier' })
  s.push({ type: 'text', itemId: 'answer', text: 'An earlier answer.' })
  s.push({ type: 'turn_completed', turnId: 'earlier', status: 'completed', reason: 'end_turn', finalText: 'An earlier answer.' })
  s.acceptInput('new turn', 'started')
  s.push({ type: 'turn_started', turnId: 'unfinished' })
  const pending = s.acceptInput('queued lead message', 'queued')
  const idle = saved(store, 'idle')
  s.info.closedAt = Date.now() - 400 * 86400_000
  for (const session of [s, idle]) { session.info.updatedAt = Date.now() - 400 * 86400_000; session.save() }
  store.close()
  run.launch()
  await run.ready()
  const events = (await run.call('GET', '/sessions/recover/events')).body.events
  const end = events.find((e: any) => e.type === 'turn_completed' && e.turnId === 'unfinished')
  assert.equal(end.reason, 'daemon_restart')
  assert.equal(end.finalText, '')
  const dropped = events.find((e: any) => e.type === 'input_dropped' && e.inputId === pending.id)
  assert.ok(dropped.seq < end.seq)
  assert.equal((await run.call('GET', '/sessions/recover/messages?all=1')).body.turns.length, 2)
  for (const id of ['idle', 'recover']) {
    const info = (await run.call('GET', `/sessions/${id}`)).body
    assert.equal(info.state, 'detached')
    assert.ok(info.closedAt)
  }
  const leaseId = await run.lease()
  assert.equal((await run.call('POST', '/sessions/idle/attach', { leaseId })).status, 200)
  assert.equal((await run.call('POST', '/sessions/idle/input', { text: 'continue' })).body.delivery, 'started')
  assert.equal(fs.statSync(run.dataDir).mode & 0o777, 0o700)
  for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.statSync(path.join(run.dataDir, 'bitfrost.db') + suffix).mode & 0o777, 0o600)
})

test('last-resort exception and rejection logging leaves the daemon responsive and the store on disk', async (t) => {
  const run = setup(t)
  run.launch(['--import', path.join(HERE, 'fake-daemon-errors.mjs')])
  await run.ready()
  await until(async () => {
    const log = fs.readFileSync(path.join(run.runDir, 'bitfrostd.log'), 'utf8')
    return log.includes('fixture uncaught exception') && log.includes('fixture unhandled rejection')
  })
  assert.equal((await run.call('GET', '/health')).body.store.degraded, false)
  const leaseId = await run.lease()
  await until(async () => (await run.call('GET', '/agents')).body.agents.length > 0)
  const spawned = await run.call('POST', '/sessions', { leaseId, agent: 'gpt-test', cwd: run.root, prompt: 'still working', canAskUser: true })
  assert.equal(spawned.status, 200)
  assert.equal((await run.call('GET', `/sessions/${spawned.body.id}/summary`)).status, 200)
})

test('a newer on-disk schema starts the daemon with persistence disabled', async (t) => {
  const run = setup(t), file = path.join(run.dataDir, 'bitfrost.db'), store = new Store(file)
  store.db.exec('PRAGMA user_version=99')
  store.close()
  run.launch()
  await run.ready()
  const health = (await run.call('GET', '/health')).body
  assert.equal(health.store.degraded, true)
  assert.match(health.store.error, /version 99/)
  const reader = new Store(file, () => {})
  try { assert.equal(reader.degraded, true) } finally { reader.close() }
})

test('HTTP input received during stop returns a queued receipt before stop confirmation', async (t) => {
  const run = setup(t)
  run.launch([], { BITFROST_FAKE_INTERRUPT_DELAY: '300' })
  await run.ready()
  const leaseId = await run.lease()
  await until(async () => (await run.call('GET', '/agents')).body.agents.length > 0)
  const id = (await run.call('POST', '/sessions', { leaseId, agent: 'gpt-test', cwd: run.root, prompt: 'first', canAskUser: true })).body.id
  await until(async () => (await run.call('GET', `/sessions/${id}/approvals`)).body.approvals.length > 0)
  let confirmed = false
  const stop = run.call('POST', `/sessions/${id}/interrupt`).then((r) => { confirmed = true; return r })
  await until(async () => (await run.call('GET', `/sessions/${id}`)).body.state === 'stopping')
  const input = await run.call('POST', `/sessions/${id}/input`, { text: 'continue after stop' })
  assert.equal(input.status, 200)
  assert.equal(input.body.delivery, 'queued')
  assert.equal(confirmed, false)
  assert.equal((await stop).body.how, 'graceful')
  await until(async () => (await run.call('GET', `/sessions/${id}/events`)).body.events.some((e: any) => e.type === 'input_consumed' && e.inputId === input.body.inputId))
  const fates = (await run.call('GET', `/sessions/${id}/events`)).body.events.filter((e: any) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === input.body.inputId)
  assert.equal(fates.length, 1)
})

test('rehydration kills a stored ZCode process group only after checking its ownership token', async (t) => {
  const { processIdentity } = await import('../process.ts')
  const run = setup(t), token = `review-${process.pid}`
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, BITFROST_ZCODE_TURN: token } })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((r) => child.once('spawn', r))
  const store = new Store(path.join(run.dataDir, 'bitfrost.db'))
  const s = new Session({ id: 'orphan', harness: 'zcode', agent: 'glm-test', model: 'GLM-test', cwd: run.root, state: 'idle' }, store)
  s.setNativeRef({ zcodeSessionId: 'native', process: processIdentity(child.pid!, token) })
  s.push({ type: 'turn_started', turnId: 'orphan-turn' })
  store.close()
  run.launch()
  await run.ready()
  await until(async () => child.signalCode === 'SIGKILL')
  assert.equal((await run.call('GET', '/sessions/orphan/summary')).body.turns[0].reason, 'daemon_restart')
  assert.match(fs.readFileSync(path.join(run.runDir, 'bitfrostd.log'), 'utf8'), /stopped leftover ZCode process group/)
})
