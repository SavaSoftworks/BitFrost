// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for SessionTable: how sessions follow their host's lease. A fake
// provider records what it is asked; the clock moves by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_MS, LEASE_TTL_MS, SessionTable } from '../leases.ts'
import type { Provider } from '../provider.ts'
import { Session } from '../session.ts'

function setup() {
  let now = 1_000_000
  const interrupted: string[] = []
  const disposed: string[] = []
  const provider = {
    interrupt: async (s: Session) => {
      interrupted.push(s.info.id)
    },
    disposeSession: (s: Session) => {
      disposed.push(s.info.id)
    },
  } as unknown as Provider
  const table = new SessionTable(() => provider, () => {}, () => now)
  const session = (id: string, leaseId: string, running = false) => {
    const s = new Session({ id, harness: 'fake', agent: 'test', model: 'm', cwd: '/tmp', state: 'idle' })
    if (running) s.push({ type: 'turn_started', turnId: `${id}-t` })
    table.add(s, leaseId)
    return s
  }
  const stop = (s: Session) => s.push({ type: 'turn_completed', turnId: `${s.info.id}-t`, status: 'interrupted', reason: 'interrupted', finalText: '' })
  const advance = (ms: number) => {
    now += ms
    table.tick()
  }
  return { table, session, stop, advance, interrupted, disposed }
}

const settle = () => new Promise((r) => setImmediate(r))

test('a released lease lets its idle sessions go at once', () => {
  const { table, session, interrupted, disposed } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  session('a', 'L1')
  session('b', 'L1')
  table.addLease('L2', { host: 'claude-code', profile: '/p', hostSessionId: 'H2' })
  session('c', 'L2')

  assert.strictEqual(table.release('L1'), true)
  assert.deepStrictEqual(interrupted, [])
  assert.deepStrictEqual(disposed.sort(), ['a', 'b'])
  assert.deepStrictEqual([...table.sessions.keys()], ['c'])
  assert.strictEqual(table.release('L1'), false)
})

test('a released lease interrupts a running session and lets it go once it stops', async () => {
  const { table, session, stop, interrupted, disposed } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  const s = session('a', 'L1', true)

  table.release('L1')
  assert.deepStrictEqual(interrupted, ['a'])
  assert.strictEqual(table.sessions.has('a'), false) // gone from the API now
  assert.deepStrictEqual(disposed, []) // never while running
  assert.deepStrictEqual(table.running().map((x) => x.info.id), ['a'])

  stop(s)
  await settle()
  assert.deepStrictEqual(disposed, ['a'])
  assert.deepStrictEqual(table.running(), [])
})

test('a lapsed lease keeps its sessions for the hold, and a new lease from the same host takes them over', async () => {
  const { table, session, stop, advance, interrupted, disposed } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  const running = session('a', 'L1', true)
  session('b', 'L1')

  advance(LEASE_TTL_MS + 1)
  assert.strictEqual(table.leases.has('L1'), false)
  assert.deepStrictEqual(interrupted, ['a'])
  assert.deepStrictEqual([...table.sessions.keys()].sort(), ['a', 'b'])
  assert.strictEqual(table.leaseIdOf('a'), null)

  table.addLease('X', { host: 'claude-code', profile: '/p', hostSessionId: 'H2' })
  assert.strictEqual(table.leaseIdOf('b'), null)

  table.addLease('L2', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  assert.strictEqual(table.leaseIdOf('a'), 'L2')
  assert.strictEqual(table.leaseIdOf('b'), 'L2')
  assert.deepStrictEqual(disposed, [])

  table.release('L2')
  assert.deepStrictEqual(disposed, ['b'])
  stop(running)
  await settle()
  assert.deepStrictEqual(disposed, ['b', 'a'])
})

test('sessions whose host does not come back are let go when the hold ends', async () => {
  const { table, session, stop, advance, disposed } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  const running = session('a', 'L1', true)
  session('b', 'L1')

  advance(LEASE_TTL_MS + 1)
  advance(HOLD_MS - 1000)
  assert.deepStrictEqual(disposed, [])
  assert.strictEqual(table.sessions.size, 2)

  advance(2000)
  assert.strictEqual(table.sessions.size, 0)
  assert.deepStrictEqual(disposed, ['b'])
  stop(running)
  await settle()
  assert.deepStrictEqual(disposed, ['b', 'a'])
})

test('a lapsed lease whose host already has a newer one moves its sessions over', () => {
  const { table, session, advance, disposed } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  session('a', 'L1')
  advance(LEASE_TTL_MS / 2)
  table.addLease('L2', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  advance(LEASE_TTL_MS / 2 + 1)
  assert.strictEqual(table.leases.has('L1'), false)
  assert.strictEqual(table.leaseIdOf('a'), 'L2')
  assert.deepStrictEqual(disposed, [])
})

test('renewing keeps a lease; closing an unknown session is refused', () => {
  const { table, session, advance } = setup()
  table.addLease('L1', { host: 'claude-code', profile: '/p', hostSessionId: 'H1' })
  session('a', 'L1')
  for (let i = 0; i < 5; i++) {
    advance(LEASE_TTL_MS - 1000)
    assert.strictEqual(table.renew('L1'), true)
  }
  assert.strictEqual(table.leaseIdOf('a'), 'L1')
  assert.strictEqual(table.renew('nope'), false)
  assert.strictEqual(table.close('nope', 'test'), false)
})

test('a session whose lease ended while it started is let go', () => {
  const { table, session, disposed } = setup()
  session('a', 'gone')
  assert.strictEqual(table.sessions.size, 0)
  assert.deepStrictEqual(disposed, ['a'])
})

test('attach rebinds a held or closing session and persists its new owner', async () => {
  const { table,session,stop,disposed } = setup()
  table.addLease('L1',{ host:'test',profile:'/p',hostSessionId:'old' })
  const s = session('a','L1',true)
  table.release('L1')
  assert.equal(table.get('a'),s)
  assert.equal(s.info.state,'stopping')
  table.addLease('L2',{ host:'test',profile:'/p',hostSessionId:'new' })
  table.attach(s,'L2','lead')
  assert.equal(table.leaseIdOf('a'),'L2')
  assert.equal(s.info.claudeSession,'lead')
  assert.equal(s.info.closedAt,null)
  stop(s)
  await settle()
  assert.deepEqual(disposed,[])
  assert.equal(table.get('a'),s)
})

test('detached loads are cached across requests and expire only when unowned and unused', () => {
  let now = Date.now()
  const table = new SessionTable(() => undefined, () => {}, () => now)
  let reads = 0
  const store = { load: (id: string) => { reads++; return { info: { id, harness: 'fake', agent: 'test', model: 'm', cwd: '/tmp', state: 'detached' }, events: [], lastSeq: 0, nativeRef: null } }, saveSession: () => {} } as any
  const first = table.load('saved', store)!
  first.lastSeenAt = now
  assert.equal(table.load('saved', store), first)
  assert.equal(reads, 1)
  assert.deepEqual(table.summaries(), [])
  now += HOLD_MS + 1
  table.tick()
  assert.notEqual(table.load('saved', store), first)
  assert.equal(reads, 2)
  table.addLease('lease', { host: 'test', profile: '/p', hostSessionId: 'lead' })
  const attached = table.load('saved', store)!
  table.attach(attached, 'lease')
  now += HOLD_MS + 1
  table.renew('lease')
  table.tick()
  assert.equal(table.load('saved', store), attached)
})
