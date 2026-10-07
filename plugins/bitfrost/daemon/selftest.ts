// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Test real provider apps with a tiny task; print events and a pass or fail verdict.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_DIR, loadConfig, providerEnv, type Config } from './config.ts'
import { buildAgents, selectModels, type AgentDef } from './registry.ts'
import type { Provider, ProviderFactory } from './provider.ts'
import { PROVIDERS } from './providers/index.ts'
import { Session } from './session.ts'
import type { AgentEvent } from './events.ts'

const PROMPT = 'Run `ls` in this folder with a shell command, then reply with just the number of files.'
const TIMEOUT_MS = 180_000
// Reject input usage large enough to suggest a sum over multiple model requests.
const MAX_INPUT_TOKENS = 2_000_000

const short = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 120 ? `${one.slice(0, 117)}…` : one
}

function summary(ev: AgentEvent): string {
  switch (ev.type) {
    case 'turn_started': return `turn ${ev.turnId}`
    case 'text': return short(ev.text)
    case 'reasoning': return short(ev.text)
    case 'command_started': return `${short(ev.command)} (${short(ev.summary)})`
    case 'command_completed': return `${short(ev.command)} exit ${ev.exitCode ?? '?'}: ${short(ev.output)}`
    case 'file_change': return `${ev.changes.length} change(s) ${ev.status}: ${ev.changes.map((c) => path.basename(c.path)).join(', ')}`
    case 'tool': return `${ev.name} ${ev.status}: ${short(ev.output)}`
    case 'tool_started': return `${ev.name} ${short(JSON.stringify(ev.input))}`
    case 'tool_completed': return `${ev.name} ${ev.ok ? 'ok' : 'failed'}: ${short(ev.output)}`
    case 'plan': return short(ev.entries.map((e) => `${e.content} (${e.status})`).join(' / '))
    case 'usage': return `in ${ev.inputTokens}, out ${ev.outputTokens}, cached ${ev.cachedInputTokens}`
    case 'turn_completed': return `${ev.status}: ${short(ev.error ?? ev.finalText)}`
    case 'session_failed': return short(ev.error)
    case 'approval_requested': return `${ev.title} (${ev.kind})`
    case 'approval_resolved': return ev.decision
    case 'auto_reviewed': return `${ev.action} -> ${ev.decision}`
    case 'question_asked': return short(ev.questions.map((q) => q.question).join(' / '))
    case 'question_answered': return ev.how
  }
}

// Allow only ls with plain arguments; reject shell operators and extra commands.
function isPlainLs(ev: AgentEvent): boolean {
  if (ev.type !== 'approval_requested' || ev.tool !== 'Bash') return false
  const command = (ev.input as { command?: unknown } | undefined)?.command
  return typeof command === 'string' && (command === 'ls' || command.startsWith('ls ')) && !/[;&|><`\n\r]|\$\(/.test(command)
}

const CHEAP = /flash|mini|lite|luna/i

function pickAgent(agents: AgentDef[], agentName?: string): AgentDef | undefined {
  if (agentName) return agents.find((a) => a.name === agentName || a.model === agentName || a.aliases.includes(agentName))
  return agents.find((a) => CHEAP.test(a.model) || CHEAP.test(a.displayName)) ?? agents.find((a) => a.isDefault) ?? agents[0]
}

function checkedConfig(): Config {
  const config = loadConfig()
  for (const w of config.warnings) console.error(`warning: ${w}`)
  if (config.error) {
    console.error(`FAIL ${config.error}`)
    process.exit(1)
  }
  return config
}

type Result = { code: 0 | 1 | 2; why: string }

export async function selftest(providerId: string | undefined, agentName?: string): Promise<void> {
  const factory = PROVIDERS.find((f) => f.id === providerId)
  if (!factory) {
    console.error(`bitfrostd selftest: no provider ${providerId ?? ''}; have ${PROVIDERS.map((f) => f.id).join(', ')}`)
    process.exit(2)
  }
  const config = checkedConfig()
  if (!(config.providers[factory.id]?.enabled ?? !factory.optIn)) console.log(`${factory.id} is off in config.json; testing it anyway`)
  const r = await runOne(factory, config, agentName)
  finish(r ? r.code : 1)
}

export async function selftestAll(): Promise<void> {
  const config = checkedConfig()
  const results: [string, Result | null][] = []
  for (const f of PROVIDERS) {
    const entry = config.providers[f.id] ?? {}
    if (!(entry.enabled ?? !f.optIn)) continue
    console.log(`==== ${f.id}`)
    const r = await runOne(f, config, undefined, entry.enabled !== true)
    results.push([f.id, r])
    console.log()
  }
  console.log('summary:')
  if (!results.length) console.log('  no provider is on')
  for (const [id, r] of results) console.log(`  ${!r ? 'SKIP' : r.code === 0 ? 'PASS' : 'FAIL'}  ${id}${r?.why ? ` (${r.why})` : !r ? ' (not installed)' : ''}`)
  finish(results.some(([, r]) => r && r.code !== 0) ? 1 : 0)
}

// Exit after cleanup even if an app leaves a handle open.
function finish(code: number) {
  process.exitCode = code
  setTimeout(() => process.exit(code), 2000).unref()
}

async function runOne(factory: ProviderFactory, config: Config, agentName?: string, skipMissing = false): Promise<Result | null> {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  // Use a separate bridge socket so a running daemon keeps its own.
  const socket = path.join(RUN_DIR, 'bitfrost-selftest.sock')
  let made: Provider | null
  try {
    made = factory.create({ ...providerEnv(config, factory.id), socket })
  } catch (e) {
    console.error(`FAIL ${factory.id}: ${(e as Error).message}`)
    return { code: 1, why: (e as Error).message }
  }
  if (!made) {
    if (skipMissing) {
      console.log(`${factory.id}: its app is not installed; skipped`)
      return null
    }
    console.error(`FAIL ${factory.id}: its app is not installed`)
    return { code: 1, why: 'its app is not installed' }
  }
  const provider = made

  const bridge = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      const reply = await provider.bridge?.(String(req.headers['x-bitfrost-token'] ?? ''), JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(reply ? JSON.stringify(reply) : '')
    } catch (e) {
      res.writeHead(500).end(`${(e as Error).message}\n`)
    }
  })
  fs.rmSync(socket, { force: true })
  await new Promise<void>((resolve) => bridge.listen(socket, resolve))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-selftest-'))
  fs.writeFileSync(path.join(dir, 'note.txt'), 'selftest file one\n')
  fs.writeFileSync(path.join(dir, 'plan.txt'), 'selftest file two\n')

  let allowed = 0
  let denied = 0
  try {
    const models = (await provider.listModels()).map((m) => ({ ...m, harness: provider.id, harnessName: provider.displayName }))
    const ownVendors = provider.vendor ? new Map([[provider.id, provider.vendor]]) : new Map<string, string>()
    const allow = new Map<string, string[]>()
    const listed = config.providers[provider.id]?.models
    if (Array.isArray(listed)) allow.set(provider.id, listed)
    // Treat an explicit model choice as the required model list for a multi-company app.
    else if (agentName && !provider.vendor) allow.set(provider.id, [agentName])
    const agents = buildAgents(selectModels(models, ownVendors, allow))
    const agent = pickAgent(agents, agentName)
    if (!agent) {
      if (agentName) {
        console.error(`bitfrostd selftest: ${provider.displayName} has no agent ${agentName}; have ${agents.map((a) => a.name).join(', ')}`)
        return { code: 2, why: `no agent ${agentName}` }
      }
      console.error(`FAIL ${provider.displayName} offers no models`)
      return { code: 1, why: 'it offers no models' }
    }
    const effort = agent.efforts[0]
    console.log(`selftest ${provider.id} (${provider.location})`)
    console.log(`agent ${agent.name} = ${agent.displayName}, effort ${effort ?? '-'}, in ${dir}`)

    const session = new Session({ id: '', harness: provider.id, agent: agent.name, model: agent.model, cwd: dir, state: 'idle' })
    await provider.spawnSession(session, { model: agent.model, cwd: dir, prompt: PROMPT, effort, canAskUser: true, ephemeral: true })

    let after = 0
    let deadline = Date.now() + TIMEOUT_MS
    let gaveUp = false
    const ended = () => session.events.some((e) => e.type === 'turn_completed' || e.type === 'session_failed')
    while (!ended()) {
      const batch = await session.eventsAfter(after, 500)
      after += batch.length
      for (const ev of batch) {
        console.log(`${String(ev.seq).padStart(3)} ${ev.type.padEnd(18)} ${summary(ev)}`)
        if (ev.type === 'approval_requested') {
          const ok = isPlainLs(ev)
          provider.resolveApproval(session, ev.approvalId, ok ? 'allow' : 'deny', ok ? undefined : 'selftest only allows ls')
          ok ? allowed++ : denied++
        } else if (ev.type === 'question_asked') {
          await provider.answerQuestion(session, ev.questionId, null, false)
        }
      }
      if (Date.now() > deadline) {
        if (gaveUp) break
        gaveUp = true
        console.log(`no result after ${TIMEOUT_MS / 1000} s; interrupting the turn`)
        await provider.interrupt(session)
        deadline = Date.now() + 10_000
      }
    }

    const done = session.events.filter((e) => e.type === 'turn_completed').pop() as Extract<AgentEvent, { type: 'turn_completed' }> | undefined
    const usage = session.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[]
    const wrongModel = session.events.filter((e) => e.type === 'turn_completed' && /instead of/.test(e.error ?? '')) as Extract<AgentEvent, { type: 'turn_completed' }>[]
    const finalText = done?.finalText ?? ''
    const checks: [string, boolean, string][] = [
      ['the turn completed', done?.status === 'completed', done ? `status ${done.status}` : 'no turn_completed event'],
      [
        'usage reported, each request over 0 and under 2M input tokens',
        usage.length > 0 && usage.every((e) => e.inputTokens > 0 && e.inputTokens < MAX_INPUT_TOKENS),
        usage.length ? usage.map((e) => e.inputTokens).join(', ') : 'no usage event',
      ],
      ['no wrong-model error', wrongModel.length === 0, short(wrongModel.map((e) => e.error ?? '').join('; '))],
      ['the final reply contains a number', /\d/.test(finalText), `"${short(finalText)}"`],
    ]

    console.log()
    console.log('verdict:')
    let ok = true
    for (const [name, pass, detail] of checks) {
      ok &&= pass
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
    }
    if (allowed + denied > 0) console.log(`  PASS  approvals: ${allowed} allowed, ${denied} denied`)
    else console.log('  NOTE  no approval was requested, so the permission path was not exercised')
    if (ok) return { code: 0, why: agent.name }
    const [failed] = checks.find(([, pass]) => !pass)!
    return { code: 1, why: `${agent.name}: ${failed} failed${done?.error ? `; ${short(done.error)}` : ''}` }
  } catch (e) {
    console.error(`FAIL ${provider.id}: ${(e as Error).message}`)
    return { code: 1, why: (e as Error).message }
  } finally {
    provider.dispose?.()
    // Close unfinished hook connections so they cannot hold the socket open.
    bridge.close()
    bridge.closeAllConnections?.()
    fs.rmSync(socket, { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
