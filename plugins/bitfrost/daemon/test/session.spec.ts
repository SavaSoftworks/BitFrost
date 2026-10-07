// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../session.ts'
import type { Provider } from '../provider.ts'

const session = () => new Session({ id: 's', harness: 'fake', agent: 'test', model: 'm', cwd: '/tmp', state: 'idle' })
const complete = (s: Session, reason = 'end_turn' as const) => s.push({ type: 'turn_completed', turnId: s.activeTurnId!, status: 'completed', reason, finalText: 'done' })
const settle = () => new Promise((r) => setImmediate(r))

test('client input ids deduplicate concurrent and later deliveries without another receipt or fate', async () => {
  const s = session(), { provider, sent } = fake(true)
  const send = provider.sendInput
  provider.sendInput = async (s, text) => { await settle(); return send(s, text) }
  const [first, retry] = await Promise.all([s.deliver(provider, 'first', 'auto', 'claude', 'client'), s.deliver(provider, 'different', 'interrupt', 'user', 'client')])
  assert.deepEqual(retry, first)
  assert.deepEqual(sent, ['first'])
  complete(s)
  assert.deepEqual(await s.deliver(provider, 'later retry', 'auto', 'claude', 'client'), first)
  const inputs: any[] = s.events.filter((e) => e.type === 'user_input')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].clientInputId, 'client')
  assert.equal(s.events.filter((e) => e.type === 'input_consumed').length, 1)
  assert.equal(s.events.filter((e) => e.type === 'turn_started').length, 1)
})

test('duplicate client input ids retain queued and restarted deliveries during a stop', async () => {
  const s = session(), { provider, sent } = fake()
  await s.deliver(provider, 'first')
  provider.interrupt = async () => {}
  const restart = await s.deliver(provider, 'restart', 'interrupt', 'claude', 'restart-id')
  const queued = await s.deliver(provider, 'queued', 'auto', 'claude', '')
  assert.deepEqual(await s.deliver(provider, 'restart retry', 'auto', 'claude', 'restart-id'), restart)
  assert.deepEqual(await s.deliver(provider, 'queued retry', 'interrupt', 'user', ''), queued)
  complete(s)
  await settle()
  complete(s)
  await settle()
  // Both waiting messages start one turn together, and each was accepted once.
  assert.equal(sent.length, 2)
  assert.match(sent[1], /^The lead interrupted you to deliver these messages.*\n1\. restart\n\n2\. queued$/)
  assert.equal(s.events.filter((e) => e.type === 'user_input').length, 3)
  assert.equal(s.events.filter((e) => e.type === 'input_consumed').length, 3)
})

test('steered client inputs and accepted inputs dropped after a send failure never deliver twice', async () => {
  const s = session(), { provider, sent } = fake(true)
  await s.deliver(provider, 'first')
  const steered = await s.deliver(provider, 'steer', 'auto', 'claude', 'steer-id')
  assert.equal(steered.delivery, 'steered')
  assert.deepEqual(await s.deliver(provider, 'steer retry', 'queue', 'user', 'steer-id'), steered)
  assert.deepEqual(sent, ['first', 'steer'])
  complete(s)
  let calls = 0
  provider.sendInput = async () => { calls++; throw new Error('rejected') }
  await assert.rejects(s.deliver(provider, 'fails', 'auto', 'claude', 'failed-id'), /rejected/)
  const retry = await s.deliver(provider, 'failed retry', 'auto', 'claude', 'failed-id')
  assert.equal(retry.delivery, 'queued')
  assert.equal(calls, 1)
  const fates = s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === retry.inputId)
  assert.equal(fates.length, 1)
  assert.equal(fates[0].type, 'input_dropped')
})

test('a stop that times out during a send keeps the turn ended when the send replays', async () => {
  const s = session(), { provider } = fake()
  let release!: () => void
  provider.sendInput = async (session) => {
    session.push({ type: 'turn_started', turnId: 'slow' })
    await new Promise<void>((r) => { release = r })
    return 'started'
  }
  provider.interrupt = async () => {}
  const delivery = s.deliver(provider, 'first')
  await settle()
  assert.equal(await s.stop(provider, 'host', { graceMs: 10, killMs: 10 }), 'timed_out')
  release()
  await delivery
  assert.equal(s.activeTurnId, null)
  assert.equal(s.info.state, 'detached')
  assert.equal(s.events.filter((e) => e.type === 'turn_started').length, 0)
})

function fake(steer = false) {
  const sent: string[] = []
  let turns = 0
  const provider = {
    displayName: 'Fake', capabilities: { steer },
    sendInput: async (s: Session, text: string) => {
      sent.push(text)
      if (s.activeTurnId && steer) return 'steered'
      s.push({ type: 'turn_started', turnId: `t${++turns}` })
      return 'started'
    },
    interrupt: async (s: Session) => { complete(s) },
  } as Provider
  return { provider, sent }
}

test('inputs return started, steered and queued receipts and consume them on the right turn', async () => {
  const s = session(), { provider, sent } = fake(true)
  const started = await s.deliver(provider, 'first')
  assert.equal(started.delivery, 'started')
  const steered = await s.deliver(provider, 'second')
  assert.equal(steered.delivery, 'steered')
  const queued = await s.deliver(provider, 'third', 'queue', 'user')
  assert.equal(queued.delivery, 'queued')
  assert.deepEqual(sent, ['first', 'second'])
  const end = complete(s)
  assert.equal(end.type === 'turn_completed' && end.continues, true)
  await settle()
  assert.deepEqual(sent, ['first', 'second', 'third'])
  assert.equal(s.activeTurnId, 't2')
  const consumed = s.events.filter((e) => e.type === 'input_consumed')
  assert.deepEqual(consumed.map((e) => [e.inputId, e.turnId]), [[started.inputId, 't1'], [steered.inputId, 't1'], [queued.inputId, 't2']])
  assert.equal(s.events.find((e) => e.type === 'user_input' && e.inputId === queued.inputId)?.sender, 'user')
})

test('auto queues for an app without steering and interrupt uses the fake steering wheel', async () => {
  const s = session(), { provider, sent } = fake()
  await s.deliver(provider, 'first')
  const queued = await s.deliver(provider, 'queued')
  assert.equal(queued.delivery, 'queued')
  const restarted = await s.deliver(provider, 'new instruction', 'interrupt')
  assert.equal(restarted.delivery, 'restarted')
  await settle()
  const end: any = s.events.find((e) => e.type === 'turn_completed')
  assert.deepEqual([end.status, end.reason, end.continues], ['interrupted', 'restarted', true])
  complete(s)
  await settle()
  // The restart carries the earlier queued message too, oldest first, so neither waits.
  assert.equal(sent.length, 2)
  assert.match(sent[1], /^The lead interrupted you to deliver these messages.*\n1\. queued\n\n2\. new instruction$/)
  assert.equal(s.events.filter((e) => e.type === 'input_consumed').length, 3)
  assert.equal(s.info.id, 's')
})

test('stop confirms graceful completion, is idempotent, and drops queued input', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  const q = await s.deliver(provider, 'queued')
  let calls = 0
  provider.interrupt = async () => { calls++; setImmediate(() => complete(s)) }
  const first = s.stop(provider, 'host')
  assert.equal(s.info.state, 'stopping')
  const second = s.stop(provider, 'lease')
  assert.equal(first, second)
  assert.equal(await first, 'graceful')
  assert.equal(calls, 1)
  assert.equal(s.info.state, 'idle')
  assert.ok(s.events.some((e) => e.type === 'input_dropped' && e.inputId === q.inputId))
  assert.equal(await s.stop(provider, 'host'), 'idle')
})

test('stop escalates to kill and reports forced completion', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  provider.interrupt = async () => {}
  let killed = false
  provider.kill = () => { killed = true; complete(s); return true }
  assert.equal(await s.stop(provider, 'abandoned', { graceMs: 10, killMs: 10 }), 'forced')
  assert.ok(killed)
  assert.equal(s.activeTurnId, null)
  assert.equal(s.info.state, 'idle')
  assert.ok(s.events.some((e) => e.type === 'interrupt_requested' && e.source === 'abandoned'))
})

test('a hung interrupt RPC times out, preserves partial output and ignores its late completion', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  const turnId = s.activeTurnId!
  s.live = { activity: 'responding', partialText: 'partial', updatedAt: Date.now() }
  provider.interrupt = () => new Promise(() => {})
  assert.equal(await s.stop(provider, 'shutdown', { graceMs: 10, killMs: 10 }), 'timed_out')
  const end: any = s.events.at(-1)
  assert.deepEqual([end.reason, end.status, end.finalText], ['stop_timeout', 'interrupted', 'partial'])
  assert.equal(s.info.state, 'detached')
  const seq = s.lastSeq
  s.push({ type: 'turn_completed', turnId, status: 'completed', reason: 'end_turn', finalText: 'late' })
  assert.equal(s.lastSeq, seq)
})

test('a turn ending during input acceptance reports the delivery returned by the provider', async () => {
  const s = session(), { provider } = fake(true)
  await s.deliver(provider, 'first')
  provider.sendInput = async () => {
    complete(s)
    s.push({ type: 'turn_started', turnId: 'next' })
    return 'started'
  }
  const receipt = await s.deliver(provider, 'new turn')
  assert.equal(receipt.delivery, 'started')
  const input: any = s.events.find((e) => e.type === 'user_input' && e.inputId === receipt.inputId)
  assert.equal(input.delivery, 'started')
  const consumed: any = s.events.find((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId)
  assert.equal(consumed.turnId, 'next')
})

test('a provider crash closes the turn and drops queued inputs', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  const receipt = await s.deliver(provider, 'queued')
  s.push({ type: 'session_failed', error: 'App exited' })
  const end: any = s.events.find((e) => e.type === 'turn_completed')
  assert.equal(end.reason, 'crashed')
  assert.equal(end.continues, undefined)
  assert.ok(s.events.some((e) => e.type === 'input_dropped' && e.inputId === receipt.inputId))
  assert.equal(s.info.state, 'failed')
})

test('inputs arriving while stopping are queued and consumed after confirmation', async () => {
  const s = session(), { provider, sent } = fake()
  await s.deliver(provider, 'first')
  provider.interrupt = async () => {}
  const stopped = s.stop(provider, 'host', { graceMs: 1000 })
  const receipt = await s.deliver(provider, 'during stop')
  assert.equal(receipt.delivery, 'queued')
  complete(s)
  assert.equal(await stopped, 'graceful')
  await settle()
  assert.deepEqual(sent, ['first', 'during stop'])
  assert.equal(s.events.filter((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId).length, 1)
})

test('draining and concurrent delivery share one FIFO even when turn startup is asynchronous', async () => {
  const s = session(), { provider, sent } = fake()
  await s.deliver(provider, 'first')
  const queued = await s.deliver(provider, 'second')
  complete(s)
  const original = provider.sendInput
  provider.sendInput = async (s, text) => {
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(s.activeTurnId, null)
    return original(s, text)
  }
  const next = await s.deliver(provider, 'third')
  assert.equal(next.delivery, 'queued')
  assert.deepEqual(sent, ['first', 'second'])
  complete(s)
  await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(sent, ['first', 'second', 'third'])
  const consumed = s.events.filter((e) => e.type === 'input_consumed') as any[]
  assert.equal(consumed.find((e) => e.inputId === queued.inputId).turnId, 't2')
  assert.equal(consumed.find((e) => e.inputId === next.inputId).turnId, 't3')
})

test('forced restart reattaches before draining and input fate precedes completion', async () => {
  const s = session(), { provider, sent } = fake()
  await s.deliver(provider, 'first')
  provider.interrupt = async () => {}
  provider.kill = () => { s.detach(); complete(s); return true }
  let attached = 0
  provider.attach = async () => { attached++; assert.equal(s.info.state, 'detached') }
  const stop = s.stop.bind(s)
  s.stop = (p, source, options) => stop(p, source, { ...options, graceMs: 5, killMs: 50 })
  const receipt = await s.deliver(provider, 'continue', 'interrupt')
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(attached, 1)
  assert.equal(s.info.state, 'running')
  assert.match(sent[1], /lead interrupted.*\ncontinue/)
  const consumed = s.events.find((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId)!
  const end = complete(s)
  assert.ok(consumed.seq < end.seq)
})

test('a refused kill is not reported forced and stop_timeout is never rewritten to restarted', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  provider.interrupt = async () => {}
  provider.kill = () => false
  const stop = s.stop.bind(s)
  s.stop = (p, source, options) => stop(p, source, { ...options, graceMs: 5, killMs: 5 })
  const restart = await s.deliver(provider, 'restart', 'interrupt')
  const queued = await s.deliver(provider, 'queued during stop')
  await new Promise((r) => setTimeout(r, 30))
  const end: any = s.events.find((e) => e.type === 'turn_completed')
  assert.equal(end.reason, 'stop_timeout')
  assert.equal(end.continues, false)
  for (const inputId of [restart.inputId, queued.inputId]) {
    const fate = s.events.filter((e) => (e.type === 'input_dropped' || e.type === 'input_consumed') && e.inputId === inputId)
    assert.equal(fate.length, 1)
    assert.equal(fate[0].type, 'input_dropped')
    assert.ok(fate[0].seq < end.seq)
  }
  const other = session()
  await other.deliver(provider, 'hello')
  provider.kill = () => { setImmediate(() => complete(other)); return false }
  assert.equal(await other.stop(provider, 'host', { graceMs: 5, killMs: 100 }), 'graceful')
})

test('stop asks an adapter that is busy before the session has a turn id', async () => {
  const s = session(), { provider } = fake()
  let busy = true, calls = 0
  provider.isBusy = () => busy
  provider.interrupt = async () => { calls++; busy = false }
  assert.equal(await s.stop(provider, 'host', { graceMs: 5 }), 'graceful')
  assert.equal(calls, 1)
})

test('a provider completing inside sendInput still publishes exactly one fate before turn completion', async () => {
  const s = session(), { provider } = fake()
  provider.sendInput = async () => {
    s.push({ type: 'turn_started', turnId: 'fast' })
    complete(s)
    return 'started'
  }
  const receipt = await s.deliver(provider, 'instant')
  const input: any = s.events.find((e) => e.type === 'user_input')
  const consumed: any = s.events.find((e) => e.type === 'input_consumed')
  const end: any = s.events.find((e) => e.type === 'turn_completed')
  assert.equal(input.inputId, receipt.inputId)
  assert.ok(input.seq < consumed.seq && consumed.seq < end.seq)
  assert.equal(s.events.filter((e) => e.type === 'input_dropped').length, 0)
})

test('stop during attach drops the waiting input and does not start a turn afterwards', async () => {
  const s = session(), { provider, sent } = fake()
  s.detach()
  let release: () => void, loading = false
  provider.attach = async () => { loading = true; await new Promise<void>((r) => release = r); loading = false }
  provider.isBusy = () => loading
  provider.interrupt = async () => { release() }
  const delivery = s.deliver(provider, 'waiting for attach')
  await settle()
  const stopped = s.stop(provider, 'host', { graceMs: 100 })
  const receipt = await delivery
  assert.equal(await stopped, 'graceful')
  assert.equal(receipt.delivery, 'queued')
  assert.deepEqual(sent, [])
  assert.equal(s.events.filter((e) => e.type === 'input_dropped' && e.inputId === receipt.inputId).length, 1)
})

test('queued input is consumed at turn start even when the start reply is still pending during stop', async () => {
  const s = session(), { provider } = fake()
  await s.deliver(provider, 'first')
  const input = await s.deliver(provider, 'queued')
  let reply: () => void
  provider.sendInput = async () => {
    s.push({ type: 'turn_started', turnId: 'queued-turn' })
    await new Promise<void>((r) => reply = r)
    return 'started'
  }
  complete(s)
  await settle()
  assert.ok(s.events.some((e) => e.type === 'input_consumed' && e.inputId === input.inputId))
  assert.equal(await s.stop(provider, 'host'), 'graceful')
  reply()
  await settle()
  const fates = s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === input.inputId)
  assert.equal(fates.length, 1)
  assert.equal(fates[0].type, 'input_consumed')
  const end = s.events.find((e) => e.type === 'turn_completed' && e.turnId === 'queued-turn')!
  assert.ok(fates[0].seq < end.seq)
})

test('a start notification before an RPC error consumes its input instead of reporting a false drop', async () => {
  const s = session(), { provider } = fake()
  provider.sendInput = async () => {
    s.push({ type: 'turn_started', turnId: 'started' })
    complete(s)
    throw new Error('start reply lost')
  }
  await assert.rejects(s.deliver(provider, 'ran before reply'), /start reply lost/)
  const input: any = s.events.find((e) => e.type === 'user_input')
  const fates = s.events.filter((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === input.inputId)
  assert.equal(input.delivery, 'started')
  assert.equal(fates.length, 1)
  assert.equal(fates[0].type, 'input_consumed')
  assert.ok(fates[0].seq < s.events.at(-1)!.seq)
})
