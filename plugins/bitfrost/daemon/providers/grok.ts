// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Run Grok Build over ACP in always-approve mode; a BitFrost hook gates each action.
import type { ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Decision, EndReason, Question } from '../events.ts'
import type { HarnessModel, ProviderEnv, ProviderFactory } from '../provider.ts'
import type { Session } from '../session.ts'
import { AcpProvider, type AcpLaunch, type AcpOptions, type AcpState, type AcpTurn } from './acp.ts'
import { blankTool, describeAction, grantKeyOf, inside, objectOf } from './acp-shapes.ts'

type Json = any

const READ_TOOLS = new Set(['readfile', 'listdir', 'grep', 'glob', 'websearch', 'todowrite', 'skill', 'skills', 'getcommandorsubagentoutput', 'killcommandorsubagent', 'getterminalcommandoutput', 'killterminalcommand', 'gettaskoutput', 'killtask', 'wait', 'waittasks', 'taskoutput', 'bashoutput', 'killshell'])
const FILE_TOOLS = new Set(['write', 'writefile', 'searchreplace', 'edit', 'multiedit', 'hashlineedit'])
const READ_COMMANDS = new Set(['ls', 'cat', 'pwd', 'whoami', 'uptime', 'ps', 'head', 'tail', 'wc', 'tr', 'cut', 'grep'])
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const deny = (reason: string) => ({ decision: 'deny', reason })
const allow = () => ({ decision: 'allow' })
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0

type HookPending = { session: Session; grantKey: string; resolve: (reply: Json) => void }
type NativeQuestion = { session: Session; rpcId: string | number; questions: Question[] }
type Usage = { seen: Set<string>; total?: Json; stop?: string }

export function grokReadOnlyCommand(command: string): boolean {
  if (!command.trim() || /[><`$\\\n\r'"(){}!#]/.test(command)) return false
  return command.split(/&&|\|\||[;|]/).every((segment) => {
    if (!segment.trim() || segment.includes('&')) return false
    const [cmd, ...args] = segment.trim().split(/\s+/)
    if (cmd === 'date' || cmd === 'hostname') return args.length === 0
    if (cmd === 'sort') return args.every((a) => !a.startsWith('-') || /^-[bdfghMnrsuVz]+$/.test(a))
    if (cmd === 'rg') return !args.some((a) => /^--(?:pre|hostname-bin)/.test(a))
    // A second file operand is where uniq writes.
    if (cmd === 'uniq') return !args.includes('--') && args.filter((a) => a === '-' || !a.startsWith('-')).length <= 1
    // Git and kubectl can execute programs from local configuration.
    return READ_COMMANDS.has(cmd)
  })
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

export function grokEndReason(stop: string, error: string | null): EndReason {
  const text = `${stop} ${error ?? ''}`.toLowerCase()
  if (/not authenticated|unauth|authentication|\bauth(?:_required|_failed)?\b|\b401\b|\b403\b|login required/.test(text)) return 'auth'
  if (/quota|credit|billing|payment|usage.limit|budget.exceeded/.test(text)) return 'quota_exhausted'
  if (/rate.limit|\b429\b/.test(text)) return 'rate_limited'
  if (/max.tokens|token.limit|context.(?:window|length|limit)/.test(text)) return 'max_tokens'
  if (/max.(?:turn.)?requests|request.limit/.test(text)) return 'max_requests'
  if (/refus|content.filter|safety/.test(text)) return 'refusal'
  return !error && stop === 'end_turn' ? 'end_turn' : 'error'
}

export class GrokProvider extends AcpProvider {
  readonly watch: string[]
  private token: string
  private relocate?: () => string | null
  private hooks = new Map<string, HookPending>()
  private questions = new Map<string, NativeQuestion>()
  private usage = new WeakMap<AcpTurn, Usage>()

  constructor(launch: AcpLaunch, opts: AcpOptions & { token: string; watch?: string[]; relocate?: () => string | null }) {
    super({ id: 'grok', displayName: 'Grok Build', vendor: 'xAI', binary: 'grok', args: [], loginCommand: 'grok login', optIn: true, gates: 'all', note: '' }, launch, opts)
    this.token = opts.token
    this.watch = opts.watch ?? [launch.bin]
    this.relocate = opts.relocate
  }

  moved(): boolean { return !!this.relocate && this.relocate() !== this.location }

  async listModels(): Promise<HarnessModel[]> {
    await this.start()
    const state = this.initialized?._meta?.modelState
    return (state?.availableModels ?? []).filter((m: Json) => /^grok-[\w.-]+$/.test(m.modelId)).map((m: Json) => {
      const meta = m._meta ?? {}
      const context = count(meta.totalContextTokens)
      const levels = meta.supportsReasoningEffort ? meta.reasoningEfforts ?? [] : []
      return {
        harness: this.id, provider: 'xAI', model: m.modelId, displayName: m.name ?? m.modelId,
        description: [m.description, context ? `${context >= 1e6 ? `${context / 1e6}M` : `${Math.round(context / 1000)}k`} context.` : ''].filter(Boolean).join(' '),
        efforts: levels.map((e: Json) => String(e.value)),
        defaultEffort: levels.find((e: Json) => e.default)?.value ?? meta.reasoningEffort ?? null,
        isDefault: m.modelId === state.currentModelId,
      }
    })
  }

  protected sessionParams(cwd: string): Json { return { cwd, mcpServers: [], _meta: { yoloMode: true } } }

  protected explain(e: Json): Error {
    const data = e?.data
    const detail = typeof data === 'string' ? data : [data?.detail, data?.message, data?.status, data?.code, data?.error?.message, data?.error?.code].filter((v) => typeof v === 'string' || typeof v === 'number').join(' ')
    const message = [e?.message, detail, [401, 403, 429].includes(e?.code) ? e.code : null].filter(Boolean).join(' ').slice(0, 2000)
    if (e?.code === -32000 || grokEndReason('', message) === 'auth') return new Error(`Grok Build could not authenticate: ${message}. Run grok login in a terminal, then try again.`)
    return message !== e?.message ? new Error(message) : e
  }

  protected endReason(stop: string, error: string | null): EndReason { return grokEndReason(stop, error) }

  protected onNotification(method: string, p: Json) {
    if (method !== '_x.ai/session_notification') return
    const st = this.byAcpId.get(p.sessionId)
    const u = p.update ?? {}
    if (!st) return
    if (u.sessionUpdate === 'model_changed') return this.checkModel(st, [{ category: 'model', type: 'select', currentValue: u.model_id }])
    const turn = st.turn
    if (!turn) return
    const usage = this.usageOf(turn)
    if (u.sessionUpdate === 'turn_completed') {
      usage.total = u.usage
      usage.stop = u.stop_reason
    }
    if (u.sessionUpdate !== 'response_completed' || !u.usage) return
    const id = String(u.request_id ?? u.response_id ?? u.signature ?? p._meta?.eventId ?? usage.seen.size)
    if (usage.seen.has(id)) return
    usage.seen.add(id)
    const cached = count(u.usage.cache_read_input_tokens)
    st.session.push({ type: 'usage', requestId: `${turn.id}:${createHash('sha256').update(id).digest('hex')}`, inputTokens: count(u.usage.input_tokens) + cached + count(u.usage.cache_creation_input_tokens), outputTokens: count(u.usage.output_tokens), cachedInputTokens: cached })
  }

  protected onUpdate(p: Json) {
    if (p.update?.sessionUpdate === 'usage_update') return
    const u = p.update
    const meta = u?._meta?.['x.ai/tool']
    if (u && meta) p = { ...p, update: { ...u, name: u.name ?? meta.name, kind: u.kind ?? (meta.kind === 'write' ? 'edit' : meta.kind) } }
    super.onUpdate(p)
  }

  private usageOf(turn: AcpTurn): Usage {
    let usage = this.usage.get(turn)
    if (!usage) this.usage.set(turn, usage = { seen: new Set() })
    return usage
  }

  protected endUsage(st: AcpState, turn: AcpTurn, r: Json) {
    const usage = this.usageOf(turn)
    const total = r._meta?.usage ?? usage.total
    if (usage.seen.size || !total) return
    st.session.push({ type: 'usage', requestId: `${turn.id}:total`, inputTokens: count(total.inputTokens), outputTokens: count(total.outputTokens), cachedInputTokens: count(total.cachedReadTokens),
      billing: { inputTokens: count(total.inputTokens), outputTokens: count(total.outputTokens), cachedInputTokens: count(total.cachedReadTokens), requests: count(total.modelCalls) || 1 } })
  }

  protected endTurn(st: AcpState, turn: AcpTurn, r: Json, error: string | null) {
    if (st.turn !== turn) return
    if (r._meta?.modelId) this.checkModel(st, [{ category: 'model', type: 'select', currentValue: r._meta.modelId }])
    this.dropPending(st.session)
    const stop = r.stopReason ?? this.usageOf(turn).stop
    if (grokEndReason(stop, error) === 'auth' && !error?.includes('grok login')) error = `Grok Build could not authenticate. Run grok login in a terminal, then try again. ${error ?? ''}`.trim()
    super.endTurn(st, turn, { ...r, stopReason: stop }, error)
  }

  protected onRequest(msg: Json) {
    if (msg.method !== '_x.ai/ask_user_question') return super.onRequest(msg)
    const st = this.byAcpId.get(msg.params?.sessionId)
    const input = msg.params?.questions
    if (!st?.turn || st.turn.cancelled || !st.canAsk || !Array.isArray(input) || !input.length) return this.reply(msg.id, { outcome: 'skip_interview' })
    const questions: Question[] = input.map((q: Json, i: number) => ({ id: `q${i}`, header: q.header ?? `Question ${i + 1}`, question: String(q.question ?? ''), options: (q.options ?? []).map((o: Json) => ({ label: String(o.label), description: String(o.description ?? '') })), allowOther: true, secret: false }))
    const questionId = randomUUID()
    this.questions.set(questionId, { session: st.session, rpcId: msg.id, questions })
    st.session.push({ type: 'question_asked', questionId, questions })
  }

  async bridge(token: string, payload: Json): Promise<Json> {
    if (token !== this.token) return deny('Unknown BitFrost process.')
    const st = this.byAcpId.get(payload?.sessionId)
    if (!st?.turn || st.dead || st.turn.cancelled) return deny('This BitFrost task is stopped or unknown.')
    if (payload.hookEventName !== 'pre_tool_use' || payload.toolInputTruncated) return deny('BitFrost could not verify the complete tool call.')
    const name = String(payload.toolName ?? '')
    const tool = normalize(name)
    const input = objectOf(payload.toolInput)
    if (READ_TOOLS.has(tool)) return allow()
    if (/agent|workflow|schedul|cron|loop|goal|task/.test(tool)) return deny(`BitFrost subagents cannot use ${name}: nested subagents and scheduled runs are disabled.`)
    if (tool === 'askuserquestion') return st.canAsk ? allow() : deny('This BitFrost task cannot ask questions.')
    const file = input.file_path ?? input.path ?? input.filePath
    const cwd = typeof payload.cwd === 'string' ? path.resolve(st.cwd, payload.cwd) : st.cwd
    if (FILE_TOOLS.has(tool) && typeof file === 'string' && inside(path.resolve(cwd, file), st.cwd) && (!input.edits || Array.isArray(input.edits) && input.edits.every((e: Json) => !e.file_path && !e.path && !e.filePath))) return allow()
    const command = input.command ?? input.cmd
    const kind = tool === 'runterminalcommand' || tool === 'bash' ? 'execute' : FILE_TOOLS.has(tool) ? 'edit' : tool === 'webfetch' ? 'fetch' : 'other'
    if (kind === 'execute' && typeof command === 'string' && grokReadOnlyCommand(command)) return allow()
    if (!st.canAsk) return deny('This BitFrost task runs without asking, so actions that need approval are refused.')
    const t = { ...blankTool(), kind, name, title: name, rawInput: canonical({ ...input, ...(typeof file === 'string' ? { file_path: path.resolve(cwd, file) } : {}) }) }
    const grantKey = kind === 'execute' ? `${grantKeyOf(t)}\0${cwd}` : grantKeyOf(t)
    if (st.grants.has(grantKey)) return allow()
    const approvalId = randomUUID()
    const action = describeAction(t, cwd)
    return new Promise((resolve) => {
      this.hooks.set(approvalId, { session: st.session, resolve, grantKey })
      st.session.push({ type: 'approval_requested', approvalId, itemId: payload.toolUseId ?? null, ...action, title: action.title.replaceAll('`', '') })
    })
  }

  pendingApprovals(session: Session): string[] { return [...super.pendingApprovals(session), ...[...this.hooks].filter(([, p]) => p.session === session).map(([id]) => id)] }

  resolveApproval(session: Session, id: string, decision: Decision, reason?: string): boolean {
    const p = this.hooks.get(id)
    if (!p) return super.resolveApproval(session, id, decision, reason)
    if (p.session !== session) return false
    this.hooks.delete(id)
    if (decision === 'allow_session') this.stateOf(session)?.grants.add(p.grantKey)
    p.resolve(decision === 'deny' ? deny(reason || 'The user denied permission.') : allow())
    session.push({ type: 'approval_resolved', approvalId: id, decision })
    return true
  }

  pendingQuestions(session: Session): string[] { return [...super.pendingQuestions(session), ...[...this.questions].filter(([, p]) => p.session === session).map(([id]) => id)] }

  async answerQuestion(session: Session, id: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean> {
    const p = this.questions.get(id)
    if (!p) return super.answerQuestion(session, id, answers, defer)
    if (p.session !== session) return false
    this.questions.delete(id)
    const given = Object.fromEntries(p.questions.map((q) => [q.question, answers?.[q.id]?.length ? answers[q.id] : ['No answer from the user; use your best judgment.']]))
    this.reply(p.rpcId, defer ? { outcome: 'skip_interview' } : { outcome: 'accepted', answers: given })
    session.push({ type: 'question_answered', questionId: id, how: defer ? 'deferred' : 'answered' })
    if (defer) void session.stop(this, 'host', { preserveQueue: true }).catch(() => {})
    return true
  }

  protected dropPending(session: Session) {
    for (const [id, p] of this.hooks) if (p.session === session) this.resolveApproval(session, id, 'deny', 'The task was stopped.')
    for (const [id, p] of this.questions) if (p.session === session) {
      this.questions.delete(id)
      this.reply(p.rpcId, { outcome: 'skip_interview' })
    }
    super.dropPending(session)
  }

  protected onExit(proc: ChildProcess, why: string) {
    if (this.proc === proc) for (const st of this.states.values()) this.dropPending(st.session)
    super.onExit(proc, why)
  }

  dispose() {
    for (const st of this.states.values()) this.dropPending(st.session)
    super.dispose()
  }
}

function binary(env: ProviderEnv): string | null {
  const bin = process.env.BITFROST_GROK_BIN ?? env.config.bin ?? env.resolveBinary('grok') ?? path.join(os.homedir(), '.grok', 'bin', 'grok')
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return fs.realpathSync(bin)
  } catch { return null }
}

export const grokProvider: ProviderFactory = {
  id: 'grok', displayName: 'Grok Build', vendor: 'xAI', optIn: true, firstClass: true,
  detect: binary,
  create(env) {
    const bin = binary(env)
    if (!bin) return null
    const token = randomUUID()
    const dir = path.join(env.runDir, 'grok-plugin')
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true, mode: 0o700 })
    // A process plugin leaves the user's Grok and Claude settings alone.
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exec "$BITFROST_NODE" "$BITFROST_GROK_HOOK"', timeout: 7 * 24 * 3600 }] }] } }), { mode: 0o600 })
    const hook = fileURLToPath(new URL('./grok-hook.mjs', import.meta.url))
    return new GrokProvider({ bin, args: ['agent', '--no-leader', '--plugin-dir', dir, 'stdio'], env: { GROK_DISABLE_AUTOUPDATER: '1', BITFROST_NODE: process.execPath, BITFROST_GROK_HOOK: hook, BITFROST_SOCKET: env.socket, BITFROST_GROK_TOKEN: token } },
      { log: env.log, record: env.recorder('grok'), token, watch: [bin, path.join(os.homedir(), '.grok', 'bin')], relocate: () => binary(env) })
  },
}
