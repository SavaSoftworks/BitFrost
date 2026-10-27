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
// POST /leases/:id: renew a lease; the reply carries agentsAt, when the /agents list was last built.
// DELETE /leases/:id: release a lease and stop its agents.
// GET /agents?refresh=1: discover models as subagent definitions.
// POST /sessions: start an agent with a valid lease.
// GET /sessions: list sessions.
// GET /sessions/:id: session state and event count.
// DELETE /sessions/:id: stop and release a session.
// POST /sessions/:id/input: send text.
// POST /sessions/:id/interrupt: stop and confirm the turn.
// POST /sessions/:id/attach: bind a saved session to a lease.
// GET /sessions/:id/summary: activity, tools, usage and inbox.
// GET /sessions/:id/messages: persisted turns and messages.
// GET /sessions/:id/messages/:itemId: message with full detail.
// POST /sessions/:id/auto: switch to auto review.
// GET /sessions/:id/events?after=N&waitMs=M: wait for new events.
// GET /sessions/:id/items/:itemId?waitMs=M: wait for an item to finish.
// GET /sessions/:id/approvals: pending permission requests.
// POST /sessions/:id/approvals/:approvalId: allow, allow_session or deny.
// GET /sessions/:id/questions: pending agent questions.
// POST /sessions/:id/questions/:questionId: answer or defer a question.
// GET /providers: every app BitFrost knows, whether it's installed and on.
// GET /providers/:id/models?refresh=1: every model an app lists, and whether each is offered.
// GET /stats/models?provider=ID&model=M&since=S: one model's hourly usage rows changed after S.
// GET /subagents?recent=N: subagents working now, then the newest others.
// GET /subagents/page?before=T:ID|after=T:ID|oldest=1&limit=N: a page of subagents, newest first.
// GET /subagents/changed?ids=A,B&since=S&top=T:ID: those changed after S, any that started working, and newer than top.
// POST /viewers/:id: keep the helper up for a config screen; DELETE /viewers/:id lets it go.
// POST /providers/:id/bridge: app hook call with x-bitfrost-token.
// POST /zcode/hook: ZCode bridge call.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { call, get, health, start } from './client.ts'
import { Store } from './store.ts'
import { killOwnedGroups, ownProcesses } from './process.ts'
import { Session } from './session.ts'
import { buildAgents, describe, nameTable, selectModels, whyNot, type AgentDef, type HarnessModel } from './registry.ts'
import { CACHE, CONFIG, DATA_DIR, DATA_LOCK, LOCK, LOG, RUN_DIR, SOCKET, VERSION, canonical, configKey, loadConfig, log, loginShellLookup, pathLookup, providerEnv, takeLock, type Config } from './config.ts'
import { LEASE_TTL_MS, SessionTable } from './leases.ts'
import type { Provider, ProviderFactory } from './provider.ts'
import { PROVIDERS } from './providers/index.ts'
import { selftest, selftestAll } from './selftest.ts'
import { update } from './update.ts'
import { uninstall } from './uninstall.ts'
import { migrateDatabase } from './migrate.ts'
import { FEATURES, findFeature } from './features.ts'
import { setupFeatures } from './settings.ts'

const MAX_WAIT_MS = 30_000
const GRACE_MS = 45_000 // Wait after the last lease ends.
const REGISTRY_TTL_MS = 10 * 60_000
// Stop agents after 90 seconds without host polling, even during permission requests.
const ABANDONED_MS = 90_000
const DISCOVER_WAIT_MS = 15_000
const MAX_BODY_BYTES = 16 * 1024 * 1024
const VIEWER_TTL_MS = 60_000 // A config screen keeps the helper up while it renews within this.
const DETECT_TTL_MS = 60_000
// How long a models request waits for a fast listing before answering pending.
const MODELS_WAIT_MS = 1500
const RECENT_SUBAGENTS = 10
const STARTED_AT = Date.now()

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

// Allow and deny lists by app, from providers.<id>.models and providers.<id>.disabled.
function lists(config: Config) {
  const pick = (key: string) => new Map(Object.entries(config.providers).filter(([, c]) => Array.isArray(c?.[key])).map(([id, c]) => [id, (c[key] as unknown[]).map(String)]))
  return { allow: pick('models'), deny: pick('disabled'), anthropic: pick('anthropic') }
}

const or = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`)

async function ensure() {
  if (await start()) return
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
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(DATA_DIR, 0o700)
  const locks = [LOCK]
  process.on('exit', () => {
    try {
      for (const lock of locks) if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock)
    } catch {}
  })

  if (!takeLock(DATA_LOCK)) { log(`another bitfrostd owns ${DATA_DIR}; pid ${process.pid} exits`); process.exit(0) }
  locks.push(DATA_LOCK)

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

  const store = new Store(path.join(DATA_DIR, 'bitfrost.db'), log, true)
  ownProcesses(path.join(DATA_DIR, 'bitfrost.db'))
  // Only a database error turns persistence off; other bugs are logged and the helper carries on.
  const lastResort = (kind: string, error: unknown) => {
    try { log(`${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`) } catch {}
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_SQLITE_ERROR') store.degrade(error)
  }
  process.on('uncaughtException', (error) => lastResort('uncaught exception', error))
  process.on('unhandledRejection', (error) => lastResort('unhandled rejection', error))
  const providers = new Map<string, Provider>()
  const providerConfigs = new Map<string, string>()
  const providerModels = new Map<string, string>()
  const providerStamps = new Map<string, string>()
  const providerFor = (s: Session) => providers.get(s.info.harness)
  const table = new SessionTable(providerFor, log)
  killOwnedGroups(store.processes().flatMap((r) => {
    try { return [JSON.parse(r.process_identity)] } catch (error) { store.degrade(error); return [] }
  }), log)
  const recovered = new Set<string>()
  // Keep the close time and reason of a session that was already closed.
  const closeRecovered = (session: Session) => {
    if (session.info.closedAt == null) {
      session.info.closedAt = Date.now()
      session.info.closeReason = 'daemon_restart'
    }
    session.detach()
    recovered.add(session.info.id)
  }
  for (const turn of store.unfinished()) {
    const session = table.load(turn.session_id, store)
    if (!session) continue
    session.activeTurnId = turn.id
    for (const input of store.pending(session.info.id)) session.push({ type: 'input_dropped', inputId: input.id })
    const text = session.events.findLast((e) => e.type === 'text' && e.seq >= turn.seq_start)
    session.push({ type: 'turn_completed', turnId: turn.id, status: 'interrupted', reason: 'daemon_restart', finalText: text?.type === 'text' ? text.text : '' })
    closeRecovered(session)
  }
  for (const row of store.db.prepare("SELECT DISTINCT session_id FROM inbox WHERE state='pending'").all()) {
    const session = table.load(String(row.session_id), store)
    if (!session) continue
    for (const input of store.pending(session.info.id)) session.push({ type: 'input_dropped', inputId: input.id })
    closeRecovered(session)
  }
  for (const row of store.openSessions()) {
    const session = table.load(row.id, store)
    if (session && !recovered.has(row.id)) closeRecovered(session)
  }
  store.forgetProcesses()
  store.retain(readConfig().retention)
  const retentionTimer = setInterval(() => { store.retain(readConfig().retention); table.retainCache(store) }, 24 * 60 * 60_000)
  retentionTimer.unref()

  const busy = (id: string) => table.running().some((s) => s.info.harness === id)
  const updated = (p: Provider) => providerStamps.get(p.id) !== appStamp(p) || !!p.moved?.()

  // Where each app is, found without starting it. PATH is checked first; the login
  // shell is asked without blocking, since running subagents share this loop.
  const detected = new Map<string, { at: number; key: string; location: string | null; binaries: Map<string, string | null> }>()
  const detecting = new Map<string, { key: string; job: Promise<string | null> }>()
  const detect = (f: ProviderFactory, config: Config, restarting = false): Promise<string | null> => {
    const running = providers.get(f.id)
    if (running && !restarting) return Promise.resolve(running.location)
    const key = JSON.stringify(config.providers[f.id] ?? {})
    const hit = detected.get(f.id)
    if (hit?.key === key && Date.now() - hit.at < DETECT_TTL_MS) return Promise.resolve(hit.location)
    const pending = detecting.get(f.id)
    if (pending?.key === key) return pending.job
    const job = (async () => {
      const asked = new Map<string, string | null>()
      const attempt = () => {
        const missed: string[] = []
        const resolveBinary = (name: string) => {
          if (asked.has(name)) return asked.get(name)!
          const found = pathLookup(name)
          if (!found) missed.push(name)
          else asked.set(name, found)
          return found
        }
        try { return { location: f.detect?.({ ...providerEnv(config, f.id), resolveBinary }) ?? null, missed } } catch (e) {
          log(`provider ${f.id}: ${(e as Error).message}`)
          return { location: null, missed: [] }
        }
      }
      let { location, missed } = attempt()
      if (!location && missed.length) {
        for (const name of missed) asked.set(name, await loginShellLookup(name))
        location = attempt().location
      }
      detected.set(f.id, { at: Date.now(), key, location, binaries: asked })
      return location
    })().finally(() => { if (detecting.get(f.id)?.job === job) detecting.delete(f.id) })
    detecting.set(f.id, { key, job })
    return job
  }
  // Apply provider changes once their running tasks finish.
  let deferred = false
  let syncing: Promise<Config> | null = null
  const syncProviders = () => syncing ??= (async () => {
    for (;;) {
      const config = readConfig()
      await Promise.all(PROVIDERS.filter((f) => {
        const { models, disabled, ...entry } = config.providers[f.id] ?? {}
        const current = providers.get(f.id)
        return (entry.enabled ?? !f.optIn) && (!current || providerConfigs.get(f.id) !== JSON.stringify(entry) || updated(current))
      }).map((f) => detect(f, config, true)))
      if (configKey(config) !== configKey(readConfig())) continue
      deferred = false
      for (const f of PROVIDERS) {
        const entry = config.providers[f.id] ?? {}
        const enabled = entry.enabled ?? !f.optIn
        const current = providers.get(f.id)
        // Model lists apply without restarting the app.
        const { models, disabled, ...rest } = entry
        const reconfigured = current && providerConfigs.get(f.id) !== JSON.stringify(rest)
        if (current && !reconfigured && providerModels.get(f.id) !== JSON.stringify(models ?? null)) {
          current.setModels?.(Array.isArray(models) ? models.map(String) : null)
          providerModels.set(f.id, JSON.stringify(models ?? null))
        }
        if (current && (!enabled || reconfigured || updated(current))) {
          if (busy(f.id)) deferred = true
          else {
            current.dispose?.()
            for (const session of table.sessions.values()) if (session.info.harness === f.id) { session.info.state = 'detached'; session.save() }
            providers.delete(f.id)
            log(`provider ${f.id}: ${!enabled ? 'turned off' : reconfigured ? 'config changed; restarting it' : 'its app changed on disk; restarting it'}`)
          }
        }
        if (!enabled || providers.has(f.id)) continue
        try {
          const p = f.create({ ...providerEnv(config, f.id), resolveBinary: (name) => detected.get(f.id)?.binaries.get(name) ?? pathLookup(name) })
          if (!p) continue
          providers.set(p.id, p)
          providerConfigs.set(p.id, JSON.stringify(rest))
          providerModels.set(p.id, JSON.stringify(models ?? null))
          providerStamps.set(p.id, appStamp(p))
          log(`provider ${p.id}: ${p.location}`)
        } catch (e) {
          log(`provider ${f.id}: ${(e as Error).message}`)
        }
      }
      return config
    }
  })().finally(() => { syncing = null })
  void syncProviders().catch((e) => log(`provider sync: ${e.message}`))
  let noLeasesSince: number | null = Date.now()
  const viewers = new Map<string, number>()
  const leasesChanged = () => {
    const now = Date.now()
    for (const [id, until] of viewers) if (until < now) viewers.delete(id)
    if (table.leases.size || viewers.size) noLeasesSince = null
    else noLeasesSince ??= Date.now()
  }


  let registry: { agents: AgentDef[]; at: number; configKey?: string; hint?: string } | null = null
  try {
    registry = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  } catch {}
  let discovering: Promise<void> | null = null
  // Cache each app's models so slow listings do not block the others.
  const lastModels = new Map<string, HarnessModel[]>()
  const lastModelsAt = new Map<string, number>()
  const lastErrors = new Map<string, string>()
  const listing = new Map<string, Promise<void>>()
  const listProvider = (p: Provider, force = false) => {
    const inFlight = listing.get(p.id)
    if (inFlight) return inFlight
    const job = p
      .listModels(force)
      .then((models) => {
        lastModels.set(p.id, models.map((m) => ({ ...m, harness: p.id, harnessName: p.displayName })))
        lastModelsAt.set(p.id, Date.now())
        lastErrors.delete(p.id)
      })
      .catch((e) => {
        log(`discovery: ${p.id} failed: ${(e as Error).message}`)
        lastErrors.set(p.id, (e as Error).message)
        // A refused app loses its models at once instead of keeping the last good list.
        if ((e as any).blocked) {
          lastModels.delete(p.id)
          lastModelsAt.delete(p.id)
        }
      })
      .finally(() => listing.delete(p.id))
    listing.set(p.id, job)
    return job
  }
  const discover = () =>
    (discovering ??= (async () => {
      const config = await syncProviders()
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
      const { allow, deny, anthropic } = lists(config)
      const unlisted: string[] = []
      for (const p of providers.values()) {
        if (p.vendor || allow.has(p.id)) continue
        const n = found.filter((m) => m.harness === p.id).length
        log(`discovery: ${p.id} offers ${n} models from many companies; none are used until config.json lists the wanted ones in providers.${p.id}.models`)
        unlisted.push(`${p.displayName} offers ${n} models; list the ones you want in providers.${p.id}.models.`)
      }
      const agents = buildAgents(selectModels(found, ownVendors, allow, deny, anthropic), ownVendors)
      const hint = agents.length
        ? undefined
        : !providers.size
          ? `No app found: install and sign in to Codex or ZCode, or turn on ${or(PROVIDERS.filter((f) => f.optIn).map((f) => f.displayName))} in ${CONFIG}.`
          : unlisted.length
            ? `${unlisted.join(' ')} (in ${CONFIG})`
            : `None of the models from ${[...providers.values()].map((p) => p.displayName).join(', ')} can be offered; check providers.<app>.models in ${CONFIG} and the log at ${LOG}.`
      // Leave the list stale so deferred provider changes are checked again.
      registry = { agents, at: Date.now(), configKey: deferred ? undefined : configKey(config), hint }
      fs.mkdirSync(path.dirname(CACHE), { recursive: true })
      fs.writeFileSync(CACHE, JSON.stringify(registry))
      log(`discovery: ${registry.agents.map((a) => a.name).join(', ')}`)
    })().finally(() => (discovering = null)))
  const ownVendorsNow = () => new Map([...providers.values()].filter((p) => p.vendor).map((p) => [p.id, p.vendor!]))

  const providerList = async () => {
    const config = await syncProviders()
    const locations = await Promise.all(PROVIDERS.map((f) => detect(f, config)))
    return PROVIDERS.map((f, i) => ({ id: f.id, displayName: f.displayName, detected: !!locations[i], location: locations[i],
      enabled: config.providers[f.id]?.enabled ?? !f.optIn, optIn: !!f.optIn, firstClass: !!f.firstClass, running: providers.has(f.id), mode: f.vendor ? 'deny' : 'allow' }))
  }

  // Every model an app lists, with whether it's offered and why not.
  const modelsOf = async (id: string, refresh: boolean) => {
    const f = PROVIDERS.find((x) => x.id === id)
    if (!f) throw new HttpError(404, `unknown provider ${id}`)
    const config = await syncProviders()
    const p = providers.get(id)
    if (!p) {
      const location = await detect(f, config)
      const why = !location ? `${f.displayName} isn't installed on this machine` : `Turn on ${f.displayName} to see its models`
      return { provider: id, at: 0, pending: false, error: why, models: [] }
    }
    if (refresh) listProvider(p, true)
    // Discovery lists every app once and rebuilds the subagent list too.
    if (refresh || !lastModels.has(id) || registryStale()) void discover().catch((e) => log(`discovery: ${(e as Error).message}`))
    // A discovery already under way may have started before this app was on.
    const job = listing.get(id) ?? (lastModels.has(id) ? null : listProvider(p))
    if (job) await Promise.race([job, new Promise((r) => setTimeout(r, MODELS_WAIT_MS))])
    const { allow, deny, anthropic } = lists(config)
    const ownVendors = ownVendorsNow()
    const agents = registry?.agents ?? []
    const models = (lastModels.get(id) ?? []).map((m) => {
      const reason = whyNot(m, ownVendors, allow, deny, anthropic)
      const blocked = reason === 'disabled' || reason === 'not_listed'
      return { model: m.model, displayName: m.displayName, company: m.provider, description: m.description, efforts: m.efforts, defaultEffort: m.defaultEffort,
        isDefault: m.isDefault, enabled: !blocked, offered: reason === null, reason, agent: agents.find((a) => a.harness === id && a.model === m.model)?.name ?? null }
    })
    return { provider: id, at: lastModelsAt.get(id) ?? 0, pending: listing.has(id), error: lastErrors.get(id) ?? null, models }
  }

  const registryStale = () => !registry || Date.now() - registry.at > REGISTRY_TTL_MS || registry.configKey !== configKey(readConfig())


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
      startedAt: STARTED_AT,
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
      if (req.method === 'GET' && url.pathname === '/health') {
        const config = readConfig()
        // A broken config keeps the last good one for leases, but handback is opt-in, so it reads as off.
        return json(res, 200, { ok: true, pid: process.pid, version: VERSION, store: { degraded: store.degraded, error: store.error }, busy: table.running().length > 0, configError: config.error, handback: config.error ? null : config.handback ?? null, newSettings: config.newSettings ?? [] })
      }
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, status())
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (table.running().length) return json(res, 409, { error: 'agents are running' })
        json(res, 200, { ok: true })
        log('shutdown requested')
        return setTimeout(() => void shutdown(), 50)
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
          // Keep an open session's model list fresh. A deferred list waits for GET /agents.
          if (registry?.configKey && registryStale()) discover().catch((e) => log(`discovery: ${(e as Error).message}`))
          return json(res, 200, { ok: true, agentsAt: registry?.at ?? 0 })
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
        const stale = registryStale() || url.searchParams.get('refresh') === '1'
        if (stale) await Promise.race([discover(), new Promise((r) => setTimeout(r, registry ? 8000 : 30_000))])
        const agents = registry?.agents ?? []
        return json(res, 200, { agents: agents.map((a) => ({ ...a, description: describe(a, agents) })), nameTable: nameTable(agents), at: registry?.at ?? 0, hint: registry?.hint ?? null })
      }

      if (parts[0] === 'viewers' && parts[1] && !parts[2]) {
        if (req.method === 'POST') viewers.set(parts[1], Date.now() + VIEWER_TTL_MS)
        else if (req.method === 'DELETE') viewers.delete(parts[1])
        else return json(res, 404, { error: 'not found' })
        leasesChanged()
        return json(res, 200, { ok: true, ttlMs: VIEWER_TTL_MS })
      }
      if (req.method === 'GET' && url.pathname === '/providers') return json(res, 200, { providers: await providerList() })
      if (req.method === 'GET' && parts[0] === 'providers' && parts[1] && parts[2] === 'models' && !parts[3]) {
        return json(res, 200, await modelsOf(decodeURIComponent(parts[1]), url.searchParams.get('refresh') === '1'))
      }
      if (req.method === 'GET' && parts[0] === 'subagents') {
        // Running means working on a turn now, as the helper knows it; the store has the rest.
        const working = table.summaries().filter((x) => ['running', 'stopping'].includes(x.state) && table.sessions.get(x.id)?.info.closedAt == null)
        const workingIds = new Set(working.map((x) => x.id))
        const name = (h: string) => PROVIDERS.find((f) => f.id === h)?.displayName ?? h
        const shape = (r: ReturnType<typeof store.subagentsById>[number]) => ({ ...r, harnessName: name(r.harness), state: working.find((x) => x.id === r.id)?.state ?? r.state, running: workingIds.has(r.id) })
        // A working session the store can't give back (persistence off) still shows, from memory.
        const runningRows = () => {
          const stored = store.subagentsById([...workingIds])
          const missing = [...workingIds].filter((id) => !stored.some((r) => r.id === id)).map((id) => {
            const i = table.sessions.get(id)!.info
            return { id, harness: i.harness, agent: i.agent, model: i.model, effort: i.effort ?? null, title: i.title ?? null, state: i.state, createdAt: i.createdAt ?? Date.now(),
              closedAt: null, closeReason: null, changedAt: i.updatedAt ?? 0, tokens: 0, cachedTokens: 0, turns: 0, toolCalls: 0, activeMs: 0, turnStartedAt: null }
          })
          return [...stored, ...missing].map(shape)
        }
        const cursor = (key: string): [number, string] | undefined => {
          const raw = url.searchParams.get(key)
          if (!raw) return undefined
          const at = raw.indexOf(':')
          const time = Number(raw.slice(0, at))
          if (at < 1 || !Number.isFinite(time)) throw new HttpError(400, `${key} must be <createdAt>:<id>`)
          return [time, raw.slice(at + 1)]
        }
        const limit = (fallback: number) => Math.max(1, Math.min(500, Math.floor(Number(url.searchParams.get('limit') ?? fallback)) || fallback))
        if (!parts[1]) {
          const recent = Math.max(1, Math.min(50, Math.floor(Number(url.searchParams.get('recent') ?? RECENT_SUBAGENTS)) || RECENT_SUBAGENTS))
          const page = store.subagentPage({ limit: recent + workingIds.size })
          return json(res, 200, { now: Date.now(), running: runningRows(), recent: page.rows.filter((r) => !workingIds.has(r.id)).slice(0, recent).map(shape) })
        }
        if (parts[1] === 'page') {
          const page = store.subagentPage({ before: cursor('before'), after: cursor('after'), oldest: url.searchParams.get('oldest') === '1', limit: limit(50), count: true })
          return json(res, 200, { now: Date.now(), rows: page.rows.map(shape), more: page.more, total: page.total })
        }
        if (parts[1] === 'changed') {
          // Only what the screen shows: the given sessions changed since the last look, any session
          // that started working, and with top, sessions newer than the top row.
          const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 500)
          const since = Number(url.searchParams.get('since') ?? 0) || 0
          const changed = store.subagentsChanged(ids, since)
          const shown = new Set(ids)
          const started = runningRows().filter((r) => !shown.has(r.id) && (r.changedAt ?? 0) > since)
          const top = cursor('top')
          const newer = top ? store.subagentPage({ after: top, limit: limit(50) }).rows.map(shape) : []
          const recent = url.searchParams.has('recent')
            ? store.subagentPage({ limit: RECENT_SUBAGENTS + workingIds.size }).rows.filter((r) => !workingIds.has(r.id)).slice(0, RECENT_SUBAGENTS).map(shape)
            : undefined
          return json(res, 200, { now: Date.now(), stamp: changed.stamp, rows: [...changed.rows.map(shape), ...started], newer, recent })
        }
        return json(res, 404, { error: 'not found' })
      }
      if (req.method === 'GET' && url.pathname === '/stats/models') {
        const id = url.searchParams.get('provider') ?? ''
        const model = url.searchParams.get('model') ?? ''
        if (!PROVIDERS.some((f) => f.id === id)) return json(res, 404, { error: `unknown provider ${id}` })
        if (!model) return json(res, 400, { error: 'model is needed' })
        return json(res, 200, store.usageRows(id, model, Number(url.searchParams.get('since') ?? 0) || 0))
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
        const session = new Session({ id: '', harness: def.harness, agent: def.name, model: def.model, effort: effort ?? null, cwd: body.cwd, state: 'idle', title: typeof body.title === 'string' ? body.title : null, leaseId: body.leaseId, claudeSession: body.claudeSession ?? null, claudeAgent: body.claudeAgent ?? null, parentMode: body.parentMode ?? null }, store)
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

      const session = parts[0] === 'sessions' && parts[1] ? table.load(parts[1], store) : undefined
      if (!session) return json(res, 404, { error: 'no such session' })
      session.lastSeenAt = Date.now()
      store.ensure(session)
      const [, , action, itemId] = parts
      if (req.method === 'DELETE' && !action) {
        if (!table.close(session.info.id, 'deleted')) {
          if (session.info.closedAt !== null && session.info.closedAt !== undefined) return json(res, 404, { error: 'no such session' })
          session.info.closedAt = Date.now()
          session.info.closeReason = 'deleted'
          session.save()
        }
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && action === 'attach') {
        const body = await readBody(req)
        if (!body.leaseId || !table.leases.has(body.leaseId)) return json(res, 403, { error: 'a valid lease is required' })
        table.attach(session, body.leaseId, body.claudeSession)
        return json(res, 200, { ok: true, state: session.info.state, lastSeq: session.lastSeq, agent: session.info.agent, model: session.info.model, effort: session.info.effort ?? null })
      }
      if (req.method === 'GET' && !action) return json(res, 200, { ...session.info, events: session.lastSeq })
      const count = (key: string, fallback: number) => {
        const value = Number(url.searchParams.get(key) ?? fallback)
        if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, `${key} must be a positive integer`)
        return value
      }
      if (req.method === 'GET' && action === 'summary') return json(res, 200, store.summary(session, count('turns', 1)))
      if (req.method === 'GET' && action === 'messages') {
        if (itemId) {
          const message = store.message(session.info.id, decodeURIComponent(itemId))
          return json(res, message ? 200 : 404, message ? { message } : { error: 'no such message' })
        }
        const since = Number(url.searchParams.get('since') ?? 0)
        if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'since must be a non-negative integer')
        return json(res, 200, store.messages(session.info.id, { turns: count('turns', 1), all: url.searchParams.get('all') === '1', since, limit: count('limit', 200) }))
      }
      const adapter = providerFor(session)
      if (req.method === 'POST' && action === 'input') {
        const { text, mode = 'auto', sender = 'claude', clientInputId } = await readBody(req)
        if (clientInputId !== undefined && typeof clientInputId !== 'string') return json(res, 400, { error: 'clientInputId must be a string' })
        const existing = clientInputId === undefined ? null : session.inputReceipt(clientInputId)
        if (existing) return json(res, 200, { ok: true, ...existing })
        if (!['auto','queue','interrupt'].includes(mode)) return json(res, 400, { error: 'mode must be auto, queue or interrupt' })
        if (!['claude','user'].includes(sender)) return json(res, 400, { error: 'sender must be claude or user' })
        if (!adapter) return json(res, 404, { error: `${session.info.harness} is not available` })
        if (!table.leaseIdOf(session.info.id)) return json(res, 403, { error: 'attach this session to a valid lease before sending input' })
        const receipt = await session.deliver(adapter, String(text ?? ''), mode, sender, clientInputId)
        return json(res, 200, { ok: true, ...receipt })
      }
      if (req.method === 'POST' && action === 'auto') {
        if (!adapter) return json(res, 404, { error: `${session.info.harness} is not available` })
        adapter.setAutoMode?.(session)
        session.info.parentMode = 'auto'
        session.save()
        log(`session ${session.info.id}: switched to auto mode`)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && action === 'interrupt') {
        return json(res, 200, { ok: true, how: await session.stop(adapter, 'host') })
      }
      if (req.method === 'GET' && action === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0
        return json(res, 200, { events: await session.eventsAfter(after, waitMs), state: session.info.state })
      }
      if (req.method === 'GET' && action === 'items' && itemId) return json(res, 200, { event: await session.itemCompletion(itemId, waitMs) })
      if (!adapter) return json(res, 404, { error: `${session.info.harness} is not available` })
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
      void s.stop(providerFor(s), 'abandoned')
    }
    if (!discovering && [...providers.values()].some((p) => !busy(p.id) && updated(p))) void discover()
    if (noLeasesSince !== null && now - noLeasesSince > GRACE_MS) {
      void shutdown()
    }
  }, 5000)
  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    try {
      server.close()
      log('shutdown: stopping agents')
      await Promise.all(table.running().map((s) => s.stop(providerFor(s), 'shutdown')))
      for (const provider of providers.values()) provider.dispose?.()
      store.close()
    } finally {
      process.exit(0)
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown())
}

// setup alone asks about unanswered settings; --new does the same quietly, for the installer.
async function setup(id: string | undefined) {
  if (id === undefined || id === '--new') process.exit(await setupFeatures({ newOnly: id === '--new' }))
  const feature = findFeature(id)
  if (feature) process.exit(await setupFeatures({ features: [feature] }))
  const f = PROVIDERS.find((p: ProviderFactory) => p.id === id)
  if (!f?.setup) {
    console.error(`bitfrostd setup: settings: ${FEATURES.map((x) => x.id).join(', ')}; apps with a setup step: ${PROVIDERS.filter((p) => p.setup).map((p) => p.id).join(', ')}`)
    process.exit(2)
  }
  const config = loadConfig()
  if (config.error) console.error(`warning: ${config.error}; going on with the defaults`)
  f.setup(providerEnv(config, f.id))
}

// Returns why the helper is still up, or null once it's gone.
async function stop(): Promise<string | null> {
  const pid = (await health())?.pid
  const r = await call('POST', '/shutdown', 3000)
  if (!r) return null
  if (r.status !== 200) return r.body?.error ?? `HTTP ${r.status}`
  // It stops answering before it exits, and a new helper can't start until it lets go of its locks.
  const holds = (lock: string) => { try { return fs.readFileSync(lock, 'utf8') === String(pid) } catch { return false } }
  const up = async () => (Number.isSafeInteger(pid) ? holds(LOCK) || holds(DATA_LOCK) : !!(await health()))
  for (let i = 0; i < 100 && (await up()); i++) await new Promise((res) => setTimeout(res, 100))
  return (await up()) ? 'it did not exit' : null
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
  migrate                   stop an idle helper and migrate the database now
  update                    install the latest release, if it's newer
  uninstall [--yes]         remove BitFrost from Claude Code, ZCode, Antigravity and this machine
    [--keep-config]         with --yes, keep your config
    [--keep-history]        with --yes, keep subagent history and usage stats
  config                    open the config screen (also a bare bitfrost on a terminal)
  setup                     choose settings you haven't chosen yet
  setup <setting>           choose a setting again (${FEATURES.map((f) => f.id).join(', ')})
  setup <app>               one-time setup for an app (${PROVIDERS.filter((p) => p.setup).map((p) => p.id).join(', ')})
  selftest <app> [model]    check that an app works with BitFrost
  selftest --all            check every app
  socket                    print the helper's socket path
  -v, --version             print the version
  -h, --help                show this

Guide: https://github.com/${process.env.BITFROST_REPO || 'SavaSoftworks/BitFrost'}/blob/main/GUIDE.md`

const noScreen = () => `The config screen isn't available for ${process.platform}-${process.arch} here; edit ${CONFIG} instead.`

const mode = process.argv[2]
if (mode === undefined && process.stdout.isTTY && process.stdin.isTTY) console.log(`${HELP}\n\n${noScreen()}`)
else if (mode === undefined || mode === 'help' || mode === '--help' || mode === '-h') console.log(HELP)
else if (mode === 'config') {
  console.error(noScreen())
  process.exit(1)
}
else if (mode === 'tui-rpc') await (await import('./tui-rpc.ts')).serveRpc()
else if (mode === 'version' || mode === '--version' || mode === '-v') console.log(VERSION)
else if (mode === 'setup') await setup(process.argv[3])
else if (mode === 'zcode-setup') await setup('zcode')
else if (mode === 'ensure') await ensure()
else if (mode === 'serve') serve()
else if (mode === 'socket') console.log(SOCKET)
else if (mode === 'status') await printStatus()
else if (mode === 'restart') await restart()
else if (mode === 'migrate') {
  try { await migrateDatabase(stop, process.argv.includes('--install-lock')) }
  catch (error) { console.error((error as Error).message); process.exitCode = 1 }
}
else if (mode === 'update') process.exit(await update())
else if (mode === 'uninstall') {
  const flags = process.argv.slice(3)
  process.exit(await uninstall({ stop, running: async () => !!(await health()) }, { yes: flags.includes('--yes') || flags.includes('-y'), keepConfig: flags.includes('--keep-config'), keepHistory: flags.includes('--keep-history') }))
}
else if (mode === 'selftest' && process.argv[3] === '--all') await selftestAll()
else if (mode === 'selftest') await selftest(process.argv[3], process.argv[4])
else {
  console.error(`bitfrost: unknown command ${mode}\n\n${HELP}`)
  process.exit(2)
}
