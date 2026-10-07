// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Released leases drop sessions at once; expired leases hold them for a returning host.
// Dispose sessions only after they stop running.
import type { Provider } from './provider.ts'
import { Session } from './session.ts'
import type { Store } from './store.ts'

export const LEASE_TTL_MS = 30_000
export const HOLD_MS = 5 * 60_000

export type Lease = { host: string; profile: string; hostSessionId: string; expires: number }

export type SessionSummary = { id: string; agent: string; harness: string; model: string; state: string; leaseId: string | null }

export class SessionTable {
  readonly leases = new Map<string, Lease>()
  readonly sessions = new Map<string, Session>()
  private cache = new Map<string, Session>()
  private leaseOf = new Map<string, string>()
  private held = new Map<string, { hostSessionId: string; until: number }>()
  private closing = new Set<Session>() // Dispose once stopped.
  private providerFor: (s: Session) => Provider | undefined
  private log: (msg: string) => void
  private now: () => number

  constructor(providerFor: (s: Session) => Provider | undefined, log: (msg: string) => void, now: () => number = Date.now) {
    this.providerFor = providerFor
    this.log = log
    this.now = now
  }

  addLease(id: string, lease: Omit<Lease, 'expires'>) {
    this.leases.set(id, { ...lease, expires: this.now() + LEASE_TTL_MS })
    if (!lease.hostSessionId) return
    for (const [sid, h] of this.held) {
      if (h.hostSessionId !== lease.hostSessionId) continue
      this.held.delete(sid)
      this.leaseOf.set(sid, id)
      const session = this.sessions.get(sid)
      if (session) { session.info.leaseId = id; session.save() }
      this.log(`session ${sid}: taken over by lease ${id}`)
    }
  }

  renew(id: string): boolean {
    const lease = this.leases.get(id)
    if (lease) lease.expires = this.now() + LEASE_TTL_MS
    return !!lease
  }

  release(id: string): boolean {
    if (!this.leases.delete(id)) return false
    this.log(`lease ${id} released`)
    for (const sid of this.sessionsOf(id)) this.close(sid, `lease ${id} released`)
    return true
  }

  add(session: Session, leaseId: string) {
    this.cache.set(session.info.id, session)
    this.sessions.set(session.info.id, session)
    this.leaseOf.set(session.info.id, leaseId)
    session.info.leaseId = leaseId
    session.save()
    if (!this.leases.has(leaseId)) this.close(session.info.id, `lease ${leaseId} ended while it started`)
  }

  get(id: string): Session | undefined {
    return this.cache.get(id) ?? this.sessions.get(id) ?? [...this.closing].find((s) => s.info.id === id)
  }

  load(id: string, store: Store): Session | undefined {
    let session = this.get(id)
    if (!session) {
      session = Session.load(id, store) ?? undefined
      if (session) this.cache.set(id, session)
    }
    return session
  }

  attach(session: Session, leaseId: string, claudeSession?: string) {
    this.closing.delete(session)
    this.held.delete(session.info.id)
    session.info.closedAt = null
    session.info.closeReason = null
    if (claudeSession !== undefined) session.info.claudeSession = claudeSession
    this.add(session, leaseId)
  }

  leaseIdOf(sessionId: string): string | null {
    return this.leaseOf.get(sessionId) ?? null
  }

  close(sessionId: string, why: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    this.sessions.delete(sessionId)
    this.leaseOf.delete(sessionId)
    this.held.delete(sessionId)
    this.log(`session ${sessionId}: let go (${why})`)
    this.closing.add(s)
    s.info.closedAt = this.now()
    s.info.closeReason = why
    s.info.leaseId = null
    s.save()
    if (s.activeTurnId || this.providerFor(s)?.isBusy?.(s)) {
      void s.stop(this.providerFor(s), why.startsWith('lease') || why.includes('host') ? 'lease' : 'host').then(() => this.sweep())
      void this.disposeWhenStopped(s)
    }
    this.sweep()
    return true
  }

  // Include removed sessions until they stop, so shutdown still sees them.
  running(): Session[] {
    return [...this.sessions.values(), ...this.closing].filter((s) => (s.info.state === 'running' || s.info.state === 'stopping'))
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.info.id,
      agent: s.info.agent,
      harness: s.info.harness,
      model: s.info.model,
      state: s.info.state,
      leaseId: this.leaseIdOf(s.info.id),
    }))
  }

  tick() {
    const now = this.now()
    for (const [id, l] of this.leases) {
      if (l.expires >= now) continue
      this.leases.delete(id)
      this.log(`lease ${id} expired`)
      const successor = [...this.leases].find(([, other]) => l.hostSessionId && other.hostSessionId === l.hostSessionId)?.[0]
      for (const sid of this.sessionsOf(id)) {
        const s = this.sessions.get(sid)!
        if (s.info.state === 'running' || s.info.state === 'stopping') {
          this.log(`lease ${id} ended; interrupting ${sid}`)
          void s.stop(this.providerFor(s), 'lease')
        }
        if (successor) {
          this.leaseOf.set(sid, successor)
          s.info.leaseId = successor
          s.save()
          continue
        }
        this.leaseOf.delete(sid)
        s.info.leaseId = null
        s.save()
        this.held.set(sid, { hostSessionId: l.hostSessionId, until: now + HOLD_MS })
      }
    }
    for (const [sid, h] of this.held) if (h.until < now) this.close(sid, 'its host did not come back')
    this.sweep()
    for (const [id, session] of this.cache) {
      if (!this.sessions.has(id) && !this.closing.has(session) && !session.activeTurnId && now - session.lastSeenAt > HOLD_MS) this.cache.delete(id)
    }
  }

  retainCache(store: Store) {
    for (const [id, session] of this.cache) if (!this.sessions.has(id) && !this.closing.has(session) && !store.has(id)) this.cache.delete(id)
  }

  private sessionsOf(leaseId: string): string[] {
    return [...this.leaseOf].filter(([, lid]) => lid === leaseId).map(([sid]) => sid)
  }

  // Dispose as soon as events report a stop; tick catches missed stops.
  private async disposeWhenStopped(s: Session) {
    let seen = s.lastSeq
    while (this.closing.has(s) && (s.info.state === 'running' || s.info.state === 'stopping')) {
      const more = await s.eventsAfter(seen, 10_000)
      if (!more.length) return
      seen = s.lastSeq
    }
    this.sweep()
  }

  private sweep() {
    for (const s of this.closing) {
      if (s.info.state === 'running' || s.info.state === 'stopping') continue
      this.closing.delete(s)
      try {
        this.providerFor(s)?.disposeSession?.(s)
        s.detach()
      } catch (e) {
        this.log(`session ${s.info.id}: could not let go: ${(e as Error).message}`)
      }
    }
  }
}
