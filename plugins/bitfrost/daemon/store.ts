// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, Delivery } from './events.ts'
import type { Session } from './session.ts'

type Row = Record<string, any>
const DAY = 24 * 60 * 60_000
const parse = (value: string | null) => value ? JSON.parse(value) : null
const detail = (value: unknown) => {
  const json = JSON.stringify(value ?? null)
  if (Buffer.byteLength(json) <= 64 * 1024) return json
  return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(json), preview: Buffer.from(json).subarray(0, 16 * 1024).toString('utf8') })
}
// Usage rolls up by local hour; days are the local days SQLite's 'localtime' gives.
export const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const hourOf = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
}
// The rebuild buckets with the same hourOf as live writes, so a repeated autumn hour can't split in two.
const LOCAL_HOUR = (col: string) => `local_hour(${col})`
const open = (file: string) => {
  const db = new DatabaseSync(file)
  db.function('local_hour', (ms: unknown) => (ms == null ? null : hourOf(Number(ms))))
  return db
}
const USAGE = ['sessions', 'closed_sessions', 'session_ms', 'turns', 'failed_turns', 'turn_ms', 'requests', 'input_tokens', 'output_tokens', 'cached_tokens'] as const
// updated_at is a store-wide stamp that only grows, so a reader can ask for what changed since it last looked.
// Persistent upgrades run in the COBOL engine during installation.
export class MigrationRequiredError extends Error {
  constructor(version: number) {
    super(`BitFrost database schema ${version} needs migration to ${VERSION}; run bitfrost migrate or reinstall this release`)
  }
}
type Usage = Extract<AgentEvent, { type: 'usage' }>
type Bill = { input: number; output: number; cached: number; requests: number }
export function billed(last: Bill | undefined, e: Usage) {
  const u = e.billing ?? e
  const next: Bill = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0, requests: e.billing?.requests ?? 1 }
  const previous = last ?? { input: 0, output: 0, cached: 0, requests: 0 }
  return { input: Math.max(0, next.input - previous.input), output: Math.max(0, next.output - previous.output),
    cached: Math.max(0, next.cached - previous.cached), requests: Math.max(0, next.requests - previous.requests),
    last: { input: Math.max(next.input, previous.input), output: Math.max(next.output, previous.output),
      cached: Math.max(next.cached, previous.cached), requests: Math.max(next.requests, previous.requests) } }
}
// Only what a subagent row shows, so lists never read the rest of a session.
const ROW = 'id,harness,agent,model,effort,title,state,created_at,closed_at,close_reason,changed_at,tokens,cached_tokens,turns,tool_calls,active_ms'
// A list of ids bound as one JSON value, so the statement is prepared once whatever the count.
const IDS = 'SELECT value FROM json_each(?)'
const statusOf = (e: Row) => e.ok === false || ['failed', 'error'].includes(e.status) ? 'error' : e.status === 'declined' ? 'declined' : 'ok'

const VERSION = 8
const EVENT_BYTES = 256 * 1024
const bodyJSON = (e: AgentEvent) => {
  const json = JSON.stringify(e)
  if (Buffer.byteLength(json) <= EVENT_BYTES) return json
  let budget = 48 * 1024
  const trim = (value: any, depth = 0): any => {
    if (typeof value === 'string') {
      const bytes = Buffer.from(value)
      const take = Math.min(bytes.length, Math.max(0, budget), 32 * 1024)
      budget -= take
      return take < bytes.length ? bytes.subarray(0, take).toString('utf8') + '\n[truncated]' : value
    }
    budget -= 16
    if (depth > 8 || budget <= 0) return '[truncated]'
    if (Array.isArray(value)) return value.slice(0, 64).map((x) => trim(x, depth + 1))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([k, v]) => [k.slice(0, 128), trim(v, depth + 1)]))
    return value
  }
  const clipped = JSON.stringify({ ...trim(e), truncated: true, originalBytes: Buffer.byteLength(json) })
  if (Buffer.byteLength(clipped) <= EVENT_BYTES) return clipped
  const fallback = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'ext').map(([k, v]) => [k.slice(0, 128), typeof v === 'string' ? v.slice(0, 1024) : typeof v === 'object' ? '[truncated]' : v]))
  return JSON.stringify({ ...fallback, truncated: true, originalBytes: Buffer.byteLength(json) })
}

export class Store {
  private database!: DatabaseSync
  private statements = new Map<string, any>()
  private sessions = new Map<string, Row>()
  private seeding = false
  private lastStamp = 0
  private opened = false
  degraded = false
  error: string | null = null
  private log: (text: string) => void
  get db() { return this.database }

  constructor(file: string, log: (text: string) => void = (text) => console.error(text), exclusive = false) {
    this.log = log
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.chmodSync(path.dirname(file), 0o700)
      // SQLite gives its -wal and -shm files the database file's mode.
      fs.closeSync(fs.openSync(file, 'a', 0o600))
      fs.chmodSync(file, 0o600)
    }
    try {
      this.database = open(file)
      this.db.exec('PRAGMA busy_timeout=5000')
      const version = (this.database.prepare('PRAGMA user_version').get() as Row).user_version
      if (version > VERSION) {
        this.database.close()
        this.database = open(':memory:')
        this.degraded = true
        this.error = `BitFrost database version ${version} is newer than this daemon; persistence disabled`
        try { this.log(this.error) } catch {}
      }
      if (version > 0 && version < VERSION) throw new MigrationRequiredError(version)
      if (exclusive && !this.degraded) this.db.exec('PRAGMA locking_mode=EXCLUSIVE')
      this.initialize()
      this.opened = true
    } catch (error) {
      if (error instanceof MigrationRequiredError) { try { this.database.close() } catch {}; throw error }
      if (exclusive && /database is locked|database is busy/i.test((error as Error).message)) { try { this.database.close() } catch {}; throw error }
      this.degrade(error)
    }
    if (file !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600)
    }
  }

  // Switching a new file to WAL doesn't wait out the busy timeout when another
  // process opens it at the same moment, so try again for up to the same 5 seconds.
  private walMode() {
    for (let tries = 0; ; tries++) {
      try {
        this.db.exec('PRAGMA journal_mode=WAL')
        return
      } catch (error) {
        if (tries >= 250 || !/database is locked|database is busy/i.test((error as Error).message)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
  }

  private initialize() {
    this.walMode()
    this.db.exec('PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const from = (this.db.prepare('PRAGMA user_version').get() as Row).user_version
      if (from === 0) {
        // Empty development/test and memory stores need only the current schema.
        // Existing databases never run migrations or historical data work here.
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new MigrationRequiredError(from)
        this.db.exec(fs.readFileSync(new URL(`../migrations/versions/v${VERSION}/schema.sql`, import.meta.url), 'utf8'))
        this.db.exec(fs.readFileSync(new URL(`../migrations/versions/v${VERSION}/indexes.sql`, import.meta.url), 'utf8'))
        this.db.exec(`PRAGMA user_version=${VERSION}`)
      } else if (from !== VERSION) throw new MigrationRequiredError(from)
      this.db.prepare('SELECT u.updated_at,s.request_input,r.request_id FROM usage_hours u,sessions s,usage_requests r LIMIT 0').all()
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private billUsage(sessionId: string, turnId: string, e: Usage) {
    // Legacy events have no request identity. Keep their old within-turn grouping, but never
    // let a previous turn suppress a new request. Current adapters supply native identities.
    const id = e.requestId ? `request:${e.requestId}` : `legacy:${turnId}`
    let previous = this.stmt('SELECT input_tokens AS input,output_tokens AS output,cached_tokens AS cached,requests FROM usage_requests WHERE session_id=? AND request_id=?').get(sessionId, id) as Bill | undefined
    if (!e.requestId && previous?.input !== (e.billing ?? e).inputTokens) previous = undefined
    const b = billed(previous, e)
    if (previous && !b.input && !b.output && !b.cached && !b.requests) return b
    this.stmt('INSERT INTO usage_requests VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,request_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,requests=excluded.requests')
      .run(sessionId, id, b.last.input, b.last.output, b.last.cached, b.last.requests)
    return b
  }

  private stmt(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) {
      const raw = this.db.prepare(sql)
      const bind = (args: unknown[]) => args.map((v) => v === undefined ? null : v)
      statement = { run: (...args: any[]) => raw.run(...bind(args)), get: (...args: any[]) => raw.get(...bind(args)), all: (...args: any[]) => raw.all(...bind(args)) }
      this.statements.set(sql, statement)
    }
    return statement
  }

  degrade(error: unknown, s?: Session) {
    // A busy or locked database is passing trouble: skip this step, keep the file.
    if (this.opened && !this.degraded && [5, 6].includes(((error as { errcode?: number })?.errcode ?? 0) & 0xff)) {
      try { this.log(`BitFrost store is busy; skipped one step (${(error as Error).message})`) } catch {}
      return
    }
    if (!this.degraded) {
      this.error = `BitFrost store degraded: ${error instanceof Error ? error.message : String(error)}; persistence disabled`
      try { this.log(this.error) } catch {}
      try { this.database.close() } catch {}
      this.database = open(':memory:')
      this.statements.clear()
      this.sessions.clear()
      this.degraded = true
      this.initialize()
    }
    if (s) this.seed(s)
  }

  private seed(s: Session) {
    if (this.sessions.has(s.info.id) || this.seeding) return
    this.seeding = true
    let turnId: string | null = null
    try {
      this.saveSession(s)
      for (const e of s.events) {
        if (e.type === 'turn_started') turnId = e.turnId
        try { this.push(s, e, 'turnId' in e ? e.turnId : turnId) } catch {}
        if (e.type === 'turn_completed') turnId = null
      }
    } finally { this.seeding = false }
  }

  private read<T>(job: () => T, session?: Session): T {
    try { return job() } catch (error) { this.degrade(error, session); return job() }
  }

  close() { this.db.close() }

  saveSession(s: Session) {
    if (this.degraded && !this.seeding && !this.sessions.has(s.info.id)) { this.seed(s); return }
    const i = s.info
    const row = { id: i.id, harness: i.harness, agent: i.agent, model: i.model, effort: i.effort ?? null, plan: i.plan ?? null,
      native_ref: JSON.stringify(s.nativeRef ?? null), cwd: i.cwd, title: i.title ?? null, claude_session: i.claudeSession ?? null,
      claude_agent: i.claudeAgent ?? null, lease_id: i.leaseId ?? null, parent_mode: i.parentMode ?? null, state: i.state,
      created_at: i.createdAt ?? null, updated_at: i.updatedAt ?? null, closed_at: i.closedAt ?? null, close_reason: i.closeReason ?? null, last_seq: s.lastSeq }
    let old = this.sessions.get(i.id)
    if (!old) old = this.stmt('SELECT * FROM sessions WHERE id=?').get(i.id)
    const columns = Object.keys(row) as (keyof typeof row)[]
    if (!old) {
      this.stmt(`INSERT INTO sessions (${columns.join(',')},changed_at) VALUES (${columns.map(() => '?').join(',')},?)`).run(...columns.map((c) => row[c]), this.stamp())
      this.addUsage(i.harness, i.model, row.created_at ?? Date.now(), { sessions: 1 })
      if (row.closed_at != null) this.addUsage(i.harness, i.model, row.closed_at, { closed_sessions: 1, session_ms: Math.max(0, row.closed_at - (row.created_at ?? row.closed_at)) })
    }
    else {
      const changed = columns.filter((c) => c !== 'id' && row[c] !== old![c])
      if (changed.length) this.stmt(`UPDATE sessions SET ${changed.map((c) => `${c}=?`).join(',')},changed_at=? WHERE id=?`).run(...changed.map((c) => row[c]), this.stamp(), i.id)
      // A session's time counts when it closes; reopening takes that back.
      const created = row.created_at ?? old.created_at
      if (old.closed_at == null && row.closed_at != null) this.addUsage(i.harness, i.model, row.closed_at, { closed_sessions: 1, session_ms: Math.max(0, row.closed_at - (created ?? row.closed_at)) })
      else if (old.closed_at != null && row.closed_at == null) this.addUsage(i.harness, i.model, old.closed_at, { closed_sessions: -1, session_ms: -Math.max(0, old.closed_at - (created ?? old.closed_at)) })
    }
    this.sessions.set(i.id, row)
  }

  push(s: Session, e: AgentEvent, turnId: string | null) {
    if (this.degraded && !this.seeding && !this.sessions.has(s.info.id)) { this.seed(s); return }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.saveSession(s)
      this.stmt('INSERT INTO events VALUES (?,?,?,?,?,?)').run(s.info.id, e.seq, e.ts, e.type, turnId, bodyJSON(e))
      if (e.type === 'turn_started') {
        this.stmt(`INSERT INTO turns (id,session_id,seq_start,started_at,status,plan,final_text,pgid,process_identity) VALUES (?,?,?,?,?,?,?,?,?)`).run(e.turnId, s.info.id, e.seq, e.ts, 'running', s.info.plan ?? null, '', s.nativeRef?.process?.pgid, s.nativeRef?.process ? JSON.stringify(s.nativeRef.process) : null)
      } else if (e.type === 'turn_completed') {
        const started = this.stmt('SELECT started_at FROM turns WHERE id=? AND session_id=? AND ended_at IS NULL').get(e.turnId, s.info.id) as Row | undefined
        this.stmt(`UPDATE turns SET seq_end=?,ended_at=?,status=?,end_reason=?,provider_error_code=?,error=?,plan=COALESCE(?,plan),final_text=? WHERE id=? AND session_id=?`).run(e.seq, e.ts, e.status, e.reason, e.providerErrorCode, e.error, e.plan, e.finalText ?? '', e.turnId, s.info.id)
        if (started) {
          const ms = Math.max(0, e.ts - (started.started_at ?? e.ts))
          this.addUsage(s.info.harness, s.info.model, e.ts, { turns: 1, failed_turns: e.status === 'failed' ? 1 : 0, turn_ms: ms })
          this.stmt('UPDATE sessions SET turns=turns+1,active_ms=active_ms+?,changed_at=? WHERE id=?').run(ms, this.stamp(), s.info.id)
        }
        this.stmt("UPDATE messages SET seq=?,ts=?,status='error' WHERE session_id=? AND turn_id=? AND status='running'").run(e.seq, e.ts, s.info.id, e.turnId)
      } else if (e.type === 'usage' && turnId) {
        const b = this.billUsage(s.info.id, turnId, e)
        this.stmt('UPDATE turns SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,cached_tokens=cached_tokens+?,requests=requests+? WHERE id=?').run(b.input, b.output, b.cached, b.requests, turnId)
        this.addUsage(s.info.harness, s.info.model, e.ts, { requests: b.requests, input_tokens: b.input, output_tokens: b.output, cached_tokens: b.cached })
        this.stmt('UPDATE sessions SET tokens=tokens+?,cached_tokens=cached_tokens+?,request_input=?,request_output=?,changed_at=? WHERE id=?').run(b.input + b.output, b.cached, b.last.input, b.last.output, this.stamp(), s.info.id)
      } else if (e.type === 'user_input') {
        this.stmt('INSERT INTO inbox (id,session_id,ts,sender,text,delivery,state,client_input_id) VALUES (?,?,?,?,?,?,?,?)').run(e.inputId, s.info.id, e.ts, e.sender, e.text, e.delivery, 'pending', e.clientInputId)
      } else if (e.type === 'input_consumed') {
        this.stmt("UPDATE inbox SET state='consumed',consumed_turn=?,consumed_at=? WHERE id=? AND session_id=? AND state='pending'").run(e.turnId, e.ts, e.inputId, s.info.id)
        this.stmt("UPDATE messages SET turn_id=?,seq=?,ts=?,status='ok' WHERE session_id=? AND item_id=? AND kind='input'").run(e.turnId, e.seq, e.ts, s.info.id, e.inputId)
      } else if (e.type === 'input_dropped') {
        this.stmt("UPDATE inbox SET state='dropped' WHERE id=? AND session_id=? AND state='pending'").run(e.inputId, s.info.id)
        this.stmt("UPDATE messages SET seq=?,ts=?,status='declined' WHERE session_id=? AND item_id=? AND kind='input'").run(e.seq, e.ts, s.info.id, e.inputId)
      }
      this.reduce(s.info.id, turnId, e)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      this.sessions.delete(s.info.id)
      throw error
    }
  }

  private reduce(sessionId: string, turnId: string | null, e: AgentEvent) {
    const b = e as Row
    let role = 'system', kind = 'notice', name: string | null = null, text = '', status: string | null = null
    const itemId = b.itemId ?? b.inputId ?? b.approvalId ?? b.questionId ?? null
    switch (e.type) {
      case 'text': role = 'assistant'; kind = 'text'; text = e.text; break
      case 'reasoning': role = 'reasoning'; kind = 'text'; text = e.text; break
      case 'command_started': case 'command_completed':
        role = 'tool'; kind = 'command'; name = 'Bash'; text = e.summary || e.command
        status = e.type === 'command_started' ? 'running' : statusOf(e); break
      case 'tool_started': case 'tool_completed': case 'tool':
        role = 'tool'; kind = 'tool'; name = e.name ?? null; text = b.output ?? e.name ?? ''
        status = e.type === 'tool_started' ? 'running' : statusOf(e); break
      case 'file_change': role = 'tool'; kind = 'file_change'; name = 'file_change'; text = e.changes.map((c) => c.path).join('\n'); status = statusOf(e); break
      case 'plan': kind = 'plan'; text = e.entries.map((x) => `${x.status}: ${x.content}`).join('\n'); break
      case 'question_asked': kind = 'question'; text = e.questions.map((q) => q.question).join('\n'); break
      case 'approval_requested': kind = 'approval'; text = e.title; status = 'running'; break
      case 'approval_resolved':
        this.stmt('UPDATE messages SET status=?,seq=?,ts=? WHERE session_id=? AND approval_id=? AND kind=\'approval\'').run(e.decision === 'deny' ? 'declined' : 'ok', e.seq, e.ts, sessionId, e.approvalId); return
      case 'question_answered':
        this.stmt('UPDATE messages SET status=?,seq=?,ts=? WHERE session_id=? AND item_id=? AND kind=\'question\'').run(e.how === 'deferred' ? 'declined' : 'ok', e.seq, e.ts, sessionId, e.questionId); return
      case 'auto_reviewed': kind = 'approval'; text = `${e.action}: ${e.decision}. ${e.reason}`; break
      case 'user_input': role = 'user'; kind = 'input'; text = e.text; if (e.delivery !== 'steered') turnId = null; break
      case 'interrupt_requested': text = `Interrupt requested by ${e.source}`; break
      case 'session_failed': text = e.error; status = 'error'; break
      default: return
    }
    if (['command_completed', 'tool_completed'].includes(e.type)) {
      const row = this.stmt('SELECT id FROM messages WHERE session_id=? AND turn_id IS ? AND item_id=? AND kind=? ORDER BY id DESC LIMIT 1').get(sessionId, turnId, itemId, kind) as Row | undefined
      if (row) {
        this.stmt('UPDATE messages SET seq=?,ts=?,name=?,text=?,status=?,detail=? WHERE id=?').run(e.seq, e.ts, name, text, status, detail(e), row.id)
        return
      }
    }
    this.stmt('INSERT INTO messages (session_id,turn_id,seq,ts,role,kind,item_id,name,text,status,detail,approval_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(sessionId, turnId, e.seq, e.ts, role, kind, itemId, name, text, status, detail(e), e.type === 'approval_requested' ? e.approvalId : null)
    if (kind === 'tool' || kind === 'command' || kind === 'file_change') this.stmt('UPDATE sessions SET tool_calls=tool_calls+1,changed_at=? WHERE id=?').run(this.stamp(), sessionId)
  }

  has(id: string): boolean { return this.read(() => !!this.stmt('SELECT 1 FROM sessions WHERE id=?').get(id)) }
  ensure(s: Session) { if (this.degraded) this.seed(s) }

  load(id: string): { info: Row; nativeRef: any; events: AgentEvent[]; lastSeq: number } | null {
    return this.read(() => {
      const r = this.stmt('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined
      if (!r) return null
      const info = { id: r.id, harness: r.harness, agent: r.agent, model: r.model, effort: r.effort, plan: r.plan, cwd: r.cwd, title: r.title,
        claudeSession: r.claude_session, claudeAgent: r.claude_agent, leaseId: r.lease_id, parentMode: r.parent_mode,
        state: 'detached', createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at, closeReason: r.close_reason }
      const events = this.stmt('SELECT body FROM events WHERE session_id=? ORDER BY seq').all(id).map((e: Row) => parse(e.body))
      return { info, nativeRef: parse(r.native_ref), events, lastSeq: r.last_seq }
    })
  }

  unfinished(): Row[] { return this.read(() => this.stmt('SELECT * FROM turns WHERE ended_at IS NULL').all()) }
  pending(id: string): Row[] { return this.read(() => this.stmt("SELECT * FROM inbox WHERE session_id=? AND state='pending' ORDER BY ts,id").all(id)) }

  inputReceipt(id: string, clientInputId: string) {
    return this.read(() => {
      const row = this.stmt('SELECT id,delivery FROM inbox WHERE session_id=? AND client_input_id=?').get(id, clientInputId) as Row | undefined
      return row ? { inputId: row.id as string, delivery: row.delivery as Delivery } : null
    })
  }

  // A store-wide stamp that only grows, even for writes in the same millisecond.
  private stamp() {
    if (!this.lastStamp) {
      const seen = this.stmt('SELECT MAX(m) AS m FROM (SELECT MAX(updated_at) AS m FROM usage_hours UNION ALL SELECT MAX(changed_at) FROM sessions)').get() as Row | undefined
      this.lastStamp = Number(seen?.m ?? 0)
    }
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  private addUsage(harness: string, model: string, at: number, add: Partial<Record<typeof USAGE[number], number>>) {
    const cols = USAGE.filter((c) => add[c])
    if (!cols.length) return
    this.stmt(`INSERT INTO usage_hours (harness,model,hour,first_at,last_at,updated_at${cols.map((c) => `,${c}`).join('')}) VALUES (?,?,?,?,?,?${cols.map(() => ',?').join('')})
      ON CONFLICT(harness,model,hour) DO UPDATE SET first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),updated_at=excluded.updated_at${cols.map((c) => `,${c}=${c}+excluded.${c}`).join('')}`)
      .run(harness, model, hourOf(at), at, at, this.stamp(), ...cols.map((c) => add[c]))
  }

  // One model's hourly usage rows changed after since (0 for all of them), and the newest stamp seen.
  usageRows(harness: string, model: string, since = 0): { rows: Row[]; stamp: number } {
    return this.read(() => {
      const rows = this.stmt('SELECT * FROM usage_hours WHERE harness=? AND model=? AND updated_at>? ORDER BY hour').all(harness, model, since) as Row[]
      return { rows, stamp: rows.reduce((m, r) => Math.max(m, Number(r.updated_at ?? 0)), since) }
    })
  }

  // Sessions as the status page lists them, from their kept totals.
  private subagentRow(r: Row) {
    return { id: r.id, harness: r.harness, agent: r.agent, model: r.model, effort: r.effort, title: r.title, state: r.state,
      createdAt: r.created_at, closedAt: r.closed_at, closeReason: r.close_reason, changedAt: r.changed_at,
      tokens: r.tokens ?? 0, cachedTokens: r.cached_tokens ?? 0, turns: r.turns ?? 0, toolCalls: r.tool_calls ?? 0, activeMs: r.active_ms ?? 0 }
  }

  // The time a running turn began, for sessions that have one.
  private turnStarts(ids: string[]) {
    if (!ids.length) return new Map<string, number>()
    const rows = this.stmt(`SELECT session_id, MAX(started_at) AS at FROM turns WHERE session_id IN (${IDS}) AND ended_at IS NULL GROUP BY session_id`).all(JSON.stringify(ids)) as Row[]
    return new Map(rows.map((r) => [String(r.session_id), Number(r.at)]))
  }

  private withTurns(rows: Row[]) {
    const starts = this.turnStarts(rows.map((r) => r.id))
    return rows.map((r) => ({ ...this.subagentRow(r), turnStartedAt: starts.get(r.id) ?? null }))
  }

  subagentsById(ids: string[]) {
    return this.read(() => (ids.length ? this.withTurns(this.stmt(`SELECT ${ROW} FROM sessions WHERE id IN (${IDS})`).all(JSON.stringify(ids)) as Row[]) : []))
  }

  // A page of sessions, newest first, by position: before or after a session's (createdAt, id), or the oldest page.
  subagentPage(opts: { before?: [number, string]; after?: [number, string]; oldest?: boolean; limit: number; count?: boolean }) {
    return this.read(() => {
      const limit = Math.max(1, Math.min(500, Math.floor(opts.limit)))
      const from = `SELECT ${ROW} FROM sessions WHERE created_at IS NOT NULL`
      let rows: Row[]
      if (opts.before) rows = this.stmt(`${from} AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?`).all(...opts.before, limit + 1) as Row[]
      else if (opts.after) rows = this.stmt(`${from} AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?`).all(...opts.after, limit + 1) as Row[]
      else if (opts.oldest) rows = this.stmt(`${from} ORDER BY created_at,id LIMIT ?`).all(limit + 1) as Row[]
      else rows = this.stmt(`${from} ORDER BY created_at DESC,id DESC LIMIT ?`).all(limit + 1) as Row[]
      const more = rows.length > limit
      rows = rows.slice(0, limit)
      if (opts.after || opts.oldest) rows.reverse()
      // The total sizes the list's scrollbar; a count over an index, so only page loads ask for it.
      const total = opts.count ? Number((this.stmt('SELECT COUNT(*) AS n FROM sessions WHERE created_at IS NOT NULL').get() as Row).n) : null
      return { rows: this.withTurns(rows), more, total }
    })
  }

  // Of the given sessions, those changed after since, and the newest stamp seen.
  subagentsChanged(ids: string[], since: number) {
    return this.read(() => {
      const rows = ids.length ? this.stmt(`SELECT ${ROW} FROM sessions WHERE id IN (${IDS}) AND changed_at>?`).all(JSON.stringify(ids), since) as Row[] : []
      return { rows: this.withTurns(rows), stamp: rows.reduce((m, r) => Math.max(m, Number(r.changed_at ?? 0)), since) }
    })
  }

  processes(): Row[] { return this.read(() => this.stmt('SELECT pgid,process_identity FROM turns WHERE pgid IS NOT NULL AND process_identity IS NOT NULL').all()) }

  // Ended turns were swept once at startup, so later startups skip them.
  forgetProcesses() {
    try { this.stmt('UPDATE turns SET pgid=NULL,process_identity=NULL WHERE ended_at IS NOT NULL AND pgid IS NOT NULL').run() } catch (e) { this.degrade(e) }
  }

  openSessions(): Row[] { return this.read(() => this.stmt('SELECT id FROM sessions WHERE closed_at IS NULL').all()) }

  retain(retention = { eventsDays: 30, messagesDays: 180 }, now = Date.now()) {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      if (retention.eventsDays > 0) this.stmt('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE closed_at < ? AND updated_at < ?)').run(now - retention.eventsDays * DAY, now - retention.eventsDays * DAY)
      if (retention.messagesDays > 0) this.stmt('DELETE FROM sessions WHERE closed_at < ? AND updated_at < ?').run(now - retention.messagesDays * DAY, now - retention.messagesDays * DAY)
      this.db.exec('COMMIT')
      this.sessions.clear()
    } catch (e) { try { this.db.exec('ROLLBACK') } catch {}; this.degrade(e) }
  }

  private turns(id: string, n: number | null): Row[] {
    return this.stmt('SELECT * FROM turns WHERE session_id=? ORDER BY seq_start DESC LIMIT ?').all(id, n ?? -1).reverse()
  }

  private turn(r: Row, full = false) {
    return { id: r.id, status: r.status, reason: r.end_reason, error: r.error, providerErrorCode: r.provider_error_code,
      startedAt: r.started_at, endedAt: r.ended_at, ...(full ? { finalText: r.final_text ?? '' } : { finalTextChars: (r.final_text ?? '').length }) }
  }

  private messageInfo(r: Row, full = false) {
    return { seq: r.seq, ts: r.ts, role: r.role, kind: r.kind, name: r.name, text: r.text, status: r.status, itemId: r.item_id, ...(full ? { detail: parse(r.detail) } : {}) }
  }

  message(id: string, itemId: string) {
    return this.read(() => {
      const r = this.stmt("SELECT * FROM messages WHERE session_id=? AND item_id=? ORDER BY CASE WHEN role='tool' THEN 1 ELSE 0 END DESC,id DESC LIMIT 1").get(id, itemId) as Row | undefined
      return r ? this.messageInfo(r, true) : null
    })
  }

  messages(id: string, { turns = 1, all = false, since = 0, limit = 200 } = {}) {
    return this.read(() => {
      const selected = this.turns(id, all ? null : turns)
      const scope = `session_id=? AND (turn_id IS NULL OR turn_id IN (SELECT id FROM turns WHERE session_id=? ORDER BY seq_start DESC LIMIT ?))`
      const args = [id, id, all ? -1 : turns]
      let rows: Row[] = this.stmt(`SELECT * FROM messages WHERE ${scope} AND seq>? ORDER BY seq,id LIMIT ?`).all(...args, since, limit + 1)
      let truncated = rows.length > limit
      if (truncated) {
        const boundary = rows[limit - 1].seq
        if (rows[limit].seq === boundary) {
          rows = [...rows.filter((r) => r.seq < boundary), ...this.stmt(`SELECT * FROM messages WHERE ${scope} AND seq=? ORDER BY id`).all(...args, boundary)]
          truncated = !!this.stmt(`SELECT 1 FROM messages WHERE ${scope} AND seq>? LIMIT 1`).get(...args, boundary)
        } else rows.pop()
      }
      return { turns: selected.map((r) => ({ ...this.turn(r, true), messages: rows.filter((m) => m.turn_id === r.id).map((m) => this.messageInfo(m)) })),
        pending: rows.filter((m) => m.turn_id === null).map((m) => this.messageInfo(m)), nextSince: rows.at(-1)?.seq ?? since, truncated }
    })
  }

  summary(s: Session, n = 1) {
    return this.read(() => {
      this.ensure(s)
      const id = s.info.id
      const tools = this.stmt("SELECT * FROM messages WHERE session_id=? AND kind IN ('tool','command','file_change') AND status != 'running' ORDER BY seq DESC LIMIT 8").all(id) as Row[]
      const active = this.stmt("SELECT * FROM messages WHERE session_id=? AND turn_id IS ? AND kind IN ('tool','command') AND status='running' ORDER BY seq DESC LIMIT 1").get(id, s.activeTurnId) as Row | undefined
      const latest = this.stmt("SELECT * FROM messages WHERE session_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(id) as Row | undefined
      const usage = this.stmt('SELECT COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(cached_tokens),0) AS cachedTokens,COALESCE(SUM(requests),0) AS requests FROM turns WHERE session_id=?').get(id)
      const inbox = this.stmt("SELECT * FROM inbox WHERE session_id=? AND state='pending' ORDER BY ts DESC,id DESC LIMIT 10").all(id) as Row[]
      const counts = this.stmt("SELECT state,COUNT(*) AS n FROM inbox WHERE session_id=? GROUP BY state").all(id) as Row[]
      const i = s.info
      const toolSummary = (row: Row) => {
        const body = parse(row.detail)
        const input = body?.input
        return String(body?.summary ?? body?.command ?? input?.description ?? input?.file_path ?? input?.path ?? input?.query ?? input?.command ?? row.text).slice(0, 400)
      }
      return { session: { id, harness: i.harness, agent: i.agent, model: i.model, effort: i.effort ?? null, plan: i.plan ?? null, state: i.state, title: i.title ?? null,
        createdAt: i.createdAt, updatedAt: i.updatedAt, elapsedMs: Math.max(0, (i.closedAt ?? Date.now()) - i.createdAt!) },
        live: s.info.state === 'detached' ? null : s.live,
        activeTool: active ? { name: active.name, summary: toolSummary(active), startedAt: active.ts } : null,
        recentTools: tools.map((m) => ({ name: m.name, summary: toolSummary(m), status: m.status, ts: m.ts })),
        latestText: latest ? { text: latest.text.slice(0, 400), ts: latest.ts } : null, usage: { ...usage },
        inbox: { queued: counts.find((r) => r.state === 'pending')?.n ?? 0, counts: { pending: 0, consumed: 0, dropped: 0, ...Object.fromEntries(counts.map((r) => [r.state, r.n])) }, items: inbox.map((m) => ({ id: m.id, text: m.text.slice(0, 200), delivery: m.delivery, state: m.state, ts: m.ts })) },
        turns: this.turns(id, n).map((r) => this.turn(r)), lastSeq: s.lastSeq }
    }, s)
  }


}
