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
import type { AgentEventBody, Decision, FileChange, Question } from '../events.ts'
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
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private sessions = new Map<string, Session>()
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
        this.log(`codex app-server could not run: ${e.message}`)
        for (const p of this.pending.values()) p.reject(e)
        this.pending.clear()
        this.proc = null
        this.ready = null
      })
      proc.on('exit', (code, signal) => {
        this.log(`codex app-server exited code=${code} signal=${signal}`)
        for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'))
        this.pending.clear()
        for (const s of this.sessions.values()) if (s.info.state === 'running') s.push({ type: 'session_failed', error: 'codex app-server exited' })
        this.proc = null
        this.ready = null
      })
      createInterface({ input: proc.stdout! }).on('line', (line) => {
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

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
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
      // Keep threads in memory so they stay out of the app's conversation list.
      ephemeral: true,
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
    await this.sendInput(session, req.prompt)
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

  async sendInput(session: Session, text: string): Promise<void> {
    await this.start()
    const input = [{ type: 'text', text }]
    if (session.activeTurnId) {
      await this.request('turn/steer', { threadId: session.info.id, expectedTurnId: session.activeTurnId, input })
      return
    }
    const reviewer = this.autoReview.has(session.info.id) ? { approvalsReviewer: 'auto_review' } : {}
    const r = await this.request('turn/start', { threadId: session.info.id, input, ...reviewer })
    if (!session.activeTurnId && r?.turn?.id) session.push({ type: 'turn_started', turnId: r.turn.id })
  }

  // Codex changes reviewers at the next turn; the plugin reviews until then.
  setAutoMode(session: Session) {
    this.autoReview.add(session.info.id)
  }

  async interrupt(session: Session): Promise<void> {
    for (const id of this.pendingApprovals(session)) this.resolveApproval(session, id, 'deny')
    for (const [id, q] of this.questions) if (q.session === session) {
      this.questions.delete(id)
      this.send({ id: q.rpcId, result: { answers: Object.fromEntries(q.questions.map((x) => [x.id, { answers: ['Stopped.'] }])) } })
    }
    if (!session.activeTurnId || !this.proc) return
    await this.request('turn/interrupt', { threadId: session.info.id, turnId: session.activeTurnId })
  }

  dispose() {
    this.proc?.kill()
  }

  disposeSession(session: Session) {
    if (this.proc) void this.interrupt(session).catch(() => {})
    for (const [id, a] of this.approvals) if (a.session === session) this.approvals.delete(id)
    for (const [id, q] of this.questions) if (q.session === session) this.questions.delete(id)
    if (this.sessions.get(session.info.id) === session) this.sessions.delete(session.info.id)
    this.autoReview.delete(session.info.id)
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
    if (defer) await this.interrupt(session)
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
        if (session.activeTurnId !== p.turn.id) emit({ type: 'turn_started', turnId: p.turn.id })
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
      case 'turn/completed': {
        const t = p.turn
        const status = t.status === 'interrupted' ? 'interrupted' : t.status === 'failed' ? 'failed' : 'completed'
        emit({ type: 'turn_completed', turnId: t.id, status, finalText: this.turnText.get(t.id) ?? '', error: errorText(t.error?.message) })
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
