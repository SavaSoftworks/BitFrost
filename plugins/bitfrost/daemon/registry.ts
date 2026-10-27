// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import type { HarnessModel } from './provider.ts'

export type { HarnessModel }

export type AgentDef = HarnessModel & {
  name: string
  aliases: string[]
  family: string
  harnessName: string
}

const vendorKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')

export type Offer = null | 'disabled' | 'not_listed'

export const isAnthropic = (m: { provider: string }) => vendorKey(m.provider).startsWith('anthropic')

// A Claude model in a models list needs a pattern that names it; a bare wildcard is not enough.
export const turnsOn = (pattern: string, m: { provider: string; model: string }) =>
  globMatch(pattern, m.model) && (!isAnthropic(m) || pattern === m.model || /claude|anthropic/i.test(pattern))

// Apps serving many companies need a model list to keep host context small. Anthropic models
// stay off until named too: in models for those apps, in anthropic for an app's own list.
// Returns why a model isn't offered, or null when it is.
export function whyNot(m: HarnessModel, ownVendors: Map<string, string>, allow: Map<string, string[]>, deny: Map<string, string[]> = new Map(), anthropic: Map<string, string[]> = new Map()): Offer {
  const named = (list: string[] | undefined) => !!list?.some((pattern) => globMatch(pattern, m.model))
  if (named(deny.get(m.harness))) return 'disabled'
  const list = allow.get(m.harness)
  if (list) return list.some((pattern) => turnsOn(pattern, m)) ? null : 'not_listed'
  if (!ownVendors.has(m.harness)) return 'not_listed'
  return !isAnthropic(m) || named(anthropic.get(m.harness)) ? null : 'not_listed'
}

export function selectModels(found: HarnessModel[], ownVendors: Map<string, string>, allow: Map<string, string[]>, deny?: Map<string, string[]>, anthropic?: Map<string, string[]>): HarnessModel[] {
  return found.filter((m) => whyNot(m, ownVendors, allow, deny, anthropic) === null)
}

export function globMatch(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`, 'i').test(value)
}

export function agentName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

function familyOf(displayName: string): { family: string; vendor: string | null; version: string | null } {
  const tokens = displayName.replace(/\(.*?\)/g, ' ').split(/[-\s]+/).filter(Boolean)
  const v = tokens.findIndex((t) => /^\d+(\.\d+)*$/.test(t))
  if (v < 0) return { family: tokens.join(' ').toLowerCase(), vendor: null, version: null }
  const before = tokens.slice(0, v).join(' ').toLowerCase()
  const after = tokens.slice(v + 1).join(' ').toLowerCase()
  if (!after) return { family: before || tokens[v], vendor: null, version: tokens[v] }
  return { family: after, vendor: before || null, version: tokens[v] }
}

function newer(a: string | null, b: string | null): boolean {
  const pa = (a ?? '0').split('.').map(Number)
  const pb = (b ?? '0').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

// Build versioned aliases; bare names select the newest model in each family. A model run by its
// company's own app claims its name and aliases before the same model through another app.
// Claude models get no aliases, since names like sonnet already mean Claude Code's own models.
export function buildAgents(models: HarnessModel[], ownVendors: Map<string, string> = new Map()): AgentDef[] {
  const facts = new Map(models.map((m) => [m, familyOf(m.displayName)]))
  const own = (m: HarnessModel) => {
    const v = ownVendors.get(m.harness)
    return !!v && vendorKey(m.provider).startsWith(vendorKey(v))
  }
  const ranked = [...models].sort((a, b) => Number(own(b)) - Number(own(a)))
  const bareNames = (m: HarnessModel) => {
    const f = facts.get(m)!
    return f.vendor ? [f.family, `${f.vendor} ${f.family}`] : [f.family]
  }
  const newest = new Map<string, HarnessModel>()
  for (const m of ranked) {
    if (isAnthropic(m)) continue
    for (const bare of bareNames(m)) {
      const cur = newest.get(bare)
      if (!cur || newer(facts.get(m)!.version, facts.get(cur)!.version)) newest.set(bare, m)
    }
  }
  const taken = new Set<string>()
  const claimed = new Set<string>()
  const defs = new Map<HarnessModel, AgentDef>()
  for (const m of ranked) {
    const { family, vendor, version } = facts.get(m)!
    const aliases = new Set<string>()
    const claim = (alias: string) => { if (!claimed.has(alias)) { claimed.add(alias); aliases.add(alias) } }
    if (version && !isAnthropic(m)) {
      claim(`${family.replace(/\s+/g, '')}${version}`)
      claim(`${family} ${version}`)
      if (vendor) claim(`${vendor}${version} ${family}`)
    }
    for (const bare of bareNames(m)) if (newest.get(bare) === m) claim(bare)
    let name = agentName(m.model)
    while (taken.has(name)) name = `${name}-${m.harness}`
    taken.add(name)
    defs.set(m, { ...m, name, aliases: [...aliases], family, harnessName: m.harnessName ?? m.harness })
  }
  return models.map((m) => defs.get(m)!)
}

export function describe(a: AgentDef, all: AgentDef[]): string {
  const efforts = a.efforts.length
    ? ` Reasoning effort: ${a.efforts.join(' | ')} (default ${a.defaultEffort ?? 'set by the app'}); to choose one, make the prompt's first line "effort: <level>".`
    : ''
  const siblings = all.filter((o) => o !== a && o.family === a.family && o.harness === a.harness)
  const others = siblings.length
    ? ` Not to be confused with ${siblings.map((o) => `${o.displayName} (bitfrost:${o.name}${o.aliases.length ? `, "${o.aliases[0]}"` : ''})`).join(', ')}.`
    : ''
  const names = a.aliases.length ? ` Users may call it ${a.aliases.map((s) => `"${s}"`).join(', ')}.` : ''
  const about = a.description.trim()
  return (
    `${a.displayName}, ${a.provider}'s model ${a.model}, running in the real ${a.harnessName} app on this machine.` +
    `${about ? ` ${about}` : ''}${names}${others}${efforts} ` +
    `Works in the task's directory and can read, edit and run commands there.`
  )
}

export function nameTable(all: AgentDef[]): string {
  if (!all.length) return ''
  const rows = all.map((a) => {
    const efforts = a.efforts.length ? `; effort ${a.efforts.join('|')}, default ${a.defaultEffort ?? 'set by the app'}` : ''
    return `- ${a.aliases.map((s) => `"${s}"`).join(', ') || a.displayName} -> bitfrost:${a.name} (${a.displayName} via ${a.harnessName}${efforts})`
  })
  return [
    'Models from other companies that you can hand work to as subagents (via bitfrost). When the user names one of these, use exactly the matching subagent type. To set its reasoning effort ("sol6 on high"), make the first line of the prompt "effort: <level>".',
    ...rows,
  ].join('\n')
}
