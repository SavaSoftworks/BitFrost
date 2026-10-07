// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Decision, EndReason, Question } from '../events.ts'
import type { HarnessModel, Provider, ProviderCapabilities, SpawnRequest } from '../provider.ts'
import type { Session } from '../session.ts'
import { asClaudeTool, blankTool, choicesOf, commandOf, confirmShape, cwdOf, describeAction, exitCodeOf, FILE_KINDS, fileChange } from './acp-shapes.ts'
import { formContent, globMatch, grantKeyOf, hasInput, isSelect, objectOf, outputOf, permissionOutcome, summaryOf, toQuestion, vendorOf, type ToolCall } from './acp-shapes.ts'

type Json = any

const PROTOCOL_VERSION = 1
// ACP uses -32000 when the user must sign in.
const AUTH_REQUIRED = -32000
const CANCEL_GRACE_MS = 15_000
const STOPS: Record<string, string> = {
  max_tokens: 'it reached its output limit',
  max_turn_requests: 'it reached its limit of model requests for one turn',
  refusal: 'the model refused to continue',
}

export type AcpAgentSpec = {
  id: string
  displayName: string
  vendor: string | null
  binary: string
  args: string[]
  env?: Record<string, string>
  configOverlay?: { flag: string; file: string; body: unknown }
  loginCommand: string
  optIn: true
  gates: ProviderCapabilities['gates']
  note: string
}

export type AcpLaunch = { bin: string; args: string[]; env: Record<string, string> }

export type AcpOptions = {
  log: (msg: string) => void
  record?: ((line: string) => void) | null
  runDir?: string | null
  models?: string[] | null
}

// Cache for a day because listing can switch models and leave history entries.
const MODELS_TTL_MS = 24 * 60 * 60_000

type Turn = {
  id: string
  cancelled: boolean
  wrongModel: string | null
  chunk: { kind: 'text' | 'reasoning'; messageId: string | null; text: string } | null
  items: number
  finalText: string
  tools: Map<string, ToolCall>
  lastUsed: number | null
  denied: { at: number; reason: string } | null
}

type State = {
  session: Session
  acpId: string
  cwd: string
  model: string
  modelOption: string | null
  canAsk: boolean
  intro: string | null
  drifted: boolean
  dead: boolean
  turn: Turn | null
  grants: Set<string>
}

type Pending =
  | { kind: 'permission'; session: Session; rpcId: number | string; options: Json[]; grantKey: string }
  | { kind: 'confirm'; session: Session; rpcId: number | string; field: string; yes: Json; no: Json; grantKey: string }
  | { kind: 'question'; session: Session; rpcId: number | string; questions: Question[]; schema: Json }

export class AcpProvider implements Provider {
  readonly id: string
  readonly displayName: string
  readonly vendor?: string
  readonly capabilities: ProviderCapabilities
  readonly location: string
  private spec: AcpAgentSpec
  private launch: AcpLaunch
  private log: (msg: string) => void
  private record: ((line: string) => void) | null
  private cacheFile: string | null
  private allow: string[] | null
  private models: { at: number; allow: string[] | null; list: HarnessModel[] } | null = null
  private proc: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private agentCaps: Json = {}
  private nextId = 1
  private requests = new Map<number, { session?: Session; resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private byAcpId = new Map<string, State>()
  private states = new Map<string, State>()
  private pending = new Map<string, Pending>()
  private opening = new Set<Session>()
  private discovering = 0

  constructor(spec: AcpAgentSpec, launch: AcpLaunch, opts: AcpOptions) {
    this.id = spec.id
    this.displayName = spec.displayName
    if (spec.vendor) this.vendor = spec.vendor
    this.capabilities = { steer: false, autoReview: false, questions: true, gates: spec.gates }
    this.location = launch.bin
    this.spec = spec
    this.launch = launch
    this.log = opts.log
    this.record = opts.record ?? null
    this.cacheFile = opts.runDir ? path.join(opts.runDir, `acp-${spec.id}-models.json`) : null
    this.allow = opts.models?.length ? opts.models : null
  }


  private start(): Promise<void> {
    if (this.ready) return this.ready
    const proc = spawn(this.launch.bin, this.launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.launch.env } })
    this.proc = proc
    proc.on('error', (e) => this.onExit(proc, `could not start (${e.message})`))
    proc.on('exit', (code, signal) => this.onExit(proc, `exited (code ${code}, signal ${signal})`))
    proc.stdin!.on('error', () => {}) // Ignore failed writes; the exit handler reports the failure.
    proc.stderr!.on('data', (d) => this.log(`${this.id} stderr: ${String(d).trimEnd().slice(0, 1000)}`))
    // Ignore old pipes because Gemini CLI shares them with its replacement process.
    createInterface({ input: proc.stdout! }).on('line', (line) => this.proc === proc && this.onLine(line))
    // Offer only forms because the app handles files and commands itself.
    this.ready = this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'bitfrost', title: 'bitfrost', version: '0.1.0' },
    }).then((r) => {
      if (r?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${this.displayName} speaks ACP version ${r?.protocolVersion}, not ${PROTOCOL_VERSION}`)
      this.agentCaps = r.agentCapabilities ?? {}
    })
    this.ready.catch((e) => {
      this.log(`${this.id}: handshake failed: ${e.message}`)
      if (this.proc === proc) proc.kill()
    })
    return this.ready
  }

  private onExit(proc: ChildProcess, why: string) {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = null
    this.log(`${this.id}: ${this.launch.bin} ${why}`)
    this.pending.clear()
    for (const session of this.opening) if (session.info.id) session.detach()
    const states = [...this.states.values()]
    this.states.clear()
    this.byAcpId.clear()
    for (const st of states) {
      st.dead = true
      const turn = st.turn
      st.turn = null
      st.session.detach()
      if (turn?.cancelled) {
        this.flush(st, turn)
        st.session.push({ type: 'turn_completed', turnId: turn.id, status: turn.wrongModel ? 'failed' : 'interrupted', reason: turn.wrongModel ? 'wrong_model' : 'interrupted', finalText: turn.finalText })
      } else if (turn) st.session.push({ type: 'session_failed', error: `${this.displayName} ${why}` })
    }
    const err = new Error(`${this.displayName} ${why}`)
    for (const r of this.requests.values()) r.reject(err)
    this.requests.clear()
  }

  private send(msg: Json) {
    this.proc?.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  private request(method: string, params: Json, session?: Session): Promise<Json> {
    if (!this.proc) return Promise.reject(new Error(`${this.displayName} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject, session })
      this.send({ id, method, params })
    })
  }

  private reply(rpcId: number | string, result: Json) {
    this.send({ id: rpcId, result })
  }

  private onLine(line: string) {
    this.record?.(line)
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return this.log(`${this.id}: not JSON: ${line.slice(0, 200)}`)
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const r = this.requests.get(msg.id)
      if (!r) return
      this.requests.delete(msg.id)
      if (msg.error) r.reject(Object.assign(new Error(msg.error.message ?? 'error'), { code: msg.error.code }))
      else r.resolve(msg.result)
    } else if (msg.id !== undefined) {
      this.onRequest(msg)
    } else if (msg.method === 'session/update') {
      this.onUpdate(msg.params ?? {})
    }
  }

  private onRequest(msg: Json) {
    if (msg.method === 'session/request_permission') return this.onPermission(msg.id, msg.params ?? {})
    if (msg.method === 'elicitation/create') return this.onElicitation(msg.id, msg.params ?? {})
    this.log(`${this.id} asked ${msg.method}; not offered, refusing`)
    this.send({ id: msg.id, error: { code: -32601, message: `bitfrost does not handle ${msg.method}` } })
  }

  private explain(e: Json): Error {
    if (e?.code !== AUTH_REQUIRED) return e
    return new Error(`${this.displayName} could not start a session: ${e.message}. If it needs signing in, run \`${this.spec.loginCommand}\` in a terminal, then try again.`)
  }

  private async newSession(cwd: string, session?: Session): Promise<Json> {
    try {
      return await this.request('session/new', { cwd, mcpServers: [] }, session)
    } catch (e) {
      throw this.explain(e)
    }
  }

  // Close task sessions to keep their history; delete throwaway sessions when supported.
  private dropSession(acpId: string, keep = false) {
    const caps = this.agentCaps.sessionCapabilities ?? {}
    const method = caps.delete && !keep ? 'session/delete' : caps.close ? 'session/close' : null
    if (method) this.request(method, { sessionId: acpId }).catch(() => {})
  }

  private async setOption(acpId: string, configId: string, value: string, session?: Session): Promise<Json[]> {
    const r = await this.request('session/set_config_option', { sessionId: acpId, configId, value }, session)
    return r?.configOptions ?? []
  }


  async listModels(): Promise<HarnessModel[]> {
    this.discovering++
    try { return await this.discoverModels() } finally { this.discovering-- }
  }

  private async discoverModels(): Promise<HarnessModel[]> {
    const fresh = (c: typeof this.models) => c && Date.now() - c.at < MODELS_TTL_MS && JSON.stringify(c.allow) === JSON.stringify(this.allow)
    if (!fresh(this.models) && this.cacheFile) {
      try {
        this.models = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      } catch {}
    }
    if (fresh(this.models)) return this.models!.list
    await this.start()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-acp-'))
    let list: HarnessModel[]
    try {
      const r = await this.newSession(dir)
      try {
        list = await this.readModels(r)
      } finally {
        this.dropSession(r.sessionId)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    this.models = { at: Date.now(), allow: this.allow, list }
    if (this.cacheFile) {
      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.models))
      } catch (e) {
        this.log(`${this.id}: could not cache the model list: ${(e as Error).message}`)
      }
    }
    return list
  }

  // Select only allowed models to read their thought levels without recording other switches.
  private async readModels(r: Json): Promise<HarnessModel[]> {
    const picker = (r.configOptions ?? []).find(isSelect('model'))
    if (!picker) {
      const m = r.models
      return (m?.availableModels ?? []).map((x: Json) => this.harnessModel({ value: x.modelId, name: x.name, description: x.description }, null, x.modelId === m.currentModelId))
    }
    const startLevel = (r.configOptions ?? []).find(isSelect('thought_level')) ?? null
    const out: HarnessModel[] = []
    for (const choice of choicesOf(picker)) {
      const value = String(choice.value)
      const isDefault = value === picker.currentValue
      if (isDefault || !this.allow?.some((pattern) => globMatch(pattern, value))) {
        out.push(this.harnessModel(choice, isDefault ? startLevel : null, isDefault))
        continue
      }
      const options = await this.setOption(r.sessionId, picker.id, value).catch((e) => {
        this.log(`${this.id}: could not select ${value}: ${e.message}`)
        return null
      })
      out.push(this.harnessModel(choice, options?.find(isSelect('thought_level')) ?? null, false))
    }
    return out
  }

  private harnessModel(choice: Json, level: Json | null, isDefault: boolean): HarnessModel {
    const value = String(choice.value)
    const name = String(choice.name ?? value)
    const route = value.includes('/') ? value.slice(0, value.indexOf('/')) : null
    return {
      harness: this.id,
      provider: this.vendor ?? vendorOf(value),
      model: value,
      displayName: route && name.includes('/') ? name.slice(name.indexOf('/') + 1) : name,
      description: choice.description && choice.description !== value ? String(choice.description) : route ? `Through ${route}.` : '',
      // Omit "default": opencode uses it already when no effort is chosen.
      efforts: level ? choicesOf(level).map((c) => String(c.value)).filter((v) => v !== 'default') : [],
      defaultEffort: level?.currentValue && level.currentValue !== 'default' ? String(level.currentValue) : null,
      isDefault,
    }
  }

  private async chooseModel(acpId: string, r: Json, model: string, effort: string | undefined, session?: Session): Promise<string | null> {
    let options: Json[] = r.configOptions ?? []
    const picker = options.find(isSelect('model'))
    if (!picker) {
      if (!r.models) throw new Error(`${this.displayName} does not let clients choose a model`)
      if (r.models.currentModelId !== model) await this.request('session/set_model', { sessionId: acpId, modelId: model }, session)
      return null
    }
    if (picker.currentValue !== model) options = await this.setOption(acpId, picker.id, model, session)
    const now = options.find(isSelect('model'))?.currentValue
    if (now !== model) throw new Error(`${this.displayName} chose ${now ?? 'no model'} instead of ${model}`)
    const level = options.find(isSelect('thought_level'))
    if (effort && level && level.currentValue !== effort) {
      if (choicesOf(level).some((c) => c.value === effort)) await this.setOption(acpId, level.id, effort, session)
      else this.log(`${this.id}: ${model} has no thought level ${effort}; keeping ${level.currentValue}`)
    }
    return picker.id
  }


  async spawnSession(session: Session, req: SpawnRequest): Promise<string> {
    this.opening.add(session)
    try { return await this.spawn(session, req) } finally { this.opening.delete(session) }
  }

  private async spawn(session: Session, req: SpawnRequest): Promise<string> {
    await this.start()
    const r = await this.newSession(req.cwd, session)
    let modelOption: string | null
    try {
      modelOption = await this.chooseModel(r.sessionId, r, req.model, req.effort, session)
    } catch (e) {
      this.dropSession(r.sessionId)
      throw e
    }
    const id = `${this.id}_${randomUUID()}`
    session.info.id = id
    const st: State = {
      session,
      acpId: r.sessionId,
      cwd: req.cwd,
      model: req.model,
      modelOption,
      canAsk: !!req.canAskUser,
      intro: req.developerInstructions ?? null,
      drifted: false,
      dead: false,
      turn: null,
      grants: new Set(),
    }
    this.states.set(id, st)
    this.byAcpId.set(st.acpId, st)
    session.info.effort = req.effort ?? null
    session.setNativeRef({ acpSessionId: st.acpId, canAsk: st.canAsk })
    session.acceptInput(req.prompt, 'started')
    this.runTurn(st, req.prompt)
    return id
  }

  async sendInput(session: Session, text: string): Promise<'started' | 'queued'> {
    const st = this.stateOf(session)
    if (!st || st.dead) throw new Error(`${this.displayName} can't reopen this session: the app has restarted since this task began`)
    if (st.turn) { session.queueInput(this, text); return 'queued' }
    this.runTurn(st, text)
    return 'started'
  }

  async attach(session: Session, ref: Json) {
    this.opening.add(session)
    try { await this.load(session, ref) } finally { this.opening.delete(session) }
  }

  private async load(session: Session, ref: Json) {
    await this.start()
    if (!this.agentCaps.loadSession) throw new Error(`${this.displayName} can't reopen this session: the agent does not advertise loadSession`)
    if (!ref?.acpSessionId) throw new Error(`${this.displayName} can't reopen this session: no native session id was saved`)
    const r = await this.request('session/load', { sessionId: ref.acpSessionId, cwd: session.info.cwd, mcpServers: [] }, session)
    const modelOption = await this.chooseModel(ref.acpSessionId, r, session.info.model, session.info.effort ?? undefined, session)
    const st: State = { session, acpId: ref.acpSessionId, cwd: session.info.cwd, model: session.info.model, modelOption, canAsk: !!ref.canAsk, intro: null, drifted: false, dead: false, turn: null, grants: new Set() }
    this.states.set(session.info.id, st)
    this.byAcpId.set(st.acpId, st)
  }

  // The app server is shared, so only force it down when no other session has a turn running.
  kill(session: Session) {
    const busy = [...this.states.entries()].some(([id, st]) => id !== session.info.id && st.turn)
    return !busy && ![...this.opening].some((s) => s !== session) && !this.discovering ? this.proc?.kill('SIGKILL') ?? false : false
  }

  isBusy(session: Session) { return this.opening.has(session) || !!this.stateOf(session)?.turn }

  async interrupt(session: Session): Promise<void> {
    const st = this.stateOf(session)
    if (!st) return
    this.cancelTurn(st)
  }

  dispose() {
    for (const st of this.states.values()) st.session.dropInputs()
    this.proc?.kill()
  }

  disposeSession(session: Session) {
    session.dropInputs()
    const st = this.stateOf(session)
    if (st && !st.dead) {
      this.cancelTurn(st)
      this.dropPending(session)
      this.dropSession(st.acpId, true)
      st.turn = null
      st.dead = true
      this.states.delete(session.info.id)
      if (this.byAcpId.get(st.acpId) === st) this.byAcpId.delete(st.acpId)
    }
    for (const [id, request] of this.requests) if (request.session === session) {
      this.requests.delete(id)
      request.reject(new Error(`${this.displayName} session stopped`))
    }
  }

  private stateOf(session: Session): State | undefined {
    return this.states.get(session.info.id)
  }

  private runTurn(st: State, text: string) {
    const turn: Turn = { id: `acp_${randomUUID()}`, cancelled: false, wrongModel: null, chunk: null, items: 0, finalText: '', tools: new Map(), lastUsed: null, denied: null }
    st.turn = turn
    st.session.push({ type: 'turn_started', turnId: turn.id })
    // ACP has no system prompt, so prepend instructions to the first message.
    const prompt = [...(st.intro ? [{ type: 'text', text: st.intro }] : []), { type: 'text', text }]
    st.intro = null
    const go = async () => {
      if (st.drifted && st.modelOption) {
        const now = (await this.setOption(st.acpId, st.modelOption, st.model, st.session)).find(isSelect('model'))?.currentValue
        if (now !== st.model) throw new Error(`${this.displayName} kept ${now} instead of ${st.model}`)
        st.drifted = false
      }
      return this.request('session/prompt', { sessionId: st.acpId, prompt }, st.session)
    }
    go().then(
      (r) => this.endTurn(st, turn, r ?? {}, null),
      (e) => this.endTurn(st, turn, {}, this.explain(e).message),
    )
  }

  // ACP requires cancelling pending requests before stopping the turn.
  private cancelTurn(st: State) {
    const turn = st.turn
    if (!turn || turn.cancelled) return
    turn.cancelled = true
    this.dropPending(st.session)
    this.send({ method: 'session/cancel', params: { sessionId: st.acpId } })
    const timer = setTimeout(() => {
      if (st.turn === turn) this.endTurn(st, turn, { stopReason: 'cancelled' }, `${this.displayName} did not stop in time`)
    }, CANCEL_GRACE_MS)
    timer.unref()
  }

  private dropPending(session: Session) {
    for (const [id, p] of this.pending) {
      if (p.session !== session) continue
      this.pending.delete(id)
      this.reply(p.rpcId, p.kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' })
      if (p.kind !== 'question') session.push({ type: 'approval_resolved', approvalId: id, decision: 'deny' })
    }
  }

  private endTurn(st: State, turn: Turn, r: Json, error: string | null) {
    if (st.turn !== turn) return
    this.flush(st, turn)
    // Input counts are totals, so pair output with the last context size.
    const out = r.usage?.outputTokens
    if (typeof out === 'number' && out > 0 && turn.lastUsed !== null) st.session.push({ type: 'usage', inputTokens: turn.lastUsed, outputTokens: out, cachedInputTokens: 0 })
    const stop = r.stopReason
    const status =
      turn.wrongModel || (error && !turn.cancelled) ? 'failed'
      : turn.cancelled || stop === 'cancelled' ? 'interrupted'
      : stop === 'end_turn' ? 'completed'
      : 'failed'
    const denied = stop !== 'end_turn' && !turn.cancelled && !turn.wrongModel && turn.denied && Date.now() - turn.denied.at <= 2000 ? turn.denied : null
    const reason: EndReason = turn.wrongModel ? 'wrong_model' : turn.cancelled || stop === 'cancelled' ? 'interrupted' : denied ? 'permission_denied' : error ? 'error' : ({ end_turn: 'end_turn', max_tokens: 'max_tokens', max_turn_requests: 'max_requests', refusal: 'refusal' } as Record<string, EndReason>)[stop] ?? 'error'
    const why = turn.wrongModel
      ? `${this.displayName} switched to ${turn.wrongModel} instead of ${st.model}; stopped it`
      : (denied?.reason ?? error ?? (status === 'failed' ? (STOPS[stop] ?? `it stopped (${stop})`) : null))
    st.turn = null
    st.session.push({ type: 'turn_completed', turnId: turn.id, status, reason, finalText: turn.finalText, ...(why ? { error: why } : {}) })
  }


  private onUpdate(p: Json) {
    const st = this.byAcpId.get(p.sessionId)
    const u = p.update ?? {}
    if (!st) return
    if (u.sessionUpdate === 'config_option_update') return this.checkModel(st, u.configOptions)
    const turn = st.turn
    if (!turn) return
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return this.addChunk(st, turn, 'text', u)
      case 'agent_thought_chunk':
        return this.addChunk(st, turn, 'reasoning', u)
      case 'tool_call':
      case 'tool_call_update':
        this.flush(st, turn)
        return this.onToolCall(st, turn, u)
      case 'plan':
        this.flush(st, turn)
        return void st.session.push({ type: 'plan', entries: (u.entries ?? []).map((e: Json) => ({ content: String(e.content ?? ''), status: String(e.status ?? 'pending') })) })
      case 'usage_update':
        turn.lastUsed = Number(u.used) || 0
        return void st.session.push({ type: 'usage', inputTokens: turn.lastUsed, outputTokens: 0, cachedInputTokens: 0 })
    }
  }

  // Stop model switches so the task uses only the model the user chose.
  private checkModel(st: State, options: Json[] | undefined) {
    const now = options?.find(isSelect('model'))?.currentValue
    if (now === undefined || now === st.model) return
    st.drifted = true
    if (!st.turn || st.turn.wrongModel) return
    st.turn.wrongModel = String(now)
    this.cancelTurn(st)
  }

  private addChunk(st: State, turn: Turn, kind: 'text' | 'reasoning', u: Json) {
    const messageId = u.messageId ?? null
    const open = turn.chunk
    if (open && (open.kind !== kind || (messageId && open.messageId && messageId !== open.messageId))) this.flush(st, turn)
    turn.chunk ??= { kind, messageId, text: '' }
    if (u.content?.type === 'text') turn.chunk.text += String(u.content.text ?? '')
    st.session.live = { activity: kind === 'text' ? 'responding' : 'thinking', partialText: kind === 'text' ? turn.chunk.text : turn.finalText || null, updatedAt: Date.now() }
  }

  private flush(st: State, turn: Turn) {
    const c = turn.chunk
    turn.chunk = null
    const text = c?.text.trim()
    if (!c || !text) return
    if (c.kind === 'text') turn.finalText = text
    st.session.push({ type: c.kind, itemId: `${c.messageId ?? turn.id}:${++turn.items}`, text })
  }

  private onToolCall(st: State, turn: Turn, u: Json) {
    const id = String(u.toolCallId)
    let t = turn.tools.get(id)
    if (!t) turn.tools.set(id, (t = blankTool()))
    if (u.kind != null) t.kind = u.kind
    if (u.title != null) t.title = u.title
    if (u.name != null) t.name = u.name
    if (u.rawInput != null) t.rawInput = u.rawInput
    if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput
    if (u.content != null) t.content = u.content
    if (u.locations != null) t.locations = u.locations
    if (u.status != null) t.status = u.status
    if (t.done) return
    if (t.status === 'completed' || t.status === 'failed') this.finishTool(st, id, t)
    // Wait for finished file diffs and usable tool inputs; opencode may send only "bash" first.
    else if (!t.started && !FILE_KINDS.has(t.kind) && (t.status === 'in_progress' || hasInput(t))) this.startTool(st, id, t)
  }

  private startTool(st: State, id: string, t: ToolCall) {
    t.started = true
    if (t.kind === 'execute') {
      const command = commandOf(t)
      st.session.push({ type: 'command_started', itemId: id, command, summary: summaryOf(t, command), cwd: cwdOf(t, st.cwd) })
      return
    }
    const c = asClaudeTool(t)
    st.session.push({ type: 'tool_started', itemId: id, name: c.name, input: c.input })
  }

  private finishTool(st: State, id: string, t: ToolCall) {
    t.done = true
    const ok = t.status === 'completed'
    const diffs = t.content.filter((c) => c?.type === 'diff')
    if (ok && FILE_KINDS.has(t.kind) && diffs.length) {
      st.session.push({ type: 'file_change', itemId: id, changes: diffs.map((d) => fileChange(t, d)), status: 'completed' })
      return
    }
    if (!t.started) this.startTool(st, id, t)
    if (t.kind === 'execute') {
      const command = commandOf(t)
      st.session.push({
        type: 'command_completed',
        itemId: id,
        command,
        summary: summaryOf(t, command),
        cwd: cwdOf(t, st.cwd),
        output: outputOf(t),
        exitCode: exitCodeOf(t.rawOutput),
        durationMs: null,
        status: ok ? 'completed' : 'failed',
      })
      return
    }
    const c = asClaudeTool(t)
    st.session.push({ type: 'tool_completed', itemId: id, name: c.name, input: c.input, ok, output: outputOf(t) })
  }


  private onPermission(rpcId: number | string, p: Json) {
    const st = this.byAcpId.get(p.sessionId)
    const options = p.options ?? []
    if (!st || st.dead) {
      this.log(`${this.id} asked permission for an unknown session ${p.sessionId}; refusing`)
      return this.reply(rpcId, { outcome: { outcome: 'cancelled' } })
    }
    if (st.turn?.cancelled) return this.reply(rpcId, { outcome: { outcome: 'cancelled' } })
    if (!st.canAsk) return this.reply(rpcId, { outcome: permissionOutcome(options, 'deny') })
    // Merge known inputs because permission requests can omit tool details.
    const call = p.toolCall ?? {}
    const known = st.turn?.tools.get(String(call.toolCallId))
    const t: ToolCall = {
      ...(known ?? blankTool()),
      kind: call.kind ?? known?.kind ?? 'other',
      title: call.title ?? known?.title ?? '',
      name: call.name ?? known?.name ?? null,
      rawInput: { ...objectOf(known?.rawInput), ...objectOf(call.rawInput) },
      content: call.content?.length ? call.content : (known?.content ?? []),
      locations: call.locations?.length ? call.locations : (known?.locations ?? []),
    }
    const grantKey = grantKeyOf(t)
    if (st.grants.has(grantKey)) return this.reply(rpcId, { outcome: permissionOutcome(options, 'allow') })
    const approvalId = randomUUID()
    this.pending.set(approvalId, { kind: 'permission', session: st.session, rpcId, options, grantKey })
    st.session.push({ type: 'approval_requested', approvalId, itemId: call.toolCallId ?? null, ...describeAction(t, st.cwd) })
  }

  private onElicitation(rpcId: number | string, p: Json) {
    const st = p.sessionId ? this.byAcpId.get(p.sessionId) : undefined
    const fields = Object.entries<Json>(p.requestedSchema?.properties ?? {})
    if (!st || st.dead || p.mode !== 'form' || !fields.length) {
      this.log(`${this.id}: declined a ${p.mode ?? 'modeless'} elicitation${st && !st.dead ? '' : ' for an unknown session'}`)
      return this.reply(rpcId, { action: 'decline' })
    }
    if (st.turn?.cancelled) return this.reply(rpcId, { action: 'cancel' })
    const yesNo = confirmShape(fields)
    if (yesNo) return this.onConfirm(st, rpcId, p, yesNo)
    if (!st.canAsk) return this.reply(rpcId, { action: 'decline' })
    const questions = fields.map(([key, s], i) => toQuestion(key, s, i === 0 ? String(p.message ?? '') : ''))
    const questionId = randomUUID()
    this.pending.set(questionId, { kind: 'question', session: st.session, rpcId, questions, schema: p.requestedSchema })
    st.session.push({ type: 'question_asked', questionId, questions })
  }

  // Treat yes/no forms as approvals because Oh My Pi asks about tools this way.
  private onConfirm(st: State, rpcId: number | string, p: Json, c: { field: string; yes: Json; no: Json }) {
    const message = String(p.message ?? '')
    const grantKey = `form:${message}`
    if (st.grants.has(grantKey)) return this.reply(rpcId, { action: 'accept', content: { [c.field]: c.yes } })
    if (!st.canAsk) return this.reply(rpcId, { action: 'accept', content: { [c.field]: c.no } })
    const open = [...(st.turn?.tools ?? [])].filter(([, t]) => !t.done)
    const named = p.toolCallId ? st.turn?.tools.get(String(p.toolCallId)) : undefined
    const about: [string, ToolCall] | null = named ? [String(p.toolCallId), named] : open.length === 1 ? open[0] : null
    const [first, ...rest] = message.split('\n')
    let action
    if (about) {
      const d = describeAction(about[1], st.cwd)
      action = { ...d, detail: `It asks: ${message}\n${d.detail}` }
    } else {
      action = { kind: 'permissions' as const, title: `go ahead with "${first}"`, detail: [...rest, `In ${st.cwd}`].filter(Boolean).join('\n') }
    }
    const approvalId = randomUUID()
    this.pending.set(approvalId, { kind: 'confirm', session: st.session, rpcId, ...c, grantKey })
    st.session.push({ type: 'approval_requested', approvalId, itemId: about?.[0] ?? null, ...action })
  }

  pendingApprovals(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind !== 'question' && p.session === session).map(([id]) => id)
  }

  // Keep task grants here: the app's "always" option allows more than this exact action.
  resolveApproval(session: Session, approvalId: string, decision: Decision, reason?: string): boolean {
    const p = this.pending.get(approvalId)
    if (!p || p.kind === 'question' || p.session !== session) return false
    this.pending.delete(approvalId)
    if (decision === 'allow_session') this.stateOf(session)?.grants.add(p.grantKey)
    if (p.kind === 'permission') this.reply(p.rpcId, { outcome: permissionOutcome(p.options, decision) })
    else this.reply(p.rpcId, { action: 'accept', content: { [p.field]: decision === 'deny' ? p.no : p.yes } })
    if (decision === 'deny') {
      const turn = this.stateOf(session)?.turn
      if (turn) turn.denied = { at: Date.now(), reason: reason || 'The user denied permission.' }
    }
    if (decision === 'deny' && reason) this.log(`${this.id}: denied ${approvalId}; ACP has no place for the reason: ${reason}`)
    session.push({ type: 'approval_resolved', approvalId, decision })
    return true
  }

  pendingQuestions(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind === 'question' && p.session === session).map(([id]) => id)
  }

  async answerQuestion(session: Session, questionId: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean> {
    const p = this.pending.get(questionId)
    if (!p || p.kind !== 'question' || p.session !== session) return false
    this.pending.delete(questionId)
    const content = defer ? null : formContent(p.schema, answers)
    this.reply(p.rpcId, content ? { action: 'accept', content } : { action: 'decline' })
    session.push({ type: 'question_answered', questionId, how: defer ? 'deferred' : 'answered' })
    if (defer) void session.stop(this, 'host', { preserveQueue: true }).catch(() => {})
    return true
  }
}
