// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURES, CLAUDE_MODELS, askFeature, claudeModelId, claudeModels, findFeature, optionsFor, pendingFeatures, type Feature, type Question } from '../features.ts'
import { PROVIDERS } from '../providers/index.ts'

const handback = findFeature('handback')!

test('pendingFeatures asks for missing keys, but never re-asks a declined setting', () => {
  assert.deepEqual(pendingFeatures({}), FEATURES)
  assert.deepEqual(pendingFeatures({ providers: {} }), FEATURES)
  assert.deepEqual(pendingFeatures({ handback: { enabled: false } }), [])
  assert.deepEqual(pendingFeatures({ handback: { enabled: true, model: 'sonnet' } }), [])
  // Presence, rather than truthiness, decides whether a setting has been answered.
  assert.deepEqual(pendingFeatures({ handback: null }), [])
  for (const config of [undefined, null, false, 'bad', []]) assert.deepEqual(pendingFeatures(config), FEATURES)
})

test('feature ids and keys are unique and ids do not collide with any provider', () => {
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length)
  assert.equal(new Set(FEATURES.map((f) => f.key)).size, FEATURES.length)
  for (const feature of FEATURES) {
    assert.ok(!PROVIDERS.some((p) => p.id === feature.id), feature.id)
    assert.equal(findFeature(feature.id), feature)
  }
  assert.equal(findFeature('not-a-feature'), undefined)
})

test('every registered choice has non-empty, unique options and a valid default', async () => {
  for (const feature of FEATURES) {
    for (const q of feature.questions) {
      if (q.type !== 'choice') continue
      const options = await optionsFor(q, { config: {}, answers: { enabled: true } })
      assert.ok(options.length > 0, `${feature.id}.${q.key}`)
      assert.equal(new Set(options.map((o) => o.value)).size, options.length)
      for (const option of options) { assert.ok(option.value); assert.ok(option.label) }
      if (q.default !== undefined) assert.ok(options.some((o) => o.value === q.default))
    }
  }
})

test('Claude family options resolve to model ids and unknown strings pass through', () => {
  assert.deepEqual(claudeModels(), CLAUDE_MODELS.map((m) => ({ value: m.family, label: m.label })))
  assert.ok(CLAUDE_MODELS.length > 0)
  for (const model of CLAUDE_MODELS) {
    assert.equal(claudeModelId(model.family), model.id)
    assert.equal(claudeModelId(model.id), model.id)
  }
  assert.equal(claudeModelId('custom-model-2026'), 'custom-model-2026')
})

test('declining handback skips the model question and includes the unasked effort default', async () => {
  const asked: string[] = []
  const answer = await askFeature(handback, {}, async (q, options) => {
    asked.push(q.key)
    assert.equal(q.type, 'confirm')
    assert.equal(q.default, false)
    assert.deepEqual(options, [])
    return false
  })
  assert.deepEqual(asked, ['enabled'])
  assert.deepEqual(answer, { enabled: false, effort: 'low' })
  assert.deepEqual(pendingFeatures({ handback: answer }), [])
})

test('enabling handback asks the model next and keeps its family in the answers', async () => {
  const asked: string[] = []
  const answer = await askFeature(handback, {}, async (q, options) => {
    asked.push(q.key)
    if (q.type === 'confirm') return true
    assert.equal(q.default, 'sonnet')
    assert.deepEqual(options, claudeModels())
    return 'opus'
  })
  assert.deepEqual(asked, ['enabled', 'model'])
  assert.deepEqual(answer, { enabled: true, model: 'opus', effort: 'low' })
})

test('optionsFor supports static and async contextual options and ignores confirms', async () => {
  const options = [{ value: 'custom', label: 'Custom' }]
  const config = { providers: { codex: {} } }
  const answers = { enabled: true }
  const ctx = { config, answers }
  const q: Question = { type: 'choice', key: 'model', prompt: 'Model?', options }
  assert.equal(await optionsFor(q, ctx), options)
  assert.equal(await optionsFor({ ...q, options: async (seen) => {
    assert.equal(seen, ctx)
    return options
  } }, ctx), options)
  assert.deepEqual(await optionsFor({ type: 'confirm', key: 'enabled', prompt: 'Enable?', default: false }, ctx), [])
})

test('askFeature passes config and prior answers to options and preserves answers over defaults', async () => {
  const config = { customModel: 'custom' }
  const feature: Feature = {
    id: 'contextual', key: 'contextual', title: 'Contextual', since: '0.0.0',
    defaults: { model: 'fallback', enabled: false, effort: 'low' },
    questions: [
      { type: 'confirm', key: 'enabled', prompt: 'Enable?', default: false },
      { type: 'choice', key: 'model', prompt: 'Model?', when: (a) => a.enabled === true, options: async (ctx) => {
        assert.equal(ctx.config, config)
        assert.deepEqual(ctx.answers, { enabled: true })
        return [{ value: ctx.config.customModel, label: 'Custom' }]
      } },
    ],
  }
  assert.deepEqual(await askFeature(feature, config, async (q, options) => q.type === 'confirm' ? true : options[0].value),
    { enabled: true, model: 'custom', effort: 'low' })
})

test('null or undefined from either question abandons the whole feature', async () => {
  for (const value of [null, undefined]) {
    for (const stopAt of ['enabled', 'model']) {
      const asked: string[] = []
      assert.equal(await askFeature(handback, {}, async (q) => {
        asked.push(q.key)
        return q.key === stopAt ? value : true
      }), null)
      assert.deepEqual(asked, stopAt === 'enabled' ? ['enabled'] : ['enabled', 'model'])
    }
  }
})

test('an empty choice abandons the feature without asking that question', async () => {
  const feature: Feature = { ...handback, questions: handback.questions.map((q) => q.type === 'choice' ? { ...q, options: [] } : q) }
  const asked: string[] = []
  assert.equal(await askFeature(feature, {}, async (q) => { asked.push(q.key); return true }), null)
  assert.deepEqual(asked, ['enabled'])
  // A skipped empty choice must not prevent saving a decline.
  assert.deepEqual(await askFeature(feature, {}, async () => false), { enabled: false, effort: 'low' })
})
