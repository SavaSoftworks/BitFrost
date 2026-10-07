// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrost setup for features: asks their questions and saves the answers in config.json.
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.ts'
import { askFeature, optionsFor, pendingFeatures, type Answers, type Feature } from './features.ts'
import { asker, Cancelled, openTerminal, type Terminal } from './prompt.ts'
import { done, fail, note, step, warn } from './ui.ts'

// Exit code when there are questions but no terminal to ask them on. The installer lists them as a next step.
export const NEED_TERMINAL = 3

function readRaw(file: string): Record<string, any> | string {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : (e as Error).message
  }
  try {
    const c = JSON.parse(text)
    return c && typeof c === 'object' && !Array.isArray(c) ? c : 'it must be a JSON object'
  } catch (e) {
    return (e as Error).message
  }
}

// Reads the file again just before writing, so edits made while asking are kept.
function save(file: string, key: string, value: Answers): string | null {
  const raw = readRaw(file)
  if (typeof raw === 'string') return raw
  raw[key] = value
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  let mode = 0o600
  try { mode = fs.statSync(file).mode & 0o777 } catch {}
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode })
  // The umask narrows a new file's mode, so set the old one again.
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
  return null
}

async function describe(f: Feature, answers: Answers, config: Record<string, any>): Promise<string> {
  const parts: string[] = []
  for (const q of f.questions) {
    if (!(q.key in answers)) continue
    if (q.type === 'confirm') parts.push(answers[q.key] ? 'on' : 'off')
    else parts.push((await optionsFor(q, { config, answers })).find((o) => o.value === answers[q.key])?.label ?? String(answers[q.key]))
  }
  return parts.join(', ')
}

// Asks about the given features, or the unanswered ones when none are given.
// newOnly is the installer's call: quiet when there's nothing to ask.
export async function setupFeatures(opts: { features?: Feature[]; newOnly?: boolean; file?: string; terminal?: () => Terminal | null } = {}): Promise<number> {
  const file = opts.file ?? CONFIG
  const raw = readRaw(file)
  if (typeof raw === 'string') {
    fail('setup', `${file} is invalid (${raw}); fix it, then run bitfrost setup again`)
    return 1
  }
  const list = opts.features ?? pendingFeatures(raw)
  if (!list.length) {
    if (!opts.newOnly) note('Every setting is chosen. To change one, run bitfrost setup <name>.')
    return 0
  }
  const term = (opts.terminal ?? openTerminal)()
  if (!term) {
    if (!opts.newOnly) fail('setup', 'this needs a terminal to ask its questions on')
    return NEED_TERMINAL
  }
  if (opts.newOnly) step('New settings')
  try {
    for (const f of list) {
      const answers = await askFeature(f, raw, asker(term))
      if (!answers) {
        warn(`${f.title} has nothing to choose from yet; run bitfrost setup ${f.id} later`)
        continue
      }
      const why = save(file, f.key, answers)
      if (why) {
        fail('setup', `could not save ${f.title} in ${file}: ${why}`)
        return 1
      }
      raw[f.key] = answers
      console.log()
      done(f.title, await describe(f, answers, raw))
    }
  } catch (e) {
    if (e instanceof Cancelled) {
      console.log()
      warn('Stopped. Unanswered settings stay off; run bitfrost setup to choose them.')
      return 130
    }
    throw e
  } finally {
    term.close()
  }
  return 0
}
