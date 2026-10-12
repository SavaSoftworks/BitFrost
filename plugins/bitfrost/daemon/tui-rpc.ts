// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrostd tui-rpc: the config screen's helper. It speaks one JSON message per line
// on stdin and stdout, edits config.json itself and asks the helper for models and usage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { CONFIG, VERSION, loadConfig } from './config.ts'
import { call, start } from './client.ts'
import { EditError, edit, getPath, readRaw, revision, setModel, setPath, setProvider, type Raw } from './configedit.ts'
import { FEATURES, availableFeatures, optionsFor, pendingFeatures, shows, type Question } from './features.ts'
import { settingsPlan } from './settings-plan.ts'
import { PROVIDERS } from './providers/index.ts'
import { FETCH_MS, latestVersion, newer } from './update.ts'
import { summarize } from './usage.ts'
import { dayOf } from './store.ts'

export const PROTOCOL = 1
const VIEWER_RENEW_MS = 20_000
const POLL_MS = 1500
const STATS_MS = 3000
const SUBAGENTS_MS = 2000
// How long settings.get waits for app detection before answering without it.
const FOUND_WAIT_MS = 300
const REPO = process.env.BITFROST_REPO || 'SavaSoftworks/BitFrost'
// A local tarball to update from, for testing, and the version its name says it holds.
const localTarball = () => process.env.BITFROST_UPDATE_FROM || null
const localVersion = (file: string) => path.basename(file).match(/^bitfrost-(\d+(?:\.\d+)*)\.tar\.gz$/)?.[1] ?? null
const RELEASES = `https://github.com/${REPO}`

// What install.sh prints, step by step, for a simulated update.
const INSTALL_STEPS = (version: string) => {
  const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.platform === 'darwin' ? 'universal' : process.arch === 'arm64' ? 'arm64' : 'x64'}`
  return [
    { label: 'Release', detail: `bitfrost-${version}.tar.gz` },
    { label: 'Checksum', detail: `bitfrost-${version}.tar.gz` },
    { label: 'Unpacked', detail: `~/.local/share/bitfrost/versions/${version}` },
    { label: 'BitFrost TUI', detail: `bitfrost-tui-${version}-${platform}` },
    { label: 'Command', detail: '~/.local/bin/bitfrost' },
    { label: 'Kept your config', detail: '~/.config/bitfrost/config.json' },
    { label: 'Claude Code plugin', detail: 'bitfrost@bitfrost in ~/.claude' },
    { label: 'Helper', detail: 'restarted' },
  ]
}
const POLL_FOR_MS = 120_000

type Daemon = {
  start(): Promise<boolean>
  call(method: string, path: string, timeout?: number): Promise<{ status: number; body: any } | null>
}

class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type Item = {
  key: string
  label: string
  // The heading this setting is listed under.
  group: string
  help?: string
  // Words for off and on, for a bool.
  states?: [string, string]
  // Shown after a number, such as days.
  unit?: string
  // For a location left empty: where BitFrost found the app, or null when it didn't.
  found?: string | null
  type: 'bool' | 'choice' | 'number' | 'text' | 'list'
  value: unknown
  default: unknown
  options?: { value: string; label: string }[]
  min?: number
  visibleWhen?: { key: string; equals: unknown }
}

// The Settings page, built from config.json as it is now. found holds where each
// harness was found, when the helper could say.
export async function settingsOf(raw: Raw, found: Record<string, string | null> | null = null, version = VERSION): Promise<{ id: string; title: string; items: Item[] }[]> {
  const sections = [
    {
      id: 'general',
      title: 'General',
      items: [{ key: 'allowedProfiles', group: 'Claude profiles', label: 'Allowed', help: 'Claude Code profile folders allowed to use BitFrost subagents.', type: 'list', value: getPath(raw, 'allowedProfiles') ?? ['~/.claude'], default: ['~/.claude'] }] as Item[],
    },
  ]
  for (const f of availableFeatures(version)) {
    const answers = (raw[f.key] && typeof raw[f.key] === 'object' ? raw[f.key] : {}) as Raw
    const items: Item[] = []
    for (const q of [...f.questions, ...(f.more ?? [])]) {
      const def = q.type === 'confirm' ? q.default : q.default ?? f.defaults?.[q.key]
      const item: Item = { key: `${f.key}.${q.key}`, group: f.title, label: q.label ?? q.prompt, help: q.help, type: q.type === 'confirm' ? 'bool' : 'choice', value: answers[q.key] ?? def, default: def }
      if (q.states) item.states = q.states
      if (q.type === 'choice') item.options = await optionsFor(q, { config: raw, answers })
      if (q.when && typeof q.when !== 'function') item.visibleWhen = { key: `${f.key}.${q.when.key}`, equals: q.when.equals }
      items.push(item)
    }
    sections.push({ id: f.id, title: f.title, items })
  }
  sections.push({
    id: 'retention',
    title: 'History',
    items: [
      { key: 'retention.eventsDays', group: 'Retention', label: 'Raw events', unit: 'days', help: 'Days to keep each subagent event after it finishes. 0 keeps them forever.', type: 'number', value: getPath(raw, 'retention.eventsDays') ?? 30, default: 30, min: 0 },
      { key: 'retention.messagesDays', group: 'Retention', label: 'Transcripts', unit: 'days', help: 'Days to keep finished subagent transcripts. Usage totals are kept forever. 0 keeps them forever.', type: 'number', value: getPath(raw, 'retention.messagesDays') ?? 180, default: 180, min: 0 },
    ],
  })
  const harnesses: Item[] = []
  for (const f of PROVIDERS) {
    const on = !f.optIn
    harnesses.push({ key: `providers.${f.id}.enabled`, group: f.displayName, label: 'Status', states: ['Disabled', 'Enabled'], help: f.optIn ? `Off unless turned on. Pick its models on the Models page.` : 'On unless turned off.', type: 'bool', value: getPath(raw, `providers.${f.id}.enabled`) ?? on, default: on })
    const where = f.id === 'zcode' ? 'dir' : 'bin'
    const location: Item = { key: `providers.${f.id}.${where}`, group: f.displayName, label: 'Location', help: 'Leave empty to find it automatically.', type: 'text', value: getPath(raw, `providers.${f.id}.${where}`) ?? '', default: '' }
    if (found && f.id in found) location.found = found[f.id]
    harnesses.push(location)
  }
  sections.push({ id: 'harnesses', title: 'Harnesses', items: harnesses })
  return sections
}

const coerce = (item: Item, value: unknown): unknown => {
  const bad = (why: string) => new RpcError('bad_request', `${item.label}: ${why}`)
  switch (item.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw bad('must be on or off')
      return value
    case 'choice':
      if (!item.options?.some((o) => o.value === value)) throw bad(`must be one of ${item.options?.map((o) => o.value).join(', ')}`)
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (item.min ?? -Infinity)) throw bad(`must be a number of at least ${item.min ?? 0}`)
      return value
    case 'text':
      if (typeof value !== 'string') throw bad('must be text')
      return value.trim() || undefined
    case 'list': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw bad('must be a list of text')
      const list = [...new Set(value.map((v) => v.trim()).filter(Boolean))]
      if (!list.length) throw bad('needs at least one entry')
      return list
    }
  }
}

// Fills in a feature's defaults when one of its settings is first set.
function completeFeature(raw: Raw, key: string) {
  const f = FEATURES.find((x) => key.startsWith(`${x.key}.`))
  if (!f || !raw[f.key] || typeof raw[f.key] !== 'object') return
  const answers = raw[f.key] as Raw
  for (const q of [...f.questions, ...(f.more ?? [])] as Question[]) {
    if (q.key in answers || !shows(q.when, answers)) continue
    const def = q.default ?? f.defaults?.[q.key]
    if (def !== undefined) answers[q.key] = def
  }
  for (const [k, v] of Object.entries(f.defaults ?? {})) if (!(k in answers)) answers[k] = v
}

export async function serveRpc(opts: { input?: Readable; output?: Writable; file?: string; daemon?: Daemon; statsMs?: number; subagentsMs?: number
  latest?: () => Promise<string>; stepMs?: number; now?: () => number } = {}) {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const file = opts.file ?? CONFIG
  const daemon = opts.daemon ?? { start, call }
  const viewer = randomUUID()
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n')
  const notify = (method: string, params: unknown) => send({ method, params })
  let known = revision(file)
  const lastModels = new Map<string, string[]>()
  const polling = new Set<string>()
  let renew: NodeJS.Timeout | null = null
  let starting: Promise<void> | null = null
  // Each model's hourly rows once loaded, so later looks only fetch what changed.
  const usage = new Map<string, { rows: Map<number, Record<string, any>>; stamp: number; day: string; summary?: ReturnType<typeof summarize> }>()
  // The one model the stats panel shows, kept current while it's on screen.
  let watched: { provider: string; model: string } | null = null
  // The subagent rows on screen, and with top, whether newer ones have arrived above them.
  let watchedAgents: { ids: string[]; top: string | null; since: number; overview: boolean; recent: string } | null = null
  // Where each harness was last found, so Settings can answer without waiting on detection.
  let found: Record<string, string | null> | null = null
  let finding: Promise<boolean> | null = null
  const learn = (list: unknown) => {
    if (!Array.isArray(list)) return false
    const next = Object.fromEntries(list.map((p: any) => [p.id, p.location ?? null]))
    const changed = JSON.stringify(next) !== JSON.stringify(found)
    found = next
    return changed
  }
  // Settings never start the helper, so this only asks one that is already up.
  const findApps = () => finding ??= daemon.call('GET', '/providers', 10_000)
    .then((r) => r?.status === 200 && learn(r.body?.providers), () => false)
    .finally(() => { finding = null })
  const usageOf = async (provider: string, model: string) => {
    const key = `${provider}\n${model}`
    const cached = usage.get(key) ?? { rows: new Map(), stamp: 0, day: '' }
    const r = await ask(`/stats/models?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&since=${cached.stamp}`)
    for (const row of r.rows) cached.rows.set(row.hour, row)
    const now = (opts.now ?? Date.now)()
    const day = dayOf(now)
    const changed = r.rows.length > 0 || cached.day !== day || !cached.summary
    if (changed) cached.summary = summarize(model, cached.rows.values(), now)
    cached.day = day
    cached.stamp = r.stamp
    usage.set(key, cached)
    return { changed, summary: cached.summary! }
  }

  // Starts the helper on first need and keeps it up while the screen is open.
  const lost = () => {
    if (renew) clearInterval(renew)
    renew = null
    starting = null
  }
  const up = () =>
    (starting ??= (async () => {
      if (!(await daemon.start())) throw new RpcError('daemon_down', 'the BitFrost helper did not start; see bitfrost status')
      await daemon.call('POST', `/viewers/${viewer}`)
      renew = setInterval(() => void daemon.call('POST', `/viewers/${viewer}`).then((r) => { if (!r) lost() }), VIEWER_RENEW_MS)
      renew.unref()
    })().catch((e) => {
      starting = null
      throw e
    }))
  // A helper that went away is started again once.
  const ask = async (path: string, timeout = 10_000): Promise<any> => {
    await up()
    let r = await daemon.call('GET', path, timeout)
    if (!r) {
      lost()
      await up()
      r = await daemon.call('GET', path, timeout)
    }
    if (!r) throw new RpcError('daemon_down', 'the BitFrost helper did not answer')
    return checked(r)
  }
  const checked = (r: { status: number; body: any }) => {
    // Routes it doesn't know fall through to its session lookup.
    if (r.status === 404 && r.body?.error === 'no such session') throw new RpcError('daemon_down', 'the running BitFrost helper is older than this screen; run bitfrost restart once no subagent is busy')
    if (r.status === 404) throw new RpcError('unknown_provider', r.body?.error ?? 'not found')
    if (r.status !== 200) throw new RpcError('internal', r.body?.error ?? `helper answered ${r.status}`)
    return r.body
  }
  const factory = (id: unknown) => {
    const f = PROVIDERS.find((x) => x.id === id)
    if (!f) throw new RpcError('unknown_provider', `unknown provider ${String(id)}`)
    return f
  }
  const change = (expected: unknown, job: (raw: Raw) => string[] | void) => {
    const r = edit(file, typeof expected === 'string' ? expected : undefined, job)
    known = r.revision
    return { ok: true, ...r }
  }
  // A slow listing answers pending; tell the screen once it lands.
  const poll = (id: string) => {
    if (polling.has(id)) return
    polling.add(id)
    const until = Date.now() + POLL_FOR_MS
    const tick = async () => {
      try {
        const r = await ask(`/providers/${encodeURIComponent(id)}/models`)
        if (!r.pending || Date.now() > until) {
          polling.delete(id)
          lastModels.set(id, r.models.map((m: any) => m.model))
          return notify('models.updated', { provider: id })
        }
      } catch {
        // Let the screen ask again and show the error.
        polling.delete(id)
        return notify('models.updated', { provider: id })
      }
      setTimeout(tick, POLL_MS).unref()
    }
    setTimeout(tick, POLL_MS).unref()
  }

  const methods: Record<string, (p: any) => Promise<unknown> | unknown> = {
    hello: async (p) => {
      if (p?.protocol !== PROTOCOL) throw new RpcError('bad_request', `this helper speaks protocol ${PROTOCOL}; update BitFrost`)
      const r = await daemon.call('GET', '/health')
      known = revision(file)
      const config = loadConfig(file)
      return { protocol: PROTOCOL, version: VERSION, configPath: file, revision: known, configError: config.error, settingsUpToDate: config.settingsUpToDate, daemon: { up: r?.status === 200 } }
    },
    'config.get': () => {
      const c = loadConfig(file)
      return { path: file, error: c.error, warnings: c.warnings, revision: revision(file) }
    },
    'providers.list': async () => {
      const r = await ask('/providers')
      learn(r?.providers)
      return r
    },
    'models.list': async (p) => {
      const id = factory(p?.provider).id
      const r = await ask(`/providers/${encodeURIComponent(id)}/models${p?.refresh ? '?refresh=1' : ''}`, 20_000)
      lastModels.set(id, r.models.map((m: any) => m.model))
      if (r.pending) poll(id)
      return r
    },
    'status.get': async () => (await ask('/status')),
    // The same check as bitfrost update. BITFROST_PRETEND_VERSION tries it as an older install.
    'update.check': async () => {
      const current = process.env.BITFROST_PRETEND_VERSION || VERSION
      try {
        // Updating from a local tarball offers that tarball, without asking GitHub.
        const local = localTarball()
        const fromFile = local ? localVersion(local) : null
        if (local && !fromFile) throw new Error(`BITFROST_UPDATE_FROM must name a bitfrost-<version>.tar.gz: ${local}`)
        const latest = fromFile ?? (await (opts.latest ?? (() => latestVersion(RELEASES)))())
        return { current, latest, available: newer(latest, current), error: null }
      } catch (e) {
        return { current, latest: null, available: false, error: (e as Error).message }
      }
    },
    // Installs the version through its own install.sh; its steps arrive as update.step, then update.finished.
    // BITFROST_SIMULATE_UPDATE only shows the steps, and BITFROST_UPDATE_FROM installs a local tarball.
    'update.run': (p) => {
      if (typeof p?.version !== 'string' || !/^\d+(\.\d+)*$/.test(p.version)) throw new RpcError('bad_request', 'update.run needs a version')
      const simulate = p.simulate === true || !!process.env.BITFROST_SIMULATE_UPDATE
      // A local tarball installs its own version, whatever was asked for.
      const local = localTarball()
      const version = (local && localVersion(local)) || p.version
      void (simulate ? simulateUpdate(version) : runInstaller(version))
      return { ok: true, simulated: simulate }
    },
    'subagents.overview': () => ask('/subagents'),
    // A page of subagents, newest first: before or after a row's "createdAt:id", or the oldest page.
    'subagents.page': (p) => {
      const query = new URLSearchParams()
      for (const key of ['before', 'after']) if (typeof p?.[key] === 'string') query.set(key, p[key])
      if (p?.oldest === true) query.set('oldest', '1')
      query.set('limit', String(Math.max(1, Math.min(500, Math.floor(Number(p?.limit) || 50)))))
      return ask(`/subagents/page?${query}`)
    },
    // Live updates for exactly the rows on screen; top asks about newer rows too.
    'subagents.watch': (p) => {
      const ids = Array.isArray(p?.ids) ? p.ids.filter((x: unknown) => typeof x === 'string').slice(0, 500) : []
      watchedAgents = { ids, top: typeof p?.top === 'string' ? p.top : null, since: Math.max(0, Number(p?.since) || 0), overview: p?.overview === true, recent: '' }
      return { ok: true }
    },
    unwatch: (p) => {
      if (p?.what === 'subagents') watchedAgents = null
      else if (p?.what === 'stats') watched = null
      else throw new RpcError('bad_request', 'unwatch needs what: subagents or stats')
      return { ok: true }
    },
    // One model's usage, and from now on, live updates for that model only.
    'models.stats': async (p) => {
      const provider = factory(p?.provider).id
      if (typeof p?.model !== 'string' || !p.model) throw new RpcError('bad_request', 'models.stats needs a model')
      watched = { provider, model: p.model }
      return { rows: [(await usageOf(provider, p.model)).summary] }
    },
    'models.set': async (p) => {
      const f = factory(p?.provider)
      if (typeof p.model !== 'string' || !p.model || typeof p.enabled !== 'boolean') throw new RpcError('bad_request', 'models.set needs model and enabled')
      // A pattern may be turned into the models it covers, so use the app's list as it is now.
      if (!f.vendor && !p.enabled) {
        const now = await ask(`/providers/${encodeURIComponent(f.id)}/models`).catch(() => null)
        if (now?.models?.length) lastModels.set(f.id, now.models.map((m: any) => m.model))
      }
      return change(p.revision, (raw) => setModel(raw, f.id, p.model, p.enabled, f.vendor ? 'deny' : 'allow', lastModels.get(f.id) ?? []))
    },
    'providers.set': (p) => {
      const f = factory(p?.provider)
      if (typeof p.enabled !== 'boolean') throw new RpcError('bad_request', 'providers.set needs enabled')
      return change(p.revision, (raw) => setProvider(raw, f.id, p.enabled))
    },
    'settings.pending': async (p) => {
      const rev = revision(file)
      if (typeof p?.revision === 'string' && p.revision !== rev) throw new EditError('conflict', 'Config changed; reopen Configure new settings')
      const raw = readRaw(file)
      if (typeof raw === 'string') throw new RpcError('config_invalid', `${file} is invalid: ${raw}`)
      return { revision: rev, ...await settingsPlan(raw, p?.answers ?? {}) }
    },
    'settings.configure': async (p) => {
      if (typeof p?.revision !== 'string') throw new RpcError('bad_request', 'settings.configure needs a revision')
      if (p.revision !== revision(file)) throw new EditError('conflict', 'Config changed; reopen Configure new settings')
      const raw = readRaw(file)
      if (typeof raw === 'string') throw new RpcError('config_invalid', `${file} is invalid: ${raw}`)
      const plan = await settingsPlan(raw, p?.answers, true)
      return change(p.revision, (current) => {
        Object.assign(current, plan.answers)
        current.settingsUpToDate = pendingFeatures(current).length === 0
      })
    },
    'settings.get': async () => {
      const raw = readRaw(file)
      if (typeof raw === 'string') throw new RpcError('config_invalid', `${file} is invalid: ${raw}`)
      // Detection can ask a login shell, so answer with what's known and send settings.updated when it lands.
      const job = findApps()
      const late = await Promise.race([job.then(() => false), new Promise<boolean>((r) => setTimeout(r, FOUND_WAIT_MS, true).unref())])
      if (late) void job.then((changed) => { if (changed) notify('settings.updated', {}) })
      return { revision: revision(file), settingsUpToDate: pendingFeatures(raw).length === 0, sections: await settingsOf(raw, found) }
    },
    'settings.set': async (p) => {
      const raw = readRaw(file)
      if (typeof raw === 'string') throw new RpcError('config_invalid', `${file} is invalid: ${raw}`)
      const item = (await settingsOf(raw)).flatMap((s) => s.items).find((i) => i.key === p?.key)
      if (!item) throw new RpcError('unknown_key', `no setting ${String(p?.key)}`)
      const value = coerce(item, p.value)
      return change(p.revision, (r) => {
        setPath(r, item.key, value)
        completeFeature(r, item.key)
        r.settingsUpToDate = pendingFeatures(r).length === 0
      })
    },
  }

  const handle = async (line: string) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: 'bad_request', message: 'not JSON' } })
    }
    const method = methods[msg?.method]
    if (!method) return send({ id: msg?.id ?? null, error: { code: 'bad_request', message: `unknown method ${String(msg?.method)}` } })
    try {
      send({ id: msg.id, result: await method(msg.params ?? {}) })
    } catch (e) {
      const code = e instanceof RpcError || e instanceof EditError ? e.code : 'internal'
      send({ id: msg.id, error: { code, message: (e as Error).message } })
    }
  }

  const simulateUpdate = async (version: string) => {
    const steps = INSTALL_STEPS(version)
    const pause = opts.stepMs ?? 450
    for (const [index, step] of steps.entries()) {
      notify('update.step', { index, total: steps.length, ...step, state: 'running' })
      await new Promise((r) => setTimeout(r, pause + (index % 3) * pause * 0.6))
      notify('update.step', { index, total: steps.length, ...step, state: 'done' })
    }
    notify('update.finished', { ok: true, version, simulated: true })
  }

  const runInstaller = async (version: string) => {
    // One line per step, as install.sh draws it: a step's later events land on the line it
    // started, matched by name ("Unpacking" finishes as "Unpacked").
    let next = 0
    const open = new Map<string, number>()
    const shown = new Map<number, { label: string; detail: string }>()
    const same = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5))
    const show = (state: string, label: string, detail: string) => {
      const match = [...open.keys()].find((name) => same(name, label))
      const index = match !== undefined ? open.get(match)! : next++
      if (match !== undefined) open.delete(match)
      if (state === 'running') open.set(label, index)
      shown.set(index, { label, detail })
      notify('update.step', { index, label, detail, state })
    }
    // Steps still spinning when the installer ends finished with it.
    const settle = (state: string) => {
      for (const index of open.values()) notify('update.step', { index, ...shown.get(index)!, state })
      open.clear()
    }
    let dir: string | null = null
    try {
      let script: string
      let args: string[] = []
      const local = localTarball()
      if (local) {
        script = path.join(path.dirname(local), 'install.sh')
        args = ['--from', local]
      } else {
        show('running', 'Installer', `install.sh from v${version}`)
        const r = await fetch(`${RELEASES}/releases/download/v${version}/install.sh`, { signal: AbortSignal.timeout(FETCH_MS) })
        if (!r.ok) throw new Error(`can't download install.sh for v${version}: HTTP ${r.status}`)
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-update-'))
        script = path.join(dir, 'install.sh')
        fs.writeFileSync(script, await r.text())
        show('done', 'Installer', `install.sh from v${version}`)
      }
      const child = spawn('sh', [script, ...args], { env: { ...process.env, BITFROST_INSTALL_EVENTS: '1', BITFROST_DEFER_SETTINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let failure = ''
      let errors = ''
      child.stderr.on('data', (c) => (errors = (errors + c).slice(-2000)))
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('@@bitfrost\t')) return
        const [, state, label = '', detail = ''] = line.split('\t')
        if (state === 'fail') failure = label
        else show(state, label, detail)
      })
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      settle(code === 0 ? 'done' : 'fail')
      if (code === 0) notify('update.finished', { ok: true, version })
      else notify('update.finished', { ok: false, version, error: failure || errors.trim().split('\n').at(-1) || `the installer stopped (${code})` })
    } catch (e) {
      notify('update.finished', { ok: false, version, error: (e as Error).message })
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // Tell the screen when someone else changes the file.
  const watch = () => {
    const now = revision(file)
    if (now !== known) {
      known = now
      notify('config.changed', { revision: now })
    }
  }
  fs.watchFile(file, { interval: 1000, persistent: false }, watch)

  // Refresh on data changes or a new local day; otherwise reuse the summary after an indexed lookup.
  let checking = false
  const statsTimer = setInterval(async () => {
    // A watch only exists after a reply, so a helper lost since then is started again by ask.
    const was = watched
    if (!was || checking) return
    checking = true
    try {
      const r = await usageOf(was.provider, was.model)
      if (r.changed && watched === was) notify('stats.updated', { provider: was.provider, rows: [r.summary] })
    } catch {
    } finally {
      checking = false
    }
  }, opts.statsMs ?? STATS_MS)
  statsTimer.unref()
  let checkingAgents = false
  const agentsTimer = setInterval(async () => {
    const was = watchedAgents
    if (!was || checkingAgents) return
    checkingAgents = true
    try {
      const query = new URLSearchParams({ ids: was.ids.join(','), since: String(was.since) })
      if (was.top) query.set('top', was.top)
      if (was.overview) query.set('recent', '1')
      const r = await ask(`/subagents/changed?${query}`, 5000)
      if (watchedAgents !== was) return
      was.since = Math.max(was.since, Number(r.stamp) || 0)
      const recent = Array.isArray(r.recent) ? JSON.stringify(r.recent) : was.recent
      const changed = recent !== was.recent
      was.recent = recent
      if (r.rows.length || r.newer.length || changed) notify('subagents.changed', { now: r.now, rows: r.rows, newer: r.newer, ...(changed ? { recent: r.recent } : {}) })
    } catch {
    } finally {
      checkingAgents = false
    }
  }, opts.subagentsMs ?? SUBAGENTS_MS)
  agentsTimer.unref()

  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => { if (line.trim()) void handle(line) })
  await new Promise<void>((resolve) => lines.on('close', resolve))
  fs.unwatchFile(file, watch)
  clearInterval(statsTimer)
  clearInterval(agentsTimer)
  if (renew) clearInterval(renew)
  if (starting) await daemon.call('DELETE', `/viewers/${viewer}`).catch(() => null)
}
