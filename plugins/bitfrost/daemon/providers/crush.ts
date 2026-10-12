// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Crush runs as an HTTP server on a private socket, one server per task,
// because Crush keeps the chosen model per workspace and shares a workspace
// between everyone working in the same folder.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Decision, EndReason, Question } from '../events.ts'
import type { HarnessModel, Provider, ProviderCapabilities, ProviderEnv, ProviderFactory, SpawnRequest } from '../provider.ts'
import type { Session } from '../session.ts'
import { blankTool, claudeTool, describeAction, grantKeyOf, objectOf, unifiedDiff, vendorOf, type ToolCall } from './acp-shapes.ts'

type Json = any

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HOOK_SCRIPT = path.join(HERE, 'crush-hook.mjs')
// Crush lets a hook that times out fall through, so give approvals a week.
const HOOK_TIMEOUT_S = 7 * 24 * 3600
// Tools that can change things. The hook asks about each one itself, since another
// hook's allow would otherwise skip Crush's own prompt.
export const HOOK_MATCHER = '^(bash|sourcegraph|edit|multiedit|write|fetch|agentic_fetch|download|lsp_rename|lsp_replace_symbol|mcp_.*)$'
const WORKSPACE_SCOPE = 1
const START_MS = 20_000
const READY_MS = 30_000
const CANCEL_GRACE_MS = 15_000
// Crush can send a turn's last message update just after run_complete.
const SETTLE_MS = 150
const MODELS_TTL_MS = 60 * 60_000
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000

const KINDS: Record<string, string> = {
  bash: 'execute',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  lsp_replace_symbol: 'edit',
  view: 'read',
  ls: 'read',
  grep: 'search',
  glob: 'search',
  fetch: 'fetch',
  agentic_fetch: 'fetch',
  download: 'fetch',
}

export type CrushLaunch = { bin: string; args: string[]; env: Record<string, string> }

export type CrushOptions = {
  log: (msg: string) => void
  record?: ((line: string) => void) | null
  runDir: string
  dataRoot: string
  socket: string
  hook?: { node: string; script: string }
}

type Backend = {
  proc: ChildProcess
  sock: string
  client: string
  ws: string
  dataDir: string
  stream: http.ClientRequest | null
  gone: string | null
  onEvent: (ev: Json) => void
  onGone: (why: string) => void
}

type Opening = { backend: Backend | null; aborted: boolean }

type Msg = { reasoning: string; text: string; spentReasoning: number; spentText: number }

type Tool = { name: string; input: Json; started: boolean; done: boolean; oldContent?: string | null }

type Turn = {
  id: string
  runId: string
  cancelled: boolean
  wrongModel: string | null
  denied: { reason: string } | null
  error: string | null
  finish: string | null
  ending: boolean
  finalText: string
  msgs: Map<string, Msg>
  tools: Map<string, Tool>
  items: number
  usageMessage?: string
  usage?: { requestId: string; inputTokens: number; outputTokens: number }
}

type State = {
  session: Session
  backend: Backend
  token: string
  sid: string
  sessions: Set<string>
  cwd: string
  provider: string
  model: string
  canAsk: boolean
  intro: string | null
  todos: string
  closed: Set<string>
  dead: boolean
  turn: Turn | null
  grants: Set<string>
}

type Pending =
  | { kind: 'permission'; session: Session; request: Json; grantKey: string }
  | { kind: 'hook'; session: Session; resolve: (reply: Json) => void; grantKey: string }
  | { kind: 'question'; session: Session; request: Json }

const allow = () => ({ decision: 'allow' })
const deny = (reason: string) => ({ decision: 'deny', reason })
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const parse = (text: unknown): Json => {
  if (typeof text !== 'string' || !text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

function request(sock: string, method: string, url: string, body?: Json, timeoutMs = 30_000): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ socketPath: sock, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Json = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url} timed out`)))
    req.on('error', reject)
    req.end(data)
  })
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals) {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return false
  try { process.kill(-proc.pid, signal) } catch { try { proc.kill(signal) } catch { return false } }
  return true
}

// Allow only commands that cannot change anything; Crush runs some others unasked.
const READ_ONLY = new Set(['pwd', 'ls', 'date', 'cal', 'df', 'du', 'free', 'groups', 'id', 'uname', 'uptime', 'whatis', 'whereis', 'which', 'whoami', 'type', 'echo'])
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog'])

export function readOnlyCommand(command: string): boolean {
  if (!command.trim() || /[><&|;`$\\\n\r'"]/.test(command)) return false
  const words = command.trim().split(/\s+/)
  // Git can also read any file (--no-index, or a plain diff outside a repo), so paths stay inside the folder.
  if (words[0] === 'git') return GIT_READ_ONLY.has(words[1]) && !words.slice(2).some((w) => /^(-c|-O|--output|--ext-diff|--textconv|--open-files-in-pager|--exec|--no-index|--contents)/.test(w) || /^[~/]|(^|[/=:])\.\.(\/|$)/.test(w))
  if (words[0] === 'date') return !words.some((w) => /^(-s|--set)/.test(w))
  return READ_ONLY.has(words[0])
}

const shellQuote = (s: string) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

// Pick the Claude Code shape for a Crush tool call where one exists.
function toolCallOf(name: string, input: Json, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...blankTool(), kind: KINDS[name] ?? 'other', name, title: '', rawInput: { ...objectOf(input) }, ...extra }
}

function claudeShape(name: string, input: Json): { name: string; input: Json } {
  // Crush's ls lists a directory, so it shows as that command rather than as a raw tool call.
  if (name === 'ls') {
    const where = typeof objectOf(input).path === 'string' ? ` ${shellQuote(objectOf(input).path)}` : ''
    return { name: 'Bash', input: { command: `ls${where}`, description: 'List files' } }
  }
  const t = toolCallOf(name, input)
  return claudeTool(t.kind, name, t.rawInput) ?? { name, input: objectOf(input) }
}

function endReason(error: string): EndReason {
  if (/quota|insufficient|billing|credit|payment/i.test(error)) return 'quota_exhausted'
  if (/rate.?limit|\b429\b|too many requests/i.test(error)) return 'rate_limited'
  if (/unauthori[sz]ed|\b401\b|\b403\b|api key|authenticat|forbidden/i.test(error)) return 'auth'
  return 'error'
}

export function modelsOf(cfg: Json): HarnessModel[] {
  const large = cfg?.models?.large
  const out: HarnessModel[] = []
  for (const [pid, pc] of Object.entries<Json>(cfg?.providers ?? {})) {
    if (!pc || pc.disable) continue
    // Crush serves only the subscription's models to accounts signed in with ChatGPT or Grok.
    const list: Json[] = (pid === 'openai' && pc.oauth ? pc.chatgpt_models : pid === 'xai' && pc.oauth ? pc.grok_models : pc.models) ?? []
    for (const m of list) {
      if (!m?.id) continue
      const levels: string[] = Array.isArray(m.reasoning_levels) ? m.reasoning_levels.map(String) : []
      out.push({
        harness: 'crush',
        provider: vendorOf(`${pid}/${m.id}`),
        model: `${pid}/${m.id}`,
        displayName: String(m.name || m.id),
        description: `Through ${pc.name || pid}.`,
        efforts: levels,
        defaultEffort: levels.length && m.default_reasoning_effort ? String(m.default_reasoning_effort) : null,
        isDefault: large?.provider === pid && large?.model === m.id,
      })
    }
  }
  return out
}

function splitModel(full: string): [string, string] {
  const i = full.indexOf('/')
  if (i <= 0 || i === full.length - 1) throw new Error(`Crush models are named provider/model, not ${full}`)
  return [full.slice(0, i), full.slice(i + 1)]
}

export class CrushProvider implements Provider {
  readonly id = 'crush'
  readonly displayName = 'Crush'
  readonly capabilities: ProviderCapabilities = { steer: false, autoReview: false, questions: true, gates: 'all' }
  readonly location: string
  private launch: CrushLaunch
  private log: (msg: string) => void
  private record: ((line: string) => void) | null
  private sockDir: string
  private dataRoot: string
  private socket: string
  private hookCommand: string
  private cacheFile: string
  private models: { at: number; list: HarnessModel[] } | null = null
  private listing: Promise<HarnessModel[]> | null = null
  private backends = new Set<Backend>()
  private states = new Map<string, State>()
  private byToken = new Map<string, State>()
  private pending = new Map<string, Pending>()
  private opening = new Map<Session, Opening>()

  constructor(launch: CrushLaunch, opts: CrushOptions) {
    this.location = launch.bin
    this.launch = launch
    this.log = opts.log
    this.record = opts.record ?? null
    this.sockDir = path.join(opts.runDir, 'crush')
    this.dataRoot = opts.dataRoot
    this.socket = opts.socket
    const hook = opts.hook ?? { node: process.execPath, script: HOOK_SCRIPT }
    this.hookCommand = `${quote(hook.node)} ${quote(hook.script)}`
    this.cacheFile = path.join(opts.runDir, 'crush-models.json')
  }


  private async api(b: Backend, method: string, url: string, body?: Json): Promise<Json> {
    const r = await request(b.sock, method, url, body)
    if (r.status < 200 || r.status >= 300) throw new Error(`Crush refused ${method} ${url.replace(/\?.*/, '')}: ${r.body?.message ?? r.status}`)
    return r.body
  }

  private ws(b: Backend, method: string, sub: string, body?: Json): Promise<Json> {
    return this.api(b, method, `/v1/workspaces/${b.ws}${sub}`, body)
  }

  // Keep the task hook in the task's own Crush folder; the user's hooks still run too.
  private writeTaskConfig(dataDir: string) {
    const file = path.join(dataDir, 'crush.json')
    let cfg: Json = {}
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {}
    cfg.hooks = { PreToolUse: [{ name: 'bitfrost', matcher: HOOK_MATCHER, command: this.hookCommand, timeout: HOOK_TIMEOUT_S }] }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  }

  private async startBackend(dataDir: string, cwd: string, token: string, slot?: Opening): Promise<Backend> {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.sockDir, { recursive: true, mode: 0o700 })
    this.writeTaskConfig(dataDir)
    const sock = path.join(this.sockDir, `${randomBytes(6).toString('hex')}.sock`)
    // Crush shuts its server down once the task's event stream is gone, so a lost helper leaves nothing behind.
    const proc = spawn(this.launch.bin, [...this.launch.args, 'server', '-H', `unix://${sock}`, '-D', path.join(dataDir, 'server')], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.launch.env,
        BITFROST_SOCKET: this.socket,
        BITFROST_CRUSH_TOKEN: token,
        CRUSH_CACHE_DIR: path.join(dataDir, 'cache'),
        CRUSH_SERVER_IDLE_TIMEOUT: '0',
      },
    })
    const b: Backend = { proc, sock, client: randomUUID(), ws: '', dataDir, stream: null, gone: null, onEvent: () => {}, onGone: () => {} }
    this.backends.add(b)
    if (slot) slot.backend = b
    proc.on('error', (e) => this.lost(b, `could not start (${e.message})`))
    proc.on('exit', (code, signal) => this.lost(b, `exited (code ${code}, signal ${signal})`))
    proc.stdout!.resume()
    proc.stderr!.on('data', (d) => this.log(`crush stderr: ${String(d).trimEnd().slice(0, 1000)}`))
    try {
      const deadline = Date.now() + START_MS
      for (;;) {
        if (b.gone) throw new Error(`Crush ${b.gone}`)
        const ok = await request(sock, 'GET', '/v1/health', undefined, 2000).then((r) => r.status === 200, () => false)
        if (ok) break
        if (Date.now() > deadline) throw new Error('Crush did not start its server in time')
        await sleep(50)
      }
      const w = await this.api(b, 'POST', '/v1/workspaces', { path: cwd, data_dir: dataDir, client_id: b.client })
      if (!w?.id) throw new Error('Crush did not open a workspace')
      b.ws = String(w.id)
      await this.openStream(b)
      if (slot?.aborted) throw new Error('The task was stopped while Crush started')
    } catch (e) {
      this.stopBackend(b)
      throw e
    }
    return b
  }

  private openStream(b: Backend): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: b.sock, method: 'GET', path: `/v1/workspaces/${b.ws}/events?client_id=${b.client}` })
      b.stream = req
      // A dying server ends the stream first; give its exit a moment to explain why.
      const ended = (why: string) => setTimeout(() => this.lost(b, why), 250).unref()
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`Crush refused the event stream (${res.statusCode})`))
        }
        resolve()
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (chunk: string) => {
          buf += chunk
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            for (const line of block.split('\n')) if (line.startsWith('data:')) this.onLine(b, line.slice(5).trim())
          }
        })
        res.on('end', () => ended('closed its event stream'))
        res.on('error', () => ended('lost its event stream'))
      })
      req.on('error', (e) => {
        reject(e)
        ended(`lost its event stream (${e.message})`)
      })
      req.end()
    })
  }

  private onLine(b: Backend, line: string) {
    if (b.gone) return
    this.record?.(line)
    let ev: Json
    try {
      ev = JSON.parse(line)
    } catch {
      return this.log(`crush: not JSON: ${line.slice(0, 200)}`)
    }
    try { b.onEvent(ev) } catch (e) { this.log(`crush: could not handle ${ev?.type}: ${(e as Error).stack}`) }
  }

  private lost(b: Backend, why: string) {
    if (b.gone) return
    b.gone = why
    this.backends.delete(b)
    b.stream?.destroy()
    killGroup(b.proc, 'SIGKILL')
    this.log(`crush: server ${why}`)
    b.onGone(why)
  }

  // Ask the server to stop, then make sure its whole process group goes.
  private stopBackend(b: Backend) {
    if (!b.gone) b.gone = 'stopped'
    this.backends.delete(b)
    b.stream?.destroy()
    if (killGroup(b.proc, 'SIGTERM')) setTimeout(() => killGroup(b.proc, 'SIGKILL'), 3000).unref()
  }


  async listModels(force = false): Promise<HarnessModel[]> {
    if (!this.models) {
      try { this.models = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) } catch {}
    }
    if (!force && this.models && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list
    this.listing ??= this.discover().finally(() => (this.listing = null))
    return this.listing
  }

  private async discover(): Promise<HarnessModel[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-crush-'))
    const cwd = path.join(dir, 'work')
    fs.mkdirSync(cwd)
    let b: Backend | null = null
    try {
      b = await this.startBackend(path.join(dir, 'data'), cwd, randomUUID())
      // The config carries API keys; read the model lists and keep nothing else.
      const list = modelsOf(await this.ws(b, 'GET', '/config'))
      this.models = { at: Date.now(), list }
      try {
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 })
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.models), { mode: 0o600 })
      } catch (e) {
        this.log(`crush: could not cache the model list: ${(e as Error).message}`)
      }
      return list
    } finally {
      if (b) this.stopBackend(b)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // Use the chosen model for both of Crush's slots so titles and summaries stay on it too.
  private async pinModel(b: Backend, full: string, effort: string | null | undefined): Promise<void> {
    const [provider, model] = splitModel(full)
    const cfg = await this.ws(b, 'GET', '/config')
    const known = modelsOf(cfg).find((m) => m.model === full)
    if (!known) throw new Error(`Crush has no model ${full}. Check that its provider is set up in Crush (crush models).`)
    if (effort && !known.efforts.includes(effort)) this.log(`crush: ${full} has no reasoning effort ${effort}; using its default`)
    const selected = { provider, model, ...(effort && known.efforts.includes(effort) ? { reasoning_effort: effort } : {}) }
    for (const slot of ['large', 'small']) await this.ws(b, 'POST', '/config/model', { scope: WORKSPACE_SCOPE, model_type: slot, model: selected })
    await this.ws(b, 'POST', '/agent/update')
    const deadline = Date.now() + READY_MS
    for (;;) {
      const info = await this.ws(b, 'GET', '/agent').catch(() => null)
      if (info?.is_ready) {
        const now = `${info.model_cfg?.provider}/${info.model?.id ?? info.model_cfg?.model}`
        if (now !== full) throw new Error(`Crush chose ${now} instead of ${full}`)
        break
      }
      if (b.gone) throw new Error(`Crush ${b.gone}`)
      if (Date.now() > deadline) throw new Error('Crush did not get its agent ready in time')
      await sleep(100)
    }
  }


  async spawnSession(session: Session, req: SpawnRequest): Promise<string> {
    const slot: Opening = { backend: null, aborted: false }
    this.opening.set(session, slot)
    try { return await this.spawn(session, req, slot) } finally { this.opening.delete(session) }
  }

  private async spawn(session: Session, req: SpawnRequest, slot: Opening): Promise<string> {
    splitModel(req.model)
    const id = `crush_${randomUUID()}`
    const dataDir = path.join(this.dataRoot, id)
    const token = randomUUID()
    const b = await this.startBackend(dataDir, req.cwd, token, slot).catch((e) => {
      fs.rmSync(dataDir, { recursive: true, force: true })
      throw e
    })
    let sid: string
    try {
      await this.pinModel(b, req.model, req.effort)
      const s = await this.ws(b, 'POST', '/sessions', { title: req.title || 'BitFrost task' })
      sid = String(s?.id ?? '')
      if (!sid) throw new Error('Crush did not create a session')
      if (slot.aborted) throw new Error('The task was stopped while Crush started')
    } catch (e) {
      this.stopBackend(b)
      fs.rmSync(dataDir, { recursive: true, force: true })
      throw e
    }
    session.info.id = id
    const st = this.track(session, b, token, sid, req.cwd, req.model, !!req.canAskUser, req.developerInstructions ?? null)
    session.info.effort = req.effort ?? null
    session.setNativeRef({ dataDir, crushSessionId: sid, canAsk: st.canAsk })
    session.acceptInput(req.prompt, 'started')
    this.runTurn(st, req.prompt)
    return id
  }

  private track(session: Session, b: Backend, token: string, sid: string, cwd: string, full: string, canAsk: boolean, intro: string | null): State {
    const [provider, model] = splitModel(full)
    const st: State = {
      session, backend: b, token, sid, sessions: new Set([sid]), cwd, provider, model, canAsk, intro,
      todos: '[]', closed: new Set(), dead: false, turn: null, grants: new Set(),
    }
    this.states.set(session.info.id, st)
    this.byToken.set(token, st)
    b.onEvent = (ev) => this.onEvent(st, ev)
    b.onGone = (why) => this.onGone(st, why)
    return st
  }

  async sendInput(session: Session, text: string): Promise<'started' | 'queued'> {
    const st = this.stateOf(session)
    if (!st || st.dead) throw new Error("Crush can't reopen this session: its server has stopped since this task began")
    if (st.turn) { session.queueInput(this, text); return 'queued' }
    this.runTurn(st, text)
    return 'started'
  }

  async attach(session: Session, ref: Json) {
    const slot: Opening = { backend: null, aborted: false }
    this.opening.set(session, slot)
    try { await this.reopen(session, ref, slot) } finally { this.opening.delete(session) }
  }

  // Start a fresh server on the task's own folder, which keeps Crush's history.
  private async reopen(session: Session, ref: Json, slot: Opening) {
    if (!ref?.dataDir || !ref?.crushSessionId || !fs.existsSync(ref.dataDir)) throw new Error("Crush can't reopen this session: its saved history is gone")
    const token = randomUUID()
    const b = await this.startBackend(ref.dataDir, session.info.cwd, token, slot)
    let saved: Json
    try {
      await this.pinModel(b, session.info.model, session.info.effort)
      saved = await this.ws(b, 'GET', `/sessions/${ref.crushSessionId}`)
      if (slot.aborted) throw new Error('the task was stopped while Crush started')
    } catch (e) {
      this.stopBackend(b)
      throw new Error(`Crush can't reopen this session: ${(e as Error).message}`)
    }
    const st = this.track(session, b, token, String(ref.crushSessionId), session.info.cwd, session.info.model, !!ref.canAsk, null)
    st.todos = JSON.stringify(saved?.todos ?? [])
  }

  // A task stopped while its server starts never runs.
  private abortOpening(session: Session): boolean {
    const slot = this.opening.get(session)
    if (!slot) return false
    slot.aborted = true
    if (slot.backend) this.stopBackend(slot.backend)
    return true
  }

  kill(session: Session) {
    const st = this.stateOf(session)
    return st ? killGroup(st.backend.proc, 'SIGKILL') : this.abortOpening(session)
  }

  isBusy(session: Session) { return this.opening.has(session) || !!this.stateOf(session)?.turn }

  async interrupt(session: Session): Promise<void> {
    const st = this.stateOf(session)
    if (st) this.cancelTurn(st)
    else this.abortOpening(session)
  }

  dispose() {
    for (const st of this.states.values()) st.session.dropInputs()
    for (const session of this.opening.keys()) this.abortOpening(session)
    for (const b of [...this.backends]) {
      const gone = b.onGone
      this.stopBackend(b)
      gone('stopped with the BitFrost helper')
    }
  }

  disposeSession(session: Session) {
    session.dropInputs()
    this.abortOpening(session)
    const st = this.stateOf(session)
    if (!st) return
    this.cancelTurn(st)
    this.dropPending(session)
    st.turn = null
    this.forget(st)
    this.stopBackend(st.backend)
  }

  private forget(st: State) {
    st.dead = true
    if (this.states.get(st.session.info.id) === st) this.states.delete(st.session.info.id)
    this.byToken.delete(st.token)
  }

  private stateOf(session: Session): State | undefined {
    return this.states.get(session.info.id)
  }

  private onGone(st: State, why: string) {
    if (st.dead) return
    this.forget(st)
    this.dropPending(st.session, false)
    const turn = st.turn
    if (turn) this.flushUsage(st, turn)
    st.turn = null
    st.session.detach()
    if (turn?.cancelled) {
      this.flushAll(st, turn)
      st.session.push({ type: 'turn_completed', turnId: turn.id, status: turn.wrongModel ? 'failed' : 'interrupted', reason: turn.wrongModel ? 'wrong_model' : 'interrupted', finalText: turn.finalText })
    } else if (turn) st.session.push({ type: 'session_failed', error: `Crush ${why}` })
  }


  private runTurn(st: State, text: string) {
    const turn: Turn = { id: `crush_${randomUUID()}`, runId: randomUUID(), cancelled: false, wrongModel: null, denied: null, error: null, finish: null, ending: false, finalText: '', msgs: new Map(), tools: new Map(), items: 0 }
    st.turn = turn
    st.session.push({ type: 'turn_started', turnId: turn.id })
    // Crush has no per-session system prompt, so the instructions lead the first message.
    const prompt = st.intro ? `${st.intro}\n\n${text}` : text
    st.intro = null
    this.ws(st.backend, 'POST', '/agent', { session_id: st.sid, run_id: turn.runId, prompt }).catch((e) => this.endTurn(st, turn, {}, e.message))
  }

  private cancelTurn(st: State) {
    const turn = st.turn
    if (!turn || turn.cancelled || turn.ending) return
    turn.cancelled = true
    this.dropPending(st.session)
    this.ws(st.backend, 'POST', `/agent/sessions/${st.sid}/cancel`).catch((e) => this.log(`crush: cancel failed: ${e.message}`))
    // Never leave a run going that BitFrost thinks has stopped.
    const timer = setTimeout(() => {
      if (st.turn === turn) this.lost(st.backend, 'did not stop in time')
    }, CANCEL_GRACE_MS)
    timer.unref()
  }

  private dropPending(session: Session, answer = true) {
    for (const [id, p] of this.pending) {
      if (p.session !== session) continue
      this.pending.delete(id)
      if (p.kind === 'hook') p.resolve(deny('The task was stopped.'))
      else if (p.kind === 'question' && answer) {
        const st = this.stateOf(session)
        if (st) this.ws(st.backend, 'POST', '/questions/cancel').catch(() => {})
      }
      if (p.kind !== 'question') session.push({ type: 'approval_resolved', approvalId: id, decision: 'deny' })
    }
  }

  private endTurn(st: State, turn: Turn, rc: Json, error: string | null) {
    if (st.turn !== turn) return
    this.dropPending(st.session)
    this.flushAll(st, turn)
    const text = typeof rc.text === 'string' ? rc.text.trim() : ''
    if (text && text !== turn.finalText) {
      turn.finalText = text
      st.session.push({ type: 'text', itemId: `${rc.message_id || turn.id}:${++turn.items}`, text })
    }
    for (const id of turn.msgs.keys()) st.closed.add(id)
    for (const id of turn.tools.keys()) st.closed.add(id)
    if (rc.message_id) st.closed.add(String(rc.message_id))
    const cancelled = turn.cancelled || !!rc.cancelled
    const failure = error ?? (rc.error ? String(rc.error) : null) ?? turn.error
    const finish = turn.finish
    let status: 'completed' | 'interrupted' | 'failed'
    let reason: EndReason
    let why: string | null = null
    if (turn.wrongModel) {
      [status, reason, why] = ['failed', 'wrong_model', `Crush switched to ${turn.wrongModel} instead of ${st.provider}/${st.model}; stopped it`]
    } else if (cancelled) {
      [status, reason] = ['interrupted', 'interrupted']
    } else if (failure) {
      [status, reason, why] = ['failed', endReason(failure), failure]
    } else if (turn.denied) {
      // Crush ends its turn when a permission is denied.
      [status, reason, why] = ['failed', 'permission_denied', turn.denied.reason]
    } else if (finish === 'max_tokens') {
      [status, reason, why] = ['failed', 'max_tokens', 'it reached its output limit']
    } else if (finish === 'content_filter') {
      [status, reason, why] = ['failed', 'refusal', 'the model refused to continue']
    } else {
      [status, reason] = ['completed', 'end_turn']
    }
    st.turn = null
    st.session.push({ type: 'turn_completed', turnId: turn.id, status, reason, finalText: turn.finalText, ...(why ? { error: why } : {}) })
  }


  private onEvent(st: State, ev: Json) {
    if (st.dead) return
    const p = ev?.payload?.payload ?? {}
    switch (ev?.type) {
      case 'message':
        return this.onMessage(st, ev.payload?.type, p)
      case 'session':
        return this.onSession(st, p)
      case 'permission_request':
        return this.onPermission(st, p)
      case 'permission_notification':
        return this.onPermissionSettled(st, p)
      case 'question_batch_request':
        return this.onQuestion(st, p)
      case 'question_batch_notification':
        return this.onQuestionSettled(st, p)
      case 'agent_event':
        if (p.type === 'error' && st.turn && (p.run_id ? p.run_id === st.turn.runId : p.session_id === st.sid)) st.turn.error = String(p.error || 'Crush reported an error')
        return
      case 'run_complete':
        if (st.turn && !st.turn.ending && (p.run_id ? p.run_id === st.turn.runId : p.session_id === st.sid)) {
          const turn = st.turn
          turn.ending = true
          setTimeout(() => this.endTurn(st, turn, p, null), SETTLE_MS)
        }
        return
    }
  }

  private onSession(st: State, s: Json) {
    if (s.parent_session_id && st.sessions.has(s.parent_session_id)) st.sessions.add(String(s.id))
    // Child sessions run their own, smaller contexts, so only the main one tracks context growth.
    if (s.id !== st.sid) return
    // Crush reports the last model request's prompt and output sizes; it has no cached split.
    const input = Number(s.prompt_tokens) || 0
    const output = Number(s.completion_tokens) || 0
    const turn = st.turn
    // Session updates can carry the previous request's counts before the new ones arrive.
    // Keep the latest snapshot for this assistant message, then bill it at its boundary.
    if (turn?.usageMessage && (input || output)) {
      // Some Crush versions append several model responses to one assistant message.
      const requestId = `${turn.usageMessage}:${s.message_count ?? ''}`
      if (turn.usage && turn.usage.requestId !== requestId) this.flushUsage(st, turn)
      turn.usage = { requestId, inputTokens: input, outputTokens: output }
    }
    if (!st.turn) return
    const todos = JSON.stringify(s.todos ?? [])
    if (todos === st.todos) return
    st.todos = todos
    st.session.push({ type: 'plan', entries: (s.todos ?? []).map((t: Json) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') })) })
  }

  private onMessage(st: State, change: string, m: Json) {
    if (!st.sessions.has(m.session_id) || st.closed.has(m.id)) return
    const turn = st.turn
    if (m.role === 'assistant') this.checkModel(st, m)
    if (!turn || m.session_id !== st.sid) return
    if (m.role === 'assistant') {
      if (!turn.msgs.has(m.id)) {
        this.flushUsage(st, turn)
        turn.usageMessage = String(m.id)
      }
      if (change === 'created') turn.denied = null
      return this.onAssistant(st, turn, m)
    }
    if (m.role === 'tool') for (const part of m.parts ?? []) if (part?.type === 'tool_result') this.finishTool(st, turn, part.data ?? {})
  }

  // Stop the turn if Crush answers with any model but the chosen one.
  private checkModel(st: State, m: Json) {
    if (!m.model || (m.provider === st.provider && m.model === st.model)) return
    const turn = st.turn
    if (!turn || turn.wrongModel) return
    turn.wrongModel = `${m.provider}/${m.model}`
    this.cancelTurn(st)
  }

  private onAssistant(st: State, turn: Turn, m: Json) {
    let msg = turn.msgs.get(m.id)
    if (!msg) turn.msgs.set(m.id, (msg = { reasoning: '', text: '', spentReasoning: 0, spentText: 0 }))
    for (const part of m.parts ?? []) {
      const d = part?.data ?? {}
      switch (part?.type) {
        case 'reasoning':
          msg.reasoning = String(d.thinking ?? '')
          st.session.live = { activity: 'thinking', partialText: turn.finalText || null, updatedAt: Date.now() }
          break
        case 'text':
          msg.text = String(d.text ?? '')
          st.session.live = { activity: 'responding', partialText: msg.text, updatedAt: Date.now() }
          break
        case 'tool_call':
          if (!d.finished) break
          this.flush(st, turn, m.id, msg)
          this.startTool(st, turn, d)
          break
        case 'finish':
          this.flush(st, turn, m.id, msg)
          turn.finish = String(d.reason ?? '')
          if (d.reason === 'error' && !turn.error) turn.error = String(d.message || d.details || 'Crush stopped with an error')
          break
      }
    }
  }

  private flush(st: State, turn: Turn, id: string, msg: Msg) {
    const reasoning = msg.reasoning.slice(msg.spentReasoning).trim()
    msg.spentReasoning = msg.reasoning.length
    if (reasoning) st.session.push({ type: 'reasoning', itemId: `${id}:${++turn.items}`, text: reasoning })
    const text = msg.text.slice(msg.spentText).trim()
    msg.spentText = msg.text.length
    if (!text) return
    turn.finalText = msg.text.trim()
    st.session.push({ type: 'text', itemId: `${id}:${++turn.items}`, text })
  }

  private flushAll(st: State, turn: Turn) {
    this.flushUsage(st, turn)
    for (const [id, msg] of turn.msgs) this.flush(st, turn, id, msg)
  }

  private flushUsage(st: State, turn: Turn) {
    if (!turn.usage) return
    st.session.push({ type: 'usage', ...turn.usage, cachedInputTokens: 0 })
    turn.usage = undefined
  }

  private toolOf(turn: Turn, id: string, name: string): Tool {
    let t = turn.tools.get(id)
    if (!t) turn.tools.set(id, (t = { name, input: {}, started: false, done: false }))
    return t
  }

  // Announce file edits only when they finish, with their diff, as the other adapters do.
  private startTool(st: State, turn: Turn, d: Json, edits = false) {
    const id = String(d.id ?? '')
    if (!id) return
    const t = this.toolOf(turn, id, String(d.name ?? 'tool'))
    if (t.started) return
    if (d.input !== undefined) t.input = parse(d.input)
    if (KINDS[t.name] === 'edit' && !edits) return
    t.started = true
    if (t.name === 'bash') {
      const command = String(t.input.command ?? '')
      st.session.push({ type: 'command_started', itemId: id, command, summary: this.summary(t.input, command), cwd: t.input.working_dir || st.cwd })
      return
    }
    const c = claudeShape(t.name, t.input)
    st.session.push({ type: 'tool_started', itemId: id, name: c.name, input: c.input })
  }

  private summary(input: Json, command: string) {
    if (typeof input.description === 'string' && input.description) return input.description
    const first = command.split('\n')[0]
    return first.length > 70 ? first.slice(0, 67) + '…' : first
  }

  private finishTool(st: State, turn: Turn, r: Json) {
    const id = String(r.tool_call_id ?? '')
    if (!id || st.closed.has(id)) return
    const t = this.toolOf(turn, id, String(r.name ?? 'tool'))
    if (t.done) return
    if (!t.started && KINDS[t.name] !== 'edit') this.startTool(st, turn, { id, name: t.name })
    t.done = true
    const ok = !r.is_error
    const meta = parse(r.metadata)
    const output = String(r.content ?? '')
    if (t.name === 'bash') {
      const command = String(t.input.command ?? '')
      const code = output.match(/Exit code (\d+)\s*$/)
      const ms = Number(meta.end_time) - Number(meta.start_time)
      st.session.push({
        type: 'command_completed',
        itemId: id,
        command,
        summary: this.summary(t.input, command),
        cwd: meta.working_directory || t.input.working_dir || st.cwd,
        output: typeof meta.output === 'string' ? meta.output : output,
        exitCode: code ? Number(code[1]) : ok ? 0 : null,
        durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
        status: ok ? 'completed' : 'failed',
      })
      return
    }
    const file = typeof t.input.file_path === 'string' ? t.input.file_path : null
    if (ok && file && KINDS[t.name] === 'edit') {
      // Crush returns whole files for edits; a write's old text is known only from its permission request.
      const before = typeof meta.old_content === 'string' ? meta.old_content : t.oldContent
      const diff =
        typeof meta.new_content === 'string' ? unifiedDiff(before || null, meta.new_content)
        : t.name === 'write' && before !== undefined ? unifiedDiff(before || null, String(t.input.content ?? ''))
        : typeof meta.diff === 'string' ? meta.diff
        : null
      if (diff !== null) {
        st.session.push({ type: 'file_change', itemId: id, changes: [{ path: file, kind: before === undefined || before ? 'update' : 'add', movePath: null, diff }], status: 'completed' })
        return
      }
    }
    if (!t.started) this.startTool(st, turn, { id, name: t.name }, true)
    const c = claudeShape(t.name, t.input)
    st.session.push({ type: 'tool_completed', itemId: id, name: c.name, input: c.input, ok, output })
  }


  private grant(st: State, request: Json, action: 'allow' | 'deny') {
    this.ws(st.backend, 'POST', '/permissions/grant', { permission: request, action }).catch((e) => this.log(`crush: could not answer a permission request: ${e.message}`))
  }

  // Describe a Crush permission request with the tool's own input where known.
  private actionOf(st: State, p: Json): ToolCall {
    const name = String(p.tool_name ?? '')
    const params = objectOf(p.params)
    const known = st.turn?.tools.get(String(p.tool_call_id))
    const input = { ...params, ...objectOf(known?.input) }
    if (name === 'view' || name === 'ls') input.file_path ??= params.path ?? p.path
    const extra: Partial<ToolCall> = { title: KINDS[name] ? '' : name }
    if (KINDS[name] === 'edit' && typeof params.file_path === 'string') {
      if (known) known.oldContent = typeof params.old_content === 'string' ? params.old_content : null
      extra.content = [{ type: 'diff', path: params.file_path, oldText: params.old_content || null, newText: params.new_content ?? '' }]
    }
    return toolCallOf(name, input, extra)
  }

  private onPermission(st: State, p: Json) {
    if (!st.sessions.has(p.session_id)) {
      this.log(`crush: permission request for an unknown session ${p.session_id}; denying`)
      return this.grant(st, p, 'deny')
    }
    if (!st.turn || st.turn.cancelled) return this.grant(st, p, 'deny')
    if (!st.canAsk) {
      st.turn.denied = { reason: `Crush asked for permission (${String(p.description || p.tool_name)}), and this task runs without asking.` }
      return this.grant(st, p, 'deny')
    }
    const t = this.actionOf(st, p)
    const grantKey = grantKeyOf(t)
    if (st.grants.has(grantKey)) return this.grant(st, p, 'allow')
    const approvalId = randomUUID()
    this.pending.set(approvalId, { kind: 'permission', session: st.session, request: p, grantKey })
    st.session.push({ type: 'approval_requested', approvalId, itemId: p.tool_call_id || null, ...describeAction(t, st.cwd) })
  }

  private onPermissionSettled(st: State, n: Json) {
    if (!n.granted && !n.denied) return
    for (const [id, p] of this.pending) {
      if (p.kind !== 'permission' || p.session !== st.session || p.request.tool_call_id !== n.tool_call_id) continue
      this.pending.delete(id)
      st.session.push({ type: 'approval_resolved', approvalId: id, decision: n.granted ? 'allow' : 'deny' })
    }
  }


  // Show edits and writes as diffs; a write's old text is the file on disk.
  private diffOf(st: State, tool: string, input: Json): Json[] {
    const file = typeof input.file_path === 'string' ? path.resolve(st.cwd, input.file_path) : null
    if (!file) return []
    const old = (): string | null => {
      try { return fs.statSync(file).size <= 1 << 20 ? fs.readFileSync(file, 'utf8') : '' } catch { return null }
    }
    if (tool === 'edit' && typeof input.old_string === 'string') return [{ type: 'diff', path: input.file_path, oldText: input.old_string === '' && !fs.existsSync(file) ? null : input.old_string, newText: String(input.new_string ?? '') }]
    if (tool === 'write' && typeof input.content === 'string') return [{ type: 'diff', path: input.file_path, oldText: old(), newText: input.content }]
    return []
  }

  // Answer the hook: commands that cannot change anything pass, everything else is asked.
  async bridge(token: string, payload: Json): Promise<Json | null> {
    const st = this.byToken.get(token)
    if (!st || st.dead) return deny('Unknown BitFrost task.')
    const turn = st.turn
    if (!turn || turn.cancelled) return deny('The task was stopped.')
    const tool = String(payload?.tool_name ?? '')
    const input = objectOf(payload?.tool_input)
    if (tool === 'bash' && readOnlyCommand(String(input.command ?? ''))) return null
    if (!st.canAsk) return deny('This BitFrost task runs without asking, so actions that need approval are refused.')
    const t = toolCallOf(tool, input, { title: KINDS[tool] ? '' : tool, content: this.diffOf(st, tool, input) })
    const grantKey = grantKeyOf(t)
    if (st.grants.has(grantKey)) return allow()
    const itemId = [...turn.tools].find(([, x]) => !x.done && x.name === tool && JSON.stringify(x.input) === JSON.stringify(input))?.[0] ?? null
    const action = tool === 'sourcegraph'
      ? { kind: 'permissions' as const, title: `search Sourcegraph for "${String(input.query ?? '')}"`, detail: `Sends the query to sourcegraph.com.\nIn ${st.cwd}`, tool: 'WebSearch', input: { query: String(input.query ?? '') } }
      : describeAction(t, st.cwd)
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      this.pending.set(approvalId, { kind: 'hook', session: st.session, resolve, grantKey })
      st.session.push({ type: 'approval_requested', approvalId, itemId, ...action })
    })
  }

  pendingApprovals(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind !== 'question' && p.session === session).map(([id]) => id)
  }

  // Keep task grants here: Crush's own "allow for session" covers a whole folder.
  resolveApproval(session: Session, approvalId: string, decision: Decision, reason?: string): boolean {
    const p = this.pending.get(approvalId)
    const st = this.stateOf(session)
    if (!p || p.kind === 'question' || p.session !== session || !st) return false
    this.pending.delete(approvalId)
    if (decision === 'allow_session') st.grants.add(p.grantKey)
    const why = reason || 'The user denied permission.'
    if (p.kind === 'hook') p.resolve(decision === 'deny' ? deny(why) : allow())
    else {
      this.grant(st, p.request, decision === 'deny' ? 'deny' : 'allow')
      if (decision === 'deny' && st.turn) st.turn.denied = { reason: why }
      if (decision === 'deny' && reason) this.log(`crush: denied ${approvalId}; Crush has no place for the reason: ${reason}`)
    }
    session.push({ type: 'approval_resolved', approvalId, decision })
    return true
  }


  private onQuestion(st: State, q: Json) {
    if (!st.sessions.has(q.session_id) || !st.turn || st.turn.cancelled || !st.canAsk || !Array.isArray(q.questions) || !q.questions.length) {
      this.ws(st.backend, 'POST', '/questions/cancel').catch(() => {})
      return
    }
    const questions: Question[] = q.questions.map((x: Json, i: number) => ({
      id: String(x.id ?? i),
      header: String(x.label || `Question ${i + 1}`),
      question: [x.question, x.description].filter(Boolean).join('\n') || String(x.label ?? ''),
      options: x.type === 'yes_no' ? [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] : (x.choices ?? []).map((c: Json) => ({ label: String(c.label ?? c.id), description: String(c.description ?? '') })),
      allowOther: x.type === 'free_text',
      secret: false,
    }))
    const questionId = randomUUID()
    this.pending.set(questionId, { kind: 'question', session: st.session, request: q })
    st.session.push({ type: 'question_asked', questionId, questions })
  }

  private onQuestionSettled(st: State, n: Json) {
    for (const [id, p] of this.pending) {
      if (p.kind !== 'question' || p.session !== st.session || p.request.id !== n.batch_id) continue
      this.pending.delete(id)
      st.session.push({ type: 'question_answered', questionId: id, how: 'answered' })
    }
  }

  pendingQuestions(session: Session): string[] {
    return [...this.pending].filter(([, p]) => p.kind === 'question' && p.session === session).map(([id]) => id)
  }

  async answerQuestion(session: Session, questionId: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean> {
    const p = this.pending.get(questionId)
    const st = this.stateOf(session)
    if (!p || p.kind !== 'question' || p.session !== session || !st) return false
    this.pending.delete(questionId)
    if (defer || !answers) {
      await this.ws(st.backend, 'POST', '/questions/cancel').catch(() => {})
    } else {
      const responses = (p.request.questions as Json[]).map((x, i) => {
        const given = answers[String(x.id ?? i)] ?? []
        const r: Json = { request_id: String(x.id ?? i) }
        if (x.type === 'yes_no') r.yes = /^(y|yes|true)$/i.test(given[0] ?? '')
        else if (x.type === 'free_text') r.fill_in_text = given.join(', ')
        else {
          const choices: Json[] = x.choices ?? []
          const ids = given.map((g) => choices.find((c) => c.label === g || c.id === g)?.id).filter(Boolean)
          const other = given.filter((g) => !choices.some((c) => c.label === g || c.id === g))
          r.selected_ids = ids
          if (other.length) r.fill_in_text = other.join(', ')
        }
        return r
      })
      await this.ws(st.backend, 'POST', '/questions/answer', { batch_request_id: p.request.id, responses }).catch((e) => this.log(`crush: could not answer a question: ${e.message}`))
    }
    session.push({ type: 'question_answered', questionId, how: defer ? 'deferred' : 'answered' })
    if (defer) void session.stop(this, 'host', { preserveQueue: true }).catch(() => {})
    return true
  }
}


const HOME = os.homedir()

function dataRootFor(dataDir?: string): string {
  const base = dataDir || process.env.BITFROST_DATA_DIR || (process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'BitFrost') : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'bitfrost'))
  return path.join(base, 'crush')
}

// Use the real binary: the npm package's launcher would outlive a stopped server.
export function resolveCrush(env: ProviderEnv): string | null {
  const bin = env.config.bin ?? env.resolveBinary('crush')
  if (!bin) return null
  try {
    const real = fs.realpathSync(bin)
    if (/\.(c|m)?js$/.test(real)) {
      const inner = path.join(path.dirname(real), 'bin', 'crush')
      if (fs.existsSync(inner)) return inner
    }
  } catch {}
  return bin
}

// Drop task folders nobody has used for a month.
function prune(root: string, log: (msg: string) => void) {
  let names: string[]
  try { names = fs.readdirSync(root) } catch { return }
  for (const name of names) {
    if (!name.startsWith('crush_')) continue
    const dir = path.join(root, name)
    try {
      const db = path.join(dir, 'crush.db')
      const at = fs.existsSync(db) ? fs.statSync(db).mtimeMs : fs.statSync(dir).mtimeMs
      if (Date.now() - at > PRUNE_AFTER_MS) fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      log(`crush: could not prune ${dir}: ${(e as Error).message}`)
    }
  }
}

export const crushProvider: ProviderFactory = {
  id: 'crush',
  displayName: 'Crush',
  optIn: true,
  detect: (env) => resolveCrush(env),
  create(env) {
    const bin = resolveCrush(env)
    if (!bin) return null
    const dataRoot = dataRootFor(env.dataDir)
    prune(dataRoot, env.log)
    return new CrushProvider({ bin, args: [], env: {} }, { log: env.log, record: env.recorder('crush'), runDir: env.runDir, dataRoot, socket: env.socket })
  },
  uninstall(dryRun = false) {
    const root = dataRootFor()
    const found = fs.existsSync(root) ? [{ label: 'Crush task history', path: root }] : []
    if (!dryRun) fs.rmSync(root, { recursive: true, force: true })
    return found
  },
}
