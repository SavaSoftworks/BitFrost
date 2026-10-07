// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Settings that ask before they turn on. Each feature owns one top-level config
// key, and is asked about while that key is missing, so installs, updates,
// --from and --force all ask exactly what a user hasn't answered yet.

export type Option = { value: string; label: string; hint?: string }
export type Answers = Record<string, unknown>
// What a question's option list or condition gets to look at.
export type AskContext = { config: Record<string, any>; answers: Answers }

type Base = { key: string; prompt: string; help?: string; when?: (answers: Answers) => boolean }
export type Question =
  | (Base & { type: 'confirm'; default: boolean })
  | (Base & { type: 'choice'; default?: string; options: Option[] | ((ctx: AskContext) => Option[] | Promise<Option[]>) })

export type Feature = {
  id: string // also the name for bitfrost setup <id>
  key: string // its top-level key in config.json
  since: string
  title: string
  questions: Question[]
  // Written with the answers, for settings that aren't asked.
  defaults?: Answers
}

// The newest Claude model of each family. Config keeps the family name, so a
// release with a newer model moves everyone on that family to it.
export const CLAUDE_MODELS = [
  { family: 'haiku', label: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001' },
  { family: 'sonnet', label: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { family: 'opus', label: 'Opus 5.5', id: 'claude-opus-5-5' },
  { family: 'fable', label: 'Fable 5.1', id: 'claude-fable-5-1' },
]
// A family name to its model id. Anything else is taken as an id already.
export const claudeModelId = (model: string) => CLAUDE_MODELS.find((m) => m.family === model)?.id ?? model

export const claudeModels = (): Option[] => CLAUDE_MODELS.map((m) => ({ value: m.family, label: m.label }))

export const FEATURES: Feature[] = [
  {
    id: 'handback',
    key: 'handback',
    since: '0.9.1',
    title: 'Official handback',
    questions: [
      {
        key: 'enabled',
        type: 'confirm',
        prompt: 'Enable official subagent handback?',
        help: 'This uses an Anthropic model to process the handback, so its safety classifiers run on it.',
        default: false,
      },
      {
        key: 'model',
        type: 'choice',
        prompt: 'Which model should handle subagent handback calls?',
        when: (a) => a.enabled === true,
        options: claudeModels,
        default: 'sonnet',
      },
    ],
    defaults: { effort: 'low' },
  },
]

export const findFeature = (id: string) => FEATURES.find((f) => f.id === id)

// Features whose key the config doesn't have yet.
export const pendingFeatures = (config: unknown): Feature[] => {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
  return FEATURES.filter((f) => !(f.key in c))
}

export async function optionsFor(q: Question, ctx: AskContext): Promise<Option[]> {
  if (q.type !== 'choice') return []
  return typeof q.options === 'function' ? await q.options(ctx) : q.options
}

// Asks a feature's questions in order through ask, which returns null when it can't.
// Returns the value to store under the feature's key, or null when nothing was answered.
export async function askFeature(
  f: Feature,
  config: Record<string, any>,
  ask: (q: Question, options: Option[]) => Promise<unknown>,
): Promise<Answers | null> {
  const answers: Answers = {}
  for (const q of f.questions) {
    if (q.when && !q.when(answers)) continue
    const options = await optionsFor(q, { config, answers })
    // A choice with nothing to pick leaves the feature for later.
    if (q.type === 'choice' && !options.length) return null
    const value = await ask(q, options)
    if (value === null || value === undefined) return null
    answers[q.key] = value
  }
  return { ...answers, ...Object.fromEntries(Object.entries(f.defaults ?? {}).filter(([k]) => !(k in answers))) }
}
