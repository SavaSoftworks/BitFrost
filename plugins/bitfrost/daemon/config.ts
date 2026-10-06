// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ProviderEnv } from './provider.ts'
import { PROVIDERS } from './providers/index.ts'

const HOME = os.homedir()
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RUN_DIR = process.env.BITFROST_RUNTIME_DIR || path.join(process.env.XDG_RUNTIME_DIR ?? `/tmp/bitfrost-${process.getuid!()}`, 'bitfrost')
export const SOCKET = path.join(RUN_DIR, 'bitfrostd.sock')
export const LOG = path.join(RUN_DIR, 'bitfrostd.log')
export const LOCK = path.join(RUN_DIR, 'bitfrostd.lock')
export const CACHE = path.join(process.env.XDG_CACHE_HOME ?? path.join(HOME, '.cache'), 'bitfrost', 'agents.json')
export const CONFIG = path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'bitfrost', 'config.json')
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version as string

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`
  if (process.stderr.isTTY) process.stderr.write(line)
  fs.appendFileSync(LOG, line)
}

const expandHome = (p: string) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
export const canonical = (p: string) => {
  const abs = path.resolve(expandHome(p))
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

// Invalid config falls back to defaults and blocks new leases.
export type Config = { allowedProfiles: string[]; providers: Record<string, any>; error: string | null; warnings: string[] }

export function loadConfig(file = CONFIG): Config {
  let cfg: any = {}
  let problems: string[] = []
  let warnings: string[] = []
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const checked = validateConfig(cfg)
    problems = checked.errors
    warnings = checked.warnings
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems = [(e as Error).message]
  }
  if (problems.length) cfg = {}
  const providers = { ...(cfg.providers ?? {}) }
  if (cfg.codexBin) providers.codex = { bin: cfg.codexBin, ...providers.codex }
  if (cfg.zcodeDir) providers.zcode = { dir: cfg.zcodeDir, ...providers.zcode }
  return {
    allowedProfiles: (cfg.allowedProfiles ?? ['~/.claude']).map(canonical),
    providers,
    error: problems.length ? `${file} is invalid: ${problems.join('; ')}` : null,
    warnings: warnings.map((w) => `${file}: ${w}`),
  }
}

const TOP_KEYS = new Set(['allowedProfiles', 'providers', 'codexBin', 'zcodeDir'])
const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

export function validateConfig(cfg: unknown, known: string[] = PROVIDERS.map((p) => p.id)): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(cfg)) return { errors: ['it must be a JSON object'], warnings }
  const c = cfg as Record<string, any>
  for (const key of Object.keys(c)) if (!TOP_KEYS.has(key)) warnings.push(`unknown key ${key}`)
  if ('allowedProfiles' in c && !isStrings(c.allowedProfiles)) errors.push('allowedProfiles must be a list of strings')
  for (const key of ['codexBin', 'zcodeDir']) if (key in c && typeof c[key] !== 'string') errors.push(`${key} must be a string`)
  if ('providers' in c && !isObject(c.providers)) errors.push('providers must be an object')
  else {
    for (const [id, entry] of Object.entries<any>(c.providers ?? {})) {
      if (!known.includes(id)) warnings.push(`unknown provider ${id} (known: ${known.join(', ')})`)
      if (!isObject(entry)) {
        errors.push(`providers.${id} must be an object`)
        continue
      }
      if ('enabled' in entry && typeof entry.enabled !== 'boolean') errors.push(`providers.${id}.enabled must be true or false`)
      if ('models' in entry && !isStrings(entry.models)) errors.push(`providers.${id}.models must be a list of strings`)
      for (const key of ['bin', 'dir']) if (key in entry && typeof entry[key] !== 'string') errors.push(`providers.${id}.${key} must be a string`)
    }
  }
  return { errors, warnings }
}

export const configKey = (config: Config) => createHash('sha256').update(JSON.stringify(config.providers)).digest('hex').slice(0, 16)

export function providerEnv(config: Config, id: string): ProviderEnv {
  const recordDir = process.env.BITFROST_RECORD_DIR
  return {
    runDir: RUN_DIR,
    socket: SOCKET,
    log,
    config: config.providers[id] ?? {},
    resolveBinary,
    recorder: (name) => {
      if (!recordDir) return null
      fs.mkdirSync(recordDir, { recursive: true })
      const file = path.join(recordDir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
      return (line) => fs.appendFileSync(file, line + '\n')
    },
  }
}

// Try the login shell too, since tools may only be on its PATH.
export function resolveBinary(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  const r = spawnSync(process.env.SHELL ?? '/bin/sh', ['-lic', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 })
  const found = (r.stdout ?? '').trim().split('\n').pop()
  return found && found.startsWith('/') ? found : null
}

// Link a file containing the PID into place so concurrent starts cannot see an empty lock.
export function takeLock(lock = LOCK): boolean {
  const mine = `${lock}.${process.pid}`
  fs.writeFileSync(mine, String(process.pid))
  try {
    fs.linkSync(mine, lock)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  } finally {
    fs.rmSync(mine, { force: true })
  }
  let holder = NaN
  try {
    holder = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10)
  } catch {}
  if (holder === process.pid) return true
  if (holder > 0 && alive(holder)) return false
  fs.rmSync(lock, { force: true })
  return takeLock(lock)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
