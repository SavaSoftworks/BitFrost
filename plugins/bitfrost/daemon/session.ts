// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventBody, Delivery } from './events.ts'
import type { Provider } from './provider.ts'
import type { Store } from './store.ts'

export type SessionInfo = {
  id: string
  harness: string
  agent: string
  model: string
  cwd: string
  state: 'running' | 'idle' | 'stopping' | 'failed' | 'detached'
  effort?: string | null
  plan?: string | null
  title?: string | null
  claudeSession?: string | null
  claudeAgent?: string | null
  leaseId?: string | null
  parentMode?: string | null
  createdAt?: number
  updatedAt?: number
  closedAt?: number | null
  closeReason?: string | null
}

type Input = { id: string; text: string; delivery: Delivery; provider?: Provider; dispatched?: boolean; turnId?: string | null }
type InputReceipt = { inputId: string; delivery: Delivery }
export type StopHow = 'graceful' | 'forced' | 'timed_out' | 'idle'

// One prompt for every message waiting for the next turn.
function batchText(batch: Input[]): string {
  const many = batch.length > 1
  const head = batch.some((i) => i.delivery === 'restarted')
    ? `The lead interrupted you to deliver ${many ? 'these messages' : 'this message'}. Continue the task with ${many ? 'them' : 'it'} in mind.`
    : many ? 'The lead sent these messages while you were working, oldest first:' : ''
  const body = many ? batch.map((i, n) => `${n + 1}. ${i.text}`).join('\n\n') : batch[0].text
  return head ? `${head}\n${body}` : body
}

export class Session {
  info: SessionInfo
  events: AgentEvent[] = []
  activeTurnId: string | null = null
  nativeRef: any = null
  live: { activity: string | null; partialText: string | null; updatedAt: number } | null = null
  lastSeq = 0
  lastSeenAt = Date.now()
  private store?: Store
  private waiters = new Set<() => void>()
  private turnListeners = new Set<(event: AgentEvent) => void>()
  private queue: Input[] = []
  private settledInputs = new Set<string>()
  private receipts = new Map<string, InputReceipt>()
  private deliveries = new Map<string, Promise<InputReceipt>>()
  private restartTurnId: string | null = null
  private stopping: Promise<StopHow> | null = null
  private attaching: Promise<void> | null = null
  private sending: Promise<unknown> = Promise.resolve()
  private dispatching = false
  private stopVersion = 0
  private cancelledSend = false
  private captured: { body: AgentEventBody; ext?: Record<string, unknown> }[] | null = null

  constructor(info: SessionInfo, store?: Store) {
    this.info = { createdAt: Date.now(), updatedAt: Date.now(), ...info }
    this.store = store
  }

  static load(id: string, store: Store): Session | null {
    const saved = store.load(id)
    if (!saved) return null
    const s = new Session(saved.info as SessionInfo, store)
    s.events = saved.events
    s.lastSeq = saved.lastSeq
    s.nativeRef = saved.nativeRef
    for (const e of s.events) {
      if (e.type === 'input_consumed' || e.type === 'input_dropped') s.settledInputs.add(e.inputId)
      if (e.type === 'user_input' && e.clientInputId !== undefined) s.receipts.set(e.clientInputId, { inputId: e.inputId, delivery: e.delivery })
    }
    return s
  }

  hasTurnStarted(turnId: string) {
    return this.events.some((e) => e.type === 'turn_started' && e.turnId === turnId) || !!this.captured?.some((e) => e.body.type === 'turn_started' && e.body.turnId === turnId)
  }

  hasPendingInput() { return this.queue.length > 0 }
  onTurnCompleted(listener: (event: AgentEvent) => void) {
    this.turnListeners.add(listener)
    return () => { this.turnListeners.delete(listener) }
  }

  save() {
    if (!this.info.id) return
    try { this.store?.saveSession(this) } catch (e) { this.store?.degrade(e, this) }
  }
  setNativeRef(ref: any) { this.nativeRef = ref; this.save() }
  detach() {
    this.info.state = 'detached'
    this.info.closedAt ??= Date.now()
    this.info.closeReason ??= 'provider_exit'
    this.info.updatedAt = Date.now()
    this.save()
  }

  push(body: AgentEventBody, ext?: Record<string, unknown>): AgentEvent {
    if (this.captured && !['user_input', 'input_consumed', 'input_dropped', 'interrupt_requested'].includes(body.type) && !(body.type === 'turn_completed' && body.reason === 'stop_timeout')) {
      this.captured.push({ body, ext })
      if (body.type === 'turn_started') this.activeTurnId = body.turnId
      else if (body.type === 'turn_completed' && this.activeTurnId === body.turnId) this.activeTurnId = null
      return { ...body, seq: this.lastSeq + this.captured.length, ts: Date.now() } as AgentEvent
    }
    if (body.type === 'input_consumed' || body.type === 'input_dropped') {
      if (this.settledInputs.has(body.inputId)) return this.events.find((e) => (e.type === 'input_consumed' || e.type === 'input_dropped') && e.inputId === body.inputId)!
      this.settledInputs.add(body.inputId)
      this.queue = this.queue.filter((i) => i.id !== body.inputId)
    }
    if (body.type === 'session_failed') {
      this.restartTurnId = null
      this.dropInputs()
      if (this.activeTurnId) this.push({ type: 'turn_completed', turnId: this.activeTurnId, status: 'failed', reason: 'crashed', finalText: this.live?.partialText ?? '', error: body.error })
    }
    if (body.type === 'turn_completed') {
      const old = this.events.find((e) => e.type === 'turn_completed' && e.turnId === body.turnId)
      if (old) return old
      for (const input of [...this.queue]) if (input.dispatched && (!input.turnId || input.turnId === body.turnId)) this.push({ type: 'input_dropped', inputId: input.id })
      if (body.reason === 'stop_timeout') {
        // A send still in flight started this turn; its replay must not revive it.
        if (this.captured?.some((e) => e.body.type === 'turn_started' && e.body.turnId === body.turnId)) this.captured = []
        this.restartTurnId = null
        this.dropInputs()
        body = { ...body, continues: false }
      } else if (body.turnId === this.restartTurnId) body = { ...body, status: 'interrupted', reason: 'restarted', continues: this.queue.length > 0 }
      else if (this.queue.length) body = { ...body, continues: true }
    }
    const turnId = 'turnId' in body ? body.turnId : this.activeTurnId
    const ev = { ...body, seq: ++this.lastSeq, ts: Date.now(), ...(ext ? { ext } : {}) } as AgentEvent
    if (body.type === 'turn_started') {
      this.activeTurnId = body.turnId
      this.info.state = this.stopping ? 'stopping' : 'running'
      this.info.closedAt = null
      this.info.closeReason = null
    } else if (body.type === 'turn_completed') {
      if (this.activeTurnId === body.turnId) this.activeTurnId = null
      if (this.info.state !== 'detached' && !this.activeTurnId) this.info.state = 'idle'
    } else if (body.type === 'session_failed') {
      this.activeTurnId = null
      if (this.info.state !== 'detached') this.info.state = 'failed'
    }
    this.info.updatedAt = ev.ts
    this.events.push(ev)
    if (body.type === 'user_input' && body.clientInputId !== undefined) this.receipts.set(body.clientInputId, { inputId: body.inputId, delivery: body.delivery })
    try { this.store?.push(this, ev, turnId) } catch (e) { this.store?.degrade(e, this) }
    if (body.type === 'turn_started') {
      for (const input of [...this.queue]) if (input.dispatched && (!input.turnId || input.turnId === body.turnId)) this.push({ type: 'input_consumed', inputId: input.id, turnId: body.turnId })
    }
    if (body.type === 'turn_completed') {
      this.live = null
      if (body.turnId === this.restartTurnId) this.restartTurnId = null
      this.scheduleDrain()
      for (const listener of this.turnListeners) listener(ev)
    }
    for (const wake of this.waiters) wake()
    return ev
  }

  acceptInput(text: string, delivery: Delivery, sender: 'claude' | 'user' = 'claude', clientInputId?: string): Input {
    const input = { id: randomUUID(), text, delivery, dispatched: delivery === 'started' }
    this.queue.push(input)
    this.push({ type: 'user_input', inputId: input.id, ...(clientInputId !== undefined ? { clientInputId } : {}), text, sender, delivery })
    return input
  }

  queueInput(provider: Provider, text: string) {
    if (this.dispatching) return
    const input = this.acceptInput(text, 'queued')
    input.provider = provider
    this.scheduleDrain()
  }

  dropInputs(pendingOnly = false) {
    for (const input of [...this.queue]) if (!pendingOnly || !input.dispatched) this.push({ type: 'input_dropped', inputId: input.id })
  }

  async attach(provider: Provider) {
    if (this.info.state !== 'detached') return
    await (this.attaching ??= (async () => {
      if (!provider.attach) throw new Error(`${provider.displayName} can't reopen this session`)
      await provider.attach(this, this.nativeRef)
      this.info.state = 'idle'
      this.info.closedAt = null
      this.info.closeReason = null
      this.info.updatedAt = Date.now()
      this.save()
      for (const wake of this.waiters) wake()
    })().finally(() => this.attaching = null))
  }

  inputReceipt(clientInputId: string): InputReceipt | null {
    const receipt = this.receipts.get(clientInputId) ?? this.store?.inputReceipt(this.info.id, clientInputId) ?? null
    if (receipt) this.receipts.set(clientInputId, receipt)
    return receipt
  }

  deliver(provider: Provider, text: string, mode: 'auto' | 'queue' | 'interrupt' = 'auto', sender: 'claude' | 'user' = 'claude', clientInputId?: string): Promise<InputReceipt> {
    if (clientInputId === undefined) return this.deliverInput(provider, text, mode, sender)
    const receipt = this.inputReceipt(clientInputId)
    if (receipt) return Promise.resolve(receipt)
    const pending = this.deliveries.get(clientInputId)
    if (pending) return pending
    const job = this.deliverInput(provider, text, mode, sender, clientInputId)
    this.deliveries.set(clientInputId, job)
    void job.then(() => this.deliveries.delete(clientInputId), () => this.deliveries.delete(clientInputId))
    return job
  }

  private deliverInput(provider: Provider, text: string, mode: 'auto' | 'queue' | 'interrupt', sender: 'claude' | 'user', clientInputId?: string): Promise<InputReceipt> {
    if (this.stopping || this.info.state === 'stopping') {
      const input = this.acceptInput(text, 'queued', sender, clientInputId)
      input.provider = provider
      this.scheduleDrain()
      return Promise.resolve({ inputId: input.id, delivery: input.delivery })
    }
    const job = this.sending.then(async () => {
      const version = this.stopVersion
      if (this.info.state === 'stopping' || this.stopping || (!this.activeTurnId && this.queue.some((i) => !i.dispatched))) {
        const input = this.acceptInput(text, 'queued', sender, clientInputId)
        input.provider = provider
        this.scheduleDrain()
        return { inputId: input.id, delivery: input.delivery }
      }
      await this.attach(provider)
      if (version !== this.stopVersion) {
        const input = this.acceptInput(text, 'queued', sender, clientInputId)
        this.push({ type: 'input_dropped', inputId: input.id })
        return { inputId: input.id, delivery: input.delivery }
      }
      const active = !!this.activeTurnId || !!provider.isBusy?.(this)
      const delivery: Delivery = !active ? 'started' : mode === 'interrupt' ? 'restarted' : mode === 'auto' && provider.capabilities.steer ? 'steered' : 'queued'
      if (delivery === 'queued' || delivery === 'restarted') {
        const input = this.acceptInput(text, delivery, sender, clientInputId)
        input.provider = provider
        if (delivery === 'restarted') {
          this.restartTurnId = this.activeTurnId
          // Fake steering wheel: stop, then resume the same native session.
          void this.stop(provider, 'host', { preserveQueue: true }).catch(() => {})
        }
        return { inputId: input.id, delivery }
      }
      return this.send(provider, text, sender, undefined, clientInputId)
    })
    this.sending = job.catch(() => {})
    return job
  }

  private async send(provider: Provider, text: string, sender: 'claude' | 'user', queued?: Input[], clientInputId?: string) {
    const active = this.activeTurnId
    const state = this.info.state
    if (queued) {
      for (const q of queued) q.dispatched = true
      this.dispatching = true
      try {
        const actual = await provider.sendInput(this, text)
        if (actual === 'queued') for (const q of queued) q.dispatched = false
        if (actual === 'steered' && this.activeTurnId) for (const q of queued) this.push({ type: 'input_consumed', inputId: q.id, turnId: this.activeTurnId })
        return { inputId: queued[0].id, delivery: queued[0].delivery }
      } catch (error) {
        for (const q of queued) this.push({ type: 'input_dropped', inputId: q.id })
        throw error
      } finally {
        this.dispatching = false
        for (const wake of this.waiters) wake()
      }
    }
    this.cancelledSend = false
    this.dispatching = true
    // Publish the receipt and input fate before replaying adapter completions.
    this.captured = []
    let actual: 'started' | 'steered' | 'queued'
    let failure: unknown
    try { actual = await provider.sendInput(this, text) }
    catch (e) { failure = e; actual = 'queued' }
    finally { this.dispatching = false }
    const captured = this.captured
    this.captured = null
    const detached = this.info.state === 'detached'
    this.activeTurnId = active
    this.info.state = detached ? 'detached' : state
    const started = captured?.find((e) => e.body.type === 'turn_started')?.body
    if (failure && started) actual = 'started'
    const input = this.acceptInput(text, actual!, sender, clientInputId)
    input.provider = provider
    input.dispatched = actual! === 'started'
    input.turnId = started?.type === 'turn_started' ? started.turnId : null
    if (actual! === 'steered' && active) this.push({ type: 'input_consumed', inputId: input.id, turnId: active })
    if ((failure || this.cancelledSend) && !started && actual! !== 'steered') this.push({ type: 'input_dropped', inputId: input.id })
    for (const event of captured ?? []) this.push(event.body, event.ext)
    if (failure) {
      this.scheduleDrain()
      throw failure
    }
    return { inputId: input.id, delivery: actual! }
  }

  private scheduleDrain() {
    if (!this.queue.some((i) => i.provider && !i.dispatched)) return
    const job = this.sending.then(async () => {
      if (this.stopping) await this.stopping
      if (this.activeTurnId) return
      const first = this.queue.find((i) => !i.dispatched)
      const provider = first?.provider
      if (!provider) return
      // Everything waiting goes in one turn, oldest first, so no message waits behind another.
      let batch = this.queue.filter((i) => !i.dispatched && i.provider === provider)
      try {
        await this.attach(provider)
        batch = batch.filter((i) => !this.settledInputs.has(i.id))
        if (!batch.length || this.activeTurnId || provider.isBusy?.(this)) return
        await this.send(provider, batchText(batch), 'claude', batch)
      } catch (e) {
        for (const i of batch) this.push({ type: 'input_dropped', inputId: i.id })
        this.push({ type: 'session_failed', error: (e as Error).message })
      }
    })
    this.sending = job.catch(() => {})
  }

  stop(provider: Provider | undefined, source: string, { graceMs = 10_000, killMs = 2_000, preserveQueue = false } = {}): Promise<StopHow> {
    if (!preserveQueue) { this.stopVersion++; if (this.captured) this.cancelledSend = true; this.restartTurnId = null; this.dropInputs(true) }
    this.push({ type: 'interrupt_requested', source })
    if (this.stopping) return this.stopping
    if (!this.activeTurnId && !provider?.isBusy?.(this) && !this.dispatching) {
      if (this.info.state === 'running' || this.info.state === 'stopping') { this.info.state = 'idle'; this.save() }
      return Promise.resolve('idle')
    }
    const turnId = this.activeTurnId
    this.info.state = 'stopping'
    this.save()
    const ended = () => turnId ? this.events.some((e) => e.type === 'turn_completed' && e.turnId === turnId) : !this.activeTurnId && !provider?.isBusy?.(this) && !this.dispatching
    try { void provider?.interrupt(this).catch(() => {}) } catch {}
    this.stopping = (async () => {
      if (!ended()) await this.wait(graceMs, ended)
      if (ended()) return 'graceful'
      let forced = false
      try { if (provider?.kill) forced = provider.kill(this) === true } catch {}
      if (!ended()) await this.wait(killMs, ended)
      if (ended()) return forced ? 'forced' : 'graceful'
      this.dropInputs()
      if (this.activeTurnId) this.push({ type: 'turn_completed', turnId: this.activeTurnId, status: 'interrupted', reason: 'stop_timeout', finalText: this.live?.partialText ?? '' })
      try { provider?.disposeSession?.(this) } catch {}
      this.detach()
      return 'timed_out'
    })().finally(() => {
      this.stopping = null
      if (this.info.state === 'stopping' && !this.activeTurnId) { this.info.state = 'idle'; this.save() }
      this.scheduleDrain()
    })
    return this.stopping
  }

  async eventsAfter(after: number, waitMs: number): Promise<AgentEvent[]> {
    const ready = () => this.events.slice(Math.max(0, after - (this.events[0]?.seq ?? 1) + 1))
    if (this.lastSeq > after || waitMs <= 0 || this.info.state === 'detached') return ready()
    await this.wait(waitMs, () => this.lastSeq > after)
    return ready()
  }

  async itemCompletion(itemId: string, waitMs: number): Promise<AgentEvent | null> {
    const find = () =>
      this.events.find((e) => (e.type === 'command_completed' || e.type === 'tool_completed') && e.itemId === itemId) ??
      (this.events.some((e) => 'itemId' in e && e.itemId === itemId)
        ? this.events.find((e, i) => e.type === 'turn_completed' && i > this.events.findIndex((e) => 'itemId' in e && e.itemId === itemId))
        : undefined) ?? null
    if (find() || waitMs <= 0 || this.info.state === 'detached') return find()
    await this.wait(waitMs, () => find() !== null)
    return find()
  }

  private wait(waitMs: number, done: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(check); resolve() }
      const check = () => { if (done()) finish() }
      const timer = setTimeout(finish, waitMs)
      this.waiters.add(check)
    })
  }
}
