// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import type { AgentEvent, AgentEventBody } from './events.ts'

export type SessionInfo = {
  id: string
  harness: string
  agent: string
  model: string
  cwd: string
  state: 'running' | 'idle' | 'failed'
}

export class Session {
  info: SessionInfo
  events: AgentEvent[] = []
  activeTurnId: string | null = null
  // The daemon stops running sessions when the host stops polling them.
  lastSeenAt = Date.now()
  private waiters = new Set<() => void>()

  constructor(info: SessionInfo) {
    this.info = info
  }

  push(body: AgentEventBody, ext?: Record<string, unknown>): AgentEvent {
    const ev = { ...body, seq: this.events.length + 1, ts: Date.now(), ...(ext ? { ext } : {}) } as AgentEvent
    this.events.push(ev)
    if (body.type === 'turn_started') {
      this.activeTurnId = body.turnId
      this.info.state = 'running'
    } else if (body.type === 'turn_completed') {
      this.activeTurnId = null
      this.info.state = 'idle'
    } else if (body.type === 'session_failed') {
      this.activeTurnId = null
      this.info.state = 'failed'
    }
    for (const wake of this.waiters) wake()
    return ev
  }

  async eventsAfter(after: number, waitMs: number): Promise<AgentEvent[]> {
    const ready = () => this.events.slice(after)
    if (this.events.length > after || waitMs <= 0) return ready()
    await this.wait(waitMs, () => this.events.length > after)
    return ready()
  }

  async itemCompletion(itemId: string, waitMs: number): Promise<AgentEvent | null> {
    const find = () =>
      this.events.find((e) => (e.type === 'command_completed' || e.type === 'tool_completed') && e.itemId === itemId) ??
      // Return the turn completion if it ended without finishing this item.
      (this.events.some((e) => 'itemId' in e && e.itemId === itemId)
        ? this.events.find((e, i) => e.type === 'turn_completed' && i > this.indexOfItem(itemId))
        : undefined) ??
      null
    if (find() || waitMs <= 0) return find()
    await this.wait(waitMs, () => find() !== null)
    return find()
  }

  private indexOfItem(itemId: string): number {
    return this.events.findIndex((e) => 'itemId' in e && e.itemId === itemId)
  }

  private wait(waitMs: number, done: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve()
      }
      const check = () => {
        if (done()) finish()
      }
      const timer = setTimeout(finish, waitMs)
      this.waiters.add(check)
    })
  }
}
