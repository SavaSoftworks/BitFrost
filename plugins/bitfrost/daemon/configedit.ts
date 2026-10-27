// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Reads and writes config.json for bitfrost setup and the config screen.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateConfig } from './config.ts'
import { globMatch, turnsOn } from './registry.ts'

export type Raw = Record<string, any>

export class EditError extends Error {
  code: 'conflict' | 'config_invalid' | 'bad_request'
  constructor(code: EditError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const textOf = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// The hash of the file's text, or "" when there is no file.
export const revisionOf = (text: string | null) => (text === null ? '' : createHash('sha256').update(text).digest('hex'))
export const revision = (file: string) => revisionOf(textOf(file))

export function readRaw(file: string): Raw | string {
  let text: string | null
  try {
    text = textOf(file)
  } catch (e) {
    return (e as Error).message
  }
  if (text === null) return {}
  try {
    const c = JSON.parse(text)
    return c && typeof c === 'object' && !Array.isArray(c) ? c : 'it must be a JSON object'
  } catch (e) {
    return (e as Error).message
  }
}

// Write where a symlink points, so a config kept in a dotfiles folder stays linked.
export function writeRaw(file: string, raw: Raw) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  let mode = 0o600
  try { mode = fs.statSync(target).mode & 0o777 } catch {}
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode })
  // The umask narrows a new file's mode, so set the old one again.
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, target)
}

// Reads the file again just before writing, so edits made meanwhile are kept.
export function save(file: string, key: string, value: unknown): string | null {
  const raw = readRaw(file)
  if (typeof raw === 'string') return raw
  raw[key] = value
  writeRaw(file, raw)
  return null
}

// Applies one change if the file is still at the given revision and the result is valid.
export function edit(file: string, expected: string | undefined, change: (raw: Raw) => string[] | void): { revision: string; warnings: string[] } {
  const before = textOf(file)
  if (expected !== undefined && revisionOf(before) !== expected) throw new EditError('conflict', `${file} changed on disk; showing it again`)
  let raw: Raw
  try {
    raw = before === null ? {} : JSON.parse(before)
  } catch (e) {
    throw new EditError('config_invalid', `${file} is not valid JSON: ${(e as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EditError('config_invalid', `${file} must be a JSON object`)
  const notes = change(raw) ?? []
  const checked = validateConfig(raw)
  if (checked.errors.length) throw new EditError('config_invalid', checked.errors.join('; '))
  writeRaw(file, raw)
  return { revision: revision(file), warnings: [...notes, ...checked.warnings] }
}

const entryOf = (raw: Raw, id: string) => {
  if (!raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) raw.providers = {}
  if (!raw.providers[id] || typeof raw.providers[id] !== 'object') raw.providers[id] = {}
  return raw.providers[id] as Raw
}
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

// deny: apps serving their own company offer every model unless providers.<id>.disabled names it,
// except Claude models, which they offer once providers.<id>.anthropic names them.
// allow: apps serving many companies offer only what providers.<id>.models names.
export function setModel(raw: Raw, id: string, model: string, enabled: boolean, mode: 'deny' | 'allow', known: string[], claude = false): string[] {
  const entry = entryOf(raw, id)
  const notes: string[] = []
  const hasList = Array.isArray(entry.models)
  const covers = (p: string) => (claude ? turnsOn(p, { provider: 'Anthropic', model }) : globMatch(p, model))
  if (claude && mode === 'deny' && !hasList) {
    const rest = listOf(entry.anthropic).filter((p) => p !== model)
    const still = !enabled && rest.find((p) => globMatch(p, model))
    if (still) notes.push(`${model} is still turned on by "${still}" in providers.${id}.anthropic`)
    const list = enabled ? [...rest, model] : rest
    if (list.length) entry.anthropic = list
    else delete entry.anthropic
    if (enabled) {
      const disabled = listOf(entry.disabled).filter((p) => p !== model)
      if (disabled.length) entry.disabled = disabled
      else delete entry.disabled
    }
    return notes
  }
  if (enabled) {
    const disabled = listOf(entry.disabled).filter((p) => p !== model)
    const still = disabled.find((p) => globMatch(p, model))
    if (still) notes.push(`${model} is still turned off by "${still}" in providers.${id}.disabled`)
    if (disabled.length) entry.disabled = disabled
    else delete entry.disabled
    if (mode === 'allow' || hasList) {
      const models = listOf(entry.models)
      if (!models.some(covers)) models.push(model)
      entry.models = models
    }
  } else if (mode === 'deny' && !hasList) {
    const disabled = listOf(entry.disabled)
    if (!disabled.some((p) => globMatch(p, model))) disabled.push(model)
    entry.disabled = disabled
  } else {
    // A pattern that covers this model turns into the models it covers now, minus this one.
    const out: string[] = []
    for (const p of listOf(entry.models)) {
      if (!covers(p)) out.push(p)
      else if (p !== model && p.includes('*')) out.push(...known.filter((k) => k !== model && globMatch(p, k)))
    }
    entry.models = [...new Set(out)]
  }
  return notes
}

export function setProvider(raw: Raw, id: string, enabled: boolean) {
  entryOf(raw, id).enabled = enabled
}

// Sets a dotted key such as handback.model; undefined removes it.
export function setPath(raw: Raw, key: string, value: unknown) {
  const parts = key.split('.')
  let at = raw
  for (const part of parts.slice(0, -1)) {
    if (!at[part] || typeof at[part] !== 'object' || Array.isArray(at[part])) at[part] = {}
    at = at[part]
  }
  const last = parts.at(-1)!
  if (value === undefined) delete at[last]
  else at[last] = value
}

export function getPath(raw: Raw, key: string): unknown {
  let at: any = raw
  for (const part of key.split('.')) at = at && typeof at === 'object' ? at[part] : undefined
  return at
}
