// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Run Codex app-server over standard input and output, and translate its events.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path, { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { AgentEventBody, Decision, EndReason, FileChange, Question } from '../events.ts'
import type { HarnessModel, Provider, ProviderEnv, ProviderFactory, SpawnRequest } from '../provider.ts'
import type { Session } from '../session.ts'

type Json = any

export type CodexSpawn = SpawnRequest & { sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' }

// Decode a single quoted or escaped shell word; return null for multiple words.
function shellWord(text: string): string | null {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) return null
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      out += text.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) i++
        out += text[i++]
      }
      if (i >= text.length) return null
      i++
    } else if (c === '\\') {
      out += text[i + 1] ?? ''
      i += 2
    } else {
      out += c
      i++
    }
  }
  return out
}

export function unwrapShell(command: string): string {
  const m = command.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/)
  if (!m) return command
  const inner = m[1].trim()
  return shellWord(inner) ?? inner
}

export function describeCommand(actions: Json[] | undefined, command: string): string {
  const parts = (actions ?? []).map((a: Json) => {
    const where = (p: string | null | undefined) => (p ? ` in ${p.split('/').pop() || p}` : '')
    if (a.type === 'read') return `Read ${a.name ?? a.path}`
    if (a.type === 'listFiles') return `List files${where(a.path)}`
    if (a.type === 'search') return a.query ? `Search for ${JSON.stringify(a.query)}${where(a.path)}` : `Search${where(a.path)}`
    return null
  })
  if (parts.length && parts.every(Boolean)) return parts.join(', ')
  const first = command.split('\n')[0]
  return first.length > 70 ? first.slice(0, 67) + '…' : first
}

const KNOWN_ITEMS = new Set(['agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'userMessage'])

export class CodexAdapter implements Provider {
  readonly id = 'codex'
  readonly displayName = 'Codex'
  readonly vendor = 'OpenAI'
  readonly capabilities = { steer: true, autoReview: true, questions: true, gates: 'all' as const }
  readonly location: string
  private proc: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, { threadId?: string; method: string; resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private sessions = new Map<string, Session>()
  private turnListeners = new Map<Session, () => void>()
  private archived = new Map<string, boolean>()
  private archiveJobs = new Map<string, Promise<void>>()
  private resumeNeeded = new Set<string>()
  private disposed = new WeakMap<Session, number>()
  private starting = new Set<Session>()
  private interruptedStarts = new Set<Session>()
  private turnText = new Map<string, string>()
  private approvals = new Map<string, { rpcId: number | string; method: string; params: Json; session: Session }>()
  private questions = new Map<string, { rpcId: number | string; questions: Question[]; session: Session }>()
  private autoReview = new Set<string>()
  private bin: string
  private relocate?: () => string | null
  private log: (msg: string) => void
  private record: ((line: string) => void) | null

  constructor(bin: string, log: (msg: string) => void, record: ((line: string) => void) | null = null, relocate?: () => string | null) {
    this.bin = bin
    this.location = bin
    this.log = log
    this.record = record
    this.relocate = relocate
  }

  moved(): boolean {
    return !!this.relocate && this.relocate() !== this.bin
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      // Put the launcher's own Node first on PATH.
      const env = { ...process.env, PATH: `${dirname(this.bin)}:${process.env.PATH ?? ''}` }
      const proc = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env })
      this.proc = proc
      proc.stderr!.on('data', (d) => this.log(`codex stderr: ${String(d).trimEnd()}`))
      // Catch writes to an exited app-server so they cannot crash the helper.
      proc.stdin!.on('error', (e) => this.log(`codex stdin: ${e.message}`))
      proc.on('error', (e) => {
        if (this.proc !== proc) return
        this.log(`codex app-server could not run: ${e.message}`)
        for (const p of this.pending.values()) p.reject(e)
        this.pending.clear()
        this.proc = null
        this.ready = null
      })
      proc.on('exit', (code, signal) => {
        if (this.proc !== proc) return
        this.log(`codex app-server exited code=${code} signal=${signal}`)
        for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'))
        this.pending.clear()
        const sessions = [...this.sessions.values()]
        this.sessions.clear()
        for (const remove of this.turnListeners.values()) remove()
        this.turnListeners.clear()
        this.archived.clear()
        this.resumeNeeded.clear()
        this.autoReview.clear()
        this.approvals.clear()
        this.questions.clear()
        for (const s of sessions) {
          s.detach()
          if (s.activeTurnId) s.push({ type: 'session_failed', error: 'codex app-server exited' })
          else s.dropInputs()
        }
        this.proc = null
        this.ready = null
      })
      createInterface({ input: proc.stdout! }).on('line', (line) => {
        if (this.proc !== proc) return
        this.record?.(line)
        let msg: Json
        try {
          msg = JSON.parse(line)
        } catch {
          return this.log(`codex: unparseable line ${line.slice(0, 200)}`)
        }
        this.onMessage(msg)
      })
      await this.request('initialize', {
        clientInfo: { name: 'bitfrost', title: 'bitfrost', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      this.send({ method: 'initialized' })
    })()
    return this.ready
  }

  private send(msg: Json) {
    this.proc!.stdin!.write(JSON.stringify(msg) + '\n')
  }

  private request(method: string, params: Json, timeoutMs = 0): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const done = { resolve: (value: Json) => { clearTimeout(timer); resolve(value) }, reject: (error: Error) => { clearTimeout(timer); reject(error) }, threadId: params?.threadId, method }
      this.pending.set(id, done)
      if (timeoutMs) {
        timer = setTimeout(() => { this.pending.delete(id); done.reject(new Error(`${method} timed out`)) }, timeoutMs)
        timer.unref()
      }
      try { this.send({ id, method, params }) }
      catch (error) { this.pending.delete(id); done.reject(error as Error) }
    })
  }

  private watchTurns(session: Session) {
    this.turnListeners.get(session)?.()
    this.turnListeners.set(session, session.onTurnCompleted((event) => {
      if (event.type === 'turn_completed' && !event.continues) void this.setArchived(session, true)
    }))
  }

  private setArchived(session: Session, archived: boolean, disposing = false): Promise<void> {
    const ref = session.nativeRef
    const threadId = ref?.threadId
    if (!threadId || ref.ephemeral) return Promise.resolve()
    const job = (this.archiveJobs.get(threadId) ?? Promise.resolve()).then(async () => {
      if (archived && !disposing && (session.activeTurnId || session.hasPendingInput())) return
      if (this.archived.get(threadId) === archived) return
      const method = archived ? 'thread/archive' : 'thread/unarchive'
      if (archived) this.resumeNeeded.add(threadId)
      try {
        if (!this.proc) throw new Error('app-server is not running')
        await this.request(method, { threadId }, 2000)
      } catch (error) {
        if (archived || !/\b(?:not archived|already unarchived|not in (?:the )?archive)\b/i.test((error as Error).message)) {
          this.archived.delete(threadId)
          try { this.log(`codex ${method} ${threadId}: ${(error as Error).message}`) } catch {}
          return
        }
      }
      this.archived.set(threadId, archived)
      session.setNativeRef({ ...session.nativeRef, archived })
    }).catch((error) => {
      this.archived.delete(threadId)
      try { this.log(`codex archive state ${threadId}: ${(error as Error).message}`) } catch {}
    })
    this.archiveJobs.set(threadId, job)
    void job.then(() => { if (this.archiveJobs.get(threadId) === job) this.archiveJobs.delete(threadId) })
    return job
  }

  async spawnSession(session: Session, req: CodexSpawn): Promise<string> {
    await this.start()
    const r = await this.request('thread/start', {
      model: req.model,
      cwd: req.cwd,
      sandbox: req.sandbox ?? 'workspace-write',
      // Ask the user before leaving the sandbox only when the host can ask.
      approvalPolicy: req.canAskUser ? 'on-request' : 'never',
      ...(req.canAskUser ? { approvalsReviewer: req.autoReview ? 'auto_review' : 'user' } : {}),
      // Persistent threads can be resumed after the daemon restarts.
      ephemeral: !!req.ephemeral,
      config: {
        ...(req.effort ? { model_reasoning_effort: req.effort } : {}),
        // Enable questions outside plan mode, where Codex disables them by default.
        ...(req.canAskUser ? { 'features.default_mode_request_user_input': true } : {}),
      },
      developerInstructions: req.developerInstructions,
    })
    const threadId: string = r.thread.id
    session.info.id = threadId
    this.sessions.set(threadId, session)
    if (req.autoReview) this.autoReview.add(threadId)
    session.info.effort = req.effort ?? null
    session.setNativeRef({ threadId, canAskUser: !!req.canAskUser, autoReview: !!req.autoReview, sandbox: req.sandbox ?? 'workspace-write', ephemeral: !!req.ephemeral })
    this.archived.set(threadId, false)
    this.watchTurns(session)
    session.acceptInput(req.prompt, 'started')
    try { await this.sendInput(session, req.prompt) }
    catch (error) {
      await session.stop(this, 'host')
      this.disposeSession(session)
      session.detach()
      throw error
    }
    return threadId
  }

  // Exclude model routes containing a slash, which can select another company's models.
  async listModels(): Promise<HarnessModel[]> {
    await this.start()
    const models: Json[] = []
    let cursor: string | null = null
    do {
      const r = await this.request('model/list', { cursor, limit: 100 })
      models.push(...(r.data ?? []))
      cursor = r.nextCursor ?? null
    } while (cursor)
    return models
      .filter((m) => !m.hidden && !String(m.id).includes('/'))
      .map((m) => ({
        harness: this.id,
        provider: 'OpenAI',
        model: m.id,
        displayName: m.displayName ?? m.id,
        description: m.description ?? '',
        efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort ?? null,
        isDefault: !!m.isDefault,
      }))
  }

  async sendInput(session: Session, text: string): Promise<'started' | 'steered'> {
    await this.start()
    const input = [{ type: 'text', text }]
    if (session.activeTurnId) {
      const expected = session.activeTurnId
      try {
        await this.request('turn/steer', { threadId: session.info.id, expectedTurnId: expected, input })
        return 'steered'
      } catch (e) {
        if (session.activeTurnId === expected && !/\b(?:turn|expectedTurnId)\b.*\b(?:ended|completed|mismatch|not found|no active|not active)\b/i.test((e as Error).message)) throw e
        // The turn just ended; let its own turn/completed arrive before calling it failed.
        for (let waited = 0; session.activeTurnId === expected && waited < 2000; waited += 50) await new Promise((r) => setTimeout(r, 50))
        if (session.activeTurnId === expected) session.push({ type: 'turn_completed', turnId: expected, status: 'failed', reason: 'error', error: (e as Error).message, finalText: session.live?.partialText ?? '' })
      }
    }
    const reviewer = this.autoReview.has(session.info.id) ? { approvalsReviewer: 'auto_review' } : {}
    this.starting.add(session)
    try {
      await this.setArchived(session, false)
      if (this.sessions.get(session.info.id) !== session) throw new Error('Codex session stopped')
      if (this.resumeNeeded.has(session.info.id)) await this.resumeThread(session, session.nativeRef)
      const r = await this.request('turn/start', { threadId: session.info.id, input, ...reviewer })
      if (r?.turn?.id && !session.hasTurnStarted(r.turn.id)) session.push({ type: 'turn_started', turnId: r.turn.id })
      if (this.interruptedStarts.delete(session)) void this.interrupt(session).catch(() => {})
      return 'started'
    } finally { this.starting.delete(session) }
  }

  async attach(session: Session, ref: Json) {
    if (!ref?.threadId) throw new Error("Codex can't reopen this session: no thread id was saved")
    const version = this.disposed.get(session) ?? 0
    session.setNativeRef(ref)
    await this.start()
    try {
      // Archived rollout files must be restored before resuming by thread id.
      await this.setArchived(session, false)
      if ((this.disposed.get(session) ?? 0) !== version) throw new Error('Codex session stopped')
      await this.resumeThread(session, ref)
      if ((this.disposed.get(session) ?? 0) !== version) throw new Error('Codex session stopped')
    } catch (e) { throw new Error(`Codex can't reopen this session: ${(e as Error).message}`) }
    this.sessions.set(ref.threadId, session)
    this.watchTurns(session)
    if (ref.autoReview) this.autoReview.add(session.info.id)
  }

  private async resumeThread(session: Session, ref: Json) {
    await this.request('thread/resume', { threadId: ref.threadId, cwd: session.info.cwd, model: session.info.model, sandbox: ref.sandbox ?? 'workspace-write', approvalPolicy: ref.canAskUser ? 'on-request' : 'never', ...(ref.canAskUser ? { approvalsReviewer: ref.autoReview ? 'auto_review' : 'user' } : {}), config: { ...(session.info.effort ? { model_reasoning_effort: session.info.effort } : {}), ...(ref.canAskUser ? { 'features.default_mode_request_user_input': true } : {}) } })
    this.resumeNeeded.delete(ref.threadId)
  }

  // Codex changes reviewers at the next turn; the plugin reviews until then.
  setAutoMode(session: Session) {
    this.autoReview.add(session.info.id)
    session.setNativeRef({ ...session.nativeRef, autoReview: true })
  }

  isBusy(session: Session) { return this.starting.has(session) || !!session.activeTurnId || [...this.pending.values()].some((p) => p.threadId === session.info.id && ['turn/start', 'turn/steer', 'thread/resume', 'thread/unarchive'].includes(p.method)) }

  async interrupt(session: Session): Promise<void> {
    if (this.starting.has(session) && !session.activeTurnId) this.interruptedStarts.add(session)
    for (const id of this.pendingApprovals(session)) this.resolveApproval(session, id, 'deny')
    for (const [id, q] of this.questions) if (q.session === session) {
      this.questions.delete(id)
      this.send({ id: q.rpcId, result: { answers: Object.fromEntries(q.questions.map((x) => [x.id, { answers: ['Stopped.'] }])) } })
    }
    if (!session.activeTurnId || !this.proc) return
    await this.request('turn/interrupt', { threadId: session.info.id, turnId: session.activeTurnId })
  }

  dispose() {
    for (const session of this.sessions.values()) session.dropInputs()
    this.proc?.kill()
  }

  disposeSession(session: Session) {
    this.disposed.set(session, (this.disposed.get(session) ?? 0) + 1)
    session.dropInputs()
    for (const [id, p] of this.pending) if (p.threadId === session.info.id && p.method !== 'thread/archive') { this.pending.delete(id); p.reject(new Error('Codex session stopped')) }
    if (this.proc) void this.interrupt(session).catch(() => {})
    for (const [id, a] of this.approvals) if (a.session === session) this.approvals.delete(id)
    for (const [id, q] of this.questions) if (q.session === session) this.questions.delete(id)
    if (this.sessions.get(session.info.id) === session) this.sessions.delete(session.info.id)
    this.turnListeners.get(session)?.()
    this.turnListeners.delete(session)
    void this.setArchived(session, true, true)
    this.autoReview.delete(session.info.id)
    this.interruptedStarts.delete(session)
  }

  private onMessage(msg: Json) {
    if (msg.id !== undefined && ('result' in msg || 'error' in msg) && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message ?? 'codex error'} (${msg.error.code})`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method && msg.id !== undefined) return this.onServerRequest(msg)
    if (msg.method) this.onNotification(msg.method, msg.params ?? {})
  }

  private onServerRequest(msg: Json) {
    const p = msg.params ?? {}
    const session = p.threadId ? this.sessions.get(p.threadId) : undefined
    if (session && msg.method === 'item/tool/requestUserInput') {
      const questionId = randomUUID()
      const questions: Question[] = (p.questions ?? []).map((q: Json) => ({
        id: q.id,
        header: q.header ?? '',
        question: q.question ?? '',
        options: (q.options ?? []).map((o: Json) => ({ label: o.label, description: o.description ?? '' })),
        allowOther: !!q.isOther,
        secret: !!q.isSecret,
      }))
      this.questions.set(questionId, { rpcId: msg.id, questions, session })
      session.push({ type: 'question_asked', questionId, questions })
      return
    }
    const kind =
      msg.method === 'item/commandExecution/requestApproval' ? 'command'
      : msg.method === 'item/fileChange/requestApproval' ? 'file_change'
      : msg.method === 'item/permissions/requestApproval' ? 'permissions'
      : null
    if (!session || !kind) {
      this.log(`codex asked ${msg.method}; not handled, refusing`)
      return this.send({ id: msg.id, error: { code: -32601, message: 'bitfrost does not handle this request' } })
    }
    const approvalId = randomUUID()
    this.approvals.set(approvalId, { rpcId: msg.id, method: msg.method, params: p, session })
    const access = (perms: Json) =>
      [perms?.network ? 'network access' : null, perms?.fileSystem ? `file access (${JSON.stringify(perms.fileSystem).slice(0, 200)})` : null]
        .filter(Boolean)
        .join(' and ')
    const title =
      kind === 'command' ? `run \`${unwrapShell(p.command ?? '(unknown command)')}\``
      : kind === 'file_change' ? (p.grantRoot ? `write files under ${p.grantRoot}` : 'change files outside its sandbox')
      : `get ${access(p.permissions) || 'extra permissions'}`
    const detail = [
      p.reason ? `Reason: ${p.reason}` : null,
      kind === 'command' && p.additionalPermissions ? `Needs ${access(p.additionalPermissions) || 'extra permissions'}.` : null,
      p.cwd ? `In ${p.cwd}` : null,
    ]
      .filter(Boolean)
      .join('\n')
    const tool = kind === 'command' && p.command ? { tool: 'Bash', input: { command: unwrapShell(p.command) } } : {}
    session.push({ type: 'approval_requested', approvalId, itemId: p.itemId ?? null, kind, title, detail, ...tool })
  }

  pendingQuestions(session: Session): string[] {
    return [...this.questions].filter(([, q]) => q.session === session).map(([id]) => id)
  }

  async answerQuestion(session: Session, questionId: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean> {
    const q = this.questions.get(questionId)
    if (!q || q.session !== session) return false
    this.questions.delete(questionId)
    const fallback = defer
      ? 'The lead agent will answer this. Stop now; the answer will arrive as the next message.'
      : 'No answer from the user; use your best judgment.'
    const out: Record<string, { answers: string[] }> = {}
    for (const question of q.questions) out[question.id] = { answers: answers?.[question.id]?.length ? answers[question.id] : [fallback] }
    this.send({ id: q.rpcId, result: { answers: out } })
    session.push({ type: 'question_answered', questionId, how: defer ? 'deferred' : 'answered' })
    if (defer) void session.stop(this, 'host', { preserveQueue: true }).catch(() => {})
    return true
  }

  pendingApprovals(session: Session): string[] {
    return [...this.approvals].filter(([, a]) => a.session === session).map(([id]) => id)
  }

  // Codex approval replies cannot carry a denial reason.
  resolveApproval(session: Session, approvalId: string, decision: Decision, _reason?: string): boolean {
    const a = this.approvals.get(approvalId)
    if (!a || a.session !== session) return false
    this.approvals.delete(approvalId)
    let result: Json
    if (a.method === 'item/permissions/requestApproval') {
      const granted = Object.fromEntries(Object.entries(a.params.permissions ?? {}).filter(([, v]) => v != null))
      result = decision === 'deny' ? { permissions: {}, scope: 'turn' } : { permissions: granted, scope: decision === 'allow_session' ? 'session' : 'turn' }
    } else {
      result = { decision: decision === 'allow' ? 'accept' : decision === 'allow_session' ? 'acceptForSession' : 'decline' }
    }
    this.send({ id: a.rpcId, result })
    session.push({ type: 'approval_resolved', approvalId, decision })
    return true
  }

  private onNotification(method: string, p: Json) {
    const session = p.threadId ? this.sessions.get(p.threadId) : undefined
    if (!session) return
    const item = p.item
    const emit = (body: AgentEventBody) => session.push(body, { codex: { method } })
    switch (method) {
      case 'turn/started':
        if (!session.hasTurnStarted(p.turn.id)) emit({ type: 'turn_started', turnId: p.turn.id })
        return
      case 'item/started':
        if (item.type === 'commandExecution')
          emit({
            type: 'command_started',
            itemId: item.id,
            command: unwrapShell(item.command),
            summary: describeCommand(item.commandActions, unwrapShell(item.command)),
            cwd: item.cwd,
          })
        return
      case 'item/completed':
        return this.onItemCompleted(session, p.turnId, item, emit)
      case 'item/autoApprovalReview/completed': {
        const a = p.action ?? {}
        const action = typeof a.command === 'string' ? `run \`${unwrapShell(a.command)}\`` : String(a.type ?? 'a request')
        emit({ type: 'auto_reviewed', itemId: p.targetItemId ?? null, action, decision: String(p.review?.status ?? 'unknown'), reason: p.review?.rationale ?? '' })
        return
      }
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last
        if (last) emit({ type: 'usage', inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0, cachedInputTokens: last.cachedInputTokens ?? 0 })
        return
      }
      case 'item/agentMessage/delta':
        session.live = { activity: 'responding', partialText: (session.live?.partialText ?? '') + (p.delta ?? ''), updatedAt: Date.now() }
        return
      case 'turn/completed': {
        const t = p.turn
        const status = t.status === 'interrupted' ? 'interrupted' : t.status === 'failed' ? 'failed' : 'completed'
        emit({ type: 'turn_completed', turnId: t.id, status, reason: codexEndReason(status, t.error), finalText: this.turnText.get(t.id) ?? session.live?.partialText ?? '', error: errorText(t.error?.message) })
        this.turnText.delete(t.id)
        return
      }
      case 'error':
        this.log(`codex error on ${p.threadId}: ${JSON.stringify(p.error ?? p).slice(0, 300)}`)
        return
    }
  }

  private onItemCompleted(session: Session, turnId: string, item: Json, emit: (b: AgentEventBody) => void) {
    if (!KNOWN_ITEMS.has(item.type)) this.log(`codex: unhandled item ${item.type}: ${JSON.stringify(item).slice(0, 600)}`)
    switch (item.type) {
      case 'agentMessage':
        if (!item.text) return
        this.turnText.set(turnId, item.text)
        return emit({ type: 'text', itemId: item.id, text: item.text })
      case 'reasoning': {
        const text = (item.summary ?? []).map((s: Json) => (typeof s === 'string' ? s : s.text ?? '')).join('\n').trim()
        if (text) emit({ type: 'reasoning', itemId: item.id, text })
        return
      }
      case 'commandExecution':
        return emit({
          type: 'command_completed',
          itemId: item.id,
          command: unwrapShell(item.command),
          summary: describeCommand(item.commandActions, unwrapShell(item.command)),
          cwd: item.cwd,
          output: item.aggregatedOutput ?? '',
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
          status: item.status,
        })
      case 'fileChange': {
        const changes: FileChange[] = (item.changes ?? []).map((c: Json) => ({
          path: c.path,
          kind: c.kind?.type ?? 'update',
          movePath: c.kind?.move_path ?? null,
          diff: c.diff ?? '',
        }))
        return emit({ type: 'file_change', itemId: item.id, changes, status: item.status })
      }
      case 'mcpToolCall':
        return emit({
          type: 'tool',
          itemId: item.id,
          name: `${item.server}.${item.tool}`,
          input: item.arguments,
          output: JSON.stringify(item.result ?? item.error ?? null).slice(0, 4000),
          status: item.status,
        })
      case 'webSearch':
        return emit({ type: 'tool', itemId: item.id, name: 'web_search', input: { query: item.query }, output: '', status: 'completed' })
      case 'dynamicToolCall':
        return emit({
          type: 'tool',
          itemId: item.id,
          name: `${item.namespace ?? ''}.${item.tool}`,
          input: item.arguments,
          output: JSON.stringify(item.contentItems ?? null).slice(0, 4000),
          status: item.success === false ? 'failed' : 'completed',
        })
    }
  }
}

export function codexEndReason(status: string, error: Json): EndReason {
  if (status === 'interrupted') return 'interrupted'
  if (status === 'completed') return 'end_turn'
  const info = error?.codexErrorInfo
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : null
  const http = error?.httpStatusCode ?? (info && typeof info === 'object' ? Object.values(info).find((v: any) => v?.httpStatusCode)?.httpStatusCode : null)
  if (Number(http) === 429) return 'rate_limited'
  if ([401, 403].includes(Number(http))) return 'auth'
  switch (code) {
    case 'usageLimitExceeded': case 'sessionBudgetExceeded': return 'quota_exhausted'
    case 'contextWindowExceeded': return 'max_tokens'
    case 'activeTurnNotSteerable': return 'error'
    case 'tooManyDenials': case 'tooManyPendingApprovals': case 'approvalDenied': case 'permissionDenied': return 'permission_denied'
    case 'maxTurnRequests': return 'max_requests'
    case 'refusal': case 'cyberPolicy': case 'misalignmentPolicyViolation': case 'misalignmentPolicy': return 'refusal'
    case 'unauthorized': case 'authenticationFailed': return 'auth'
    case 'rateLimitExceeded': return 'rate_limited'
  }
  const message = String(error?.message ?? (typeof error === 'string' ? error : '')).toLowerCase()
  if (/\b(?:rate[ _-]?limit(?:ed| exceeded)?|429)\b/.test(message)) return 'rate_limited'
  if (/\b(?:auth|authentication|unauthorized|401|403)\b/.test(message)) return 'auth'
  if (/\b(?:quota|usage[ _-]?limits?|insufficient_quota|session[ _-]?budget)\b/.test(message)) return 'quota_exhausted'
  if (/\b(?:context[ _-]?window|token[ _-]?limit)\b/.test(message)) return 'max_tokens'
  if (/\b(?:denials|permission[ _-]?denied)\b/.test(message)) return 'permission_denied'
  if (/\b(?:max[ _-]?requests|max[ _-]?turn[ _-]?requests)\b/.test(message)) return 'max_requests'
  if (/\b(?:refusal|cyberpolicy|misalignmentpolicy)\b/.test(message)) return 'refusal'
  return 'error'
}

function errorText(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try {
    const body = JSON.parse(raw)
    const e = body.error ?? body
    return [e.message, e.status ?? body.status].filter(Boolean).join(' ') || raw.slice(0, 300)
  } catch {
    return raw.slice(0, 300)
  }
}

// Try the desktop app's newest downloaded Codex, then its bundled copy.
const BUNDLED_CODEX = ['/usr/lib/chatgpt/resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex']

export function desktopCodex(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), bundled = BUNDLED_CODEX): string | null {
  const releases = path.join(codexHome, 'packages', 'app-server-daemon', 'releases')
  let names: string[] = []
  try {
    names = fs.readdirSync(releases)
  } catch {}
  const version = (name: string) => (name.match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  const newestFirst = (a: string, b: string) => {
    const [va, vb] = [version(a), version(b)]
    return vb[0] - va[0] || vb[1] - va[1] || vb[2] - va[2]
  }
  const downloaded = names.filter((n) => version(n).length === 3).sort(newestFirst).map((n) => path.join(releases, n, 'bin', 'codex'))
  for (const bin of [...downloaded, ...bundled]) {
    try {
      fs.accessSync(bin, fs.constants.X_OK)
      return bin
    } catch {}
  }
  return null
}

export const codexProvider: ProviderFactory = {
  id: 'codex',
  create(env: ProviderEnv) {
    const chosen = process.env.BITFROST_CODEX_BIN ?? env.config.bin ?? env.resolveBinary('codex')
    if (chosen) return new CodexAdapter(chosen, env.log, env.recorder('codex'))
    const bin = desktopCodex()
    return bin ? new CodexAdapter(bin, env.log, env.recorder('codex'), () => desktopCodex()) : null
  },
}
