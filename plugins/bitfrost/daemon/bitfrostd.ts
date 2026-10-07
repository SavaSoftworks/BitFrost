// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrostd commands: see HELP at the bottom. serve and ensure are for the plugin, not people.
// HTTP API over the Unix socket, with JSON bodies:
// GET /health: helper health and config errors.
// GET /status: providers, leases and sessions.
// POST /shutdown: exit when no agent runs.
// POST /leases: create a lease for an allowed profile.
// POST /leases/:id: renew a lease.
// DELETE /leases/:id: release a lease and stop its agents.
// GET /agents?refresh=1: discover models as subagent definitions.
// POST /sessions: start an agent with a valid lease.
// GET /sessions: list sessions.
// GET /sessions/:id: session state and event count.
// DELETE /sessions/:id: stop and release a session.
// POST /sessions/:id/input: send text.
// POST /sessions/:id/interrupt: stop the turn.
// POST /sessions/:id/auto: switch to auto review.
// GET /sessions/:id/events?after=N&waitMs=M: wait for new events.
// GET /sessions/:id/items/:itemId?waitMs=M: wait for an item to finish.
// GET /sessions/:id/approvals: pending permission requests.
// POST /sessions/:id/approvals/:approvalId: allow, allow_session or deny.
// GET /sessions/:id/questions: pending agent questions.
// POST /sessions/:id/questions/:questionId: answer or defer a question.
// POST /providers/:id/bridge: app hook call with x-bitfrost-token.
// POST /zcode/hook: ZCode bridge call.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Session } from './session.ts'
import { buildAgents, describe, nameTable, selectModels, type AgentDef, type HarnessModel } from './registry.ts'
import { CACHE, CONFIG, LOCK, LOG, RUN_DIR, SOCKET, VERSION, canonical, configKey, loadConfig, log, providerEnv, takeLock, type Config } from './config.ts'
import { LEASE_TTL_MS, SessionTable } from './leases.ts'
import type { Provider, ProviderFactory } from './provider.ts'
import { PROVIDERS } from './providers/index.ts'
import { selftest, selftestAll } from './selftest.ts'
import { update } from './update.ts'
import { uninstall } from './uninstall.ts'

const MAX_WAIT_MS = 30_000
const GRACE_MS = 45_000 // Wait after the last lease ends.
const REGISTRY_TTL_MS = 10 * 60_000
// Stop agents after 90 seconds without host polling, even during permission requests.
const ABANDONED_MS = 90_000
const DISCOVER_WAIT_MS = 15_000
const MAX_BODY_BYTES = 16 * 1024 * 1024

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function appStamp(p: Provider): string {
  return (p.watch ?? [p.location])
    .map((file) => {
      try {
        const real = fs.realpathSync(file)
        const st = fs.statSync(real)
        return `${real}:${st.size}:${st.mtimeMs}`
      } catch {
        return `${file}:missing`
      }
    })
    .join('|')
}

function call(method: string, urlPath: string, timeout = 1000): Promise<{ status: number; body: any } | null> {
  return new Promise((resolve) => {
    // Avoid pooled connections to a helper that may have exited.
    const req = http.request({ socketPath: SOCKET, path: urlPath, method, timeout, agent: false }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        let body: any = null
        try {
          body = JSON.parse(data)
        } catch {}
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => (req.destroy(), resolve(null)))
    req.end()
  })
}
const get = async (urlPath: string, timeout = 1000) => {
  const r = await call('GET', urlPath, timeout)
  return r?.status === 200 ? r.body : null
}
const health = () => get('/health')

async function ensure() {
  if (await health()) return
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const out = fs.openSync(LOG, 'a')
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await health()) return
  }
  console.error(`bitfrostd did not come up; see ${LOG}`)
  process.exit(1)
}

function serve() {
  // Child apps inherit this flag to prevent nested bitfrost agents.
  process.env.BITFROST_INSIDE = '1'
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  if (!takeLock()) {
    log(`another bitfrostd is running; pid ${process.pid} exits`)
    process.exit(0)
  }
  process.on('exit', () => {
    try {
      if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK)
    } catch {}
  })

  // Keep the last valid config while edits are invalid; refuse new leases.
  let lastGood: Config | null = null
  let lastProblems = ''
  const readConfig = (): Config => {
    const c = loadConfig()
    const problems = [c.error, ...c.warnings].filter(Boolean).join('\n')
    if (problems !== lastProblems) {
      if (c.error) log(`config: ${c.error}`)
      for (const w of c.warnings) log(`config: ${w}`)
      if (!problems) log(`config: ${CONFIG} is fine again`)
      lastProblems = problems
    }
    if (!c.error) return (lastGood = c)
    return { ...(lastGood ?? c), error: c.error, warnings: c.warnings }
  }

  const providers = new Map<string, Provider>()
  const providerConfigs = new Map<string, string>()
  const providerStamps = new Map<string, string>()
  const providerFor = (s: Session) => providers.get(s.info.harness)
  const table = new SessionTable(providerFor, log)
  const busy = (id: string) => table.running().some((s) => s.info.harness === id)
  const updated = (p: Provider) => providerStamps.get(p.id) !== appStamp(p) || !!p.moved?.()

  // Apply provider changes once their running tasks finish.
  let deferred = false
  const syncProviders = () => {
    const config = readConfig()
    deferred = false
    for (const f of PROVIDERS) {
      const entry = config.providers[f.id] ?? {}
      const enabled = entry.enabled ?? !f.optIn
      const current = providers.get(f.id)
      const reconfigured = current && providerConfigs.get(f.id) !== JSON.stringify(entry)
      if (current && (!enabled || reconfigured || updated(current))) {
        if (busy(f.id)) deferred = true
        else {
          current.dispose?.()
          providers.delete(f.id)
          log(`provider ${f.id}: ${!enabled ? 'turned off' : reconfigured ? 'config changed; restarting it' : 'its app changed on disk; restarting it'}`)
        }
      }
      if (!enabled || providers.has(f.id)) continue
      try {
        const p = f.create(providerEnv(config, f.id))
        if (!p) continue
        providers.set(p.id, p)
        providerConfigs.set(p.id, JSON.stringify(entry))
        providerStamps.set(p.id, appStamp(p))
        log(`provider ${p.id}: ${p.location}`)
      } catch (e) {
        log(`provider ${f.id}: ${(e as Error).message}`)
      }
    }
    return config
  }
  syncProviders()
  let noLeasesSince: number | null = Date.now()
  const leasesChanged = () => {
    if (table.leases.size) noLeasesSince = null
    else noLeasesSince ??= Date.now()
  }


  let registry: { agents: AgentDef[]; at: number; configKey?: string; hint?: string } | null = null
  try {
    registry = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  } catch {}
  let discovering: Promise<void> | null = null
  // Cache each app's models so slow listings do not block the others.
  const lastModels = new Map<string, HarnessModel[]>()
  const listing = new Map<string, Promise<void>>()
  const listProvider = (p: Provider) => {
    const inFlight = listing.get(p.id)
    if (inFlight) return inFlight
    const job = p
      .listModels()
      .then((models) => {
        lastModels.set(p.id, models.map((m) => ({ ...m, harness: p.id, harnessName: p.displayName })))
      })
      .catch((e) => log(`discovery: ${p.id} failed: ${(e as Error).message}`))
      .finally(() => listing.delete(p.id))
    listing.set(p.id, job)
    return job
  }
  const discover = () =>
    (discovering ??= (async () => {
      const config = syncProviders()
      const late = [...providers.values()].map((p) => {
        const job = listProvider(p)
        return Promise.race([job.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), DISCOVER_WAIT_MS))]).then((slow) => {
          // Rebuild the list when the slow app answers.
          if (slow) void job.then(() => discover())
        })
      })
      await Promise.all(late)
      const found = [...providers.values()].flatMap((p) => lastModels.get(p.id) ?? [])
      const ownVendors = new Map([...providers.values()].filter((p) => p.vendor).map((p) => [p.id, p.vendor!]))
      const allow = new Map(Object.entries(config.providers).filter(([, c]) => Array.isArray(c?.models)).map(([id, c]) => [id, c.models as string[]]))
      const unlisted: string[] = []
      for (const p of providers.values()) {
        if (p.vendor || allow.has(p.id)) continue
        const n = found.filter((m) => m.harness === p.id).length
        log(`discovery: ${p.id} offers ${n} models from many companies; none are used until config.json lists the wanted ones in providers.${p.id}.models`)
        unlisted.push(`${p.displayName} offers ${n} models; list the ones you want in providers.${p.id}.models.`)
      }
      const agents = buildAgents(selectModels(found, ownVendors, allow))
      const hint = agents.length
        ? undefined
        : !providers.size
          ? `No app found: install and sign in to Codex or ZCode, or turn on opencode, Oh My Pi or Gemini CLI in ${CONFIG}.`
          : unlisted.length
            ? `${unlisted.join(' ')} (in ${CONFIG})`
            : `None of the models from ${[...providers.values()].map((p) => p.displayName).join(', ')} can be offered; check providers.<app>.models in ${CONFIG} and the log at ${LOG}.`
      // Leave the list stale so deferred provider changes are checked again.
      registry = { agents, at: Date.now(), configKey: deferred ? undefined : configKey(config), hint }
      fs.mkdirSync(path.dirname(CACHE), { recursive: true })
      fs.writeFileSync(CACHE, JSON.stringify(registry))
      log(`discovery: ${registry.agents.map((a) => a.name).join(', ')}`)
    })().finally(() => (discovering = null)))


  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      const tooBig = () => new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`)
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        req.resume()
        return reject(tooBig())
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size <= MAX_BODY_BYTES) chunks.push(c)
      })
      req.on('error', reject)
      req.on('end', () => {
        if (size > MAX_BODY_BYTES) return reject(tooBig())
        const data = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (e) {
          reject(new HttpError(400, `request body is not JSON: ${(e as Error).message}`))
        }
      })
    })

  const status = () => {
    const now = Date.now()
    const config = readConfig()
    return {
      version: VERSION,
      pid: process.pid,
      socket: SOCKET,
      config: CONFIG,
      configError: config.error,
      providers: [...providers.values()].map((p) => ({ id: p.id, location: p.location, models: registry?.agents.filter((a) => a.harness === p.id).length ?? 0 })),
      registryAt: registry?.at ?? null,
      leases: [...table.leases].map(([id, l]) => ({ id, host: l.host, profile: l.profile, expiresInMs: Math.max(0, l.expires - now) })),
      sessions: table.summaries(),
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bitfrost')
    const parts = url.pathname.split('/').filter(Boolean)
    const waitMs = Math.min(Number(url.searchParams.get('waitMs') ?? 0) || 0, MAX_WAIT_MS)
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return json(res, 200, { ok: true, pid: process.pid, version: VERSION, busy: table.running().length > 0, configError: readConfig().error })
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, status())
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (table.running().length) return json(res, 409, { error: 'agents are running' })
        json(res, 200, { ok: true })
        log('shutdown requested')
        return setTimeout(() => process.exit(0), 50)
      }

      if (parts[0] === 'leases') {
        if (req.method === 'POST' && !parts[1]) {
          const body = await readBody(req)
          const config = readConfig()
          if (config.error) return json(res, 503, { error: config.error })
          const profile = canonical(String(body.profile ?? ''))
          if (!config.allowedProfiles.includes(profile)) {
            log(`lease refused for profile ${profile}`)
            return json(res, 403, { error: `profile ${profile} is not allowed to use bitfrost` })
          }
          const id = randomUUID()
          log(`lease ${id} for ${body.host} session ${body.hostSessionId}`)
          table.addLease(id, { host: body.host, profile, hostSessionId: body.hostSessionId })
          leasesChanged()
          return json(res, 200, { leaseId: id, ttlMs: LEASE_TTL_MS })
        }
        if (!parts[1] || !table.leases.has(parts[1])) return json(res, 404, { error: 'no such lease' })
        if (req.method === 'POST') {
          table.renew(parts[1])
          return json(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          table.release(parts[1])
          leasesChanged()
          return json(res, 200, { ok: true })
        }
      }

      const bridgeId = parts[0] === 'providers' && parts[2] === 'bridge' ? parts[1] : url.pathname === '/zcode/hook' ? 'zcode' : null
      if (req.method === 'POST' && bridgeId) {
        const body = await readBody(req)
        const token = String(req.headers['x-bitfrost-token'] ?? '')
        const p = providers.get(bridgeId)
        const reply = p?.bridge ? await p.bridge(token, body) : null
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(reply ? JSON.stringify(reply) : '')
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        const config = readConfig()
        const stale =
          !registry ||
          Date.now() - registry.at > REGISTRY_TTL_MS ||
          registry.configKey !== configKey(config) ||
          url.searchParams.get('refresh') === '1'
        if (stale) await Promise.race([discover(), new Promise((r) => setTimeout(r, registry ? 8000 : 30_000))])
        const agents = registry?.agents ?? []
        return json(res, 200, { agents: agents.map((a) => ({ ...a, description: describe(a, agents) })), nameTable: nameTable(agents), at: registry?.at ?? 0, hint: registry?.hint ?? null })
      }

      if (req.method === 'GET' && url.pathname === '/sessions') return json(res, 200, { sessions: table.summaries() })

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readBody(req)
        if (!body.leaseId || !table.leases.has(body.leaseId)) return json(res, 403, { error: 'a valid lease is required' })
        const def = registry?.agents.find((a) => a.name === body.agent)
        if (!def) return json(res, 404, { error: `unknown agent ${body.agent}` })
        const effort = body.effort && def.efforts.includes(body.effort) ? body.effort : (def.defaultEffort ?? undefined)
        const provider = providers.get(def.harness)
        if (!provider) return json(res, 404, { error: `${def.harnessName} is not available` })
        const session = new Session({ id: '', harness: def.harness, agent: def.name, model: def.model, cwd: body.cwd, state: 'running' })
        const id = await provider.spawnSession(session, {
          model: def.model,
          cwd: body.cwd,
          prompt: body.prompt,
          effort,
          developerInstructions: body.developerInstructions,
          canAskUser: !!body.canAskUser,
          autoReview: !!body.autoReview,
          title: typeof body.title === 'string' ? body.title : undefined,
        })
        log(`session ${id} agent=${def.name} model=${def.model} effort=${effort ?? '-'} cwd=${body.cwd}`)
        table.add(session, body.leaseId)
        return json(res, 200, { id, model: def.model, effort: effort ?? null })
      }

      const session = parts[0] === 'sessions' && parts[1] ? table.sessions.get(parts[1]) : undefined
      if (!session) return json(res, 404, { error: 'no such session' })
      session.lastSeenAt = Date.now()
      const [, , action, itemId] = parts
      if (req.method === 'DELETE' && !action) {
        table.close(session.info.id, 'deleted')
        return json(res, 200, { ok: true })
      }
      const adapter = providerFor(session)
      if (!adapter) return json(res, 404, { error: `${session.info.harness} is not available` })
      if (req.method === 'GET' && !action) return json(res, 200, { ...session.info, events: session.events.length })
      if (req.method === 'POST' && action === 'input') {
        const { text } = await readBody(req)
        await adapter.sendInput(session, String(text ?? ''))
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && action === 'auto') {
        adapter.setAutoMode?.(session)
        log(`session ${session.info.id}: switched to auto mode`)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && action === 'interrupt') {
        await adapter.interrupt(session)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'GET' && action === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0
        return json(res, 200, { events: await session.eventsAfter(after, waitMs), state: session.info.state })
      }
      if (req.method === 'GET' && action === 'items' && itemId) return json(res, 200, { event: await session.itemCompletion(itemId, waitMs) })
      if (req.method === 'GET' && action === 'approvals') {
        const ids = new Set(adapter.pendingApprovals(session))
        return json(res, 200, { approvals: session.events.filter((e) => e.type === 'approval_requested' && ids.has(e.approvalId)) })
      }
      if (req.method === 'GET' && action === 'questions') {
        const ids = new Set(adapter.pendingQuestions(session))
        return json(res, 200, { questions: session.events.filter((e) => e.type === 'question_asked' && ids.has(e.questionId)) })
      }
      if (req.method === 'POST' && action === 'questions' && itemId) {
        const body = await readBody(req)
        if (!(await adapter.answerQuestion(session, itemId, body.answers ?? null, !!body.defer))) return json(res, 404, { error: 'no such pending question' })
        log(`session ${session.info.id}: question ${itemId} ${body.defer ? 'handed to the lead agent' : 'answered'}`)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && action === 'approvals' && itemId) {
        const { decision, reason, by } = await readBody(req)
        if (!['allow', 'allow_session', 'deny'].includes(decision)) return json(res, 400, { error: 'decision must be allow, allow_session or deny' })
        if (!adapter.resolveApproval(session, itemId, decision, typeof reason === 'string' ? reason : undefined)) return json(res, 404, { error: 'no such pending request' })
        log(`session ${session.info.id}: approval ${itemId} -> ${decision}${by ? ` (${by})` : ''}`)
        return json(res, 200, { ok: true })
      }
      return json(res, 404, { error: 'not found' })
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      log(`error ${req.method} ${url.pathname}: ${(e as Error).message}`)
      if (res.headersSent) return res.end()
      if (status === 413) res.setHeader('connection', 'close')
      return json(res, status, { error: (e as Error).message })
    }
  })

  try {
    fs.unlinkSync(SOCKET)
  } catch {}
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600)
    const found = [...providers.values()].map((p) => `${p.id}=${p.location}`).join(', ') || 'no providers found'
    log(`bitfrostd ${VERSION} listening on ${SOCKET} (pid ${process.pid}, ${found})`)
  })

  setInterval(() => {
    const now = Date.now()
    table.tick()
    leasesChanged()
    for (const s of table.running()) {
      if (now - s.lastSeenAt < ABANDONED_MS) continue
      log(`session ${s.info.id}: its subagent stopped asking about it; stopping it`)
      s.lastSeenAt = now // Limit interrupts to one per 90 seconds.
      providerFor(s)?.interrupt(s).catch(() => {})
    }
    if (!discovering && [...providers.values()].some((p) => !busy(p.id) && updated(p))) void discover()
    if (noLeasesSince !== null && now - noLeasesSince > GRACE_MS) {
      for (const s of table.running()) providerFor(s)?.interrupt(s).catch(() => {})
      log('no hosts; exiting')
      setTimeout(() => process.exit(0), 500)
    }
  }, 5000)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))
}

function setup(id: string | undefined) {
  const f = PROVIDERS.find((p: ProviderFactory) => p.id === id)
  if (!f?.setup) {
    console.error(`bitfrostd setup: providers with a setup step: ${PROVIDERS.filter((p) => p.setup).map((p) => p.id).join(', ')}`)
    process.exit(2)
  }
  const config = loadConfig()
  if (config.error) console.error(`warning: ${config.error}; going on with the defaults`)
  f.setup(providerEnv(config, f.id))
}

// Returns why the helper is still up, or null once it's gone.
async function stop(): Promise<string | null> {
  const r = await call('POST', '/shutdown', 3000)
  if (!r) return null
  if (r.status !== 200) return r.body?.error ?? `HTTP ${r.status}`
  for (let i = 0; i < 50 && (await health()); i++) await new Promise((res) => setTimeout(res, 100))
  return (await health()) ? 'it did not exit' : null
}

async function restart() {
  const wasUp = !!(await health())
  const why = await stop()
  if (why) {
    console.error(`bitfrostd restart: ${why}; try again once they finish (bitfrostd status)`)
    process.exit(1)
  }
  await ensure()
  const h = await health()
  console.log(`bitfrostd ${h.version} ${wasUp ? 'restarted' : 'started'}, pid ${h.pid}`)
}

async function printStatus() {
  const s = await get('/status', 3000)
  if (!s) {
    console.log(`bitfrostd is not running (no answer on ${SOCKET})`)
    process.exit(1)
  }
  const ago = (at: number | null) => (at ? `${Math.round((Date.now() - at) / 60_000)} min ago` : 'never')
  const rows = (items: string[][]) => {
    const widths = items[0]?.map((_, i) => Math.max(...items.map((r) => r[i].length))) ?? []
    return items.map((r) => `  ${r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]) : c)).join('  ')}`)
  }
  const lines = [
    `bitfrostd ${s.version}, pid ${s.pid}`,
    `socket   ${s.socket}`,
    `config   ${s.config}${s.configError ? `\n  INVALID: ${s.configError}` : ''}`,
    `models   listed ${ago(s.registryAt)}`,
    '',
    `providers (${s.providers.length})`,
    ...rows(s.providers.map((p: any) => [p.id, `${p.models} model${p.models === 1 ? '' : 's'}`, p.location])),
    '',
    `leases (${s.leases.length})`,
    ...rows(s.leases.map((l: any) => [l.id, l.host ?? '?', l.profile, `expires in ${Math.round(l.expiresInMs / 1000)} s`])),
    '',
    `sessions (${s.sessions.length})`,
    ...rows(s.sessions.map((x: any) => [x.id, `${x.agent} (${x.harness})`, x.state, x.leaseId ? `lease ${x.leaseId}` : 'waiting for its host to come back'])),
  ]
  console.log(lines.join('\n'))
}

const HELP = `BitFrost ${VERSION}: lets Claude hand work to models from other companies.

usage: bitfrost <command>

  status                    what the helper is doing: apps, models, subagents
  restart                   restart the helper, once no subagent is running
  update                    install the latest release, if it's newer
  uninstall [--yes]         remove BitFrost from Claude Code, ZCode and this machine
    [--keep-config]         with --yes, keep your config
  setup <app>               one-time setup for an app (${PROVIDERS.filter((p) => p.setup).map((p) => p.id).join(', ')})
  selftest <app> [model]    check that an app works with BitFrost
  selftest --all            check every app
  socket                    print the helper's socket path
  -v, --version             print the version
  -h, --help                show this

Guide: https://github.com/${process.env.BITFROST_REPO || 'SavaSoftworks/BitFrost'}/blob/main/GUIDE.md`

const mode = process.argv[2]
if (mode === undefined || mode === 'help' || mode === '--help' || mode === '-h') console.log(HELP)
else if (mode === 'version' || mode === '--version' || mode === '-v') console.log(VERSION)
else if (mode === 'setup') setup(process.argv[3])
else if (mode === 'zcode-setup') setup('zcode')
else if (mode === 'ensure') await ensure()
else if (mode === 'serve') serve()
else if (mode === 'socket') console.log(SOCKET)
else if (mode === 'status') await printStatus()
else if (mode === 'restart') await restart()
else if (mode === 'update') process.exit(await update())
else if (mode === 'uninstall') {
  const flags = process.argv.slice(3)
  process.exit(await uninstall({ stop, running: async () => !!(await health()) }, { yes: flags.includes('--yes') || flags.includes('-y'), keepConfig: flags.includes('--keep-config') }))
}
else if (mode === 'selftest' && process.argv[3] === '--all') await selftestAll()
else if (mode === 'selftest') await selftest(process.argv[3], process.argv[4])
else {
  console.error(`bitfrost: unknown command ${mode}\n\n${HELP}`)
  process.exit(2)
}
