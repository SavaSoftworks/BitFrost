// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrost uninstall: stops the helper, takes BitFrost out of Claude Code and
// the apps it set up, then deletes everything install.sh and the helper wrote.
// The user's config goes only when they say so.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import readline from 'node:readline/promises'
import { CACHE, CONFIG, DATA_DIR, RUN_DIR, canonical, loadConfig, resolveBinary } from './config.ts'
import { PROVIDERS } from './providers/index.ts'
import { LABEL, blue, bold, dim, done, fail, note, short, step, task, yellow } from './ui.ts'

const HOME = os.homedir()
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'bitfrost')
const BIN = path.join(process.env.BITFROST_BIN_DIR || path.join(HOME, '.local', 'bin'), 'bitfrost')
const DEFAULT_PROFILE = canonical('~/.claude')

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
async function claudeRun(claude: string, profile: string, args: string[]): Promise<boolean> {
  const env = { ...process.env }
  if (profile === DEFAULT_PROFILE) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = profile
  try {
    await promisify(execFile)(claude, args, { env, encoding: 'utf8', timeout: 60_000 })
    return true
  } catch (e) {
    const r = e as { stdout?: string; stderr?: string; message: string }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    if (/not found/i.test(out)) return false
    throw new Error(`claude ${args.join(' ')} failed for ${profile}: ${out || r.message}`)
  }
}

// A line of the plan: what goes, where, and how much disk it frees.
type Item = { label: string; path: string; size?: number }
const pluginIn = (profile: string) => `bitfrost@bitfrost from ${short(profile)}`
// Apps keep their own config; only BitFrost's entry leaves it.
const entryIn = (file: string) => `from ${short(file)}`
export type Plan = { program: Item[]; config: Item[]; claude: string | null }
export type Choice = { program: boolean; config: boolean }

function sizeOf(p: string): number {
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory()) return st.size
    return fs.readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0)
  } catch {
    return 0
  }
}

function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes, u = 0
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++ }
  return u ? `${n.toFixed(1)} ${units[u]}` : `${n} B`
}

const ours = () => {
  try { return fs.lstatSync(BIN).isSymbolicLink() && fs.readlinkSync(BIN).startsWith(`${DATA}/`) } catch { return false }
}

function profilesOf(): string[] {
  return [...new Set([...loadConfig().allowedProfiles, ...(process.env.CLAUDE_CONFIG_DIR ? [canonical(process.env.CLAUDE_CONFIG_DIR)] : [])])].filter((p) => fs.existsSync(p))
}

// Whether Claude lists BitFrost in this profile, or still holds a copy of it.
function hasPlugin(profile: string): boolean {
  const listed = (file: string, key: string, inner?: string) => {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(profile, 'plugins', file), 'utf8'))
      return key in ((inner ? json[inner] : json) ?? {})
    } catch {
      return false
    }
  }
  return listed('installed_plugins.json', 'bitfrost@bitfrost', 'plugins') || listed('known_marketplaces.json', 'bitfrost') || fs.existsSync(path.join(profile, 'plugins', 'cache', 'bitfrost'))
}

export function planOf(claude = findClaude()): Plan {
  const file = (label: string, p: string): Item[] => (fs.existsSync(p) ? [{ label, path: p, size: sizeOf(p) }] : [])
  return {
    claude,
    program: [
      // Only the plugin leaves the profile; the profile itself stays.
      ...profilesOf().filter(hasPlugin).map((profile) => ({ label: 'Claude Code plugin', path: pluginIn(profile) })),
      ...PROVIDERS.flatMap((p) => p.uninstall?.(true) ?? []).map((i) => ({ label: i.label, path: entryIn(i.path) })),
      ...file('App files', DATA),
      ...(DATA_DIR !== DATA ? file('Subagent history', DATA_DIR) : []),
      ...(ours() ? [{ label: 'Command', path: BIN }] : []),
      ...file('Model list cache', path.dirname(CACHE)),
      ...file('Helper runtime files', RUN_DIR),
    ],
    config: file('Config', path.dirname(CONFIG)),
  }
}

function printGroup(n: number, title: string, items: Item[], width: [number, number]) {
  console.log(`${bold(` ${n}`)}  ${bold(title)}`)
  for (const i of items) console.log(`      ${i.label.padEnd(width[0])}  ${short(i.path).padEnd(width[1])}  ${i.size ? dim(human(i.size)) : ''}`.trimEnd())
}

export function printPlan(plan: Plan) {
  const all = [...plan.program, ...plan.config]
  const width: [number, number] = [Math.max(0, ...all.map((i) => i.label.length)), Math.max(0, ...all.map((i) => short(i.path).length))]
  console.log(`\n${bold('BitFrost uninstall')}\n`)
  if (plan.program.length) {
    printGroup(1, 'BitFrost itself', plan.program, width)
    if (!plan.claude) console.log(`      ${yellow("Claude Code not found; you'll get the commands to remove the plugin yourself")}`)
    console.log()
  }
  if (plan.config.length) {
    printGroup(2, 'Your config', plan.config, width)
    console.log()
  }
}

async function confirm(plan: Plan): Promise<Choice> {
  printPlan(plan)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    // Ctrl+D counts as no.
    const yes = async (q: string) => /^y(es)?$/i.test((await rl.question(`${blue('::')} ${bold(q)} [y/N] `).catch(() => '')).trim())
    // With only the config left, that is the one question.
    if (!plan.program.length) return { program: false, config: await yes('Remove your config (2)?') }
    if (!(await yes('Remove BitFrost itself (1)?'))) return { program: false, config: false }
    return { program: true, config: plan.config.length > 0 && (await yes('Also remove your config (2)?')) }
  } finally {
    rl.close()
  }
}

async function remove(p: string, label: string) {
  if (!fs.existsSync(p)) return
  await task(label, `removing ${short(p)}`, () => fs.promises.rm(p, { recursive: true, force: true }))
  done(label, p)
}

export type Options = { yes?: boolean; keepConfig?: boolean }
// stop() shuts the helper down and returns why it couldn't, or null; running() says whether it is up.
export type Helper = { stop: () => Promise<string | null>; running: () => Promise<boolean> }

export async function uninstall(helper: Helper, opts: Options = {}, ask: (plan: Plan) => Promise<Choice> = confirm): Promise<number> {
  let choice: Choice = { program: true, config: !opts.keepConfig }
  const claude = findClaude()
  if (!opts.yes) {
    if (!process.stdin.isTTY && ask === confirm) {
      fail('uninstall', 'no terminal to ask in; run bitfrost uninstall --yes (add --keep-config to keep your config)')
      return 1
    }
    // Only a person reads the plan, so only then is it worth sizing every file.
    const plan = planOf(claude)
    if (!plan.program.length && !plan.config.length) {
      step('BitFrost is not on this machine. Nothing to remove.')
      return 0
    }
    choice = await ask(plan)
    if (!choice.program && !choice.config) {
      console.log(`\n${blue('::')} Nothing changed.`)
      return 1
    }
  }
  console.log()
  step(choice.program ? 'Removing BitFrost' : 'Removing your config')
  const profiles = profilesOf()
  if (choice.program) {
    const up = await helper.running()
    if (up) {
      const busy = await task('Helper', 'stopping it', helper.stop)
      if (busy) {
        fail('uninstall', `can't stop the helper (${busy}). Let the subagents finish (bitfrost status), then run this again.`)
        return 1
      }
      done('Helper', 'stopped')
    }
    if (!claude) {
      note("Claude Code not found. To remove the plugin yourself, run:")
      console.log('       claude plugin uninstall bitfrost@bitfrost --scope user\n       claude plugin marketplace remove bitfrost')
    } else {
      try {
        for (const profile of profiles) {
          const removed = await task('Claude Code plugin', `removing it from ${short(profile)}`, async () => {
            const removed = await claudeRun(claude, profile, ['plugin', 'uninstall', 'bitfrost@bitfrost', '--scope', 'user'])
            await claudeRun(claude, profile, ['plugin', 'marketplace', 'remove', 'bitfrost'])
            // Claude only marks its copy as orphaned and deletes it some time later.
            await fs.promises.rm(path.join(profile, 'plugins', 'cache', 'bitfrost'), { recursive: true, force: true })
            return removed
          })
          if (removed) done('Claude Code plugin', pluginIn(profile))
        }
      } catch (e) {
        fail('uninstall', `${(e as Error).message}`)
        fail('uninstall', 'stopped before deleting any files; fix that and run this again')
        return 1
      }
    }

    for (const p of PROVIDERS) for (const i of p.uninstall?.() ?? []) done(i.label, entryIn(i.path))
    if (ours()) await remove(BIN, 'Command')
    await remove(DATA, 'App files')
    if (DATA_DIR !== DATA) await remove(DATA_DIR, 'Subagent history')
    await remove(path.dirname(CACHE), 'Model list cache')
    await remove(RUN_DIR, 'Helper runtime files')
  }
  if (choice.config) await remove(path.dirname(CONFIG), 'Config')
  else if (fs.existsSync(CONFIG)) note(`${'Kept your config'.padEnd(LABEL)}  ${dim(short(CONFIG))}`)

  console.log()
  if (!choice.program) {
    step('Your config is removed.')
    return 0
  }
  step('BitFrost is uninstalled. Restart any open Claude sessions.')
  for (const profile of profiles) {
    const settings = path.join(profile, 'settings.json')
    try {
      if (fs.readFileSync(settings, 'utf8').includes('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS')) {
        note(`If no other plugin needs it, you can remove CLAUDE_CODE_ENABLE_FUNCTION_HOOKS from ${short(settings)}`)
      }
    } catch {}
  }
  return 0
}
