// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

// A draft is resolved through the same registry as CLI setup. Nothing is written
// until the recap is confirmed; conditions and dynamic options are re-evaluated.
import { EditError, type Raw } from './configedit.ts'
import { optionsFor, pendingFeatures, shows, type Answers } from './features.ts'

const object = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

export async function settingsPlan(raw: Raw, draft: unknown = {}, strict = false) {
  if (!object(draft)) throw new EditError('bad_request', 'settings answers must be an object')
  const features = pendingFeatures(raw)
  if (strict && Object.keys(draft).some((key) => !features.some((f) => f.key === key))) {
    throw new EditError('bad_request', 'settings changed; reopen Configure new settings')
  }
  const answers: Record<string, Answers> = {}
  const steps: { feature: string; key: string; title: string; label: string; prompt: string; help?: string; options: { value: unknown; label: string; hint?: string }[]; value: unknown }[] = []
  const config = { ...raw }
  for (const f of features) {
    const supplied = draft[f.key] ?? {}
    if (!object(supplied)) throw new EditError('bad_request', `${f.title}: answers must be an object`)
    if (strict && Object.keys(supplied).some((key) => !f.questions.some((q) => q.key === key) && !(key in (f.defaults ?? {})))) {
      throw new EditError('bad_request', `${f.title}: unknown answer`)
    }
    const chosen: Answers = {}
    for (const q of f.questions) {
      if (!shows(q.when, chosen)) continue
      const options = q.type === 'confirm'
        ? [{ value: false, label: q.states?.[0] ?? 'No' }, { value: true, label: q.states?.[1] ?? 'Yes' }]
        : await optionsFor(q, { config, answers: chosen })
      if (!options.length) throw new EditError('bad_request', `${f.title}: no options available yet`)
      let value = supplied[q.key]
      if (!options.some((o) => o.value === value)) {
        if (strict) throw new EditError('bad_request', `${f.title}: choose a valid answer for ${q.label ?? q.prompt}`)
        value = options.some((o) => o.value === q.default) ? q.default : options[0].value
      }
      chosen[q.key] = value
      steps.push({ feature: f.key, key: q.key, title: f.title,
        label: !q.label || q.label === f.title ? f.title : `${f.title}: ${q.label}`,
        prompt: q.prompt, help: q.help, options, value })
    }
    answers[f.key] = { ...f.defaults, ...chosen }
    config[f.key] = answers[f.key]
  }
  return { answers, steps }
}
