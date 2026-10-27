// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { edit, revision, setModel } from '../configedit.ts'
import { whyNot } from '../registry.ts'
import { serveRpc } from '../tui-rpc.ts'
import { availableFeatures } from '../features.ts'
import { useTestSettings } from './fixtures/settings.ts'

const model = (harness: string, provider: string, id: string) => ({ harness, provider, model: id, displayName: id, description: '', efforts: [], defaultEffort: null, isDefault: false })

test('whyNot: deny lists, allow lists, and Claude models only once named', () => {
  const own = new Map([['codex', 'OpenAI'], ['agy', 'Google']])
  const allow = new Map([['opencode', ['opencode-go/*', 'anthropic/claude-opus-5']]])
  const deny = new Map([['codex', ['gpt-old*']]])
  const anthropic = new Map([['agy', ['claude-sonnet-4-6']]])
  // A Claude model runs through an app that lists it, like any other company's model.
  assert.equal(whyNot(model('opencode', 'Anthropic', 'anthropic/claude-opus-5'), own, allow, deny), null)
  assert.equal(whyNot(model('opencode', 'Anthropic', 'anthropic/claude-haiku-5'), own, allow, deny), 'not_listed')
  // A wildcard alone never turns a Claude model on; a pattern naming Claude does.
  assert.equal(whyNot(model('crush', 'Anthropic', 'anthropic/claude-haiku-5'), own, new Map([['crush', ['*']]]), deny), 'not_listed')
  assert.equal(whyNot(model('crush', 'OpenAI', 'openai/gpt-x'), own, new Map([['crush', ['*']]]), deny), null)
  assert.equal(whyNot(model('crush', 'Anthropic', 'anthropic/claude-haiku-5'), own, new Map([['crush', ['anthropic/*']]]), deny), null)
  // An app's own list offers everything but Claude models, which wait for the anthropic list.
  assert.equal(whyNot(model('agy', 'Google', 'gemini-3.8-flash'), own, allow, deny, anthropic), null)
  assert.equal(whyNot(model('agy', 'Anthropic', 'claude-sonnet-4-6'), own, allow, deny, anthropic), null)
  assert.equal(whyNot(model('agy', 'Anthropic', 'claude-opus-4-6-thinking'), own, allow, deny, anthropic), 'not_listed')
  assert.equal(whyNot(model('agy', 'Anthropic', 'claude-sonnet-4-6'), own, allow, new Map([['agy', ['claude-*']]]), anthropic), 'disabled')
  assert.equal(whyNot(model('opencode', 'OpenAI', 'opencode-go/gpt-x'), own, allow, deny), null)
  assert.equal(whyNot(model('opencode', 'OpenAI', 'gpt-x'), own, allow, deny), 'not_listed')
  assert.equal(whyNot(model('codex', 'OpenAI', 'gpt-old-1'), own, allow, deny), 'disabled')
  assert.equal(whyNot(model('codex', 'OpenAI', 'gpt-new'), own, allow, deny), null)
  assert.equal(whyNot(model('opencode', 'Moonshot', 'opencode-go/kimi'), own, allow, deny), null)
  assert.equal(whyNot(model('opencode', 'Moonshot', 'other/kimi'), own, allow, deny), 'not_listed')
  assert.equal(whyNot(model('omp', 'Moonshot', 'kimi'), own, allow, deny), 'not_listed')
})

test('setModel: a Claude model in an own-company app goes in and out of the anthropic list', () => {
  const raw: any = { providers: { agy: { disabled: ['claude-sonnet-4-6', 'gemini-old'] } } }
  setModel(raw, 'agy', 'claude-sonnet-4-6', true, 'deny', [], true)
  assert.deepEqual(raw.providers.agy, { disabled: ['gemini-old'], anthropic: ['claude-sonnet-4-6'] })
  setModel(raw, 'agy', 'claude-sonnet-4-6', false, 'deny', [], true)
  assert.deepEqual(raw.providers.agy, { disabled: ['gemini-old'] })
  // An app with a models list keeps using it, Claude models included.
  const listed: any = { providers: { agy: { models: ['gemini-*'] } } }
  setModel(listed, 'agy', 'claude-sonnet-4-6', true, 'deny', [], true)
  assert.deepEqual(listed.providers.agy, { models: ['gemini-*', 'claude-sonnet-4-6'] })
  // A wildcard doesn't cover a Claude model, so turning one on names it and turning it off keeps the wildcard.
  const wild: any = { providers: { crush: { models: ['*'] } } }
  setModel(wild, 'crush', 'anthropic/claude-haiku-5', true, 'allow', [], true)
  assert.deepEqual(wild.providers.crush, { models: ['*', 'anthropic/claude-haiku-5'] })
  setModel(wild, 'crush', 'anthropic/claude-haiku-5', false, 'allow', [], true)
  assert.deepEqual(wild.providers.crush, { models: ['*'] })
})

test('setModel: deny mode adds and removes exact ids in disabled', () => {
  const raw: any = {}
  setModel(raw, 'codex', 'gpt-a', false, 'deny', [])
  assert.deepEqual(raw.providers.codex, { disabled: ['gpt-a'] })
  setModel(raw, 'codex', 'gpt-a', false, 'deny', [])
  assert.deepEqual(raw.providers.codex.disabled, ['gpt-a'])
  setModel(raw, 'codex', 'gpt-a', true, 'deny', [])
  assert.deepEqual(raw.providers.codex, {})
  raw.providers.codex.disabled = ['gpt-*']
  assert.match(setModel(raw, 'codex', 'gpt-a', true, 'deny', [])[0], /still turned off by "gpt-\*"/)
})

test('setModel: allow mode lists ids, and turning one off expands a pattern', () => {
  const raw: any = { providers: { opencode: { enabled: true } } }
  setModel(raw, 'opencode', 'go/a', true, 'allow', [])
  setModel(raw, 'opencode', 'go/a', true, 'allow', [])
  assert.deepEqual(raw.providers.opencode, { enabled: true, models: ['go/a'] })
  setModel(raw, 'opencode', 'go/a', false, 'allow', [])
  assert.deepEqual(raw.providers.opencode.models, [])
  raw.providers.opencode.models = ['go/*', 'x/y']
  setModel(raw, 'opencode', 'go/b', false, 'allow', ['go/a', 'go/b', 'go/c', 'x/y'])
  assert.deepEqual(raw.providers.opencode.models, ['go/a', 'go/c', 'x/y'])
})

test('edit refuses a stale revision and an invalid result, and writes nothing then', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-edit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  assert.equal(revision(file), '')
  const first = edit(file, '', (raw) => { raw.retention = { eventsDays: 5 } })
  assert.equal(first.revision, revision(file))
  assert.throws(() => edit(file, '', () => {}), (e: any) => e.code === 'conflict')
  assert.throws(() => edit(file, first.revision, (raw) => { raw.retention.eventsDays = -1 }), (e: any) => e.code === 'config_invalid')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { retention: { eventsDays: 5 } })
})

// Runs the broker over in-memory streams with a fake helper.
function broker(t: any, replies: Record<string, (path: string) => any> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  const file = path.join(dir, 'config.json')
  const input = new PassThrough()
  const output = new PassThrough()
  const calls: string[] = []
  const daemon = {
    start: async () => true,
    call: async (method: string, p: string) => {
      calls.push(`${method} ${p}`)
      const hit = Object.entries(replies).find(([prefix]) => p.startsWith(prefix))
      return hit ? { status: 200, body: hit[1](p) } : { status: 200, body: { ok: true } }
    },
  }
  const done = serveRpc({ input, output, file, daemon })
  const waiting = new Map<number, (m: any) => void>()
  const notes: any[] = []
  let buf = ''
  output.on('data', (c) => {
    buf += c
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.id == null) notes.push(msg)
      else waiting.get(msg.id)?.(msg)
    }
  })
  let next = 1
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      input.write(JSON.stringify({ id, method, params }) + '\n')
    })
  t.after(async () => {
    input.end()
    await done
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { rpc, file, calls, notes, close: async () => { input.end(); await done } }
}

test('broker: wizard drafts are read-only and recap saves all new answers together', async (t) => {
  useTestSettings(t)
  const { rpc, file } = broker(t)
  fs.writeFileSync(file, JSON.stringify({ handback: { enabled: false }, settingsUpToDate: false, providers: { codex: { bin: '/custom' } } }))
  const original = fs.readFileSync(file, 'utf8')
  assert.equal((await rpc('hello', { protocol: 1 })).result.settingsUpToDate, false)
  let plan = (await rpc('settings.pending')).result
  assert.equal(plan.steps.length, 4)
  assert.ok(plan.steps.every((s: any) => s.help.includes('Test setting')))
  plan.answers.previewAppearance.choice = 'Compact'
  plan = (await rpc('settings.pending', { revision: plan.revision, answers: plan.answers })).result
  assert.equal(plan.steps[0].value, 'Compact')
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'moving between questions cannot save answers')
  const saved = await rpc('settings.configure', { revision: plan.revision, answers: plan.answers })
  assert.equal(saved.result.ok, true)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.settingsUpToDate, true)
  assert.equal(raw.previewAppearance.choice, 'Compact')
  assert.deepEqual(raw.providers, { codex: { bin: '/custom' } })
  assert.equal((await rpc('hello', { protocol: 1 })).result.settingsUpToDate, true)
  assert.deepEqual((await rpc('settings.pending')).result.steps, [])
})

test('broker: invalid or incomplete recap and concurrent edits cannot partially save', async (t) => {
  useTestSettings(t)
  const { rpc, file } = broker(t)
  fs.writeFileSync(file, '{"handback":{"enabled":false},"settingsUpToDate":true}')
  const original = fs.readFileSync(file, 'utf8')
  // Missing answers take precedence over a stale stored flag.
  assert.equal((await rpc('hello', { protocol: 1 })).result.settingsUpToDate, false)
  const plan = (await rpc('settings.pending')).result
  for (const answers of [{}, { ...plan.answers, previewStartup: { choice: 'invalid' } }, { ...plan.answers, unknown: {} }]) {
    assert.equal((await rpc('settings.configure', { revision: plan.revision, answers })).error.code, 'bad_request')
    assert.equal(fs.readFileSync(file, 'utf8'), original)
  }
  fs.writeFileSync(file, original + '\n')
  assert.equal((await rpc('settings.configure', { revision: plan.revision, answers: plan.answers })).error.code, 'conflict')
  assert.equal((await rpc('settings.pending', { revision: plan.revision, answers: plan.answers })).error.code, 'conflict')
  assert.equal(fs.readFileSync(file, 'utf8'), original + '\n')
})

test('broker: wizard re-evaluates conditional questions and drops hidden answers', async (t) => {
  useTestSettings(t, [])
  const { rpc } = broker(t)
  const initial = (await rpc('settings.pending')).result
  assert.equal(initial.steps.length, 1)
  assert.deepEqual(initial.answers.handback, { enabled: false, effort: 'low' })
  const enabled = (await rpc('settings.pending', { answers: { ...initial.answers, handback: { enabled: true } } })).result
  assert.equal(enabled.steps.length, 2)
  assert.equal(enabled.answers.handback.model, 'sonnet')
  const disabled = (await rpc('settings.pending', { answers: { ...enabled.answers, handback: { enabled: false, model: 'opus', effort: 'max' } } })).result
  assert.equal(disabled.steps.length, 1)
  assert.deepEqual(disabled.answers.handback, { enabled: false, effort: 'low' })
  assert.equal((await rpc('settings.configure', { revision: disabled.revision, answers: disabled.answers })).result.ok, true)
})

test('broker: hello, settings and model toggles edit config.json', async (t) => {
  const { rpc, file } = broker(t, { '/providers/opencode/models': () => ({ provider: 'opencode', pending: false, models: [{ model: 'go/a' }, { model: 'go/b' }] }) })
  const hello = (await rpc('hello', { protocol: 1 })).result
  assert.deepEqual([hello.protocol, hello.configPath, hello.revision], [1, file, ''])
  assert.equal((await rpc('hello', { protocol: 9 })).error.code, 'bad_request')

  const settings = (await rpc('settings.get')).result
  const items = settings.sections.flatMap((s: any) => s.items)
  assert.deepEqual(settings.sections.map((s: any) => s.id), ['general', ...availableFeatures().map((f) => f.id), 'retention', 'harnesses'])
  const model = items.find((i: any) => i.key === 'handback.model')
  assert.deepEqual(model.visibleWhen, { key: 'handback.enabled', equals: true })
  assert.ok(model.options.some((o: any) => o.value === 'sonnet'))
  assert.ok(items.some((i: any) => i.key === 'handback.effort'))
  const status = items.find((i: any) => i.key === 'handback.enabled')
  assert.deepEqual([status.group, status.label, status.states], ['Official handback', 'Status', ['Disabled', 'Enabled']])
  assert.deepEqual(items.filter((i: any) => i.group === 'Codex').map((i: any) => i.label), ['Status', 'Location'])
  assert.equal(items.find((i: any) => i.key === 'retention.eventsDays').unit, 'days')

  let rev = (await rpc('settings.set', { key: 'handback.enabled', value: true, revision: settings.revision })).result.revision
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).handback, { enabled: true, model: 'sonnet', effort: 'low' })
  assert.equal((await rpc('settings.set', { key: 'handback.model', value: 'nope', revision: rev })).error.code, 'bad_request')
  assert.equal((await rpc('settings.set', { key: 'what', value: 1, revision: rev })).error.code, 'unknown_key')
  assert.equal((await rpc('settings.set', { key: 'retention.eventsDays', value: 7, revision: 'stale' })).error.code, 'conflict')
  rev = (await rpc('settings.set', { key: 'allowedProfiles', value: [' ~/.claude ', '~/.claude-work', ''], revision: rev })).result.revision
  rev = (await rpc('settings.set', { key: 'providers.codex.bin', value: '  ', revision: rev })).result.revision

  await rpc('models.list', { provider: 'opencode' })
  rev = (await rpc('providers.set', { provider: 'opencode', enabled: true, revision: rev })).result.revision
  rev = (await rpc('models.set', { provider: 'opencode', model: 'go/a', enabled: true, revision: rev })).result.revision
  rev = (await rpc('models.set', { provider: 'codex', model: 'gpt-a', enabled: false, revision: rev })).result.revision
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.allowedProfiles, ['~/.claude', '~/.claude-work'])
  assert.deepEqual(saved.providers, { codex: { disabled: ['gpt-a'] }, opencode: { enabled: true, models: ['go/a'] } })
  assert.equal((await rpc('config.get')).result.revision, rev)
  assert.equal((await rpc('models.set', { provider: 'nope', model: 'x', enabled: true })).error.code, 'unknown_provider')
})

test('broker: asks the helper, keeps it up, and reports a slow listing when it lands', async (t) => {
  let pending = true
  const { rpc, calls, notes, close } = broker(t, {
    '/providers/codex/models': () => ({ provider: 'codex', pending, models: pending ? [] : [{ model: 'gpt-a' }] }),
    '/providers': () => ({ providers: [{ id: 'codex' }] }),
    '/stats/models': () => ({ rows: [], stamp: 1 }),
  })
  assert.deepEqual((await rpc('providers.list')).result, { providers: [{ id: 'codex' }] })
  assert.ok(calls.some((c) => c.startsWith('POST /viewers/')))
  assert.equal((await rpc('models.list', { provider: 'codex', refresh: true })).result.pending, true)
  assert.ok(calls.includes('GET /providers/codex/models?refresh=1'))
  pending = false
  const deadline = Date.now() + 5000
  while (!notes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(notes[0], { method: 'models.updated', params: { provider: 'codex' } })
  const stats = (await rpc('models.stats', { provider: 'codex', model: 'gpt-a' })).result
  assert.deepEqual([stats.rows.length, stats.rows[0].model, stats.rows[0].total.turns], [1, 'gpt-a', 0])
  assert.ok(calls.includes('GET /stats/models?provider=codex&model=gpt-a&since=0'))
  assert.equal((await rpc('models.stats', { provider: 'codex' })).error.code, 'bad_request')
  await close()
  assert.ok(calls.some((c) => c.startsWith('DELETE /viewers/')))
})

test('broker: settings answer before slow app detection, then say when it lands', async (t) => {
  let finish: () => void = () => {}
  const slow = new Promise<void>((r) => { finish = r })
  const daemon = {
    start: async () => true,
    call: async (_m: string, p: string) => {
      if (p === '/providers') await slow
      return { status: 200, body: p === '/providers' ? { providers: [{ id: 'codex', location: '/opt/codex' }] } : { ok: true } }
    },
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
  const codexPath = (id: number) => lines.find((l) => l.id === id).result.sections.flatMap((s: any) => s.items).find((i: any) => i.key === 'providers.codex.bin')?.found
  const started = Date.now()
  input.write('{"id":1,"method":"settings.get"}\n')
  await wait(() => lines.some((l) => l.id === 1))
  assert.ok(Date.now() - started < 2000, 'settings did not wait for detection')
  assert.equal(codexPath(1), undefined)
  finish()
  await wait(() => lines.some((l) => l.method === 'settings.updated'))
  input.write('{"id":2,"method":"settings.get"}\n')
  await wait(() => lines.some((l) => l.id === 2))
  input.end()
  await done
  assert.equal(codexPath(2), '/opt/codex')
  assert.equal(lines.filter((l) => l.method === 'settings.updated').length, 1)
})

test('broker: a helper that will not start is daemon_down, and bad lines get errors', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon: { start: async () => false, call: async () => null } })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  input.write('not json\n{"id":1,"method":"nope"}\n{"id":2,"method":"providers.list"}\n')
  const deadline = Date.now() + 2000
  while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  input.end()
  await done
  assert.deepEqual(lines.map((l) => l.error?.code).sort(), ['bad_request', 'bad_request', 'daemon_down'])
})

test('broker: a helper that went away is started again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let starts = 0
  let alive = true
  const daemon = {
    start: async () => { starts++; alive = true; return true },
    call: async (method: string, p: string) => (alive ? { status: 200, body: p === '/providers' ? { providers: [] } : { ok: true } } : null),
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (n: number) => { const end = Date.now() + 2000; while (lines.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
  input.write('{"id":1,"method":"providers.list"}\n')
  await wait(1)
  alive = false
  input.write('{"id":2,"method":"providers.list"}\n')
  await wait(2)
  input.end()
  await done
  assert.deepEqual(lines.map((l) => l.result?.providers), [[], []])
  assert.equal(starts, 2)
})

test('broker: stats ask only for the model on screen, then only for rows changed since', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hour = new Date().setMinutes(0, 0, 0)
  let stamp = 5
  let pending: any[] = [{ hour, input_tokens: 1, output_tokens: 0, turns: 1 }]
  const asked: string[] = []
  const daemon = {
    start: async () => true,
    call: async (_m: string, p: string) => {
      if (!p.startsWith('/stats/models')) return { status: 200, body: { ok: true } }
      asked.push(p)
      const rows = pending
      pending = []
      return { status: 200, body: { rows, stamp } }
    },
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon, statsMs: 30 })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
  input.write('{"id":1,"method":"models.stats","params":{"provider":"codex","model":"m"}}\n')
  await wait(() => lines.some((l) => l.id === 1))
  assert.equal(lines.find((l) => l.id === 1).result.rows[0].total.inputTokens, 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(lines.filter((l) => l.method === 'stats.updated').length, 0)
  assert.ok(asked.slice(1).every((p) => p.endsWith('model=m&since=5')), asked.join(' '))
  stamp = 6
  pending = [{ hour, input_tokens: 4, output_tokens: 0, turns: 2 }]
  await wait(() => lines.some((l) => l.method === 'stats.updated'))
  input.write('{"id":2,"method":"unwatch","params":{"what":"stats"}}\n')
  await wait(() => lines.some((l) => l.id === 2))
  const count = asked.length
  await new Promise((r) => setTimeout(r, 150))
  input.end()
  await done
  const updates = lines.filter((l) => l.method === 'stats.updated')
  assert.equal(updates.length, 1)
  assert.deepEqual([updates[0].params.provider, updates[0].params.rows[0].total.inputTokens, updates[0].params.rows[0].total.turns], ['codex', 4, 2])
  assert.equal(asked.length, count, 'nothing is asked after unwatching')
})

test('broker: the status page pages subagents, and watches only the rows it shows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let changed: any = { now: 1, stamp: 9, rows: [], newer: [] }
  const asked: string[] = []
  const daemon = {
    start: async () => true,
    call: async (_m: string, p: string) => {
      asked.push(p)
      const body = p.startsWith('/subagents/changed') ? changed : p.startsWith('/subagents/page') ? { now: 1, rows: [{ id: 'old' }], more: false } : p.startsWith('/subagents') ? { now: 1, running: [], recent: [] } : p === '/status' ? { version: 'x' } : { ok: true }
      return { status: 200, body }
    },
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon, subagentsMs: 30 })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
  input.write('{"id":1,"method":"status.get"}\n{"id":2,"method":"subagents.overview"}\n{"id":3,"method":"subagents.page","params":{"before":"5:a","limit":9999}}\n')
  await wait(() => [1, 2, 3].every((id) => lines.some((l) => l.id === id)))
  assert.equal(lines.find((l) => l.id === 1).result.version, 'x')
  assert.deepEqual(lines.find((l) => l.id === 3).result.rows, [{ id: 'old' }])
  assert.ok(asked.includes('/subagents/page?before=5%3Aa&limit=500'), asked.join(' '))
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!asked.some((p) => p.startsWith('/subagents/changed')), 'nothing is watched until asked')
  input.write('{"id":4,"method":"subagents.watch","params":{"ids":["a","b"],"top":"5:a","since":3}}\n')
  await wait(() => asked.some((p) => p.startsWith('/subagents/changed')))
  assert.ok(asked.find((p) => p.startsWith('/subagents/changed'))!.includes('ids=a%2Cb&since=3&top=5%3Aa'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(lines.filter((l) => l.method === 'subagents.changed').length, 0, 'quiet rows send nothing')
  assert.ok(asked.filter((p) => p.startsWith('/subagents/changed')).at(-1)!.includes('since=9'), 'the stamp moves forward')
  changed = { now: 2, stamp: 10, rows: [{ id: 'a', turns: 2 }], newer: [] }
  await wait(() => lines.some((l) => l.method === 'subagents.changed'))
  assert.deepEqual(lines.find((l) => l.method === 'subagents.changed').params, { now: 2, rows: [{ id: 'a', turns: 2 }], newer: [] })
  input.write('{"id":5,"method":"unwatch","params":{"what":"subagents"}}\n')
  await wait(() => lines.some((l) => l.id === 5))
  const watches = () => asked.filter((p) => p.startsWith('/subagents')).length
  const count = watches()
  await new Promise((r) => setTimeout(r, 150))
  input.end()
  await done
  assert.equal(watches(), count, 'nothing is asked after unwatching')
})

test('broker: a watched status page starts a helper that went away again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let starts = 0
  let alive = true
  let turns = 1
  const daemon = {
    start: async () => { starts++; alive = true; return true },
    call: async (_m: string, p: string) => {
      if (!alive) return null
      return { status: 200, body: p.startsWith('/subagents/changed') ? { now: 1, stamp: turns, rows: [{ id: 'a', turns }], newer: [] } : p.startsWith('/subagents') ? { now: 1, running: [], recent: [{ id: 'a' }] } : { ok: true } }
    },
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon, subagentsMs: 30 })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
  input.write('{"id":1,"method":"subagents.overview"}\n{"id":2,"method":"subagents.watch","params":{"ids":["a"],"since":0}}\n')
  await wait(() => lines.some((l) => l.method === 'subagents.changed'))
  alive = false
  turns = 2
  await wait(() => lines.some((l) => l.method === 'subagents.changed' && l.params.rows[0].turns === 2))
  input.end()
  await done
  assert.equal(starts, 2)
  assert.ok(lines.some((l) => l.method === 'subagents.changed' && l.params.rows[0].turns === 2), 'updates resume after the restart')
})

test('broker: the version check and a simulated update', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const input = new PassThrough()
  const output = new PassThrough()
  const daemon = { start: async () => true, call: async () => ({ status: 200, body: {} }) }
  process.env.BITFROST_PRETEND_VERSION = '0.9.0'
  t.after(() => { delete process.env.BITFROST_PRETEND_VERSION })
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon, latest: async () => '0.9.2', stepMs: 1 })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)) }
  input.write('{"id":1,"method":"update.check"}\n{"id":2,"method":"update.run","params":{"version":"latest; rm -rf"}}\n{"id":3,"method":"update.run","params":{"simulate":true,"version":"0.9.2"}}\n')
  await wait(() => lines.some((l) => l.method === 'update.finished'))
  input.end()
  await done
  assert.deepEqual(lines.find((l) => l.id === 1).result, { current: '0.9.0', latest: '0.9.2', available: true, error: null })
  assert.equal(lines.find((l) => l.id === 2).error.code, 'bad_request')
  const steps = lines.filter((l) => l.method === 'update.step')
  assert.equal(steps.length, 16)
  assert.deepEqual(steps.slice(0, 2).map((s) => [s.params.label, s.params.state]), [['Release', 'running'], ['Release', 'done']])
  assert.deepEqual(lines.find((l) => l.method === 'update.finished').params, { ok: true, version: '0.9.2', simulated: true })
})

// Runs a fake install.sh next to a fake tarball, the way BITFROST_UPDATE_FROM does.
async function realUpdate(t: any, body: string, asked = '0.9.2') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-update-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'install.sh'), body)
  fs.writeFileSync(path.join(dir, 'bitfrost-0.9.2.tar.gz'), '')
  process.env.BITFROST_UPDATE_FROM = path.join(dir, 'bitfrost-0.9.2.tar.gz')
  t.after(() => { delete process.env.BITFROST_UPDATE_FROM })
  const input = new PassThrough()
  const output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'c.json'), daemon: { start: async () => true, call: async () => null } })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((l) => JSON.parse(l))))
  process.env.BITFROST_PRETEND_VERSION = '0.9.0'
  t.after(() => { delete process.env.BITFROST_PRETEND_VERSION })
  input.write(`{"id":1,"method":"update.run","params":{"version":"${asked}"}}\n{"id":2,"method":"update.check"}\n`)
  const end = Date.now() + 5000
  while (!lines.some((l) => l.method === 'update.finished') && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  input.end()
  await done
  return lines
}

test('broker: a real update runs the release installer and follows its steps', async (t) => {
  const lines = await realUpdate(t, `printf '@@bitfrost\\trunning\\tUnpacking\\tbitfrost-0.9.2.tar.gz\\n'
printf 'some ordinary output\\n'
printf '@@bitfrost\\tdone\\tUnpacked\\t~/x/0.9.2\\n'
printf '@@bitfrost\\twarn\\tSomething small\\t\\n'
printf '@@bitfrost\\tdone\\tHelper\\trestarted\\n'
[ "$1" = --from ] && [ "$BITFROST_INSTALL_EVENTS" = 1 ] && [ "$BITFROST_DEFER_SETTINGS" = 1 ]
`)
  assert.deepEqual(lines.find((l) => l.id === 1).result, { ok: true, simulated: false })
  const steps = lines.filter((l) => l.method === 'update.step').map((l) => [l.params.index, l.params.state, l.params.label])
  assert.deepEqual(steps, [[0, 'running', 'Unpacking'], [0, 'done', 'Unpacked'], [1, 'warn', 'Something small'], [2, 'done', 'Helper']])
  assert.deepEqual(lines.find((l) => l.method === 'update.finished').params, { ok: true, version: '0.9.2' })
})

test('broker: a local tarball is what the check offers and what the update reports', async (t) => {
  const lines = await realUpdate(t, 'exit 0\n', '0.9.1')
  assert.deepEqual(lines.find((l) => l.method === 'update.finished').params, { ok: true, version: '0.9.2' })
  const check = lines.find((l) => l.id === 2).result
  assert.deepEqual([check.latest, check.available], ['0.9.2', true])
})

test('broker: a failed install reports the installer\'s own reason', async (t) => {
  const lines = await realUpdate(t, `printf '@@bitfrost\\tfail\\tbitfrost-tui-0.9.2-linux-x64 failed its checksum\\t\\n'
exit 1
`)
  assert.deepEqual(lines.find((l) => l.method === 'update.finished').params, { ok: false, version: '0.9.2', error: 'bitfrost-tui-0.9.2-linux-x64 failed its checksum' })
})


test('broker: midnight updates unchanged usage and keeps the all-time totals', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-midnight-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = new Date(2026, 9, 10, 23, 59, 59).getTime()
  let initial = true
  const daemon = {
    start: async () => true,
    call: async (_m: string, p: string) => {
      const rows = p.startsWith('/stats/models') && initial ? [{ hour: new Date(2026, 9, 10, 23).getTime(), input_tokens: 25, output_tokens: 0 }] : []
      if (p.startsWith('/stats/models')) initial = false
      return { status: 200, body: { rows, stamp: 1 } }
    },
  }
  const input = new PassThrough(), output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'config.json'), daemon, now: () => now, statsMs: 20 })
  t.after(async () => { input.end(); await done })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((line) => JSON.parse(line))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()) }
  input.write('{"id":1,"method":"models.stats","params":{"provider":"codex","model":"m"}}\n')
  await wait(() => lines.some((l) => l.id === 1))
  assert.equal(lines.find((l) => l.id === 1).result.rows[0].today.inputTokens, 25)
  now = new Date(2026, 9, 11, 0, 0, 1).getTime()
  await wait(() => lines.some((l) => l.method === 'stats.updated'))
  const row = lines.find((l) => l.method === 'stats.updated').params.rows[0]
  assert.deepEqual([row.today.inputTokens, row.total.inputTokens], [0, 25])
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(lines.filter((l) => l.method === 'stats.updated').length, 1, 'unchanged polls stay quiet after rollover')
})

test('broker: overview watches report a task that finished entirely between polls', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-rpc-recent-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let recent: any[] = []
  const asked: string[] = []
  const daemon = {
    start: async () => true,
    call: async (_m: string, p: string) => { asked.push(p); return { status: 200, body: { now: 1, stamp: 1, rows: [], newer: [], recent } } },
  }
  const input = new PassThrough(), output = new PassThrough()
  const done = serveRpc({ input, output, file: path.join(dir, 'config.json'), daemon, subagentsMs: 20 })
  t.after(async () => { input.end(); await done })
  const lines: any[] = []
  output.on('data', (c) => lines.push(...String(c).trim().split('\n').map((line) => JSON.parse(line))))
  const wait = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()) }
  input.write('{"id":1,"method":"subagents.watch","params":{"ids":[],"overview":true}}\n')
  await wait(() => lines.some((l) => l.method === 'subagents.changed'))
  assert.ok(asked.some((p) => p.startsWith('/subagents/changed') && p.includes('recent=1')))
  recent = [{ id: 'fast', running: false, state: 'idle' }]
  await wait(() => lines.some((l) => l.params?.recent?.[0]?.id === 'fast'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(lines.filter((l) => l.params?.recent?.[0]?.id === 'fast').length, 1, 'unchanged recent snapshot sends nothing')
})
