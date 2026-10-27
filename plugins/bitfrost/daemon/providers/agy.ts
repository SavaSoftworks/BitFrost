// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Run one Antigravity CLI process per task, in print mode with stream-json in and out.
// Print mode refuses whatever needs permission, so Antigravity runs with permission
// prompts off and BitFrost's bridge plugin gates every tool call through a PreToolUse hook.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { AgentEventBody, Decision, EndReason, Question } from '../events.ts'
import type { HarnessModel, Provider, ProviderCapabilities, ProviderEnv, ProviderFactory, SpawnRequest } from '../provider.ts'
import type { Session } from '../session.ts'
import { killOwnedGroup, processIdentity, type ProcessIdentity } from '../process.ts'
import { blankTool, claudeTool, describeAction, grantKeyOf, inside, objectOf, unifiedDiff, vendorOf, type ToolCall } from './acp-shapes.ts'
import { killGroup, readOnlyCommand } from './crush.ts'

type Json = any

const PLUGIN_NAME = 'bitfrost-bridge'
// Listing also rechecks the sign-in, so a list is kept only briefly.
const MODELS_TTL_MS = 5 * 60_000
const IDLE_MS = 10 * 60_000
const STOP_GRACE_MS = 5_000
const AUTH_WAIT_MS = 15_000
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const READ_ONLY = new Set(['view_file', 'list_dir', 'grep_search', 'find_by_name', 'codebase_search', 'view_file_outline', 'view_code_item', 'view_content_chunk', 'command_status', 'list_permissions', 'list_resources', 'list_plugin_accounts', 'wait', 'wait_5_seconds', 'finish'])
const FILE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'])
// No nested subagents, agent messaging, workflows, or runs scheduled outside BitFrost.
const DISALLOWED = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents', 'browser_subagent', 'send_message', 'manage_inbox', 'run_workflow', 'schedule'])
const PERMISSION_TOOLS = new Set(['ask_permission', 'ask_custom_permission'])
const PATH_KEYS = ['TargetFile', 'AbsolutePath', 'FilePath', 'NotebookPath', 'File', 'Path', 'DirectoryPath', 'SearchPath', 'SearchDirectory']

export type AgyOptions = {
  bin: string
  args?: string[]
  log: (msg: string) => void
  record?: ((line: string) => void) | null
  runDir: string
  socket: string
  // Whether Antigravity will load the bridge plugin; without it permission prompts stay on.
  bridgeLoaded?: () => Promise<boolean>
  node?: string
  idleMs?: number
  authWaitMs?: number
}

type Proc = { child: ChildProcess; identity: ProcessIdentity | null; skip: boolean; verified: boolean; stopping: boolean; stderr: string; exited: boolean; gone: Promise<void>; done: () => void; idle: NodeJS.Timeout | null; denied: number; auth: { file: string; read: number } }

type Turn = {
  id: string
  proc: Proc | null
  lines: number
  interrupted: boolean
  wrongModel: string | null
  failure: { reason: EndReason; error: string } | null
  texts: Map<string, string>
  finalText: string
  started: Set<string>
}

type Call = { name: string; args: Json; file?: string; old?: string | null }

type State = {
  session: Session
  token: string
  cwd: string
  model: string
  canAsk: boolean
  intro: string | null
  conversationId: string | null
  proc: Proc | null
  launching: Promise<Proc> | null
  dying: Promise<void> | null
  turn: Turn | null
  steer: string[]
  carry: string[]
  calls: Map<string, Call>
  grants: Set<string>
  dead: boolean
}

type Pending =
  | { kind: 'approval'; session: Session; grantKey: string; resolve: (reply: Json) => void }
  | { kind: 'question'; session: Session; questions: Question[]; resolve: (reply: Json) => void }

type Listing = { at: number; auth?: string; models: HarnessModel[]; variants: Record<string, Record<string, string>> }

const allow = () => ({ decision: 'allow' })
const deny = (reason: string) => ({ decision: 'deny', reason })
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const SIGN_IN = "Sign Antigravity in with an API key or a business account; BitFrost can't use it with a personal Google account."

// Antigravity's terms don't allow driving it from another tool while it's signed in to a
// personal Google account; API keys and business accounts are fine. Each run says how it
// signed in only in its own log, so anything BitFrost can't read counts as personal.
// Every sign-in a log shows, null for one BitFrost can't read.
function authMethods(log: string): (string | null)[] {
  return log.split('\n').filter((l) => l.includes('applyAuthResult:')).map((l) => l.match(/\bauthMethod=([A-Za-z_]*)[,\s]/)?.[1].toLowerCase() ?? null)
}

// A run counts as refused when any of its sign-ins is.
export function authMethodOf(log: string): string | null {
  const all = authMethods(log)
  const bad = all.findIndex((m) => authRefusal(m))
  return bad === -1 ? all.at(-1) ?? null : all[bad]
}

// Only sign-ins known to be API keys or business accounts run; anything else is refused.
const ALLOWED_AUTH = /^(?:gemini_api_key|vertex\w*|business_\w+|enterprise\w*)$/

export function authRefusal(method: string | null | undefined): string | null {
  if (!method) return `BitFrost couldn't tell how Antigravity is signed in, so it won't run it. ${SIGN_IN}`
  if (/consumer|personal/.test(method)) return "Antigravity is signed in with a personal Google account. Its terms don't allow using it through another tool that way, so BitFrost won't run it. Sign it in with an API key or a business account to use it here."
  if (!ALLOWED_AUTH.test(method)) return `Antigravity is signed in a way BitFrost doesn't recognize (${method}), so it won't run it. ${SIGN_IN}`
  return null
}

// What a run logged since the last check; a partial last line waits for the next one.
function readNew(file: string, from: number): { text: string; next: number } {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return { text: '', next: from } }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= from) return { text: '', next: from }
    const buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    const end = buf.lastIndexOf(10) + 1
    return { text: buf.subarray(0, end).toString('utf8'), next: from + end }
  } finally { fs.closeSync(fd) }
}

const refused = (why: string) => Object.assign(new Error(why), { blocked: true })

function drop(file: string) {
  try { fs.rmSync(file, { force: true }) } catch {}
}

// Antigravity signs in within a second of starting and logs how.
function waitForAuth(file: string, ms: number, gone: () => boolean): Promise<string | null> {
  const until = Date.now() + ms
  return new Promise((resolve) => {
    const tick = () => {
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch {}
      const method = authMethodOf(text)
      if (method !== null || gone() || Date.now() >= until) return resolve(method)
      setTimeout(tick, 100)
    }
    tick()
  })
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function killLeftovers(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {}
}

// The next turn starts a new process, once this one has gone, and resumes the conversation.
function retire(st: State, proc: Proc, signal: NodeJS.Signals) {
  proc.stopping = true
  if (proc.idle) clearTimeout(proc.idle)
  if (st.proc === proc) st.proc = null
  st.dying = proc.gone
  killGroup(proc.child, signal)
  if (signal !== 'SIGKILL') setTimeout(() => { if (!proc.exited) killGroup(proc.child, 'SIGKILL') }, STOP_GRACE_MS).unref()
}

export function foldModels(listing: string): Omit<Listing, 'at'> {
  const groups = new Map<string, { name: string; ids: Map<string, string> }>()
  for (const line of listing.split('\n')) {
    const [id, name] = line.split('\t').map((s) => s.trim())
    if (!id || name === undefined || /\s/.test(id)) continue
    const m = id.match(/^(.+)-(minimal|low|medium|high|xhigh|max)$/)
    const base = m ? m[1] : id
    const g = groups.get(base) ?? { name: m ? name.replace(/\s*\([^)]*\)\s*$/, '') : name, ids: new Map() }
    g.ids.set(m ? m[2] : '', id)
    groups.set(base, g)
  }
  const models: HarnessModel[] = []
  const variants: Listing['variants'] = {}
  for (const [base, g] of groups) {
    const efforts = EFFORTS.filter((e) => g.ids.has(e))
    variants[base] = Object.fromEntries(g.ids)
    models.push({
      harness: 'agy',
      provider: vendorOf(base),
      model: base,
      displayName: g.name || base,
      description: 'Through your Antigravity API key or business account.',
      efforts,
      defaultEffort: g.ids.has('') || !efforts.length ? null : efforts.includes('medium') ? 'medium' : efforts[0],
      isDefault: !models.length,
    })
  }
  return { models, variants }
}

export function agyEndReason(text: string): EndReason {
  if (/\bcredits?\b|quota/i.test(text)) return 'quota_exhausted'
  if (/rate.?limit|RESOURCE_EXHAUSTED|\b429\b|too many requests/i.test(text)) return 'rate_limited'
  if (/sign(?:ed)?[ -]?in|log[ -]?in|authenticat|unauthori[sz]ed|UNAUTHENTICATED|\b401\b|\b403\b/i.test(text)) return 'auth'
  if (/context (?:window|length)|token limit|max(?:imum)? (?:output )?tokens|prompt is too long/i.test(text)) return 'max_tokens'
  return 'error'
}

function stderrError(stderr: string): string | null {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines.reverse()) {
    const m = line.match(/^AGY_ERROR:\s*(\{.*\})$/)
    if (m) {
      try {
        const e = JSON.parse(m[1])
        return String(e.short_error ?? e.message ?? m[1])
      } catch { return m[1] }
    }
  }
  return lines.find((l) => /^error:/i.test(l))?.replace(/^error:\s*/i, '') ?? (lines.length ? lines.slice(0, 3).reverse().join(' ') : null)
}

function pathArg(args: Json, cwd: string): string | undefined {
  for (const key of PATH_KEYS) if (str(args[key])) return path.resolve(cwd, args[key])
  return undefined
}

function readOld(file: string): string | null | undefined {
  try { return fs.statSync(file).size <= 1 << 20 ? fs.readFileSync(file, 'utf8') : undefined } catch { return null }
}

function toolCallOf(name: string, args: Json, cwd: string, old?: string | null): ToolCall {
  const a = Object.fromEntries(Object.entries(objectOf(args)).filter(([k]) => k !== 'toolAction' && k !== 'toolSummary'))
  const file = pathArg(a, cwd)
  const t = (kind: string, rawInput: Json, content: Json[] = []) => ({ ...blankTool(), kind, name, title: kind === 'other' ? name : '', rawInput, content })
  switch (name) {
    case 'run_command':
      return t('execute', { command: String(a.CommandLine ?? ''), ...(str(args.toolSummary) ? { description: args.toolSummary } : {}) })
    case 'view_file':
      return t('read', { file_path: file })
    case 'write_to_file':
      return t('edit', { file_path: file, content: String(a.CodeContent ?? '') }, file && old !== undefined ? [{ type: 'diff', path: file, oldText: old, newText: String(a.CodeContent ?? '') }] : [])
    case 'replace_file_content':
      return typeof a.TargetContent === 'string' && typeof a.ReplacementContent === 'string'
        ? t('edit', { file_path: file, old_string: a.TargetContent, new_string: a.ReplacementContent })
        : t('edit', { file_path: file, ...a })
    case 'read_url_content':
      return t('fetch', { url: str(a.Url) ?? str(a.url) ?? '' })
    case 'search_web':
      return t('fetch', { query: str(a.query) ?? str(a.Query) ?? '' })
  }
  if (FILE_TOOLS.has(name)) return t('edit', { ...a, ...(file ? { file_path: file } : {}) })
  return t('other', a)
}

function shapeOf(name: string, args: Json, cwd: string): { name: string; input: Json } {
  if (name === 'list_dir') {
    const where = pathArg(args, cwd)
    return { name: 'Bash', input: { command: where ? `ls '${where.replace(/'/g, `'\\''`)}'` : 'ls', description: 'List files' } }
  }
  const t = toolCallOf(name, args, cwd)
  return claudeTool(t.kind, name, t.rawInput) ?? { name, input: t.rawInput }
}

function batch(texts: string[]): string {
  return texts.length === 1 ? texts[0] : `The lead sent these messages while you were working, oldest first:\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n\n')}`
}

export class AgyProvider implements Provider {
  readonly id = 'agy'
  readonly displayName = 'Antigravity'
  readonly vendor = 'Google'
  readonly capabilities: ProviderCapabilities = { steer: true, autoReview: false, questions: true, gates: 'all' }
  readonly location: string
  readonly watch: string[]
  private opts: AgyOptions
  private log: (msg: string) => void
  private cacheFile: string
  private listing: Listing | null = null
  private fetching: Promise<Listing> | null = null
  private states = new Map<string, State>()
  private byToken = new Map<string, State>()
  private pending = new Map<string, Pending>()
  // Set once the bridge failed to load, so later runs keep permission prompts on.
  private unsafe = false
  // Why the last check refused how Antigravity is signed in.
  private refusal: string | null = null

  constructor(opts: AgyOptions) {
    this.opts = opts
    this.log = opts.log
    this.location = opts.bin
    this.watch = [opts.bin]
    this.cacheFile = path.join(opts.runDir, 'agy-models.json')
  }

  // A private file for one run's log, which holds the account's email address.
  private authLog(): string {
    const dir = path.join(this.opts.runDir, 'agy-auth')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return path.join(dir, `${randomUUID()}.log`)
  }

  private checked(method: string | null): string | null {
    this.refusal = authRefusal(method)
    if (this.refusal) {
      this.listing = null
      drop(this.cacheFile)
    }
    return this.refusal
  }

  async listModels(force = false): Promise<HarnessModel[]> {
    return (await this.models(force)).models
  }

  private async models(force = false): Promise<Listing> {
    if (!this.listing) {
      try { this.listing = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) } catch {}
    }
    // A list from before the sign-in check, or after a refusal, is fetched again.
    if (!force && !this.refusal && this.listing && !authRefusal(this.listing.auth) && Date.now() - this.listing.at < MODELS_TTL_MS) return this.listing
    this.fetching ??= this.fetchModels().finally(() => (this.fetching = null))
    return this.fetching
  }

  private fetchModels(): Promise<Listing> {
    return new Promise((resolve, reject) => {
      const logFile = this.authLog()
      execFile(this.opts.bin, [...(this.opts.args ?? []), '--log-file', logFile, 'models'], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        let method: string | null = null
        try { method = authMethodOf(fs.readFileSync(logFile, 'utf8')) } catch {}
        drop(logFile)
        // Check first, so a failed listing on a refused sign-in still drops the old list.
        const refusal = this.checked(method)
        const folded = foldModels(String(stdout ?? ''))
        if (!folded.models.length && (!refusal || method === null)) {
          const said = `${stdout ?? ''}\n${stderr ?? ''}\n${err?.message ?? ''}`
          const why = agyEndReason(said) === 'auth' ? `Antigravity is not signed in. ${SIGN_IN}` : `Antigravity listed no models: ${said.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`
          return reject(refusal ? refused(why) : new Error(why))
        }
        if (refusal) return reject(refused(refusal))
        this.listing = { at: Date.now(), auth: method!, ...folded }
        try {
          fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 })
          fs.writeFileSync(this.cacheFile, JSON.stringify(this.listing), { mode: 0o600 })
        } catch (e) { this.log(`agy: could not cache the model list: ${(e as Error).message}`) }
        resolve(this.listing)
      })
    })
  }

  private async variantOf(model: string, effort: string | undefined): Promise<string> {
    let v: Record<string, string> | undefined
    try { v = (await this.models()).variants[model] } catch {}
    if (!v) return effort && EFFORTS.includes(effort) && !model.endsWith(`-${effort}`) ? `${model}-${effort}` : model
    if (effort && v[effort]) return v[effort]
    if (effort) this.log(`agy: ${model} has no effort ${effort}; using its default`)
    const listed = this.listing?.models.find((m) => m.model === model)
    return v[''] ?? v[listed?.defaultEffort ?? ''] ?? Object.values(v)[0]
  }

  async spawnSession(session: Session, req: SpawnRequest): Promise<string> {
    const model = await this.variantOf(req.model, req.effort)
    session.info.id = `agy_${randomUUID()}`
    session.info.effort = req.effort ?? null
    const st = this.track(session, req.cwd, model, !!req.canAskUser, req.developerInstructions ?? null, null)
    session.setNativeRef({ conversationId: null, model, canAsk: st.canAsk })
    session.acceptInput(req.prompt, 'started')
    this.runTurn(st, req.prompt)
    return session.info.id
  }

  private track(session: Session, cwd: string, model: string, canAsk: boolean, intro: string | null, conversationId: string | null): State {
    const st: State = { session, token: randomUUID(), cwd, model, canAsk, intro, conversationId, proc: null, launching: null, dying: null, turn: null, steer: [], carry: [], calls: new Map(), grants: new Set(), dead: false }
    this.states.set(session.info.id, st)
    this.byToken.set(st.token, st)
    return st
  }

  async sendInput(session: Session, text: string): Promise<'started' | 'steered' | 'queued'> {
    const st = this.states.get(session.info.id)
    if (!st || st.dead) throw new Error("Antigravity can't reopen this session")
    if (st.turn) {
      if (st.turn.interrupted || st.turn.wrongModel) { session.queueInput(this, text); return 'queued' }
      // The next model request picks it up through the PreInvocation hook.
      st.steer.push(text)
      return 'steered'
    }
    this.runTurn(st, text)
    return 'started'
  }

  async attach(session: Session, ref: Json) {
    if (!ref?.conversationId) throw new Error("Antigravity can't reopen this session: no conversation id was saved")
    const model = str(ref.model) ?? await this.variantOf(session.info.model, session.info.effort ?? undefined)
    if (ref.process) killOwnedGroup(ref.process, this.log)
    this.track(session, session.info.cwd, model, !!ref.canAsk, null, String(ref.conversationId))
  }

  kill(session: Session) {
    const st = this.states.get(session.info.id)
    const proc = st?.turn?.proc ?? st?.proc
    return proc ? killGroup(proc.child, 'SIGKILL') : false
  }

  isBusy(session: Session) { return !!this.states.get(session.info.id)?.turn }

  async interrupt(session: Session): Promise<void> {
    this.dropPending(session, 'Stopped.')
    const st = this.states.get(session.info.id)
    const turn = st?.turn
    if (!st || !turn || turn.interrupted) return
    turn.interrupted = true
    const proc = turn.proc ?? st.proc
    // SIGINT ends the turn cleanly and the process with it.
    if (proc) retire(st, proc, 'SIGINT')
  }

  dispose() {
    for (const st of [...this.states.values()]) this.close(st, 'BitFrost stopped.')
  }

  disposeSession(session: Session) {
    const st = this.states.get(session.info.id)
    if (st) this.close(st, 'The task was stopped.')
    else session.dropInputs()
  }

  private close(st: State, why: string) {
    st.dead = true
    st.session.dropInputs()
    this.dropPending(st.session, why)
    if (st.turn) st.turn.interrupted = true
    const proc = st.proc
    if (!proc) killOwnedGroup(st.session.nativeRef?.process, this.log)
    if (proc && st.turn) retire(st, proc, 'SIGTERM')
    else if (proc) {
      proc.child.stdin?.end()
      setTimeout(() => { if (!proc.exited) killGroup(proc.child, 'SIGKILL') }, STOP_GRACE_MS).unref()
    }
    if (this.states.get(st.session.info.id) === st) this.states.delete(st.session.info.id)
    this.byToken.delete(st.token)
  }

  private runTurn(st: State, text: string) {
    const turn: Turn = { id: `agy_${randomUUID()}`, proc: null, lines: 0, interrupted: false, wrongModel: null, failure: null, texts: new Map(), finalText: '', started: new Set() }
    st.turn = turn
    if (st.proc?.idle) { clearTimeout(st.proc.idle); st.proc.idle = null }
    st.session.push({ type: 'turn_started', turnId: turn.id })
    // Antigravity has no system prompt option, so the instructions lead the first message.
    const prompt = [st.intro, ...st.carry.splice(0), text].filter(Boolean).join('\n\n')
    st.intro = null
    void this.write(st, turn, prompt)
  }

  private async write(st: State, turn: Turn, text: string) {
    try {
      const proc = st.proc ?? await (st.launching ??= this.launch(st).finally(() => (st.launching = null)))
      if (st.turn !== turn) return
      if (turn.interrupted) return this.finish(st, turn, 'interrupted', 'interrupted')
      if (proc.exited) throw new Error(stderrError(proc.stderr) ?? 'it exited at once')
      if (this.signedOut(st, proc)) throw refused(this.refusal!)
      turn.proc = proc
      turn.lines++
      proc.child.stdin!.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n')
    } catch (e) {
      if (turn.interrupted) this.finish(st, turn, 'interrupted', 'interrupted')
      else if ((e as Json).blocked) this.finish(st, turn, 'failed', 'auth', (e as Error).message)
      else this.finish(st, turn, 'failed', 'crashed', `Antigravity could not run: ${(e as Error).message}`)
    }
  }

  private async launch(st: State): Promise<Proc> {
    const check = this.opts.bridgeLoaded ?? (() => Promise.resolve(false))
    const skip = !this.unsafe && await check().catch(() => false)
    if (!skip) this.log('agy: the BitFrost bridge plugin is not loaded in Antigravity, so it will refuse every action that needs permission (run: bitfrostd setup agy)')
    await st.dying
    if (st.dead) throw new Error('the task was stopped')
    const logFile = this.authLog()
    const args = ['--log-file', logFile, '-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model', st.model]
    if (skip) args.push('--dangerously-skip-permissions')
    if (st.conversationId) args.push('--conversation', st.conversationId)
    const mark = randomUUID()
    const child = spawn(this.opts.bin, [...(this.opts.args ?? []), ...args], {
      cwd: st.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BITFROST_SOCKET: this.opts.socket, BITFROST_AGY_TOKEN: st.token, BITFROST_AGY_PROC: mark, BITFROST_NODE: this.opts.node ?? process.execPath },
    })
    let done = () => {}
    const gone = new Promise<void>((resolve) => (done = resolve))
    // A restarted helper finds the group through the saved session and stops what is left of it.
    const identity = child.pid ? processIdentity(child.pid, mark, 'BITFROST_AGY_PROC') : null
    if (identity) st.session.setNativeRef({ ...st.session.nativeRef, process: identity })
    const proc: Proc = { child, identity, skip, verified: false, stopping: false, stderr: '', exited: false, gone, done, idle: null, denied: 0, auth: { file: logFile, read: 0 } }
    st.proc = proc
    child.stdin!.on('error', (e) => this.log(`agy stdin: ${e.message}`))
    child.stderr!.on('data', (d) => {
      proc.stderr = (proc.stderr + String(d)).slice(-4000)
      this.log(`agy stderr: ${String(d).trimEnd().slice(0, 1000)}`)
    })
    createInterface({ input: child.stdout! }).on('line', (line) => {
      this.opts.record?.(line)
      let ev: Json
      try { ev = JSON.parse(line) } catch { return }
      try { this.onLine(st, proc, ev) } catch (e) { this.log(`agy: could not handle ${ev?.event}: ${(e as Error).stack}`) }
    })
    let exitTimer: NodeJS.Timeout | null = null
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitTimer) clearTimeout(exitTimer)
      this.onExit(st, proc, code, signal)
    }
    child.on('error', (e) => {
      proc.stderr += `\n${e.message}`
      ended(null, null)
    })
    // A command left running can hold the pipes open, so wait only briefly for them after exit.
    child.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        ended(code, signal)
      }, 1000)
      exitTimer.unref()
    })
    child.on('close', ended)
    // No prompt goes in until the run has shown how it signed in. The log stays until the
    // process ends, so later sign-ins are checked too.
    const method = await waitForAuth(logFile, this.opts.authWaitMs ?? AUTH_WAIT_MS, () => proc.exited || st.dead)
    if (proc.exited || st.dead) return proc
    const refusal = this.checked(method)
    if (refusal) {
      this.log(`agy: refused the run: ${method === null ? 'no sign-in found in its log' : `signed in as ${method}`}`)
      drop(logFile)
      retire(st, proc, 'SIGKILL')
      throw refused(refusal)
    }
    return proc
  }

  // True when the run has signed in again in a way that is refused; it is then stopped.
  private signedOut(st: State, proc: Proc): boolean {
    const { text, next } = readNew(proc.auth.file, proc.auth.read)
    proc.auth.read = next
    if (!text.includes('applyAuthResult:')) return false
    const method = authMethodOf(text)
    const refusal = this.checked(method)
    if (!refusal) return false
    this.log(`agy: refused the run: it signed in again ${method === null ? 'in a way BitFrost could not read' : `as ${method}`}`)
    if (st.turn?.proc === proc && !st.turn.failure) st.turn.failure = { reason: 'auth', error: refusal }
    retire(st, proc, 'SIGKILL')
    return true
  }

  private onExit(st: State, proc: Proc, code: number | null, signal: NodeJS.Signals | null) {
    if (proc.exited) return
    proc.exited = true
    proc.done()
    drop(proc.auth.file)
    if (proc.idle) clearTimeout(proc.idle)
    if (st.proc === proc) st.proc = null
    if (proc.stopping) killLeftovers(proc.child)
    if (proc.identity && st.session.nativeRef?.process?.token === proc.identity.token && !groupAlive(proc.identity.pgid)) {
      const { process: _, ...ref } = st.session.nativeRef
      st.session.setNativeRef(ref)
    }
    const turn = st.turn
    if (!turn || turn.proc !== proc) return
    this.dropPending(st.session, 'Antigravity stopped.')
    if (turn.interrupted && !turn.wrongModel && !turn.failure) return this.finish(st, turn, 'interrupted', 'interrupted')
    if (turn.wrongModel || turn.failure) return this.finish(st, turn, 'failed')
    const said = stderrError(proc.stderr) ?? `exit ${code ?? signal}`
    const reason = agyEndReason(said)
    this.log(`agy exited mid-turn code=${code} signal=${signal}: ${proc.stderr.trim().slice(-500)}`)
    this.finish(st, turn, 'failed', reason === 'error' ? 'crashed' : reason, `Antigravity stopped: ${said}${reason === 'auth' ? ` ${SIGN_IN}` : ''}`)
  }

  private onLine(st: State, proc: Proc, ev: Json) {
    const conv = str(ev.conversation_id) ?? str(ev.step_update?.conversation_id) ?? str(ev.result?.conversation_id)
    if (conv && st.conversationId !== conv && st.proc === proc) {
      st.conversationId = conv
      st.session.setNativeRef({ ...st.session.nativeRef, conversationId: conv })
    }
    const turn = st.turn
    if (!turn || turn.proc !== proc) return
    if (ev.event === 'init') {
      const ran = str(ev.init?.model)
      if (ran && ran !== st.model) this.wrongModel(st, turn, ran)
    } else if (ev.event === 'step_update') this.onStep(st, proc, turn, ev.step_update ?? {})
    else if (ev.event === 'result') this.onResult(st, proc, turn, ev.result ?? {})
  }

  private onStep(st: State, proc: Proc, turn: Turn, s: Json) {
    if (turn.wrongModel || turn.failure) return
    // The PreInvocation hook runs before every model request, so a request without it means no gate.
    if (proc.skip && !proc.verified && (s.step_type === 'agent_response' || s.step_type === 'tool')) {
      this.unsafe = true
      turn.failure = { reason: 'error', error: 'Antigravity did not load the BitFrost bridge plugin, so BitFrost stopped it before it could act unchecked. Run: bitfrostd setup agy' }
      retire(st, proc, 'SIGKILL')
      return
    }
    const id = `${s.conversation_id ?? st.conversationId}:${s.step_index}`
    const emit = (body: AgentEventBody) => st.session.push(body)
    if (s.step_type === 'agent_response') {
      const text = (turn.texts.get(id) ?? '') + (typeof s.text_delta === 'string' ? s.text_delta : '')
      turn.texts.set(id, text)
      st.session.live = { activity: 'responding', partialText: text || turn.finalText || null, updatedAt: Date.now() }
      if (s.state === 'ACTIVE') return
      turn.texts.delete(id)
      if (text.trim()) {
        turn.finalText = text.trim()
        emit({ type: 'text', itemId: id, text: text.trim() })
      }
      const u = s.usage
      // Antigravity reports uncached input; BitFrost counts cached input inside inputTokens.
      if (u) emit({ type: 'usage', requestId: id, inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_tokens) || 0), outputTokens: Number(u.output_tokens) || 0, cachedInputTokens: Number(u.cache_read_tokens) || 0 })
      return
    }
    if (s.step_type === 'tool') this.onTool(st, turn, id, s, emit)
  }

  private onTool(st: State, turn: Turn, id: string, s: Json, emit: (b: AgentEventBody) => void) {
    const name = String(s.tool_name ?? s.tool_info?.name ?? 'tool')
    const call = st.calls.get(id)
    const args = objectOf(call?.args ?? s.tool_info?.parameters)
    const cwd = str(args.Cwd) ?? st.cwd
    st.session.live = { activity: 'working', partialText: turn.finalText || null, updatedAt: Date.now() }
    const start = () => {
      if (turn.started.has(id)) return
      turn.started.add(id)
      if (name === 'run_command') {
        const command = String(args.CommandLine ?? '')
        emit({ type: 'command_started', itemId: id, command, summary: str(args.toolSummary) ?? command.split('\n')[0].slice(0, 70), cwd })
      } else emit({ type: 'tool_started', itemId: id, ...shapeOf(name, args, st.cwd) })
    }
    // Edits are announced when they finish, with their diff.
    if (s.state === 'ACTIVE') return FILE_TOOLS.has(name) ? undefined : start()
    st.calls.delete(id)
    const ok = s.state === 'DONE'
    const output = str(s.tool_info?.output) ?? str(s.tool_info?.error?.message) ?? ''
    if (name === 'run_command') {
      start()
      const command = String(args.CommandLine ?? '')
      const ms = Number(s.duration_seconds) * 1000
      emit({ type: 'command_completed', itemId: id, command, summary: str(args.toolSummary) ?? command.split('\n')[0].slice(0, 70), cwd, output, exitCode: null, durationMs: Number.isFinite(ms) ? Math.round(ms) : null, status: ok ? 'completed' : 'failed' })
      return
    }
    if (ok && call?.file && call.old !== undefined) {
      const now = readOld(call.file)
      if (typeof now === 'string') {
        emit({ type: 'file_change', itemId: id, changes: [{ path: call.file, kind: call.old === null ? 'add' : 'update', movePath: null, diff: unifiedDiff(call.old, now) }], status: 'completed' })
        return
      }
    }
    start()
    emit({ type: 'tool_completed', itemId: id, ...shapeOf(name, args, st.cwd), ok, output })
  }

  private onResult(st: State, proc: Proc, turn: Turn, r: Json) {
    turn.lines = Math.max(0, turn.lines - 1)
    if (str(r.response)?.trim()) turn.finalText = r.response.trim()
    if (turn.lines > 0) return
    if (turn.wrongModel || turn.failure) return this.finish(st, turn, 'failed')
    if (turn.interrupted) return this.finish(st, turn, 'interrupted', 'interrupted')
    if (r.status === 'ERROR') {
      const said = str(r.error) ?? stderrError(proc.stderr) ?? 'Antigravity reported an error'
      const reason = agyEndReason(said)
      return this.finish(st, turn, 'failed', reason, `${said}${reason === 'auth' ? ` ${SIGN_IN}` : ''}`)
    }
    // The lead's message came after the model's last request, so it runs next, in this same turn.
    if (st.steer.length) {
      if (this.signedOut(st, proc)) return this.finish(st, turn, 'failed')
      turn.lines++
      proc.child.stdin!.write(JSON.stringify({ event: 'user', message: { content: batch(st.steer.splice(0)) } }) + '\n')
      return
    }
    // The list covers the whole process, so only its new entries belong to this turn.
    const denied = Array.isArray(r.denied_actions) ? r.denied_actions.slice(proc.denied) : []
    proc.denied += denied.length
    if (!proc.skip && denied.length) {
      const what = denied.map((d: Json) => d?.display_name ?? d?.action).filter(Boolean).join(', ')
      return this.finish(st, turn, 'failed', 'permission_denied', `Antigravity refused ${what || 'an action'} because the BitFrost bridge plugin is not loaded. Run: bitfrostd setup agy`)
    }
    this.finish(st, turn, 'completed', 'end_turn')
  }

  private finish(st: State, turn: Turn, status: 'completed' | 'interrupted' | 'failed', reason?: EndReason, error?: string) {
    if (st.turn !== turn) return
    st.turn = null
    st.carry.push(...st.steer.splice(0))
    this.dropPending(st.session, 'The turn ended.')
    if (turn.wrongModel) [reason, error] = ['wrong_model', `Antigravity started ${turn.wrongModel} instead of ${st.model}; stopped it`]
    else if (turn.failure) [reason, error] = [turn.failure.reason, turn.failure.error]
    const partial = [...turn.texts.values()].join('').trim()
    st.session.push({ type: 'turn_completed', turnId: turn.id, status, reason: reason ?? 'error', finalText: turn.finalText || partial, ...(error ? { error } : {}) })
    const proc = st.proc
    // An idle process ends when its input closes; the next turn resumes the conversation.
    if (proc && !st.turn && !st.dead) {
      if (proc.idle) clearTimeout(proc.idle)
      proc.idle = setTimeout(() => {
        if (st.turn || st.proc !== proc) return
        proc.stopping = true
        st.proc = null
        st.dying = proc.gone
        proc.child.stdin?.end()
        setTimeout(() => { if (!proc.exited) killGroup(proc.child, 'SIGKILL') }, STOP_GRACE_MS).unref()
      }, this.opts.idleMs ?? IDLE_MS)
      proc.idle.unref()
    }
  }

  private wrongModel(st: State, turn: Turn, ran: string) {
    if (turn.wrongModel) return
    turn.wrongModel = ran
    this.dropPending(st.session, 'Stopped: Antigravity runs the wrong model.')
    const proc = turn.proc ?? st.proc
    if (proc) retire(st, proc, 'SIGINT')
  }

  async bridge(token: string, body: Json): Promise<Json | null> {
    const hook = String(body?.hook ?? '')
    const input = objectOf(body?.input)
    const st = this.byToken.get(token)
    if (!st || st.dead) return hook === 'PreToolUse' ? deny('Unknown BitFrost task.') : null
    if (st.proc) st.proc.verified = true
    // Hooks run before every model request and tool call, so each one rechecks the sign-in.
    const live = st.turn?.proc ?? st.proc
    if (live && this.signedOut(st, live)) return hook === 'PreToolUse' ? deny(this.refusal!) : null
    const turn = st.turn
    if (turn && str(input.modelName) && input.modelName !== 'auto' && input.modelName !== st.model) this.wrongModel(st, turn, input.modelName)
    if (hook === 'PreInvocation') {
      if (!turn || turn.interrupted || turn.wrongModel || turn.failure || !st.steer.length) return null
      return { injectSteps: [{ userMessage: batch(st.steer.splice(0)) }] }
    }
    if (hook !== 'PreToolUse') return null
    if (!turn || turn.interrupted || turn.wrongModel || turn.failure) return deny('The task was stopped.')
    return this.gate(st, input)
  }

  private gate(st: State, input: Json): Json | Promise<Json> {
    const name = String(input.toolCall?.name ?? '')
    const args = objectOf(input.toolCall?.args)
    if (DISALLOWED.has(name)) return deny(`BitFrost subagents cannot use ${name}: nested subagents, multi-agent workflows, and runs scheduled outside BitFrost are disabled.`)
    if (name === 'ask_question') return this.ask(st, args)
    if (PERMISSION_TOOLS.has(name)) return deny('BitFrost asks the user itself when an action runs. Call the tool you need directly.')
    const itemId = input.stepIdx != null ? `${str(input.conversationId) ?? st.conversationId}:${input.stepIdx}` : null
    const file = pathArg(args, st.cwd)
    const old = FILE_TOOLS.has(name) && file ? readOld(file) : undefined
    if (itemId) st.calls.set(itemId, { name, args, ...(FILE_TOOLS.has(name) && file ? { file, old } : {}) })
    if (READ_ONLY.has(name)) return allow()
    if (name === 'manage_task' && /^(status|list)$/i.test(String(args.Action ?? args.action ?? ''))) return allow()
    if (name === 'run_command' && readOnlyCommand(String(args.CommandLine ?? ''))) return allow()
    if (FILE_TOOLS.has(name) && file && inside(file, st.cwd)) return allow()
    if (!st.canAsk) return deny('This BitFrost task runs without asking, so actions that need approval are refused.')
    if (st.proc && !st.proc.skip) return deny('Antigravity refuses this here because the BitFrost bridge plugin is out of date or turned off. Run: bitfrostd setup agy')
    const t = toolCallOf(name, args, st.cwd, old)
    const runIn = path.resolve(st.cwd, str(args.Cwd) ?? '.')
    const grantKey = t.kind === 'execute' ? `${grantKeyOf(t)}\0${runIn}` : grantKeyOf(t)
    if (st.grants.has(grantKey)) return allow()
    const action = describeAction(t, runIn)
    const said = str(args.toolSummary)
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      this.pending.set(approvalId, { kind: 'approval', session: st.session, grantKey, resolve })
      st.session.push({ type: 'approval_requested', approvalId, itemId, ...action, detail: said && !action.detail.includes(said) ? `It says: ${said}\n${action.detail}` : action.detail })
    })
  }

  // Print mode skips ask_question, so the hook asks BitFrost and denies with the answer, which the model reads.
  private ask(st: State, args: Json): Json | Promise<Json> {
    if (!st.canAsk) return deny('No one can answer questions in this task; use your best judgment.')
    const questions: Question[] = (Array.isArray(args.questions) ? args.questions : []).map((q: Json, i: number) => ({
      id: `q${i}`,
      header: String(q?.header ?? ''),
      question: `${q?.question ?? ''}${q?.is_multi_select ? ' (pick one or more)' : ''}`,
      options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => (typeof o === 'string' ? { label: o, description: '' } : { label: String(o?.label ?? ''), description: String(o?.description ?? '') })),
      allowOther: true,
      secret: false,
    }))
    if (!questions.length) return deny('The question was empty.')
    const questionId = randomUUID()
    return new Promise((resolve) => {
      this.pending.set(questionId, { kind: 'question', session: st.session, questions, resolve })
      st.session.push({ type: 'question_asked', questionId, questions })
    })
  }

  private dropPending(session: Session, why: string) {
    for (const [id, p] of this.pending) {
      if (p.session !== session) continue
      this.pending.delete(id)
      p.resolve(deny(why))
      if (p.kind === 'approval') session.push({ type: 'approval_resolved', approvalId: id, decision: 'deny' })
    }
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
    const given = p.questions.flatMap((q) => (answers?.[q.id]?.length ? [`${q.question}\n${answers[q.id].join(', ')}`] : []))
    p.resolve(deny(given.length ? `The user answered your question.\n\n${given.join('\n\n')}` : 'No answer from the user; use your best judgment.'))
    return true
  }
}


const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BRIDGE_SOURCE = path.join(HERE, '..', '..', 'agy-plugin')
const BRIDGE_FILES = ['plugin.json', 'hook', 'hook.mjs']

export const bridgeDir = (home = os.homedir()) => path.join(home, '.gemini', 'config', 'plugins', PLUGIN_NAME)

// Hooks run from the plugin folder; a full path keeps them working wherever Antigravity runs them.
function bridgeHooks(dir: string, source: string): string {
  const hooks = JSON.parse(fs.readFileSync(path.join(source, 'hooks.json'), 'utf8'))
  const hook = `'${path.join(dir, 'hook').replace(/'/g, `'\\''`)}'`
  return JSON.stringify(hooks, (key, value) => (key === 'command' && typeof value === 'string' ? value.replace(/^\.\/hook\b/, hook) : value), 2) + '\n'
}

export function bridgeCurrent(dir = bridgeDir(), source = BRIDGE_SOURCE): boolean {
  try {
    return BRIDGE_FILES.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(source, f), 'utf8'))
      && fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8') === bridgeHooks(dir, source)
  } catch {
    return false
  }
}

// Build the copy outside the plugins folder and move it in, so Antigravity never loads half a plugin.
export function installBridge(dir = bridgeDir(), source = BRIDGE_SOURCE) {
  const next = path.join(path.dirname(path.dirname(dir)), `.${PLUGIN_NAME}.new`)
  fs.rmSync(next, { recursive: true, force: true })
  fs.mkdirSync(next, { recursive: true })
  for (const f of BRIDGE_FILES) fs.copyFileSync(path.join(source, f), path.join(next, f))
  fs.chmodSync(path.join(next, 'hook'), 0o755)
  fs.writeFileSync(path.join(next, 'hooks.json'), bridgeHooks(dir, source))
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(next, dir)
}

export function uninstallBridge(dir = bridgeDir(), dryRun = false): { label: string; path: string }[] {
  const found = fs.existsSync(dir) ? [{ label: 'BitFrost bridge plugin in Antigravity', path: dir }] : []
  if (!dryRun) fs.rmSync(dir, { recursive: true, force: true })
  return found
}

export function bridgeLoaded(bin: string, dir = bridgeDir(), source = BRIDGE_SOURCE, prefix: string[] = []): Promise<boolean> {
  if (!bridgeCurrent(dir, source)) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(bin, [...prefix, 'plugin', 'list', '--json'], { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(false)
      try {
        const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
        resolve((JSON.parse(String(stdout)) as Json[]).some((p) => p?.name === PLUGIN_NAME && p.enabled !== false && real(String(p.path ?? '')) === real(dir) && (p.hooks ?? []).includes(PLUGIN_NAME)))
      } catch {
        resolve(false)
      }
    })
  })
}

export function resolveAgy(env: ProviderEnv, fallback = path.join(os.homedir(), '.local', 'bin', 'agy')): string | null {
  const chosen = process.env.BITFROST_AGY_BIN ?? env.config?.bin ?? env.resolveBinary('agy')
  if (chosen) return chosen
  try {
    fs.accessSync(fallback, fs.constants.X_OK)
    return fallback
  } catch {
    return null
  }
}

export const agyProvider: ProviderFactory = {
  id: 'agy',
  displayName: 'Antigravity',
  vendor: 'Google',
  firstClass: true,
  optIn: true,
  detect: (env) => resolveAgy(env),
  create(env) {
    const bin = resolveAgy(env)
    if (!bin) return null
    // The user turned Antigravity on, so keep the bridge copy current.
    try { if (!bridgeCurrent()) installBridge() } catch (e) { env.log(`agy: could not install the bridge plugin: ${(e as Error).message}`) }
    return new AgyProvider({ bin, log: env.log, record: env.recorder('agy'), runDir: env.runDir, socket: env.socket, bridgeLoaded: () => bridgeLoaded(bin) })
  },
  setup() {
    installBridge()
    console.log(`Installed the BitFrost bridge plugin in ${bridgeDir()}`)
  },
  uninstall: (dryRun = false) => uninstallBridge(bridgeDir(), dryRun),
}
