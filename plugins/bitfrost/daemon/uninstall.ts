// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrost uninstall: stops the helper, takes BitFrost out of Claude Code and
// the apps it set up, then deletes everything install.sh and the helper wrote.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'
import { CACHE, CONFIG, RUN_DIR, canonical, loadConfig, resolveBinary } from './config.ts'
import { PROVIDERS } from './providers/index.ts'

const HOME = os.homedir()
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'bitfrost')
const BIN = path.join(process.env.BITFROST_BIN_DIR || path.join(HOME, '.local', 'bin'), 'bitfrost')
const DEFAULT_PROFILE = canonical('~/.claude')

const say = (msg: string) => console.log(`bitfrost: ${msg}`)

// Same places install.sh looks, since a desktop app may hold the only copy.
function findClaude(): string | null {
  const found = resolveBinary('claude')
  if (found) return found
  const fixed = [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude')]
  const bundled = [path.join(HOME, '.config', 'Claude', 'claude-code'), path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code')].flatMap((dir) => {
    try {
      return fs.readdirSync(dir).map((v) => path.join(dir, v, 'claude'))
    } catch {
      return []
    }
  })
  return [...fixed, ...bundled].find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }) ?? null
}

// True when Claude did it, false when there was nothing to do.
function claudeRun(claude: string, profile: string, args: string[]): boolean {
  const env = { ...process.env }
  if (profile === DEFAULT_PROFILE) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = profile
  const r = spawnSync(claude, args, { env, encoding: 'utf8', timeout: 60_000 })
  if (r.status === 0) return true
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (/not found/i.test(out)) return false
  throw new Error(`claude ${args.join(' ')} failed for ${profile}: ${out || r.error?.message || `exit ${r.status}`}`)
}

function remove(p: string) {
  if (!fs.existsSync(p)) return
  fs.rmSync(p, { recursive: true, force: true })
  say(`removed ${p}`)
}

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('bitfrost uninstall: no terminal to ask in; run bitfrost uninstall --yes')
    return false
  }
  console.log(`This removes BitFrost from Claude Code and ZCode, and deletes:\n  ${[DATA, BIN, path.dirname(CONFIG) + ' (your BitFrost config)', path.dirname(CACHE)].join('\n  ')}`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Uninstall BitFrost? [y/N] ')
  rl.close()
  if (/^y(es)?$/i.test(answer.trim())) return true
  say('nothing changed')
  return false
}

// stop() shuts the helper down and returns why it couldn't, or null.
export async function uninstall(stop: () => Promise<string | null>, yes = false, ask = confirm): Promise<number> {
  if (!yes && !(await ask())) return 1
  const busy = await stop()
  if (busy) {
    console.error(`bitfrost uninstall: can't stop the helper (${busy}). Let the subagents finish (bitfrost status), then run this again.`)
    return 1
  }

  const profiles = [...new Set([...loadConfig().allowedProfiles, ...(process.env.CLAUDE_CONFIG_DIR ? [canonical(process.env.CLAUDE_CONFIG_DIR)] : [])])].filter((p) => fs.existsSync(p))
  const claude = findClaude()
  if (!claude) {
    say("Claude Code not found. To remove the plugin yourself, run:")
    console.log('    claude plugin uninstall bitfrost@bitfrost --scope user\n    claude plugin marketplace remove bitfrost')
  } else {
    try {
      for (const profile of profiles) {
        if (claudeRun(claude, profile, ['plugin', 'uninstall', 'bitfrost@bitfrost', '--scope', 'user'])) say(`removed the plugin from ${profile}`)
        claudeRun(claude, profile, ['plugin', 'marketplace', 'remove', 'bitfrost'])
        // Claude only marks its copy as orphaned and deletes it some time later.
        remove(path.join(profile, 'plugins', 'cache', 'bitfrost'))
      }
    } catch (e) {
      console.error(`bitfrost uninstall: ${(e as Error).message}`)
      console.error('bitfrost uninstall: stopped before deleting any files; fix that and run this again')
      return 1
    }
  }

  for (const p of PROVIDERS) p.uninstall?.()

  try {
    if (fs.lstatSync(BIN).isSymbolicLink() && fs.readlinkSync(BIN).startsWith(`${DATA}/`)) remove(BIN)
  } catch {}
  for (const p of [DATA, path.dirname(CONFIG), path.dirname(CACHE), RUN_DIR]) remove(p)

  say('BitFrost is uninstalled. Restart any open Claude sessions.')
  for (const profile of profiles) {
    const settings = path.join(profile, 'settings.json')
    try {
      if (fs.readFileSync(settings, 'utf8').includes('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS')) {
        say(`if no other plugin needs it, you can remove CLAUDE_CODE_ENABLE_FUNCTION_HOOKS from ${settings}`)
      }
    } catch {}
  }
  return 0
}
