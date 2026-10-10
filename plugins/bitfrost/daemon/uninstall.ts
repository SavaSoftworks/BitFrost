// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrost uninstall: stops the helper, takes BitFrost out of Claude Code and
// the apps it set up, then deletes everything install.sh and the helper wrote.
// The user's config and subagent history go only when they say so.
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
// The subagent history and usage stats, kept apart so a reinstall can pick them up again.
const HISTORY = ['bitfrost.db', 'bitfrost.db-wal', 'bitfrost.db-shm'].map((f) => path.join(DATA_DIR, f))

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
export type Plan = { program: Item[]; config: Item[]; history: Item[]; claude: string | null }
export type Choice = { program: boolean; config: boolean; history: boolean }

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

// What's in a folder besides the history files, which may live inside it.
const others = (dir: string) => {
  try {
    return fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => !HISTORY.some((h) => h === f || h.startsWith(`${f}/`)))
  } catch {
    return []
  }
}

export function planOf(claude = findClaude()): Plan {
  const file = (label: string, p: string): Item[] => (fs.existsSync(p) ? [{ label, path: p, size: sizeOf(p) }] : [])
  const history = HISTORY.filter((f) => fs.existsSync(f))
  const historySize = history.reduce((sum, f) => sum + sizeOf(f), 0)
  const appFiles = file('App files', DATA).map((i) => ({ ...i, size: (i.size ?? 0) - (DATA_DIR === DATA ? historySize : 0) }))
  return {
    claude,
    program: [
      // Only the plugin leaves the profile; the profile itself stays.
      ...profilesOf().filter(hasPlugin).map((profile) => ({ label: 'Claude Code plugin', path: pluginIn(profile) })),
      ...PROVIDERS.flatMap((p) => p.uninstall?.(true) ?? []).map((i) => ({ label: i.label, path: entryIn(i.path) })),
      ...appFiles,
      ...(DATA_DIR !== DATA && others(DATA_DIR).length ? [{ label: 'Helper data', path: DATA_DIR, size: others(DATA_DIR).reduce((sum, f) => sum + sizeOf(f), 0) }] : []),
      ...(ours() ? [{ label: 'Command', path: BIN }] : []),
      ...file('Model list cache', path.dirname(CACHE)),
      ...file('Helper runtime files', RUN_DIR),
    ],
    config: file('Config', path.dirname(CONFIG)),
    history: history.length ? [{ label: 'Subagent history and stats', path: HISTORY[0], size: historySize }] : [],
  }
}

function printGroup(n: number, title: string, items: Item[], width: [number, number]) {
  console.log(`${bold(` ${n}`)}  ${bold(title)}`)
  for (const i of items) console.log(`      ${i.label.padEnd(width[0])}  ${short(i.path).padEnd(width[1])}  ${i.size ? dim(human(i.size)) : ''}`.trimEnd())
}

export function printPlan(plan: Plan) {
  const all = [...plan.program, ...plan.config, ...plan.history]
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
  if (plan.history.length) {
    printGroup(3, 'Your history', plan.history, width)
    console.log()
  }
}

async function confirm(plan: Plan): Promise<Choice> {
  printPlan(plan)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    // Ctrl+D counts as no.
    const yes = async (q: string) => /^y(es)?$/i.test((await rl.question(`${blue('::')} ${bold(q)} [y/N] `).catch(() => '')).trim())
    // With BitFrost itself gone, only what's left is asked about.
    if (!plan.program.length) {
      const config = plan.config.length > 0 && (await yes('Remove your config (2)?'))
      const history = plan.history.length > 0 && (await yes(`${config ? 'Also remove' : 'Remove'} your subagent history and usage stats (3)?`))
      return { program: false, config, history }
    }
    if (!(await yes('Remove BitFrost itself (1)?'))) return { program: false, config: false, history: false }
    const config = plan.config.length > 0 && (await yes('Also remove your config (2)?'))
    const history = plan.history.length > 0 && (await yes('Also remove your subagent history and usage stats (3)?'))
    return { program: true, config, history }
  } finally {
    rl.close()
  }
}

async function remove(p: string, label: string) {
  if (!fs.existsSync(p)) return
  await task(label, `removing ${short(p)}`, () => fs.promises.rm(p, { recursive: true, force: true }))
  done(label, p)
}

// Removes a folder, or everything in it but the history when that stays.
async function removeAround(dir: string, label: string, keepHistory: boolean) {
  if (!keepHistory || !HISTORY.some((f) => f.startsWith(`${dir}/`) && fs.existsSync(f))) return remove(dir, label)
  const rest = others(dir)
  if (rest.length) {
    await task(label, `removing ${short(dir)}`, () => Promise.all(rest.map((f) => fs.promises.rm(f, { recursive: true, force: true }))))
    done(label, dir)
  }
  // Walk protected ancestors too, removing their siblings while keeping the database itself.
  for (const file of HISTORY) {
    if (!file.startsWith(`${dir}/`)) continue
    const child = path.join(dir, path.relative(dir, file).split(path.sep)[0])
    if (child !== file && fs.existsSync(child)) {
      await removeAround(child, label, true)
      break
    }
  }
}

export type Options = { yes?: boolean; keepConfig?: boolean; keepHistory?: boolean }
// stop() shuts the helper down and returns why it couldn't, or null; running() says whether it is up.
export type Helper = { stop: () => Promise<string | null>; running: () => Promise<boolean> }

export async function uninstall(helper: Helper, opts: Options = {}, ask: (plan: Plan) => Promise<Choice> = confirm): Promise<number> {
  let choice: Choice = { program: true, config: !opts.keepConfig, history: !opts.keepHistory }
  const claude = findClaude()
  if (!opts.yes) {
    if (!process.stdin.isTTY && ask === confirm) {
      fail('uninstall', 'no terminal to ask in; run bitfrost uninstall --yes (add --keep-config or --keep-history to keep those)')
      return 1
    }
    // Only a person reads the plan, so only then is it worth sizing every file.
    const plan = planOf(claude)
    if (!plan.program.length && !plan.config.length && !plan.history.length) {
      step('BitFrost is not on this machine. Nothing to remove.')
      return 0
    }
    choice = await ask(plan)
    if (!choice.program && !choice.config && !choice.history) {
      console.log(`\n${blue('::')} Nothing changed.`)
      return 1
    }
  }
  console.log()
  step(choice.program ? 'Removing BitFrost' : choice.config && choice.history ? 'Removing your config and history' : choice.config ? 'Removing your config' : 'Removing your history')
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
    await removeAround(DATA, 'App files', !choice.history)
    if (DATA_DIR !== DATA) await removeAround(DATA_DIR, 'Helper data', !choice.history)
    await remove(path.dirname(CACHE), 'Model list cache')
    await remove(RUN_DIR, 'Helper runtime files')
  }
  if (choice.config) await remove(path.dirname(CONFIG), 'Config')
  else if (fs.existsSync(CONFIG)) note(`${'Kept your config'.padEnd(LABEL)}  ${dim(short(CONFIG))}`)
  if (choice.history) {
    const files = HISTORY.filter((f) => fs.existsSync(f))
    if (files.length) {
      await task('History', `removing ${short(HISTORY[0])}`, () => Promise.all(files.map((f) => fs.promises.rm(f, { force: true }))))
      done('History', HISTORY[0])
    }
    // The folder goes too once nothing else is in it.
    try { if (!fs.readdirSync(DATA_DIR).length) fs.rmdirSync(DATA_DIR) } catch {}
  } else if (fs.existsSync(HISTORY[0])) note(`${'Kept your history'.padEnd(LABEL)}  ${dim(short(HISTORY[0]))}`)

  console.log()
  if (!choice.program) {
    step(choice.config && choice.history ? 'Your config and history are removed.' : choice.config ? 'Your config is removed.' : 'Your history is removed.')
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
