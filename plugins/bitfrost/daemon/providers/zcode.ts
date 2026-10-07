// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Run one headless ZCode process per turn so ZCode handles its own sign-in.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { AgentEventBody, Decision, EndReason, Question } from '../events.ts'
import type { HarnessModel, Provider, ProviderEnv, ProviderFactory, SpawnRequest } from '../provider.ts'
import type { Session } from '../session.ts'
import { processIdentity, killOwnedGroup, killOwnedGroups, type ProcessIdentity } from '../process.ts'

const CODING_PLAN = 'account:zai-individual-coding-plan'

type Json = any

export type ZCodeConfig = {
  electron: string
  cli: string
  builtinProviderConfig: string
  runDir: string
  sessionDb: string
  socket: string
  bridgeInstalled: () => boolean
  recorder?: (name: string) => ((line: string) => void) | null
}

export type ZCodeSpawn = SpawnRequest

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'NotebookEdit'])
// ZCode marks todo tools as having side effects, though they only update run bookkeeping.
const HARMLESS_TOOLS = new Set(['TodoWrite', 'TodoRead'])
// No nested subagents or runs scheduled outside BitFrost.
const DISALLOWED_TOOLS = new Set(['Agent', 'CreateWorkflow', 'AmendWorkflow', 'CronCreate', 'OffPeakCreate'])

type Pending =
  | { kind: 'approval'; session: Session; grantKey: string; resolve: (reply: Json) => void }
  | { kind: 'question'; session: Session; questions: Question[]; input: Json; resolve: (reply: Json) => void }

type Turn = {
  proc: ChildProcess
  turnId: string
  interrupted: boolean
  wrongModel: string | null
  finalText: string
  text: Map<string, string>
  reasoning: Map<string, string>
  builtInMessages: Set<string>
  tools: Map<string, { name: string; input: unknown }>
  stderr: string
  failed: boolean
  failure: { reason: EndReason; code?: string; error: string } | null
}

type State = { zcodeSessionId: string | null; cwd: string; mode: string; model: string; choiceFile: string; token: string; grants: Set<string>; turn: Turn | null; processes: ProcessIdentity[] }

export class ZCodeAdapter implements Provider {
  readonly id = 'zcode'
  readonly displayName = 'ZCode'
  readonly vendor = 'Z.ai'
  readonly capabilities = { steer: false, autoReview: false, questions: true, gates: 'all' as const }
  readonly location: string
  readonly watch: string[]
  private states = new Map<string, State>()
  private byToken = new Map<string, Session>()
  private pending = new Map<string, Pending>()
  private config: ZCodeConfig
  private log: (msg: string) => void

  constructor(config: ZCodeConfig, log: (msg: string) => void) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(config.sessionDb + suffix, 0o600) } catch {}
    }
    this.config = config
    this.location = path.dirname(config.electron)
    this.watch = [config.electron, config.cli]
    this.log = log
  }

  // The last matching catalog rule sets thought levels; the last level is the default.
  async listModels(): Promise<HarnessModel[]> {
    const catalog = JSON.parse(fs.readFileSync(this.config.builtinProviderConfig, 'utf8')).config
    const plan = catalog.providerConfigRules.providerRules.find((r: Json) => r.providerId === CODING_PLAN)
    if (!plan) return []
    const api = plan.config.api
    const rules = catalog.modelConfigRules
    const match = (pattern: string | undefined, value: string) => pattern == null || new RegExp(`^(?:${pattern})$`, 'i').test(value)
    return (plan.config.builtinModelIds as string[]).map((modelId, i) => {
      const matching = [
        ...rules.modelRules.filter((r: Json) => match(r.modelMatch, modelId)),
        ...rules.modelApiRules.filter((r: Json) => match(r.modelMatch, modelId) && match(r.apiTypeMatch, api.type)),
        ...rules.providerSiteRules.filter((r: Json) => match(r.modelMatch, modelId) && match(r.apiTypeMatch, api.type) && match(r.baseUrlMatch, api.baseUrl)),
        ...rules.builtinProviderModelRules.filter((r: Json) => r.providerId === CODING_PLAN && r.modelId === modelId),
      ]
      let levels: string[] = []
      let context: number | null = null
      for (const r of matching) {
        levels = r.config?.optionSpecs?.reasoningLevel?.values ?? levels
        context = r.config?.properties?.contextWindow ?? context
      }
      return {
        harness: this.id,
        provider: 'Z.ai',
        model: modelId,
        displayName: modelId,
        description: `On your ${plan.providerName}${context ? `, ${context >= 1e6 ? `${context / 1e6}M` : `${Math.round(context / 1000)}k`} context` : ''}.`,
        efforts: levels,
        defaultEffort: levels.at(-1) ?? null,
        isDefault: i === 0,
      }
    })
  }

  private choiceFile(model: string, effort: string | undefined): string {
    const file = path.join(this.config.runDir, `zcode-${model}-${effort ?? 'default'}.json`.replace(/[^A-Za-z0-9._-]/g, '_'))
    const selection = { providerId: CODING_PLAN, modelId: model, ...(effort ? { options: { reasoningLevel: effort } } : {}) }
    const body = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: selection,
      },
    }
    fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
    return file
  }

  async spawnSession(session: Session, req: ZCodeSpawn): Promise<string> {
    const id = `zc_${randomUUID()}`
    session.info.id = id
    const choiceFile = this.choiceFile(req.model, req.effort)
    // Edit mode permits local edits and routes other actions through the bridge hook.
    const mode = req.canAskUser ? 'edit' : 'yolo'
    if (req.canAskUser && !this.config.bridgeInstalled()) this.log('zcode: bridge hook not registered; GLM will be refused anything that needs asking (run: bitfrostd setup zcode)')
    const token = randomUUID()
    this.states.set(id, { zcodeSessionId: null, cwd: req.cwd, mode, model: req.model, choiceFile, token, grants: new Set(), turn: null, processes: [] })
    this.byToken.set(token, session)
    session.info.effort = req.effort ?? null
    session.info.plan = CODING_PLAN
    session.setNativeRef({ zcodeSessionId: null, mode })
    session.acceptInput(req.prompt, 'started')
    this.runTurn(session, req.prompt)
    return id
  }

  async sendInput(session: Session, text: string): Promise<'started' | 'queued'> {
    const st = this.states.get(session.info.id)!
    if (!st) throw new Error("ZCode can't reopen this session")
    if (st.turn) { session.queueInput(this, text); return 'queued' }
    // ZCode never named this session, so nothing can resume: start over with everything it was told.
    if (!st.zcodeSessionId) {
      const consumed = new Set(session.events.flatMap((e) => e.type === 'input_consumed' ? [e.inputId] : []))
      const told = session.events.flatMap((e) => e.type === 'user_input' && consumed.has(e.inputId) ? [e.text] : [])
      if (told.length) text = `${told.join('\n\n')}\n\n${text}`
    }
    this.runTurn(session, text)
    return 'started'
  }

  async attach(session: Session, ref: Json) {
    if (!ref?.zcodeSessionId) throw new Error("ZCode can't reopen this session: no native session id was saved")
    const token = randomUUID()
    this.states.set(session.info.id, { zcodeSessionId: ref.zcodeSessionId, cwd: session.info.cwd, mode: ref.mode ?? 'edit', model: session.info.model, choiceFile: this.choiceFile(session.info.model, session.info.effort ?? undefined), token, grants: new Set(), turn: null, processes: [] })
    this.byToken.set(token, session)
  }

  kill(session: Session) {
    const turn = this.states.get(session.info.id)?.turn
    return turn ? killGroup(turn.proc, 'SIGKILL') : false
  }

  isBusy(session: Session) { return !!this.states.get(session.info.id)?.turn }

  async bridge(token: string, input: Json): Promise<Json | null> {
    const session = this.byToken.get(token)
    const st = session && this.states.get(session.info.id)
    if (!session || !st) return deny('Unknown bitfrost run.')
    if (!st.turn || st.turn.interrupted) return deny('Stopped.')
    const tool = String(input.tool_name ?? '')
    const args = input.tool_input ?? {}
    if (DISALLOWED_TOOLS.has(tool)) return deny(`BitFrost subagents cannot use ${tool}: nested subagents, multi-agent workflows, and runs scheduled outside BitFrost are disabled.`)

    if (tool === 'AskUserQuestion') {
      const questions: Question[] = (args.questions ?? []).map((q: Json, i: number) => ({
        id: `q${i}`,
        header: q.header ?? '',
        question: q.question ?? '',
        options: (q.options ?? []).map((o: Json) => ({ label: o.label, description: o.description ?? '' })),
        allowOther: true,
        secret: false,
      }))
      const questionId = randomUUID()
      return new Promise((resolve) => {
        this.pending.set(questionId, { kind: 'question', session, questions, input: args, resolve })
        session.push({ type: 'question_asked', questionId, questions })
      })
    }

    const scope = input.sideEffectScope
    const file = args.file_path ?? args.path ?? args.notebook_path
    if (scope === 'none' || HARMLESS_TOOLS.has(tool)) return null
    if (FILE_TOOLS.has(tool) && typeof file === 'string' && inside(path.resolve(st.cwd, file), st.cwd)) return null

    const grantKey = `${tool}:${tool === 'Bash' ? args.command : (file ?? JSON.stringify(args))}`
    if (st.grants.has(grantKey)) return allow()
    const approvalId = randomUUID()
    const title = tool === 'Bash' ? `run \`${args.command}\`` : file ? `${tool === 'Read' ? 'read' : 'change'} ${file}` : `use ${tool}`
    const detail = [args.description ? `It says: ${args.description}` : null, input.riskLevel ? `ZCode rates this ${input.riskLevel} risk.` : null, `In ${st.cwd}`]
      .filter(Boolean)
      .join('\n')
    return new Promise((resolve) => {
      this.pending.set(approvalId, { kind: 'approval', session, grantKey, resolve })
      session.push({ type: 'approval_requested', approvalId, itemId: input.tool_use_id ?? null, kind: tool === 'Bash' ? 'command' : 'file_change', title, detail, tool, input: args })
    })
  }

  pendingApprovals(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind === 'approval' && p.session === session).map(([id]) => id)
  }

  resolveApproval(session: Session, approvalId: string, decision: Decision, reason?: string): boolean {
    const p = this.pending.get(approvalId)
    if (!p || p.kind !== 'approval' || p.session !== session) return false
    this.pending.delete(approvalId)
    if (decision === 'allow_session') this.states.get(session.info.id)?.grants.add(p.grantKey)
    p.resolve(decision === 'deny' ? deny(reason || 'The user denied this.') : allow())
    session.push({ type: 'approval_resolved', approvalId, decision })
    return true
  }

  pendingQuestions(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind === 'question' && p.session === session).map(([id]) => id)
  }

  // ZCode reads answers from the tool input, keyed by question text.
  async answerQuestion(session: Session, questionId: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean> {
    const p = this.pending.get(questionId)
    if (!p || p.kind !== 'question' || p.session !== session) return false
    this.pending.delete(questionId)
    session.push({ type: 'question_answered', questionId, how: defer ? 'deferred' : 'answered' })
    if (defer) {
      p.resolve(deny('The lead agent will answer this. Stop now; the answer will arrive as the next message.'))
      void session.stop(this, 'host', { preserveQueue: true }).catch(() => {})
      return true
    }
    const given: Record<string, string> = {}
    for (const q of p.questions) if (answers?.[q.id]?.length) given[q.question] = answers[q.id].join(', ')
    p.resolve(Object.keys(given).length ? allow({ ...p.input, answers: given }) : deny('No answer from the user; use your best judgment.'))
    return true
  }

  async interrupt(session: Session): Promise<void> {
    for (const [id, p] of this.pending) if (p.session === session) {
      this.pending.delete(id)
      p.resolve(deny('Stopped.'))
    }
    const st = this.states.get(session.info.id)
    if (!st?.turn) return
    st.turn.interrupted = true
    killGroup(st.turn.proc, 'SIGTERM')
  }

  dispose() {
    for (const session of this.byToken.values()) {
      session.dropInputs()
      if (!this.states.get(session.info.id)?.turn) killOwnedGroup(session.nativeRef?.process, this.log)
    }
    for (const st of this.states.values()) if (st.turn) { st.turn.interrupted = true; killGroup(st.turn.proc, 'SIGKILL') }
    killOwnedGroups([...this.states.values()].flatMap((st) => st.processes), this.log)
  }

  disposeSession(session: Session) {
    session.dropInputs()
    for (const [id, p] of this.pending) if (p.session === session) {
      this.pending.delete(id)
      p.resolve(deny('Stopped.'))
    }
    const st = this.states.get(session.info.id)
    if (!st) return
    if (st.turn) {
      st.turn.interrupted = true
      killGroup(st.turn.proc, 'SIGTERM')
    }
    killOwnedGroups(st.processes, this.log)
    this.byToken.delete(st.token)
    this.states.delete(session.info.id)
  }

  private runTurn(session: Session, prompt: string) {
    const st = this.states.get(session.info.id)!
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(this.config.sessionDb + suffix, 0o600) } catch {}
    }
    const args = [this.config.cli, '-p', prompt, '--disallowed-tools', [...DISALLOWED_TOOLS].join(','), '--output-format', 'stream-json', '--cwd', st.cwd, '--mode', st.mode]
    if (st.zcodeSessionId) args.push('--resume', st.zcodeSessionId)
    const turnId = `zt_${randomUUID()}`
    const proc = spawn(this.config.electron, args, {
      cwd: st.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.config.builtinProviderConfig,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: st.choiceFile,
        // Keep bitfrost sessions out of ZCode's own conversation list.
        ZCODE_SESSION_DB_PATH: this.config.sessionDb,
        BITFROST_ZCODE_TOKEN: st.token,
        BITFROST_ZCODE_TURN: turnId,
        BITFROST_SOCKET: this.config.socket,
        BITFROST_NODE: process.execPath,
      },
    })
    const turn: Turn = { proc, turnId, interrupted: false, wrongModel: null, finalText: '', text: new Map(), reasoning: new Map(), builtInMessages: new Set(), tools: new Map(), stderr: '', failed: false, failure: null }
    st.turn = turn
    if (proc.pid) {
      const identity = processIdentity(proc.pid, turnId)
      st.processes.push(identity)
      session.setNativeRef({ ...session.nativeRef, process: identity })
    }
    session.push({ type: 'turn_started', turnId: turn.turnId })
    const emit = (body: AgentEventBody, ext?: Json) => session.push(body, ext ? { zcode: ext } : undefined)

    proc.stderr!.on('data', (d) => (turn.stderr = (turn.stderr + String(d)).slice(-4000)))
    const record = this.config.recorder?.(`zcode-${session.info.id}`) ?? null
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      record?.(line)
      if (turn.wrongModel) return
      let ev: Json
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.sessionId && !st.zcodeSessionId) {
        st.zcodeSessionId = ev.sessionId
        session.setNativeRef({ ...session.nativeRef, zcodeSessionId: st.zcodeSessionId, mode: st.mode })
      }
      // Stop if ZCode silently falls back to a different model.
      const ran = ev.type === 'session.updated' ? findModelId(ev.payload) : null
      if (ran && ran !== st.model && !turn.wrongModel) {
        turn.wrongModel = ran
        killGroup(proc, 'SIGTERM')
        return
      }
      this.onEvent(turn, ev, emit)
      session.live = { activity: turn.tools.size ? 'working' : 'responding', partialText: [...turn.text.values()].join('') || turn.finalText || null, updatedAt: Date.now() }
    })
    proc.on('error', (e) => {
      if (st.turn !== turn) return
      st.turn = null
      this.log(`zcode could not run: ${e.message}`)
      session.push({ type: 'turn_completed', turnId: turn.turnId, status: 'failed', reason: 'crashed', plan: CODING_PLAN, finalText: '', error: `ZCode could not run: ${e.message}` })
    })
    let exitTimer: NodeJS.Timeout | null = null
    proc.on('exit', (code, signal) => {
      if (turn.interrupted || turn.wrongModel) killGroup(proc, 'SIGKILL')
      exitTimer = setTimeout(() => {
        proc.stdout?.destroy()
        proc.stderr?.destroy()
        finish(code, signal)
      }, 1000)
      exitTimer.unref()
    })
    proc.on('close', (code, signal) => finish(code, signal))
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitTimer) clearTimeout(exitTimer)
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.chmodSync(this.config.sessionDb + suffix, 0o600) } catch {}
      }
      if (st.turn !== turn) return // The error handler already reported this turn.
      if (turn.interrupted || turn.wrongModel) killOwnedGroup(session.nativeRef?.process, this.log)
      // Only groups with a process left are worth sweeping later.
      st.processes = st.processes.filter((p) => { try { process.kill(-p.pgid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } })
      st.turn = null
      const status = turn.wrongModel ? 'failed' : turn.interrupted ? 'interrupted' : turn.failure || code !== 0 ? 'failed' : 'completed'
      if (status === 'failed') this.log(`zcode turn failed code=${code} signal=${signal}: ${turn.stderr.trim().slice(-500)}`)
      session.push({
        type: 'turn_completed',
        turnId: turn.turnId,
        status,
        reason: turn.wrongModel ? 'wrong_model' : turn.interrupted ? 'interrupted' : turn.failure?.reason ?? (status === 'completed' ? 'end_turn' : 'crashed'),
        providerErrorCode: turn.failure?.code,
        plan: CODING_PLAN,
        finalText: turn.finalText || [...turn.text.values()].join(''),
        error: turn.wrongModel
          ? `ZCode started ${turn.wrongModel} instead of ${st.model}; stopped it`
          : status === 'failed'
            ? turn.failure?.error || turn.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`
            : undefined,
      })
    }
  }

  private onEvent(turn: Turn, ev: Json, emit: (b: AgentEventBody, ext?: Json) => void) {
    const p = ev.payload ?? {}
    switch (ev.type) {
      case 'model.streaming': {
        const id = p.assistantMessageId
        if (p.kind === 'text_delta') turn.text.set(id, (turn.text.get(id) ?? '') + (p.delta ?? ''))
        else if (p.kind === 'reasoning_delta') turn.reasoning.set(id, (turn.reasoning.get(id) ?? '') + (p.delta ?? ''))
        else if (p.kind === 'text_end' || p.kind === 'finish') {
          const text = (turn.text.get(id) ?? '').trim()
          turn.text.delete(id)
          if (text && !this.emitBuiltInText(turn, text, `${id}:${ev.seq}`, emit)) {
            turn.finalText = text
            emit({ type: 'text', itemId: `${id}:${ev.seq}`, text })
          }
        } else if (p.kind === 'reasoning_end') {
          const text = (turn.reasoning.get(id) ?? '').trim()
          turn.reasoning.delete(id)
          if (text) emit({ type: 'reasoning', itemId: `${id}:${ev.seq}`, text })
        }
        return
      }
      case 'tool.updated': {
        if (p.source === 'subagent') return
        if (p.kind === 'scheduled') turn.tools.set(p.toolCallId, { name: p.toolName ?? 'tool', input: p.input })
        else if (p.kind === 'started') {
          const t = turn.tools.get(p.toolCallId) ?? { name: p.toolName ?? 'tool', input: {} }
          emit({ type: 'tool_started', itemId: p.toolCallId, name: t.name, input: t.input })
        } else if (p.kind === 'result' || p.kind === 'error') {
          const t = turn.tools.get(p.toolCallId) ?? { name: p.toolName ?? 'tool', input: {} }
          const r = p.result ?? {}
          const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? r.error ?? p.error ?? '')
          emit({
            type: 'tool_completed',
            itemId: p.toolCallId,
            name: t.name,
            input: t.input,
            ok: p.kind === 'result' && r.success !== false,
            output: content,
            display: r.display,
          })
        }
        return
      }
      case 'turn.failed':
        turn.failed = true
        turn.failure = zcodeFailure(p.error ?? p)
        return
      case 'session.updated':
        if (p.type === 'model_request_failed' || p.statusType === 'model_request_failed' || p.kind === 'model_request_failed' || p.reason === 'model_request_failed' || p.queryStatus === 'model_request_failed' || p.model_request_failed) turn.failure = zcodeFailure(p.error ?? p.model_request_failed ?? p)
        // Report one request's context size; turn totals would trigger false context limits.
        if (p.usage && p.querySource === 'main_turn' && p.contextWindow != null) {
          emit({ type: 'usage', inputTokens: p.usage.inputTokens ?? 0, outputTokens: p.usage.outputTokens ?? 0, cachedInputTokens: p.usage.cacheReadTokens ?? 0 })
        }
        return
      case 'turn.completed':
        if (!turn.failed) turn.failure = null
        if (p.response != null && !this.emitBuiltInText(turn, p.response, `${turn.turnId}:completed`, emit)) turn.finalText = p.response
        return
      case 'result':
        if (ev.response != null && !this.emitBuiltInText(turn, ev.response, `${turn.turnId}:result`, emit)) turn.finalText = ev.response
        return
    }
  }

  private emitBuiltInText(turn: Turn, text: string, itemId: string, emit: (b: AgentEventBody) => void): boolean {
    if (typeof text !== 'string') return false
    const parts = splitBuiltInTools(text)
    if (!parts) return false
    const last = parts.at(-1)
    turn.finalText = last?.kind === 'text' ? last.text : ''
    // Completion snapshots repeat the streamed assistant message.
    const key = text.trim()
    if (turn.builtInMessages.has(key)) return true
    turn.builtInMessages.add(key)
    parts.forEach((part, i) => {
      const id = `${itemId}:${i}`
      if (part.kind === 'text') emit({ type: 'text', itemId: id, text: part.text })
      else {
        emit({ type: 'tool_started', itemId: id, name: part.name, input: part.input })
        emit({ type: 'tool_completed', itemId: id, name: part.name, input: part.input, ok: true, output: part.output })
      }
    })
    return true
  }
}

type BuiltInPart = { kind: 'text'; text: string } | { kind: 'tool'; name: string; input: unknown; output: string }

function splitBuiltInTools(text: string): BuiltInPart[] | null {
  const block = /\*\*(?:🌐[ \t]*)?Z\.ai Built-in Tool:[ \t]*([\w.-]+)\*\*[ \t]*\r?\n[ \t\r\n]*\*\*Input:\*\*[ \t]*\r?\n[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```(?=[ \t]*(?:\r?\n|$))/g
  const parts: BuiltInPart[] = []
  let offset = 0
  for (const match of text.matchAll(block)) {
    if (match.index < offset) continue
    const before = text.slice(offset, match.index).trim()
    if (before) parts.push({ kind: 'text', text: before })
    const end = match.index + match[0].length
    const tail = text.slice(end).match(/^[ \t]*(?:\r?\n[ \t]*)*(?:\*Executing on server\.{3}\*[ \t]*(?:\r?\n[ \t]*)*)?(?:\*\*Output:\*\*[ \t]*(?:\r?\n[ \t]*)*)?(\*\*[\w.-]+_result_summary:\*\*[^\r\n]*)?/)
    let input: unknown = match[2]
    try { input = JSON.parse(match[2]!) } catch {}
    parts.push({ kind: 'tool', name: match[1]!, input, output: tail?.[1] ?? '' })
    offset = end + (tail?.[0].length ?? 0)
  }
  if (!parts.length) return null
  const after = text.slice(offset).trim()
  if (after) parts.push({ kind: 'text', text: after })
  return parts
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals) {
  if (!proc.pid) return false
  try { process.kill(-proc.pid, signal); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return proc.kill(signal)
    return false
  }
}

export function classifyZCodeError(code: string | undefined): EndReason {
  const n = Number(code)
  // Matches ZCode's own table: 1113 is an account balance error, 1304 a rate limit.
  if ([1005,1113,2056,20097].includes(n) || (n >= 1308 && n <= 1321) || /^(insufficient_quota|credit_balance_exhausted)$|_spend_limit_exceeded$/.test(code ?? '')) return 'quota_exhausted'
  if ([3002,3008,3009,3010,429,1302,1303,1304,1305].includes(n)) return 'rate_limited'
  if ([1006,3007,401,403].includes(n)) return 'auth'
  return 'error'
}

function zcodeFailure(error: Json): Turn['failure'] {
  const business = /^\d+$/.test(String(error.code)) || classifyZCodeError(error.code) !== 'error' ? error.code : null
  const code = error.attribution?.providerErrorCode ?? error.providerErrorCode ?? error.providerCode ?? error.businessCode ?? business ?? error.statusCode ?? error.code
  return { reason: classifyZCodeError(code == null ? undefined : String(code)), code: code == null ? undefined : String(code), error: String(error.message ?? error.reason ?? 'ZCode model request failed') }
}

function findModelId(value: Json, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (typeof value.modelId === 'string') return value.modelId
  for (const v of Object.values(value)) {
    const found = findModelId(v, depth + 1)
    if (found) return found
  }
  return null
}

const allow = (updatedInput?: Json) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(updatedInput ? { updatedInput } : {}) },
})
const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`)


const HOME = os.homedir()
const HERE = path.dirname(fileURLToPath(import.meta.url))
// Copy the bridge to a fixed path so ZCode's config survives plugin updates.
const BRIDGE_DIR = path.join(process.env.XDG_DATA_HOME ?? path.join(HOME, '.local', 'share'), 'bitfrost', 'zcode-plugin')
const ZCODE_CONFIG = path.join(HOME, '.zcode', 'cli', 'config.json')

function installBridgeCopy() {
  fs.rmSync(BRIDGE_DIR, { recursive: true, force: true })
  fs.cpSync(path.join(HERE, '..', '..', 'zcode-plugin'), BRIDGE_DIR, { recursive: true })
}

function readZCodeConfig(): Json {
  try {
    return JSON.parse(fs.readFileSync(ZCODE_CONFIG, 'utf8'))
  } catch {
    return null
  }
}

const bridgeInstalled = () => (readZCodeConfig()?.plugins?.dirs ?? []).includes(BRIDGE_DIR)

function resolveZCodeDir(env: ProviderEnv): string | null {
  const candidates = [process.env.BITFROST_ZCODE_DIR, env.config.dir]
  const bin = env.resolveBinary('zcode')
  if (bin) candidates.push(path.dirname(fs.realpathSync(bin)))
  candidates.push('/opt/ZCode')
  for (const dir of candidates) if (dir && fs.existsSync(path.join(dir, 'resources', 'glm', 'zcode.cjs'))) return dir
  return null
}

export function sessionDbFor(dataDir = process.env.BITFROST_DATA_DIR || (process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'BitFrost') : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'bitfrost'))): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700)
  const db = path.join(dataDir, 'zcode-sessions.sqlite')
  // Create it private, since ZCode's SQLite gives its -wal and -shm files the same mode.
  try { fs.closeSync(fs.openSync(db, 'a', 0o600)) } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(db + suffix, 0o600) } catch {}
  }
  return db
}

export const zcodeProvider: ProviderFactory = {
  id: 'zcode',
  create(env) {
    const dir = resolveZCodeDir(env)
    if (!dir) return null
    installBridgeCopy()
    return new ZCodeAdapter(
      {
        electron: path.join(dir, 'zcode'),
        cli: path.join(dir, 'resources', 'glm', 'zcode.cjs'),
        builtinProviderConfig: path.join(dir, 'resources', 'config', 'provider', 'zcode-builtin.json'),
        runDir: env.runDir,
        sessionDb: sessionDbFor(env.dataDir),
        socket: env.socket,
        bridgeInstalled,
        recorder: env.recorder,
      },
      env.log,
    )
  },
  setup() {
    installBridgeCopy()
    const cfg = readZCodeConfig() ?? {}
    cfg.plugins ??= {}
    cfg.plugins.dirs ??= []
    if (!cfg.plugins.dirs.includes(BRIDGE_DIR)) cfg.plugins.dirs.push(BRIDGE_DIR)
    fs.mkdirSync(path.dirname(ZCODE_CONFIG), { recursive: true })
    if (fs.existsSync(ZCODE_CONFIG)) fs.copyFileSync(ZCODE_CONFIG, `${ZCODE_CONFIG}.bak-bitfrost`)
    fs.writeFileSync(ZCODE_CONFIG, JSON.stringify(cfg, null, 2) + '\n')
    console.log(`Registered ${BRIDGE_DIR} in ${ZCODE_CONFIG}`)
  },
  uninstall(dryRun = false) {
    const cfg = readZCodeConfig()
    const dirs: string[] | undefined = cfg?.plugins?.dirs
    const found = dirs?.includes(BRIDGE_DIR) ? [{ label: 'GLM bridge in ZCode', path: ZCODE_CONFIG }] : []
    if (dryRun) return found
    if (found.length) {
      cfg.plugins.dirs = dirs!.filter((d) => d !== BRIDGE_DIR)
      if (!cfg.plugins.dirs.length) delete cfg.plugins.dirs
      if (!Object.keys(cfg.plugins).length) delete cfg.plugins
      fs.writeFileSync(ZCODE_CONFIG, JSON.stringify(cfg, null, 2) + '\n')
    }
    fs.rmSync(`${ZCODE_CONFIG}.bak-bitfrost`, { force: true })
    fs.rmSync(BRIDGE_DIR, { recursive: true, force: true })
    return found
  },
}
