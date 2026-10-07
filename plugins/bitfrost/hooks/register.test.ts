// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for hooks/register.js against a faked bitfrostd. The plugin's module
// state persists, so tests run in order and share the socket the first finds.
import { test, expect, mock } from 'claude-code/testing'

const SOCK = '/tmp/bitfrost-test-1000/bitfrost/bitfrostd.sock'
const NAME_TABLE = 'bitfrost models: sol6 = bitfrost:gpt-6-sol (Codex)'
const NEW_SETTINGS_NOTICE = 'BitFrost has new settings, off until you choose them. To choose them, run bitfrost setup in a terminal.'
const SOL = {
  name: 'gpt-6-sol',
  description: 'GPT-6 Sol for long tasks',
  model: 'gpt-6-sol',
  displayName: 'GPT-6-Sol',
  aliases: ['sol6'],
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  family: 'gpt-6',
  harness: 'codex',
}
const KEY = expect.stringMatching(/^ci_/)
const MAIN_ROWS = [{ role: 'user', text: 'please fix the failing test', toolUses: [] }]

type Scripted = { events: any[]; items: Record<string, any>; approvals: any[]; state?: string; lastSeq?: number; summary?: any; messages?: any; item?: any }

// A fake bitfrostd: each POST /sessions takes the next scripted session the test queued.
const world = (on: any, opts: { store?: Record<string, unknown> } = {}) => {
  const fake = {
    health: {
      version: '0.7.1', busy: false, configError: null as string | null,
      handback: null as { model: string; effort?: string | null } | null,
      newSettings: [] as string[],
    },
    healthFailure: null as 'http' | 'transport' | null,
    leaseReply: null as { status: number; body: any } | null, // null: a healthy lease
    renewalReply: null as { status: number; body: any } | null,
    agentsReply: { agents: [SOL], nameTable: NAME_TABLE, at: 1 } as { agents: any[]; nameTable: string; at: number; hint?: string },
    reviewReply: { isAnswered: true, text: 'ALLOW\nroutine work for the task.', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    queue: [] as Scripted[],
    inputReply: null as any, // null: started
    inputReplies: [] as any[], // taken first, one per POST /input
    inputDelayMs: 0, // a slow POST /input, answered when the clock moves
    // Per POST /input: 'accept' takes it and then the answer is lost, 'lose' loses it before the helper sees it.
    inputFailures: [] as ('accept' | 'lose')[],
    interruptReplies: [] as { status: number; body: any }[],
    attachFailures: 0, // 500s before an attach works
    storeFail: false,
    holdItems: false, // item waits answer only when the clock moves
    holdEvents: false, // an empty event wait answers only when the clock moves
    sendMessageDelays: [] as number[], // the engine's SendMessage, slow after its send
    modelStep: null as ((e: any) => AsyncGenerator<any, any, any>) | null,
  }
  const sessions = new Map<string, Scripted>()
  const w = {
    fake,
    runs: [] as string[][],
    calls: [] as { method: string; path: string; body?: any; socketPath?: string }[],
    posts: {} as Record<string, any[]>, // daemon POSTs by path, bodies only
    uiLogs: [] as { text: string; to: string }[],
    asks: [] as any[], // questions that reached the ask dialog
    registered: [] as any[],
    invalidated: [] as string[],
    clock: null as any,
    bottomSteps: [] as any[],
    bottomSpawns: [] as any[],
    bottomTools: [] as any[],
    modelCalls: [] as any[],
    leaseId: null as string | null,
    rows: { '': MAIN_ROWS } as Record<string, any[]>, // '' is the main conversation
    api: {} as Record<string, any[]>,
    sessions,
    tools: [] as any[], // $.tool.register specs
    sent: [] as any[], // session.send events that reached the engine
    refuseSend: null as string | null, // why the engine refuses a plugin's send, as auto mode can
    agentList: [] as any[],
    engine: null as any, // the test's $, for hooks that act as the engine
    denyRows: new Set<string>(), // agent ids whose transcript read is refused
    stored: {} as Record<string, any>,
  }
  let leaseN = 0
  let sessionN = 0
  let agentN = 0
  let inputN = 0
  const nextAgentId = () => `agent-${++agentN}`

  mock.env(on, { HOME: '/home/user' }) // no XDG_RUNTIME_DIR: finding the daemon must not need it
  w.clock = mock.clock(on)
  // The plugin's store, in memory and readable by the test, as JSON keeps it.
  Object.assign(w.stored, structuredClone(opts.store ?? {}))
  on('store.get', ($: any, e: any) => {
    if (fake.storeFail) throw new Error('the store file is locked')
    return { value: structuredClone(w.stored[e.key]) }
  })
  on('store.set', ($: any, e: any) => {
    w.stored[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    delete w.stored[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.stored) }))

  on('fs.read', ($: any, e: any) => ({ value: JSON.stringify({ version: '0.7.1' }) }))
  on('process.run', ($: any, e: any) => {
    w.runs.push(e.argv)
    const stdout = e.argv[1] === 'socket' ? `${SOCK}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('http.fetch', async ($: any, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.slice('http://bitfrost'.length).split('?')[0]
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    w.calls.push({ method, path, body, socketPath: e.init?.socketPath })
    if (method === 'POST') (w.posts[path] ??= []).push(body)
    let status = 200
    let reply: any = {}
    if (path === '/health') {
      if (fake.healthFailure === 'transport') throw new Error('socket hang up')
      if (fake.healthFailure === 'http') {
        status = 503
        reply = { error: 'health unavailable' }
      } else reply = fake.health
    }
    else if (path === '/leases') {
      if (fake.leaseReply) ({ status, body: reply } = fake.leaseReply)
      else w.leaseId = reply.leaseId = `lease-${++leaseN}`
    } else if (path.startsWith('/leases/') && method === 'POST') {
      if (fake.renewalReply) ({ status, body: reply } = fake.renewalReply)
      else reply = { ok: true, agentsAt: fake.agentsReply.at }
    }
    else if (path === '/agents') reply = fake.agentsReply
    else if (path === '/sessions') {
      const scripted = fake.queue.shift() ?? { events: [], items: {}, approvals: [] }
      const id = `fx-${++sessionN}`
      sessions.set(id, scripted)
      reply = { id }
    } else if (path.startsWith('/sessions/') && !sessions.has(path.split('/')[2])) {
      status = 404
      reply = { error: `no session ${path}` }
    } else if (path.endsWith('/input')) {
      if (fake.inputDelayMs) await w.clock.sleep(fake.inputDelayMs)
      reply = fake.inputReplies.shift() ?? fake.inputReply ?? { ok: true, inputId: `in-${++inputN}`, delivery: 'started' }
      const failure = fake.inputFailures.shift()
      if (failure === 'accept') {
        const sess = sessions.get(path.split('/')[2])!
        const seq = (sess.events.at(-1)?.seq ?? 0) + 1
        sess.events.push({ type: 'user_input', seq, inputId: reply.inputId, text: body.text, sender: 'claude', delivery: reply.delivery, clientInputId: body.clientInputId })
      }
      if (failure) throw new Error('socket hang up')
    } else if (path.endsWith('/interrupt')) {
      ;({ status, body: reply } = fake.interruptReplies.shift() ?? { status: 200, body: { ok: true, how: 'graceful' } })
    } else if (path.endsWith('/attach') && fake.attachFailures > 0) {
      fake.attachFailures--
      status = 500
      reply = { error: 'busy' }
    } else if (path.endsWith('/attach')) {
      const sess = sessions.get(path.split('/')[2])!
      reply = { ok: true, state: sess.state ?? 'idle', lastSeq: sess.lastSeq ?? 0, agent: SOL.name, model: SOL.model, effort: 'high' }
    } else if (path.endsWith('/summary')) {
      reply = sessions.get(path.split('/')[2])?.summary ?? {}
    } else if (path.endsWith('/messages')) {
      reply = sessions.get(path.split('/')[2])?.messages ?? { turns: [] }
    } else if (path.includes('/messages/')) {
      reply = { message: sessions.get(path.split('/')[2])?.item ?? null }
    } else if (path.endsWith('/events')) {
      const sess = sessions.get(path.split('/')[2])
      const after = +(e.url.split('after=')[1]?.split('&')[0] ?? 0)
      const waitMs = +(e.url.split('waitMs=')[1]?.split('&')[0] ?? 0)
      const fresh = () => (sess?.events ?? []).filter((ev) => ev.seq > after)
      if (fake.holdEvents && waitMs && !fresh().length) await w.clock.sleep(waitMs)
      reply = { events: fresh(), ...(sess?.state ? { state: sess.state } : {}) }
    } else if (path.includes('/items/')) {
      if (fake.holdItems) await w.clock.sleep(4000)
      const sess = sessions.get(path.split('/')[2])
      reply = { event: sess?.items[path.split('/').at(-1)] ?? null }
    } else if (path.endsWith('/approvals') && method === 'GET') {
      reply = { approvals: sessions.get(path.split('/')[2])?.approvals ?? [] }
    }
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(reply) } }
  })

  on('session.id', () => ({ value: 'main-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.messages', ($: any, e: any) => {
    if (w.denyRows.has(e.agentId)) return { value: { deny: 'transcripts are off' } }
    return { value: e.as === 'api' ? (w.api[e.agentId ?? ''] ?? []) : (w.rows[e.agentId ?? ''] ?? []) }
  })
  on('agent.register', ($: any, e: any) => {
    w.registered.push(e)
    return { value: { agent: e.name } }
  })
  on('ui.invalidate', ($: any, e: any) => {
    w.invalidated.push(e.event)
    return { value: undefined }
  })
  on('ui.log', ($: any, e: any) => {
    w.uiLogs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('model.complete', ($: any, e: any) => {
    w.modelCalls.push(e)
    return { value: fake.reviewReply }
  })
  on('tool.check', () => ({ value: { decision: 'ask' } }))
  on('tool.register', ($: any, e: any) => {
    w.tools.push(e)
    return { value: { tool: `mcp__bitfrost__${e.name}` } }
  })
  on('agent.list', () => ({ value: w.agentList }))
  on('session.send', ($: any, e: any) => {
    if (w.refuseSend) return { isDelivered: false, reason: w.refuseSend }
    w.sent.push(e)
    return { isDelivered: true }
  })

  // The engine's own events: answer beneath the plugin, and record what falls through.
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.context', () => ({ blocks: [{ name: 'base', text: 'base context' }] }))
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', ($: any, e: any) => {
    w.bottomSpawns.push(e)
    return { model: e.model ?? SOL.model, agentId: nextAgentId() }
  })
  on('turn.step', async function* ($: any, e: any, next: any) {
    w.bottomSteps.push(e)
    if (fake.modelStep) return yield* fake.modelStep(e)
    yield { kind: 'text', index: 0, text: 'bottom step' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'bottom step', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', async ($: any, e: any, next: any) => {
    if (e.tool === 'AskUserQuestion') {
      w.asks.push(e.questions)
      // No dialog exists here, so no answer ever comes back.
      return { result: '(the dialog never answered)' }
    }
    w.bottomTools.push(e)
    // The engine's SendMessage raises session.send, as the model's send.
    if (e.tool === 'SendMessage') {
      const sent = await w.engine.session.send({ to: e.to, text: e.message, origin: { kind: 'model' } })
      const delay = fake.sendMessageDelays.shift()
      if (delay) await w.clock.sleep(delay)
      return { result: { success: sent.isDelivered, message: 'Message sent.' } }
    }
    return { result: { stdout: 'bottom tool', stderr: '', interrupted: false } }
  })

  return w
}

// A session the helper already knows, for a restore to find.
const known = (w: any, id: string, sess: Partial<Scripted>) => w.sessions.set(id, { events: [], items: {}, approvals: [], ...sess })

const start = ($: any) => $.session.start({ cwd: '/proj', surface: null, isInteractive: true })

const spawn = ($: any, prompt: string, permissionMode = 'default') =>
  // provider and agentId are what the engine adds for a plugin-registered agent type.
  $.agent.spawn({
    prompt,
    description: 'fix the suite',
    subagentType: 'bitfrost:gpt-6-sol',
    provider: { plugin: 'bitfrost@local', tier: 'user' },
    permissionMode,
  } as any)

// Walks the stream by hand: for-await drops a generator's return value.
const drive = async (stream: any) => {
  const chunks: any[] = []
  let r = await stream.next()
  while (!r.done) {
    chunks.push(r.value)
    r = await stream.next()
  }
  return { chunks, result: r.value }
}

const step = ($: any, agentId: string, index: number) =>
  drive($.turn.step({ turnId: 'turn-1', index, model: SOL.model, messageCount: 1, agentId } as any))

const toolCall = ($: any, agentId: string, use: { name: string; id: string; input: any }) =>
  $.tool.call({ tool: use.name, tool_use_id: use.id, agentId, ...use.input } as any)

const toolChunk = (chunks: any[]) => chunks.find((c) => c.kind === 'tool')
const inputOf = (chunks: any[]) => JSON.parse(chunks.find((c) => c.kind === 'input')?.json ?? '{}')
const stopChunk = (chunks: any[]) => chunks.find((c) => c.kind === 'stop')
const textsOf = (chunks: any[]) => chunks.filter((c) => c.kind === 'text').map((c) => c.text)

// The transcript row a tool result becomes, which the next step reads back.
const addToolResult = (w: any, agentId: string, id: string, text: string) => {
  w.rows[agentId].push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
}

test('session.start asks bitfrostd for its socket, then health, lease and agents', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)

  const socketRuns = w.runs.filter((a) => a[1] === 'socket')
  expect(socketRuns).toHaveLength(1)
  expect(socketRuns[0][0]).toEndWith('/bin/bitfrostd')
  expect(w.calls.every((c) => c.socketPath === SOCK)).toBe(true)
  expect(w.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /health', 'POST /leases', 'GET /agents'])

  expect(w.posts['/leases']).toEqual([{ host: 'claude-code', profile: '/home/user/.claude', hostSessionId: 'main-1' }])
  expect(w.registered).toEqual([
    {
      name: 'gpt-6-sol',
      description: 'GPT-6 Sol for long tasks',
      prompt:
        'You relay the report of an agent that ran in another app through BitFrost. ' +
        'When asked to call SubagentHandback, pass your last message as its message, word for word, with nothing added or left out. ' +
        'Do not call any other tool.',
      model: 'gpt-6-sol',
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
    },
  ])

  const context = await $.prompt.context({ blocks: [{ name: 'base', text: 'base context' }] } as any)
  expect(context.blocks.map((b: any) => b.name)).toEqual(['base', 'bitfrostModels'])
  expect(context.blocks[1].text).toBe(NAME_TABLE)
})

test('a broken config tells the user once per session, not only the debug log', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  const broken = '/home/user/.config/bitfrost/config.json is invalid: providers must be a list'
  w.fake.health.configError = broken
  w.fake.leaseReply = { status: 503, body: { error: broken } }

  await start($)
  const said = w.uiLogs.filter((l) => l.to !== 'debug' && l.text.includes('BitFrost is off'))
  expect(said).toHaveLength(1)
  expect(said[0].text).toContain(broken)
  expect(w.uiLogs.some((l) => l.to === 'debug' && l.text.includes('no foreign agents this session'))).toBe(true)
  expect(w.registered).toEqual([])

  // A new session hears it again; this time only the lease refusal knows.
  w.fake.health.configError = null
  await start($)
  const said2 = w.uiLogs.filter((l) => l.to !== 'debug' && l.text.includes('BitFrost is off'))
  expect(said2).toHaveLength(2)
  expect(said2[1].text).toContain(broken)
})

test('an empty newSettings list does not log a settings notice', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  // Failed renewals recheck health within the same session.
  w.fake.renewalReply = { status: 503, body: { error: 'lease unavailable' } }
  await w.clock.advance(20_000)
  expect(w.calls.filter((c) => c.path === '/health')).toHaveLength(3)
  expect(w.uiLogs.filter((l) => l.text === NEW_SETTINGS_NOTICE)).toEqual([])
})

test('new settings are announced once during repeated health checks in a session', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  w.fake.health.newSettings = ['handback', 'review']
  await start($)
  expect(w.uiLogs.filter((l) => l.text === NEW_SETTINGS_NOTICE)).toHaveLength(1)

  w.fake.renewalReply = { status: 503, body: { error: 'lease unavailable' } }
  await w.clock.advance(20_000)
  expect(w.calls.filter((c) => c.path === '/health')).toHaveLength(3)
  const notices = w.uiLogs.filter((l) => l.text === NEW_SETTINGS_NOTICE)
  expect(notices).toHaveLength(1)
  expect(notices[0].to).not.toBe('debug')
})

test('with no models to offer, the helper\'s hint reaches the user', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  const hint = 'opencode offers 120 models; list the ones you want in providers.opencode.models.'
  w.fake.agentsReply = { agents: [], nameTable: '', at: 1, hint }
  await start($)
  const said = w.uiLogs.filter((l) => l.to !== 'debug' && l.text.includes('no models to offer'))
  expect(said).toHaveLength(1)
  expect(said[0].text).toContain(hint)
  expect(w.registered).toEqual([])
})

// Delivers the handback in a step's chunks, then runs the closing step after it.
async function closeOut($: any, w: any, agentId: string, s: any, index: number) {
  const id = toolChunk(s.chunks).id
  await toolCall($, agentId, { name: 'SubagentHandback', id, input: inputOf(s.chunks) })
  addToolResult(w, agentId, id, 'delivered')
  return step($, agentId, index)
}

test('turn.step replays the foreign session as chunks, tool calls and a handback', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)

  const scripted = {
    events: [
      { type: 'text', seq: 1, text: 'Looking at the failing test.' },
      { type: 'command_started', seq: 2, itemId: 'cmd-1', command: 'npm test', summary: 'run the suite' },
      { type: 'command_completed', seq: 3, itemId: 'cmd-1', status: 'completed', exitCode: 0, output: '3 passed' },
      { type: 'file_change', seq: 4, itemId: 'fc-1', changes: [{ kind: 'modify', path: 'src/a.ts', diff: '@@ -1 +1 @@\n-broken\n+fixed' }] },
      { type: 'usage', seq: 5, inputTokens: 1500, cachedInputTokens: 500, outputTokens: 700 },
      { type: 'turn_completed', seq: 6, status: 'completed', finalText: 'Fixed src/a.ts; the suite passes.' },
    ],
    items: { 'cmd-1': { type: 'command_completed', status: 'completed', exitCode: 0, output: '3 passed' } },
    approvals: [],
  }
  w.fake.queue.push(scripted)

  const spawned = await spawn($, 'fix the failing test')
  const agentId = spawned.agentId
  w.rows[agentId] = [{ role: 'user', text: 'fix the failing test', toolUses: [] }]
  w.api[agentId] = [{ role: 'user', content: [{ type: 'text', text: 'End with a SubagentHandback(...) call.' }] }]

  const s1 = await step($, agentId, 0)
  expect(w.posts['/sessions']).toEqual([
    expect.objectContaining({ agent: 'gpt-6-sol', prompt: 'fix the failing test', cwd: '/proj', canAskUser: true, autoReview: false }),
  ])
  expect(textsOf(s1.chunks)).toEqual(['Looking at the failing test.'])
  expect(toolChunk(s1.chunks).name).toBe('Bash')
  expect(inputOf(s1.chunks)).toEqual({ command: 'npm test', description: 'run the suite' })
  expect(stopChunk(s1.chunks).stopReason).toBe('tool_use')
  expect(s1.result.toolUses).toEqual([{ name: 'Bash', input: { command: 'npm test', description: 'run the suite' } }])

  const bash = await toolCall($, agentId, { name: 'Bash', id: toolChunk(s1.chunks).id, input: inputOf(s1.chunks) })
  expect(bash).toEqual({ result: { stdout: '3 passed', stderr: '', interrupted: false, noOutputExpected: false } })
  addToolResult(w, agentId, toolChunk(s1.chunks).id, '3 passed')

  const s2 = await step($, agentId, 1)
  expect(toolChunk(s2.chunks).name).toBe('Edit')
  expect(inputOf(s2.chunks)).toEqual({ file_path: 'src/a.ts', old_string: 'broken', new_string: 'fixed' })
  expect(stopChunk(s2.chunks).usage).toEqual({ input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 700, model: 'gpt-6-sol' })

  const edit = await toolCall($, agentId, { name: 'Edit', id: toolChunk(s2.chunks).id, input: inputOf(s2.chunks) })
  expect(edit.result).toMatchObject({ filePath: 'src/a.ts', oldString: 'broken', newString: 'fixed' })
  addToolResult(w, agentId, toolChunk(s2.chunks).id, 'edited')

  const s3 = await step($, agentId, 2)
  expect(toolChunk(s3.chunks).name).toBe('SubagentHandback')
  const handed = inputOf(s3.chunks)
  expect(handed.message).toContain('Report from GPT-6-Sol (bitfrost:gpt-6-sol')
  expect(handed.message).toContain('Fixed src/a.ts; the suite passes.')
  expect(stopChunk(s3.chunks).stopReason).toBe('tool_use')

  const hb = await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(s3.chunks).id, input: handed })
  expect(w.bottomTools.at(-1).tool).toBe('SubagentHandback')
  expect(hb).toEqual({ result: { stdout: 'bottom tool', stderr: '', interrupted: false } })
  addToolResult(w, agentId, toolChunk(s3.chunks).id, 'delivered')

  const s4 = await step($, agentId, 3)
  // Like a native subagent, the report closes the transcript after the handback.
  expect(textsOf(s4.chunks)).toEqual(['Fixed src/a.ts; the suite passes.'])
  expect(stopChunk(s4.chunks).stopReason).toBe('end_turn')

  expect(w.bottomSteps).toEqual([])
})

test('a permission request reaches the user and the decision is posted back', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)

  w.fake.queue.push({
    events: [
      { type: 'text', seq: 1, text: 'I will run the build.' },
      { type: 'command_started', seq: 2, itemId: 'cmd-1', command: 'npm run build', summary: 'build the project' },
      { type: 'approval_requested', seq: 3, approvalId: 'appr-1', title: 'run npm run build', detail: 'writes to node_modules' },
      { type: 'turn_completed', seq: 4, status: 'completed', finalText: 'Build skipped.' },
    ],
    items: { 'cmd-1': { type: 'command_completed', status: 'declined' } },
    approvals: [{ approvalId: 'appr-1', title: 'run npm run build', detail: 'writes to node_modules' }],
  })
  const a = await spawn($, 'run the build')
  w.rows[a.agentId] = [{ role: 'user', text: 'run the build', toolUses: [] }]
  w.api[a.agentId] = []

  const s1 = await step($, a.agentId, 0)
  expect(toolChunk(s1.chunks).name).toBe('Bash')
  expect(inputOf(s1.chunks)).toEqual({ command: 'npm run build', description: 'build the project' })

  const denied = await toolCall($, a.agentId, { name: 'Bash', id: toolChunk(s1.chunks).id, input: inputOf(s1.chunks) })
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0][0].question).toContain('GPT-6-Sol (a bitfrost subagent) wants to run npm run build')
  expect(w.asks[0][0].header).toBe('Permission')
  expect(w.asks[0][0].options.map((o: any) => o.label)).toEqual(['Allow once', 'Allow for this task', 'Switch to auto', 'Deny'])
  expect(w.posts['/sessions/fx-1/approvals/appr-1']).toEqual([{ decision: 'deny', by: 'user' }])
  expect(denied).toEqual({ result: { stdout: '', stderr: 'Not run: permission was denied.', interrupted: false } })

  addToolResult(w, a.agentId, toolChunk(s1.chunks).id, 'not run')
  const s2 = await step($, a.agentId, 1)
  expect(textsOf(s2.chunks)[0]).toStartWith('Asked you: may GPT-6-Sol run npm run build?')
  expect(stopChunk(s2.chunks).stopReason).toBe('end_turn')

  w.fake.queue.push({
    events: [
      { type: 'command_started', seq: 1, itemId: 'cmd-2', command: 'npm run build', summary: 'build the project' },
      { type: 'approval_requested', seq: 2, approvalId: 'appr-2', title: 'run npm run build', detail: '' },
      { type: 'turn_completed', seq: 3, status: 'completed', finalText: 'Build done.' },
    ],
    items: { 'cmd-2': { type: 'command_completed', status: 'completed', exitCode: 0, output: 'built in 2s' } },
    approvals: [{ approvalId: 'appr-2', title: 'run npm run build', detail: '' }],
  })
  const b = await spawn($, 'run the build', 'auto')
  w.rows[b.agentId] = [{ role: 'user', text: 'run the build', toolUses: [] }]
  w.api[b.agentId] = []

  const s3 = await step($, b.agentId, 0)
  expect(w.posts['/sessions'].at(-1)).toMatchObject({ autoReview: true })
  expect(toolChunk(s3.chunks).name).toBe('Bash')
  const allowed = await toolCall($, b.agentId, { name: 'Bash', id: toolChunk(s3.chunks).id, input: inputOf(s3.chunks) })
  expect(w.modelCalls).toHaveLength(1)
  expect(w.modelCalls[0].prompt).toContain('wants to run npm run build')
  expect(w.modelCalls[0].prompt).toContain('run the build')
  expect(w.posts['/sessions/fx-2/approvals/appr-2']).toEqual([{ decision: 'allow', by: 'auto mode' }])
  expect(allowed).toEqual({ result: { stdout: 'built in 2s', stderr: '', interrupted: false, noOutputExpected: false } })

  addToolResult(w, b.agentId, toolChunk(s3.chunks).id, 'built')
  const s4 = await step($, b.agentId, 1)
  expect(textsOf(s4.chunks)[0]).toStartWith('Auto mode allowed GPT-6-Sol to run npm run build')
})

test('a lease renewal picks up models the helper adds or drops mid-session', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const listings = () => w.calls.filter((c) => c.path === '/agents').length
  const offered = (name: string) =>
    $.agent.offer({ agent: `bitfrost:${name}`, description: '', source: 'plugin', provider: { plugin: 'bitfrost@local', tier: 'user' } } as any)
  expect(w.registered.map((r) => r.name)).toEqual(['gpt-6-sol'])
  expect(w.invalidated).toEqual(['prompt.context'])

  // An unchanged list costs a renewal and nothing more.
  await w.clock.advance(10_000)
  expect(w.posts[`/leases/${w.leaseId}`]).toHaveLength(1)
  expect(listings()).toBe(1)

  const SOL61 = { ...SOL, name: 'gpt-6-1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', aliases: ['sol6.1'], family: 'gpt-6.1' }
  const table = 'bitfrost models: sol6.1 = bitfrost:gpt-6-1-sol (Codex)'
  w.fake.agentsReply = { agents: [SOL61], nameTable: table, at: 2 }
  await w.clock.advance(10_000)
  expect(listings()).toBe(2)
  expect(w.registered.map((r) => r.name)).toEqual(['gpt-6-sol', 'gpt-6-1-sol'])
  expect(w.invalidated).toEqual(['prompt.context', 'prompt.context'])
  const context = await $.prompt.context({ blocks: [{ name: 'base', text: 'base context' }] } as any)
  expect(context.blocks.at(-1)).toEqual({ name: 'bitfrostModels', text: table })

  // Claude Code can't unregister a type, so the dropped one stays hidden instead.
  expect(await offered('gpt-6-1-sol')).toEqual({ isOffered: true })
  expect(await offered('gpt-6-sol')).toEqual({ isOffered: false })
  expect(await $.agent.offer({ agent: 'Explore', description: '', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } } as any)).toEqual({
    isOffered: true,
  })

  // A rebuilt list with the same models registers nothing again.
  w.fake.agentsReply = { agents: [SOL61], nameTable: table, at: 3 }
  await w.clock.advance(10_000)
  expect(listings()).toBe(3)
  expect(w.registered).toHaveLength(2)
  expect(w.invalidated).toHaveLength(2)
})

test('session.end returns the lease and drops the session\'s agents',{ timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)

  w.fake.queue.push({ events: [], items: {}, approvals: [] })
  const spawned = await spawn($, 'fix the failing test')
  expect(w.uiLogs.filter((l) => l.text.includes('bitfrost: spawning'))).toHaveLength(1)

  await $.session.end({ reason: 'other', sessionId: 'main-1' } as any)

  const deleted = w.calls.filter((c) => c.method === 'DELETE')
  expect(deleted.map((c) => c.path)).toEqual([`/leases/${w.leaseId}`])

  // An ended session neither renews its lease nor takes a new one.
  const leaseCalls = () => w.calls.filter((c) => c.path.startsWith('/leases')).length
  const before = leaseCalls()
  await w.clock.advance(30_000)
  expect(leaseCalls()).toBe(before)

  await step($, spawned.agentId, 0)
  expect(w.bottomSteps).toHaveLength(1)

  await spawn($, 'fix the failing test')
  expect(w.uiLogs.filter((l) => l.text.includes('bitfrost: spawning'))).toHaveLength(1)
  expect(w.bottomSpawns[1].description).toBe('fix the suite')

  const context = await $.prompt.context({ blocks: [{ name: 'base', text: 'base context' }] } as any)
  expect(context.blocks.map((b: any) => b.name)).toEqual(['base'])
})

// Spawns a subagent over a scripted session; withHandback adds the instruction auto mode sends.
const agentOver = async ($: any, w: any, events: any[], opts: { items?: any; withHandback?: boolean; task?: string; extra?: Partial<Scripted> } = {}) => {
  w.fake.queue.push({ events, items: opts.items ?? {}, approvals: [], ...opts.extra })
  const { agentId } = await spawn($, opts.task ?? 'fix the parser')
  w.rows[agentId] = [{ role: 'user', text: opts.task ?? 'fix the parser', toolUses: [] }]
  w.api[agentId] = opts.withHandback ? [{ role: 'user', content: [{ type: 'text', text: 'End with a SubagentHandback(...) call.' }] }] : []
  return agentId as string
}

// Leaves a subagent mid-turn: its step ended on a replayed command.
const running = async ($: any, w: any) => {
  const agentId = await agentOver($, w, [{ type: 'command_started', seq: 1, itemId: 'cmd-1', command: 'npm test', summary: 'run the suite' }])
  const s = await step($, agentId, 0)
  expect(toolChunk(s.chunks).name).toBe('Bash')
  return { agentId, s }
}

const interrupts = (w: any, sid: string) => w.posts[`/sessions/${sid}/interrupt`] ?? []
const handbackOf = (chunks: any[]) => (toolChunk(chunks)?.name === 'SubagentHandback' ? inputOf(chunks).message : null)

const RELAY_MODEL = { model: 'claude-sonnet-4-6', effort: 'low' }
const RELAY_GIVE_UP = 'Refused: the report was changed. BitFrost hands it back itself now; do not call any tool.'
const nudgeHandback = (w: any, agentId: string) => {
  w.api[agentId].push({ role: 'user', content: [{ type: 'text', text: '[handback-send-enforce] Call SubagentHandback(...) now.' }] })
}

// Enables the official handback setting in this world's helper health response.
const relayOver = async ($: any, w: any, finalText = 'The parser is fixed.') => {
  w.fake.health.handback = RELAY_MODEL
  const agentId = await agentOver($, w, [
    { type: 'turn_completed', seq: 1, status: 'completed', reason: 'end_turn', finalText },
  ], { withHandback: true })
  const report = `Report from GPT-6-Sol (bitfrost:gpt-6-sol, agent ${agentId}, BitFrost session fx-1)\nEnded: end_turn\n\n${finalText}`
  const shown = await step($, agentId, 0)
  expect(textsOf(shown.chunks)).toEqual([report])
  expect(toolChunk(shown.chunks)).toBeUndefined()
  expect(stopChunk(shown.chunks).stopReason).toBe('end_turn')
  expect(w.bottomSteps).toEqual([])
  return { agentId, report }
}

// The engine below BitFrost plays a Claude response, including its return value.
const modelHandback = (w: any, message: string) => {
  w.fake.modelStep = async function* (e: any) {
    yield { kind: 'tool', index: 0, id: 'toolu_relay', name: 'SubagentHandback' }
    yield { kind: 'input', index: 0, json: JSON.stringify({ message }) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input: { message } }], stopReason: 'tool_use', usage: null }
  }
}

for (const { name, failure } of [
  { name: 'the relay stays off when health has handback null', failure: null },
  { name: 'the relay stays off when the handback health call returns an HTTP error', failure: 'http' },
  { name: 'the relay stays off when the handback health call throws', failure: 'transport' },
] as const) {
  test(name, { timeoutMs: 20000 }, async ($, on) => {
    const w = world(on)
    await start($)
    const agentId = await agentOver($, w, [
      { type: 'turn_completed', seq: 1, status: 'completed', reason: 'end_turn', finalText: 'The parser is fixed.' },
    ], { withHandback: true })
    // Fail only the handback lookup, after the session has started successfully.
    w.fake.health.handback = failure ? RELAY_MODEL : null
    w.fake.healthFailure = failure
    const healthCalls = w.calls.filter((c) => c.path === '/health').length
    const s = await step($, agentId, 0)
    const report = `Report from GPT-6-Sol (bitfrost:gpt-6-sol, agent ${agentId}, BitFrost session fx-1)\nEnded: end_turn\n\nThe parser is fixed.`
    expect(w.calls.filter((c) => c.path === '/health')).toHaveLength(healthCalls + 1)
    expect(handbackOf(s.chunks)).toBe(report)
    expect(stopChunk(s.chunks).stopReason).toBe('tool_use')
    expect(s.result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: report } }])
    expect(w.stored[`agent:${agentId}`].relay).toBeNull()
    expect(w.bottomSteps).toEqual([])
    expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(s.chunks).id, input: inputOf(s.chunks) })).deny).toBeUndefined()
    expect(w.bottomTools.at(-1).message).toBe(report)
  })
}

test('relay decisions use the debug log without a shell printf', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  nudgeHandback(w, agentId)
  modelHandback(w, 'Changed report.')
  const relayed = await step($, agentId, 1)
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(relayed.chunks).id, input: inputOf(relayed.chunks) })).deny).toContain(report)

  modelHandback(w, report)
  const retry = await step($, agentId, 2)
  expect(handbackOf(retry.chunks)).toBe(report)
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(retry.chunks).id, input: inputOf(retry.chunks) })).deny).toBeUndefined()

  const logs = w.uiLogs.filter((l) => l.text.startsWith('bitfrost: handback '))
  expect(logs).toHaveLength(2)
  expect(logs.every((l) => l.to === 'debug')).toBe(true)
  expect(logs.map((l) => JSON.parse(l.text.slice('bitfrost: handback '.length)))).toEqual([
    expect.objectContaining({ agent: agentId, ...RELAY_MODEL, event: 'handback', attempt: 1, verbatim: false, sent: 'Changed report.' }),
    expect.objectContaining({ agent: agentId, ...RELAY_MODEL, event: 'handback', attempt: 2, verbatim: true, sent: report.slice(0, 300) }),
  ])
  expect(w.runs.filter((argv) => argv[0] === 'sh' && argv[1] === '-c' && /\bprintf\b/.test(argv[2]))).toEqual([])
})

test('a relay that throws mid-stream leaves a fresh block index for the fallback handback', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  nudgeHandback(w, agentId)
  let closed = 0
  w.fake.modelStep = async function* () {
    try {
      yield { kind: 'text', index: 0, text: 'Calling ' }
      yield { kind: 'text', index: 0, text: 'handback.' }
      yield { kind: 'thinking', index: 1, text: 'Relay the report.' }
      yield { kind: 'tool', index: 2, id: 'toolu_partial', name: 'SubagentHandback' }
      yield { kind: 'input', index: 2, json: '{"message":' }
      throw new Error('the Claude stream broke')
    } finally {
      closed++
    }
  }

  const s = await step($, agentId, 1)
  expect(w.bottomSteps).toEqual([expect.objectContaining({ model: RELAY_MODEL.model, effort: RELAY_MODEL.effort, agentId })])
  expect(s.chunks.filter((c: any) => typeof c.index === 'number').map((c: any) => c.index)).toEqual([0, 0, 1, 2, 2, 3, 3])
  const fallback = s.chunks.slice(-3)
  expect(toolChunk(fallback)).toMatchObject({ name: 'SubagentHandback', index: 3 })
  expect(handbackOf(fallback)).toBe(report)
  expect(stopChunk(s.chunks).stopReason).toBe('tool_use')
  expect(s.result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: report } }])
  expect(closed).toBe(1)
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(fallback).id, input: inputOf(fallback) })).deny).toBeUndefined()
  expect(w.bottomTools.at(-1).message).toBe(report)
})

test('relay blocks start after BitFrost catch-up text and a thrown stream leaves another fresh index', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  // The app wrote more while Claude Code was away. Restore replays those events
  // before reaching the pending relay, so BitFrost already owns block zero.
  known(w, 'fx-1', {
    lastSeq: 3,
    events: [
      { type: 'text', seq: 2, text: 'More app progress.' },
      { type: 'turn_completed', seq: 3, status: 'completed', reason: 'end_turn', finalText: 'More app work finished.' },
    ],
  })
  await start($)
  nudgeHandback(w, agentId)
  w.fake.modelStep = async function* () {
    yield { kind: 'text', index: 0, text: 'Claude relay progress.' }
    yield { kind: 'tool', index: 1, id: 'toolu_offset', name: 'SubagentHandback' }
    yield { kind: 'input', index: 1, json: '{"message":' }
    throw new Error('the offset stream broke')
  }
  const s = await step($, agentId, 1)
  expect(textsOf(s.chunks)).toEqual(['More app progress.', 'Claude relay progress.'])
  expect(s.chunks.filter((c: any) => typeof c.index === 'number').map((c: any) => c.index)).toEqual([0, 1, 2, 2, 3, 3])
  expect(handbackOf(s.chunks.slice(-3))).toBe(report)
  expect(w.bottomSteps).toHaveLength(1)
})

test('closing a relay step early closes the Claude iterator', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId } = await relayOver($, w)
  nudgeHandback(w, agentId)
  let closed = 0
  w.fake.modelStep = async function* () {
    try {
      yield { kind: 'text', index: 0, text: 'Relaying.' }
      yield { kind: 'text', index: 1, text: 'Must not be consumed.' }
    } finally {
      closed++
    }
  }
  const stream: any = $.turn.step({ turnId: 'turn-1', index: 1, model: SOL.model, messageCount: 1, agentId } as any)
  expect((await stream.next()).value).toMatchObject({ kind: 'text', index: 0, text: 'Relaying.' })
  await stream.return(undefined)
  await w.clock.settle()
  expect(closed).toBe(1)
  expect(interrupts(w, 'fx-1')).toEqual([])
})

test('a changed relay handback is refused after the last try and the exact fallback is accepted', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  nudgeHandback(w, agentId)
  modelHandback(w, 'A changed report.')
  for (let attempt = 1; attempt <= 3; attempt++) {
    const s = await step($, agentId, attempt)
    expect(handbackOf(s.chunks)).toBe('A changed report.')
    expect(w.bottomSteps).toHaveLength(attempt)
    expect(w.stored[`agent:${agentId}`].relay.attempts).toBe(attempt)
    const refused = await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(s.chunks).id, input: inputOf(s.chunks) })
    if (attempt < 3) {
      expect(refused.deny).toContain(`-----BEGIN REPORT-----\n${report}\n-----END REPORT-----`)
      expect(w.stored[`agent:${agentId}`].relay.failed).toBe(false)
    } else {
      expect(refused.deny).toBe(RELAY_GIVE_UP)
      expect(w.stored[`agent:${agentId}`].relay.failed).toBe(true)
    }
    expect(w.stored[`agent:${agentId}`].relay.retry).toBe(true)
    expect(w.bottomTools).toEqual([])
  }
  // A second tool in the same final model turn must still be checked after failed was set.
  expect(await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_changed_again', input: { message: 'Another changed report.' } })).toEqual({ deny: RELAY_GIVE_UP })
  expect(w.bottomTools).toEqual([])
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_exact', input: { message: report } })).deny).toBeUndefined()
  expect(w.bottomTools.map((e: any) => e.message)).toEqual([report])

  const fallback = await step($, agentId, 4)
  expect(w.bottomSteps).toHaveLength(3)
  expect(handbackOf(fallback.chunks)).toBe(report)
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(fallback.chunks).id, input: inputOf(fallback.chunks) })).deny).toBeUndefined()
})

test('the relay check preserves indentation and line breaks but accepts trailing spaces and CRLF', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w, 'Example:\nif (ready) {\n    run()\n}\nNext line.')
  nudgeHandback(w, agentId)
  await step($, agentId, 1)
  for (const changed of [report.replace('    run()', '  run()'), report.replace('\nNext line.', ' Next line.')]) {
    const refused = await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_whitespace', input: { message: changed } })
    expect(refused.deny).toContain('must carry the report below verbatim')
  }
  expect(w.bottomTools).toEqual([])
  const formatted = report.split('\n').map((line: string) => `${line}  `).join('\r\n')
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_crlf', input: { message: formatted } })).deny).toBeUndefined()
  expect(w.bottomTools.map((e: any) => e.message)).toEqual([formatted])
})

test('the relay check accepts spacing and typography within lines and extra blank lines', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w, 'She said “it’s done”—all  tests…\n\n    Kept indented.')
  nudgeHandback(w, agentId)
  await step($, agentId, 1)
  const formatted = report.replace('“it’s done”—all  tests…', '"it\'s   done"-all tests...').replace('\n\n    Kept', '\n\n\n\n    Kept')
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_typography', input: { message: formatted } })).deny).toBeUndefined()
  expect(w.bottomTools.map((e: any) => e.message)).toEqual([formatted])
})

test('restoring a relay keeps the shown report, attempt count and refused retry budget', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  expect(w.stored[`agent:${agentId}`]).toMatchObject({ handed: true, relay: { ...RELAY_MODEL, message: report, attempts: 0, retry: false, failed: false } })
  known(w, 'fx-1', { lastSeq: 1, state: 'idle', messages: { turns: [{ finalText: 'The parser is fixed.', reason: 'end_turn' }] } })

  // session.start clears the module's live agent map, forcing a store-backed restore.
  // Avoid session.end: its forced save could hide a missing save at the relay transition.
  await start($)
  const restored = await step($, agentId, 1)
  expect(w.posts['/sessions/fx-1/attach']).toHaveLength(1)
  expect(textsOf(restored.chunks)).toEqual(['Report delivered.'])
  expect(toolChunk(restored.chunks)).toBeUndefined()
  expect(w.bottomSteps).toEqual([])
  expect(w.stored[`agent:${agentId}`].relay.attempts).toBe(0)

  nudgeHandback(w, agentId)
  modelHandback(w, 'Changed after restore.')
  await step($, agentId, 2)
  expect(w.stored[`agent:${agentId}`].relay.attempts).toBe(1)
  await start($)
  // Restoring the saved attempt before any refusal must not reset it.
  const firstRefusal = await toolCall($, agentId, { name: 'SubagentHandback', id: 'toolu_restored', input: { message: 'Changed after restore.' } })
  expect(firstRefusal.deny).toContain(report)
  expect(w.stored[`agent:${agentId}`].relay).toMatchObject({ message: report, attempts: 1, retry: true, failed: false })

  for (let attempt = 2; attempt <= 3; attempt++) {
    await start($)
    const retry = await step($, agentId, attempt + 1)
    expect(textsOf(retry.chunks)).toEqual([])
    expect(handbackOf(retry.chunks)).toBe('Changed after restore.')
    expect(w.stored[`agent:${agentId}`].relay.attempts).toBe(attempt)
    const refused = await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(retry.chunks).id, input: inputOf(retry.chunks) })
    expect(refused.deny).toBe(attempt === 3 ? RELAY_GIVE_UP : firstRefusal.deny)
  }
  await start($)
  const fallback = await step($, agentId, 5)
  expect(handbackOf(fallback.chunks)).toBe(report)
  expect(textsOf(fallback.chunks)).toEqual([])
  expect(w.bottomSteps).toHaveLength(3)
  expect(w.stored[`agent:${agentId}`].relay).toMatchObject({ attempts: 3, failed: true })
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(fallback.chunks).id, input: inputOf(fallback.chunks) })).deny).toBeUndefined()
})

test('a relay report over 50000 characters gives up on its first changed handback', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w, 'x'.repeat(50_001))
  nudgeHandback(w, agentId)
  modelHandback(w, 'Too short.')
  const s = await step($, agentId, 1)
  expect(await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(s.chunks).id, input: inputOf(s.chunks) })).toEqual({ deny: RELAY_GIVE_UP })
  expect(w.stored[`agent:${agentId}`].relay).toMatchObject({ attempts: 1, retry: true, failed: true })
  expect(w.bottomTools).toEqual([])
  const fallback = await step($, agentId, 2)
  expect(w.bottomSteps).toHaveLength(1)
  expect(handbackOf(fallback.chunks)).toBe(report)
  expect(textsOf(fallback.chunks)).toEqual([])
  expect((await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(fallback.chunks).id, input: inputOf(fallback.chunks) })).deny).toBeUndefined()
})

test('a handed relay without a nudge never shows the report twice even before the first attempt', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, report } = await relayOver($, w)
  const closing = await step($, agentId, 1)
  expect(textsOf(closing.chunks)).toEqual(['Report delivered.'])
  expect(toolChunk(closing.chunks)).toBeUndefined()
  expect(stopChunk(closing.chunks).stopReason).toBe('end_turn')
  expect(w.bottomSteps).toEqual([])
  expect(w.stored[`agent:${agentId}`].relay.attempts).toBe(0)

  nudgeHandback(w, agentId)
  modelHandback(w, report)
  const relayed = await step($, agentId, 2)
  await toolCall($, agentId, { name: 'SubagentHandback', id: toolChunk(relayed.chunks).id, input: inputOf(relayed.chunks) })
  addToolResult(w, agentId, toolChunk(relayed.chunks).id, 'delivered')
  w.api[agentId].push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolChunk(relayed.chunks).id, content: 'delivered' }] })
  const delivered = await step($, agentId, 3)
  expect(textsOf(delivered.chunks)).toEqual(['Report delivered.'])
  expect(toolChunk(delivered.chunks)).toBeUndefined()
  expect(stopChunk(delivered.chunks).stopReason).toBe('end_turn')
  expect(w.bottomSteps).toHaveLength(1)
})

test(
  'an aborted tool call stops the app session with exactly one interrupt',
  {
    timeoutMs: 20000,
    // Settles first while the call beneath still runs, which aborts it, as the user's Escape does.
    plugins: [
      {
        name: 'cutter',
        tier: 'prepend',
        register(on) {
          on('tool.call', async ($, e, next) => {
            if (e.tool !== 'Bash') return next(e)
            next(e).catch(() => {})
            await $.clock.sleep(1000)
            return { result: { stdout: '', stderr: 'cut', interrupted: true } }
          })
        },
      },
    ],
  },
  async ($, on) => {
    const w = world(on)
    await start($)
    w.fake.holdItems = true
    const { agentId, s } = await running($, w)

    const call = toolCall($, agentId, { name: 'Bash', id: toolChunk(s.chunks).id, input: inputOf(s.chunks) })
    await w.clock.advance(1000)
    expect(await call).toMatchObject({ result: { stderr: 'cut' } })
    await w.clock.settle()
    expect(interrupts(w, 'fx-1')).toHaveLength(1)

    // The hook's own loop wakes later, sees the abort, and must not stop it again.
    await w.clock.advance(8000)
    expect(interrupts(w, 'fx-1')).toHaveLength(1)
    expect(w.uiLogs.some((l) => l.to === 'debug' && l.text.includes('stopped gpt-6-sol because the tool call was aborted (graceful)'))).toBe(true)
  },
)

test('a step closed early while the app works interrupts it', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const agentId = await agentOver($, w, [
    { type: 'user_input', seq: 1, inputId: 'in-0', text: 'fix the parser', sender: 'claude', delivery: 'started' },
    { type: 'text', seq: 2, text: 'Reading the parser.' },
  ])
  const stream: any = $.turn.step({ turnId: 'turn-1', index: 0, model: SOL.model, messageCount: 1, agentId } as any)
  const first = await stream.next()
  expect(first.value).toMatchObject({ kind: 'text', text: 'Reading the parser.' })
  expect(interrupts(w, 'fx-1')).toHaveLength(0)
  await stream.return(undefined)
  await w.clock.settle()
  expect(interrupts(w, 'fx-1')).toHaveLength(1)

  // Stopped means not running, so a message goes to the engine instead of the app.
  await $.session.send({ to: agentId, text: 'are you there?', origin: { kind: 'model' } } as any)
  expect(w.sent).toHaveLength(1)
  expect(w.posts['/sessions/fx-1/input']).toBeUndefined()

  // The engine resumes it with the message; the stopped turn's end comes before the new input and is skipped.
  w.sessions.get('fx-1')!.events.push(
    { type: 'turn_completed', seq: 3, status: 'interrupted', reason: 'interrupted', finalText: 'Reading the parser.' },
    { type: 'user_input', seq: 4, inputId: 'in-1', text: 'are you there?', sender: 'claude', delivery: 'started' },
    { type: 'text', seq: 5, text: 'Yes, carrying on.' },
    { type: 'turn_completed', seq: 6, status: 'completed', reason: 'end_turn', finalText: 'Parser fixed.' },
  )
  w.rows[agentId].push({ role: 'user', text: 'are you there?', toolUses: [] })
  const s = await step($, agentId, 1)
  expect(w.posts['/sessions/fx-1/input']).toEqual([{ text: 'are you there?', mode: 'auto', sender: 'claude', clientInputId: KEY }])
  expect(textsOf(s.chunks)).toEqual(['Yes, carrying on.', 'Parser fixed.'])
  expect(stopChunk(s.chunks).stopReason).toBe('end_turn')
})

test('a restarted turn keeps polling, shows the lead\'s message, and hands back once', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const long = 'Also '.repeat(100)
  const agentId = await agentOver(
    $,
    w,
    [
      { type: 'user_input', seq: 1, inputId: 'in-0', text: 'fix the parser', sender: 'claude', delivery: 'started' },
      { type: 'text', seq: 2, text: 'Looking.' },
      { type: 'turn_completed', seq: 3, status: 'interrupted', reason: 'restarted', continues: true, finalText: 'Looking.' },
      { type: 'user_input', seq: 4, inputId: 'in-9', text: 'Focus on the lexer instead.', sender: 'claude', delivery: 'restarted' },
      { type: 'input_consumed', seq: 5, inputId: 'in-9', turnId: 't-2' },
      { type: 'user_input', seq: 6, inputId: 'in-10', text: long, sender: 'claude', delivery: 'queued' },
      { type: 'user_input', seq: 7, inputId: 'in-11', text: 'typed in the app', sender: 'user', delivery: 'queued' },
      { type: 'input_dropped', seq: 7.5, inputId: 'in-11' },
      { type: 'text', seq: 8, text: 'Lexer fixed.' },
      { type: 'turn_completed', seq: 9, status: 'completed', reason: 'end_turn', continues: true, finalText: 'Lexer fixed.' },
      { type: 'input_consumed', seq: 9.5, inputId: 'in-10', turnId: 't-3' },
      { type: 'text', seq: 10, text: 'And the rest.' },
      { type: 'turn_completed', seq: 11, status: 'completed', reason: 'end_turn', finalText: 'And the rest.' },
    ],
    { withHandback: true },
  )
  const s = await step($, agentId, 0)
  expect(w.posts['/sessions'][0]).toMatchObject({ claudeSession: 'main-1', claudeAgent: agentId, parentMode: 'default' })
  const texts = textsOf(s.chunks)
  expect(texts).toEqual([
    'Looking.',
    "↻ restarted with the lead's message",
    '↳ Claude: Focus on the lexer instead.',
    `↳ Claude: ${long.trim().slice(0, 299)}…`,
    '⚠ A queued message was dropped before it started.',
    'Lexer fixed.',
  ])
  expect(handbackOf(s.chunks)).toBe(`Report from GPT-6-Sol (bitfrost:gpt-6-sol, agent ${agentId}, BitFrost session fx-1)\nEnded: end_turn\n\nAnd the rest.`)
  // The final text shows once, as the closing message after the handback.
  expect(textsOf((await closeOut($, w, agentId, s, 1)).chunks)).toEqual(['And the rest.'])
})

test('the hand-back says why a turn ended and marks a cut-short report partial', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const a = await agentOver(
    $,
    w,
    [
      { type: 'text', seq: 1, text: 'Half way there.' },
      { type: 'turn_completed', seq: 2, status: 'failed', reason: 'quota_exhausted', providerErrorCode: '1113', error: 'Usage limit reached', finalText: 'Half way there.' },
    ],
    { withHandback: true },
  )
  const s = await step($, a, 0)
  expect(textsOf(s.chunks)).toEqual([])
  expect(handbackOf(s.chunks)).toBe(
    `Report from GPT-6-Sol (bitfrost:gpt-6-sol, agent ${a}, BitFrost session fx-1)\nEnded: quota_exhausted (code 1113)\nThe turn did not finish, so the text below is partial.\n\nHalf way there.`,
  )
  expect(textsOf((await closeOut($, w, a, s, 1)).chunks)).toEqual(["⚠ GPT-6-Sol's turn ended: its plan quota is used up (Usage limit reached; code 1113).", 'Half way there.'])

  // Without a handback instruction the step ends on the same final text.
  const b = await agentOver($, w, [
    { type: 'text', seq: 1, text: 'Done.' },
    { type: 'turn_completed', seq: 2, status: 'completed', reason: 'end_turn', finalText: 'All of it is done.' },
  ])
  const s2 = await step($, b, 0)
  expect(textsOf(s2.chunks)).toEqual(['Done.', 'All of it is done.'])
  expect(stopChunk(s2.chunks).stopReason).toBe('end_turn')
  expect(s2.result.answer).toContain('All of it is done.')
})

test('the status, messages and send tools find an agent by id, session id or name', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.tools.map((t) => t.name)).toEqual(['status', 'messages', 'send'])
  expect(await $.tool.call({ tool: 'mcp__bitfrost__status', tool_use_id: 'st-0' } as any)).toEqual({ result: 'No BitFrost subagents in this session yet.' })

  const { agentId: a } = await running($, w)
  const b = await agentOver($, w, [{ type: 'turn_completed', seq: 1, status: 'completed', reason: 'end_turn', finalText: 'Done.' }])
  await step($, b, 0)
  w.sessions.get('fx-1')!.summary = {
    session: { id: 'fx-1', state: 'running', title: 'fix the parser', effort: 'high', elapsedMs: 75_000 },
    activeTool: { name: 'Bash', summary: 'npm test', startedAt: Date.now() - 5000 },
    recentTools: [{ name: 'Read', summary: 'src/parser.ts', status: 'completed', ts: 1 }],
    usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 800, requests: 4 },
    inbox: { queued: 1, items: [{ id: 'in-3', text: 'also docs', delivery: 'queued', state: 'queued', ts: 1 }] },
    turns: [],
    lastSeq: 1,
  }
  w.sessions.get('fx-2')!.summary = {
    session: { id: 'fx-2', state: 'idle', title: 'fix the parser', elapsedMs: 3000 },
    turns: [{ id: 't-1', status: 'completed', reason: 'end_turn', startedAt: Date.now() - 6000, endedAt: Date.now() - 3000, finalTextChars: 5 }],
    lastSeq: 1,
  }
  const call = (tool: string, input: any) => $.tool.call({ tool: `mcp__bitfrost__${tool}`, tool_use_id: `t-${tool}`, ...input } as any) as Promise<any>

  const all = (await call('status', {})).result
  expect(all.split('\n')).toHaveLength(2)
  expect(all).toContain(`- ${a}: GPT-6-Sol (high), running 1m 15s; fix the parser; running Bash npm test`)
  expect(all).toContain(`- ${b}: GPT-6-Sol, idle 3s; fix the parser; last turn end_turn`)

  // A model name means the latest agent of that model.
  const one = (await call('status', { agent: 'sol6' })).result
  expect(w.calls.at(-1)).toMatchObject({ method: 'GET', path: '/sessions/fx-2/summary' })
  expect(one).toContain('State: idle for 3s')
  expect(one).toContain('Turn t-1: completed (end_turn) after 3s, final text 5 chars')
  const byId = (await call('status', { agent: a })).result
  expect(byId).toContain('Running: Bash npm test')
  expect(byId).toContain('Usage: 1200 input (800 cached), 300 output, 4 requests')
  expect(byId).toContain('Inbox: 1 queued')

  w.sessions.get('fx-1')!.messages = {
    turns: [
      {
        id: 't-1',
        status: 'running',
        reason: null,
        startedAt: 0,
        endedAt: null,
        finalText: null,
        messages: [
          { seq: 1, ts: 0, role: 'user', kind: 'user', text: 'fix the parser' },
          { seq: 2, ts: 0, role: 'assistant', kind: 'tool', name: 'Bash', text: 'npm test', status: 'running', itemId: 'cmd-1' },
        ],
      },
    ],
    nextSince: 2,
    truncated: true,
  }
  const msgs = (await call('messages', { agent: 'fx-1', turns: 2 })).result
  expect(w.calls.at(-1)?.path).toBe('/sessions/fx-1/messages')
  expect(msgs).toContain('Turn t-1: running, 1970-01-01 00:00:00, still running')
  expect(msgs).toContain('#2 assistant/tool Bash [running] (item cmd-1): npm test')
  expect(msgs).toContain('[More: call messages again with since: 2]')
  w.sessions.get('fx-1')!.item = { seq: 2, text: 'npm test', output: '3 passed' }
  expect((await call('messages', { agent: a, item: 'cmd-1' })).result).toContain('"output": "3 passed"')
  expect(w.calls.at(-1)?.path).toBe('/sessions/fx-1/messages/cmd-1')

  // Running: straight to the app, with the receipt.
  w.fake.inputReply = { ok: true, inputId: 'in-7', delivery: 'queued' }
  const queued = (await call('send', { agent: 'fx-1', message: 'also update the docs' })).result
  expect(w.posts['/sessions/fx-1/input']).toEqual([{ text: 'also update the docs', mode: 'auto', sender: 'claude', clientInputId: KEY }])
  expect(queued).toContain("Queued, not read yet: GPT-6-Sol can't take messages mid-turn")
  w.fake.inputReply = { ok: true, inputId: 'in-8', delivery: 'restarted' }
  const restarted = (await call('send', { agent: a, message: 'stop, do the lexer', interrupt: true })).result
  expect(w.posts['/sessions/fx-1/input'].at(-1)).toEqual({ text: 'stop, do the lexer', mode: 'interrupt', sender: 'claude', clientInputId: KEY })
  expect(restarted).toContain("GPT-6-Sol's turn was stopped and restarted in the same session")

  // Not running: the engine resumes it.
  const resumed = (await call('send', { agent: b, message: 'now the tests' })).result
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0].text).toBe('now the tests')
  expect(JSON.stringify(w.sent[0].to)).toContain(b)
  expect(w.posts['/sessions/fx-2/input']).toBeUndefined()
  expect(resumed).toContain('starts a new turn')

  // Auto mode refuses a send a plugin makes: Claude is told to send it itself, keeping interrupt.
  w.refuseSend = 'The server-side auto mode classifier gave no verdict for SendMessage'
  const refused = (await call('send', { agent: b, message: 'stop, do the docs', interrupt: true })).result
  expect(refused).toContain('Not sent')
  expect(refused).toContain(`Send the same text with SendMessage to "${b}"`)
  expect(refused).toContain('BitFrost keeps interrupt: true for it')
  w.refuseSend = null

  const missing = await call('send', { agent: 'gemini', message: 'hi' })
  expect(missing.deny ?? missing.text).toContain('No BitFrost subagent matches "gemini"')

  const context = await $.prompt.context({ blocks: [{ name: 'base', text: 'base context' }] } as any)
  expect(context.blocks.at(-1).name).toBe('bitfrostTools')
  expect(context.blocks.at(-1).text).toContain('mcp__bitfrost__send')
})

test('a model\'s SendMessage to a running agent goes to the app session, once, with a receipt', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  w.engine = $
  await start($)
  const { agentId } = await running($, w)

  const sent = await $.session.send({ to: agentId, text: 'also check the docs', origin: { kind: 'model' } } as any)
  expect(sent).toEqual({ isDelivered: true })
  expect(w.posts['/sessions/fx-1/input']).toEqual([{ text: 'also check the docs', mode: 'auto', sender: 'claude', clientInputId: KEY }])
  expect(w.sent).toHaveLength(0)

  // By the name the engine lists it under.
  w.agentList = [{ id: agentId, name: 'parser-worker', description: 'fix the suite', type: 'bitfrost:gpt-6-sol', status: 'running' }]
  await $.session.send({ to: 'parser-worker', text: 'and the lexer', origin: { kind: 'model' } } as any)
  expect(w.posts['/sessions/fx-1/input']).toHaveLength(2)

  // A plugin's own send passes through.
  await $.session.send({ to: agentId, text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } } as any)
  expect(w.sent.map((e) => e.text)).toEqual(['from a plugin'])

  // The SendMessage tool's result carries the receipt.
  w.fake.inputReply = { ok: true, inputId: 'in-5', delivery: 'steered' }
  const r: any = await $.tool.call({ tool: 'SendMessage', tool_use_id: 'sm-1', to: agentId, message: 'one more thing' } as any)
  expect(w.posts['/sessions/fx-1/input']).toHaveLength(3)
  expect(r.context).toEqual([expect.stringContaining('Steered: GPT-6-Sol got the message in its running turn.')])
  expect(w.sent).toHaveLength(1)

  // A subagent that isn't running gets it through the engine.
  const idle = await agentOver($, w, [{ type: 'turn_completed', seq: 1, status: 'completed', reason: 'end_turn', finalText: 'Done.' }])
  await step($, idle, 0)
  await $.session.send({ to: idle, text: 'next task', origin: { kind: 'model' } } as any)
  expect(w.sent.map((e) => e.text)).toEqual(['from a plugin', 'next task'])
  expect(w.posts['/sessions/fx-2/input']).toBeUndefined()
})

const STORED = { sessionId: 'fx-old', agent: 'gpt-6-sol', effort: 'high', title: 'fix the parser', parentMode: 'default', claudeSession: 'main-1', createdAt: 1, lastSeq: 7, inputRows: 1 }

test('after a restart a stored subagent reattaches and resumes in the same app session', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { store: { 'agent:agent-old': STORED, 'agent:agent-gone': { ...STORED, sessionId: 'fx-gone' } } })
  await start($)
  known(w, 'fx-old', {
    lastSeq: 7,
    events: [
      { type: 'text', seq: 3, text: 'from before the restart' },
      { type: 'user_input', seq: 8, inputId: 'in-1', text: 'please continue', sender: 'claude', delivery: 'started' },
      { type: 'text', seq: 9, text: 'Resumed.' },
      { type: 'turn_completed', seq: 10, status: 'completed', reason: 'end_turn', finalText: 'Picked up where it stopped.' },
    ],
  })
  w.rows['agent-old'] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'user', text: 'please continue', toolUses: [] },
  ]
  w.api['agent-old'] = []

  // Listed before it is used again.
  expect((await $.tool.call({ tool: 'mcp__bitfrost__status', tool_use_id: 'st-1' } as any)).result).toContain('- agent-old: GPT-6-Sol')

  const s = await step($, 'agent-old', 0)
  expect(w.posts['/sessions/fx-old/attach']).toEqual([{ leaseId: w.leaseId, claudeSession: 'main-1' }])
  expect(w.posts['/sessions/fx-old/input']).toEqual([{ text: 'please continue', mode: 'auto', sender: 'claude', clientInputId: KEY }])
  expect(w.calls.find((c) => c.path === '/sessions/fx-old/events')).toBeTruthy()
  expect(textsOf(s.chunks)).toEqual(['Resumed.', 'Picked up where it stopped.'])
  expect(w.bottomSteps).toEqual([])
  expect(w.stored['agent:agent-old']).toMatchObject({ sessionId: 'fx-old', lastSeq: 10, inputRows: 2, effort: 'high' })

  // A stale replayed tool is refused, never run here; compaction is skipped.
  expect(await toolCall($, 'agent-old', { name: 'Bash', id: 'toolu_stale', input: { command: 'rm -rf build' } })).toMatchObject({ deny: expect.stringContaining('foreign harness') })
  expect((await $.session.compact({ trigger: 'auto', agentId: 'agent-old' } as any)).skip).toContain('keeps and compacts its own context')

  // The helper forgot this one: say so instead of falling through to Anthropic.
  w.rows['agent-gone'] = [{ role: 'user', text: 'go on', toolUses: [] }]
  w.api['agent-gone'] = []
  const gone = await step($, 'agent-gone', 0)
  expect(textsOf(gone.chunks).join('\n')).toContain('BitFrost could not reattach GPT-6-Sol (BitFrost session fx-gone)')
  expect(await toolCall($, 'agent-gone', { name: 'Bash', id: 'toolu_x', input: { command: 'ls' } })).toMatchObject({ deny: expect.stringContaining('could not reattach') })
  expect(w.bottomSteps).toEqual([])
  expect(w.bottomTools).toEqual([])

  // An agent the store doesn't know is someone else's.
  w.rows['agent-native'] = [{ role: 'user', text: 'hi', toolUses: [] }]
  await step($, 'agent-native', 0)
  expect(w.bottomSteps).toHaveLength(1)
})

const asModel = (to: string, text: string) => ({ to, text, origin: { kind: 'model' } }) as any
const inputs = (w: any, sid: string) => w.posts[`/sessions/${sid}/input`] ?? []

test('a message sent while replay runs never loses the turn end or the turn it starts', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  w.engine = $
  await start($)
  w.fake.holdEvents = true
  w.fake.inputDelayMs = 1000

  // The stream shows the input consumed before its POST answers.
  const { agentId: a, s: a0 } = await running($, w)
  addToolResult(w, a, toolChunk(a0.chunks).id, 'ran')
  w.fake.inputReplies.push({ ok: true, inputId: 'in-5', delivery: 'queued' })
  const sendingA = $.session.send(asModel(a, 'also the docs'))
  await w.clock.settle()
  w.sessions.get('fx-1')!.events.push(
    { type: 'user_input', seq: 2, inputId: 'in-5', text: 'also the docs', sender: 'claude', delivery: 'queued' },
    { type: 'turn_completed', seq: 3, status: 'completed', reason: 'end_turn', continues: true, finalText: 'Tests pass.' },
    { type: 'input_consumed', seq: 4, inputId: 'in-5', turnId: 't-2' },
    { type: 'text', seq: 5, text: 'Docs updated.' },
    { type: 'turn_completed', seq: 6, status: 'completed', reason: 'end_turn', finalText: 'Docs updated.' },
  )
  const stepA = step($, a, 1)
  await w.clock.settle()
  await w.clock.advance(1000)
  expect(await sendingA).toEqual({ isDelivered: true })
  await w.clock.advance(4000)
  const sa = await stepA
  expect(textsOf(sa.chunks)).toEqual(['↳ Claude: also the docs', 'Docs updated.'])
  expect(stopChunk(sa.chunks).stopReason).toBe('end_turn')

  // The old turn ends while a message that starts the next one is on its way.
  const b = await agentOver($, w, [{ type: 'command_started', seq: 1, itemId: 'cmd-1', command: 'npm test', summary: 'run the suite' }])
  const b0 = await step($, b, 0)
  addToolResult(w, b, toolChunk(b0.chunks).id, 'ran')
  w.fake.inputReplies.push({ ok: true, inputId: 'in-6', delivery: 'started' })
  const sendingB = $.session.send(asModel(b, 'now the lexer'))
  await w.clock.settle()
  const fx2 = w.sessions.get('fx-2')!
  fx2.events.push({ type: 'turn_completed', seq: 2, status: 'completed', reason: 'end_turn', finalText: 'Suite passes.' })
  const stepB = step($, b, 1)
  await w.clock.settle()
  await w.clock.advance(1000)
  expect(await sendingB).toEqual({ isDelivered: true })
  fx2.events.push(
    { type: 'user_input', seq: 3, inputId: 'in-6', text: 'now the lexer', sender: 'claude', delivery: 'started' },
    { type: 'input_consumed', seq: 4, inputId: 'in-6', turnId: 't-2' },
    { type: 'text', seq: 5, text: 'Lexer done.' },
    { type: 'turn_completed', seq: 6, status: 'completed', reason: 'end_turn', finalText: 'Lexer done.' },
  )
  await w.clock.advance(4000)
  const sb = await stepB
  expect(textsOf(sb.chunks)).toEqual(['↳ Claude: now the lexer', 'Lexer done.'])
})

test('a restore replays what happened while Claude Code was away and reports the real end', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, {
    store: {
      'agent:agent-away': { ...STORED, sessionId: 'fx-away', lastSeq: 2 },
      'agent:agent-done': { ...STORED, sessionId: 'fx-done', lastSeq: 5 },
      'agent:agent-long': { ...STORED, sessionId: 'fx-long', lastSeq: 0 },
    },
  })
  await start($)
  known(w, 'fx-away', {
    lastSeq: 5,
    events: [
      { type: 'text', seq: 2, text: 'seen before the restart' },
      { type: 'text', seq: 3, text: 'Worked while you were away.' },
      { type: 'turn_completed', seq: 5, status: 'failed', reason: 'quota_exhausted', providerErrorCode: '1113', finalText: 'Got half way.' },
    ],
  })
  known(w, 'fx-done', { lastSeq: 5, state: 'idle', messages: { turns: [{ id: 't-4', status: 'completed', reason: 'end_turn', finalText: 'The parser is fixed.', messages: [] }] } })
  const many = Array.from({ length: 399 }, (_, i) => ({ type: 'text', seq: i + 1, text: `step ${i + 1}` }))
  known(w, 'fx-long', { lastSeq: 400, events: [...many, { type: 'turn_completed', seq: 400, status: 'completed', reason: 'end_turn', finalText: 'Long job done.' }] })
  for (const id of ['agent-away', 'agent-done', 'agent-long']) {
    w.rows[id] = [{ role: 'user', text: 'fix the parser', toolUses: [] }]
    w.api[id] = []
  }

  const away = await step($, 'agent-away', 0)
  expect(w.posts['/sessions/fx-away/attach']).toHaveLength(1)
  expect(textsOf(away.chunks)).toEqual(['Worked while you were away.', "⚠ GPT-6-Sol's turn ended: its plan quota is used up (code 1113).", 'Got half way.'])

  const done = await step($, 'agent-done', 0)
  expect(textsOf(done.chunks)).toEqual(['The parser is fixed.'])

  const long = await step($, 'agent-long', 0)
  expect(textsOf(long.chunks)).toEqual(['… 399 events from while Claude Code was closed are not replayed here; the messages tool has them.', 'Long job done.'])
  expect(w.bottomSteps).toEqual([])
})

test('a helper restart with a queued message ends the turn instead of polling forever', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const a = await agentOver(
    $,
    w,
    [
      { type: 'user_input', seq: 1, inputId: 'in-0', text: 'fix the parser', sender: 'claude', delivery: 'started' },
      { type: 'text', seq: 2, text: 'Working.' },
      { type: 'user_input', seq: 3, inputId: 'in-1', text: 'and the docs', sender: 'claude', delivery: 'queued' },
      { type: 'turn_completed', seq: 4, status: 'interrupted', reason: 'daemon_restart', finalText: 'Working.' },
      { type: 'input_dropped', seq: 5, inputId: 'in-1' },
    ],
    { withHandback: true },
  )
  const s = await step($, a, 0)
  expect(textsOf(s.chunks)).toEqual([
    'Working.',
    '↳ Claude: and the docs',
    '⚠ A queued message was dropped before it started.',
  ])
  expect(handbackOf(s.chunks)).toContain('Ended: daemon_restart\nThe turn did not finish')
  expect(textsOf((await closeOut($, w, a, s, 1)).chunks)).toEqual(["⚠ GPT-6-Sol's turn ended: the BitFrost helper restarted.", 'Working.'])

  // Detached with no turn end in the stream: the helper's last turn says how it ended.
  const b = await agentOver($, w, [{ type: 'text', seq: 1, text: 'Starting.' }], {
    extra: { state: 'detached', messages: { turns: [{ id: 't-1', status: 'interrupted', reason: 'daemon_restart', finalText: 'Starting.', messages: [] }] } },
  })
  const s2 = await step($, b, 0)
  expect(textsOf(s2.chunks)).toEqual(["⚠ GPT-6-Sol's turn ended: the BitFrost helper restarted.", 'Starting.'])
})

test('a stop that is never confirmed is retried, reported, and tried again later', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const a = await agentOver($, w, [{ type: 'text', seq: 1, text: 'Reading.' }])
  const stuck = { status: 500, body: { error: 'the app does not answer' } }
  w.fake.interruptReplies.push(stuck, stuck, stuck)
  const stream: any = $.turn.step({ turnId: 'turn-1', index: 0, model: SOL.model, messageCount: 1, agentId: a } as any)
  await stream.next()
  await stream.return(undefined)
  await w.clock.settle()
  expect(interrupts(w, 'fx-1')).toHaveLength(1)
  await w.clock.advance(1000)
  expect(interrupts(w, 'fx-1')).toHaveLength(2)
  await w.clock.advance(1000)
  expect(interrupts(w, 'fx-1')).toHaveLength(3)
  await w.clock.settle()
  expect(w.uiLogs.some((l) => l.to === 'debug' && l.text.includes('could not stop gpt-6-sol because the step closed early'))).toBe(true)

  // Not idle: the next step says so, and leaving it early tries the stop again.
  const again: any = $.turn.step({ turnId: 'turn-1', index: 1, model: SOL.model, messageCount: 1, agentId: a } as any)
  const first = await again.next()
  expect(first.value.text).toContain('⚠ BitFrost could not confirm that GPT-6-Sol stopped')
  await again.return(undefined)
  await w.clock.settle()
  expect(interrupts(w, 'fx-1')).toHaveLength(4)
})

test('a store that cannot be read never lets a BitFrost agent run natively', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { store: { 'agent:agent-s': { ...STORED, sessionId: 'fx-s' } } })
  await start($)
  known(w, 'fx-s', {
    lastSeq: 7,
    events: [
      { type: 'user_input', seq: 8, inputId: 'in-1', text: 'continue', sender: 'claude', delivery: 'started' },
      { type: 'turn_completed', seq: 9, status: 'completed', reason: 'end_turn', finalText: 'Back.' },
    ],
  })
  w.rows['agent-s'] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'user', text: 'continue', toolUses: [] },
  ]
  w.api['agent-s'] = []
  w.fake.storeFail = true
  const s1 = await step($, 'agent-s', 0)
  expect(textsOf(s1.chunks).join('\n')).toContain('BitFrost could not read its saved state for this subagent')
  expect(await toolCall($, 'agent-s', { name: 'Bash', id: 'toolu_x', input: { command: 'ls' } })).toMatchObject({ deny: expect.stringContaining('could not read its saved state') })
  expect(w.bottomSteps).toEqual([])
  expect(w.bottomTools).toEqual([])

  // Not remembered as foreign: once the store reads again, it restores.
  w.fake.storeFail = false
  const s2 = await step($, 'agent-s', 1)
  expect(inputs(w, 'fx-s')).toHaveLength(1)
  expect(textsOf(s2.chunks)).toEqual(['Back.'])

  // An agent the engine types as its own still runs natively while the store is down.
  w.fake.storeFail = true
  w.agentList = [{ id: 'agent-explore', type: 'Explore', description: '', status: 'running' }]
  w.rows['agent-explore'] = [{ role: 'user', text: 'look around', toolUses: [] }]
  await step($, 'agent-explore', 0)
  expect(w.bottomSteps).toHaveLength(1)
})

test('send with interrupt to a restored agent whose app still runs keeps the interrupt', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { store: { 'agent:agent-busy': { ...STORED, sessionId: 'fx-busy' } } })
  await start($)
  known(w, 'fx-busy', { lastSeq: 7, state: 'running', summary: { session: { id: 'fx-busy', state: 'running' } } })
  const r: any = await $.tool.call({ tool: 'mcp__bitfrost__send', tool_use_id: 'sd-1', agent: 'agent-busy', message: 'switch to the lexer', interrupt: true } as any)
  expect(r.result).toContain('stops that turn and restarts it with your message')
  expect(w.sent).toHaveLength(1)
  expect(inputs(w, 'fx-busy')).toEqual([])

  // The engine resumes it with the message, and the forward keeps the interrupt.
  w.rows['agent-busy'] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'user', text: 'switch to the lexer', toolUses: [] },
  ]
  w.api['agent-busy'] = []
  w.fake.inputReplies.push({ ok: true, inputId: 'in-3', delivery: 'restarted' })
  w.sessions.get('fx-busy')!.events.push(
    { type: 'text', seq: 8, text: 'Still on the parser.' },
    { type: 'user_input', seq: 9, inputId: 'in-3', text: 'switch to the lexer', sender: 'claude', delivery: 'restarted' },
    { type: 'turn_completed', seq: 10, status: 'interrupted', reason: 'restarted', continues: true, finalText: 'Still on the parser.' },
    { type: 'input_consumed', seq: 11, inputId: 'in-3', turnId: 't-9' },
    { type: 'turn_completed', seq: 12, status: 'completed', reason: 'end_turn', finalText: 'Lexer switched.' },
  )
  const s = await step($, 'agent-busy', 0)
  expect(inputs(w, 'fx-busy')).toEqual([{ text: 'switch to the lexer', mode: 'interrupt', sender: 'claude', clientInputId: KEY }])
  expect(textsOf(s.chunks)).toEqual(['Still on the parser.', "↻ restarted with the lead's message", 'Lexer switched.'])
})

test('parallel SendMessage calls get their own receipts, and an ambiguous name goes to the engine', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  w.engine = $
  await start($)
  const { agentId } = await running($, w)
  w.fake.inputReplies.push({ ok: true, inputId: 'in-1', delivery: 'queued' }, { ok: true, inputId: 'in-2', delivery: 'steered' })
  w.fake.sendMessageDelays.push(1000, 0)
  const first = $.tool.call({ tool: 'SendMessage', tool_use_id: 'sm-1', to: agentId, message: 'one' } as any)
  const second = $.tool.call({ tool: 'SendMessage', tool_use_id: 'sm-2', to: agentId, message: 'two' } as any)
  await w.clock.settle()
  await w.clock.advance(1000)
  const [r1, r2]: any[] = await Promise.all([first, second])
  expect(r1.context).toEqual([expect.stringContaining("Queued, not read yet: GPT-6-Sol can't take messages mid-turn")])
  expect(r2.context).toEqual([expect.stringContaining('Steered: GPT-6-Sol got the message in its running turn.')])

  w.agentList = [
    { id: agentId, name: 'worker', description: '', type: 'bitfrost:gpt-6-sol', status: 'running' },
    { id: 'agent-x', name: 'worker', description: '', type: 'Explore', status: 'running' },
  ]
  await $.session.send(asModel('worker', 'which one?'))
  expect(w.sent.map((e) => e.text)).toEqual(['which one?'])
  expect(inputs(w, 'fx-1')).toHaveLength(2)
})

test('a lost POST answer never delivers a message twice', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  w.engine = $
  await start($)
  const { agentId } = await running($, w)
  const fx1 = w.sessions.get('fx-1')!

  // The helper took it; the stream shows its key, so nothing is sent again.
  w.fake.inputReplies.push({ ok: true, inputId: 'in-a', delivery: 'steered' })
  w.fake.inputFailures.push('accept')
  expect(await $.session.send(asModel(agentId, 'first'))).toEqual({ isDelivered: true })
  expect(inputs(w, 'fx-1')).toHaveLength(1)

  // Lost before the helper saw it: one retry under the same key.
  w.fake.inputReplies.push({ ok: true, inputId: 'in-b', delivery: 'steered' }, { ok: true, inputId: 'in-b', delivery: 'steered' })
  w.fake.inputFailures.push('lose')
  expect(await $.session.send(asModel(agentId, 'second'))).toEqual({ isDelivered: true })
  const bodies = inputs(w, 'fx-1')
  expect(bodies).toHaveLength(3)
  expect(bodies[2].clientInputId).toBe(bodies[1].clientInputId)
  fx1.events.push({ type: 'user_input', seq: 3, inputId: 'in-b', text: 'second', sender: 'claude', delivery: 'steered' })

  // Lost twice: the engine delivers it, and the forward reuses the key for the helper to dedupe.
  w.fake.inputFailures.push('lose', 'lose')
  await $.session.send(asModel(agentId, 'third'))
  expect(w.sent.map((e) => e.text)).toEqual(['third'])
  expect(bodies).toHaveLength(5)
  expect(bodies[4].clientInputId).toBe(bodies[3].clientInputId)

  w.rows[agentId].push({ role: 'user', text: 'third', toolUses: [] })
  w.fake.inputReplies.push({ ok: true, inputId: 'in-c', delivery: 'started' })
  fx1.events.push(
    { type: 'user_input', seq: 4, inputId: 'in-c', text: 'third', sender: 'claude', delivery: 'started' },
    { type: 'text', seq: 5, text: 'All three.' },
    { type: 'turn_completed', seq: 6, status: 'completed', reason: 'end_turn', finalText: 'All three.' },
  )
  const s = await step($, agentId, 1)
  expect(bodies).toHaveLength(6)
  expect(bodies[5]).toMatchObject({ text: 'third', clientInputId: bodies[3].clientInputId })
  expect(textsOf(s.chunks)).toEqual(['↳ Claude: first', '↳ Claude: second', 'All three.'])
})

test('a reattach that fails for now is tried again on the next step', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, { store: { 'agent:agent-t': { ...STORED, sessionId: 'fx-t' } } })
  await start($)
  known(w, 'fx-t', {
    lastSeq: 7,
    events: [
      { type: 'user_input', seq: 8, inputId: 'in-1', text: 'go on', sender: 'claude', delivery: 'started' },
      { type: 'turn_completed', seq: 9, status: 'completed', reason: 'end_turn', finalText: 'Resumed.' },
    ],
  })
  w.rows['agent-t'] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'user', text: 'go on', toolUses: [] },
  ]
  w.api['agent-t'] = []
  w.fake.attachFailures = 2
  const s1 = await step($, 'agent-t', 0)
  expect(w.posts['/sessions/fx-t/attach']).toHaveLength(2)
  expect(textsOf(s1.chunks).join('\n')).toContain('BitFrost could not reattach GPT-6-Sol yet')
  expect(w.bottomSteps).toEqual([])

  const s2 = await step($, 'agent-t', 1)
  expect(w.posts['/sessions/fx-t/attach']).toHaveLength(3)
  expect(inputs(w, 'fx-t')).toHaveLength(1)
  expect(textsOf(s2.chunks)).toEqual(['Resumed.'])
})

test('a refused transcript read gets a BitFrost report, not a native run', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const a = await agentOver($, w, [{ type: 'text', seq: 1, text: 'never started' }])
  w.denyRows.add(a)
  const s = await step($, a, 0)
  expect(textsOf(s.chunks)[0]).toBe("⚠ BitFrost could not read this subagent's transcript (transcripts are off), so new messages to it can't be passed on.")
  expect(w.posts['/sessions']).toBeUndefined()
  expect(w.bottomSteps).toEqual([])
  w.fake.queue.length = 0 // its scripted session was never taken

  // A running one keeps replaying.
  const { agentId: b, s: b0 } = await running($, w)
  addToolResult(w, b, toolChunk(b0.chunks).id, 'ran')
  w.denyRows.add(b)
  w.sessions.get('fx-1')!.events.push({ type: 'turn_completed', seq: 2, status: 'completed', reason: 'end_turn', finalText: 'Done anyway.' })
  const s2 = await step($, b, 1)
  expect(textsOf(s2.chunks)).toEqual(["⚠ BitFrost could not read this subagent's transcript (transcripts are off), so new messages to it can't be passed on.", 'Done anyway.'])
})

test('the messages tool cuts an oversized final text with a notice', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId } = await running($, w)
  w.sessions.get('fx-1')!.messages = {
    turns: [{ id: 't-1', status: 'completed', reason: 'end_turn', startedAt: 0, endedAt: 1000, finalText: 'x'.repeat(30_000), messages: [] }],
    nextSince: 0,
    truncated: false,
  }
  const r: any = await $.tool.call({ tool: 'mcp__bitfrost__messages', tool_use_id: 'm-1', agent: agentId } as any)
  expect(r.result).toContain('Final text (cut, showing 8000 of 30000 characters): xxx')
  expect(r.result.length).toBeLessThan(9000)
})

// How the engine renders a message it queued for a subagent mid-turn.
const reminder = (text: string, rid?: string) => {
  const id = rid ? ` id="${rid}"` : ''
  return `<system-reminder${id}>\nThe coordinator sent a message while you were working:\n${text}\n\nAddress this before completing your current task.\n</system-reminder${id}>`
}

// What the engine does with a SendMessage it queues for a subagent mid-turn: an attachment row,
// which the API form carries as a reminder beside the tool results. The test kit can't raise
// session.append (only core may answer it), so these tests read the API form alone.
const queueMessage = (w: any, agentId: string, text: string, rid: string) => {
  ;(w.api[agentId] ??= []).push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }, { type: 'text', text: reminder(text, rid) }] })
}

test('a message the engine queued mid-turn is forwarded once, and one after the hand-back starts a new turn', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)
  const { agentId, s } = await running($, w)
  addToolResult(w, agentId, toolChunk(s.chunks).id, 'ran')
  queueMessage(w, agentId, 'also update the docs', 'rid-1')
  const fx1 = w.sessions.get('fx-1')!
  w.fake.inputReplies.push({ ok: true, inputId: 'in-q1', delivery: 'queued' })
  fx1.events.push(
    { type: 'user_input', seq: 2, inputId: 'in-q1', text: 'also update the docs', sender: 'claude', delivery: 'queued' },
    { type: 'turn_completed', seq: 3, status: 'completed', reason: 'end_turn', continues: true, finalText: 'Tests pass.' },
    { type: 'input_consumed', seq: 4, inputId: 'in-q1', turnId: 't-2' },
    { type: 'text', seq: 5, text: 'Docs updated.' },
    { type: 'turn_completed', seq: 6, status: 'completed', reason: 'end_turn', finalText: 'Docs updated.' },
  )
  const s1 = await step($, agentId, 1)
  expect(inputs(w, 'fx-1')).toEqual([{ text: 'also update the docs', mode: 'auto', sender: 'claude', clientInputId: 'ci_q_r_rid-1' }])
  expect(textsOf(s1.chunks)).toContain('Docs updated.')
  expect(stopChunk(s1.chunks).stopReason).toBe('end_turn')

  // The transcript keeps the reminder; later steps don't send it again.
  await step($, agentId, 2)
  expect(inputs(w, 'fx-1')).toHaveLength(1)

  // After the hand-back, a SendMessage resumes the agent: a plain user message carrying the same
  // wording. It goes on once, as new input, never a second time as a queued message.
  w.api[agentId].push({ role: 'user', content: 'The coordinator sent a message while you were working:\nnow the changelog' })
  w.rows[agentId].push({ role: 'user', text: 'now the changelog', toolUses: [] })
  w.fake.inputReplies.push({ ok: true, inputId: 'in-q2', delivery: 'started' })
  fx1.events.push(
    { type: 'user_input', seq: 7, inputId: 'in-q2', text: 'now the changelog', sender: 'claude', delivery: 'started' },
    { type: 'text', seq: 8, text: 'Changelog done.' },
    { type: 'turn_completed', seq: 9, status: 'completed', reason: 'end_turn', finalText: 'Changelog done.' },
  )
  const s3 = await step($, agentId, 3)
  expect(inputs(w, 'fx-1')).toHaveLength(2)
  expect(inputs(w, 'fx-1')[1]).toMatchObject({ text: 'now the changelog', mode: 'auto' })
  expect(inputs(w, 'fx-1')[1].clientInputId).not.toMatch(/^ci_q_/)
  expect(textsOf(s3.chunks)).toContain('Changelog done.')
  expect(textsOf(s3.chunks)).not.toContain('Docs updated.')
  await step($, agentId, 4)
  expect(inputs(w, 'fx-1')).toHaveLength(2)
  expect(w.stored[`agent:${agentId}`].queuedSent).toEqual(['r:rid-1'])
})

test('a restart does not send queued messages again', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, {
    store: {
      'agent:agent-r': { ...STORED, sessionId: 'fx-r', queuedSent: ['r:rid-1'], queuedBaseline: true },
      'agent:agent-pre': { ...STORED, sessionId: 'fx-pre' }, // saved before queued messages were tracked
    },
  })
  await start($)
  const ended = { turns: [{ id: 't-1', status: 'completed', reason: 'end_turn', finalText: 'Earlier report.', messages: [] }] }
  known(w, 'fx-r', { lastSeq: 7, state: 'idle', messages: ended })
  known(w, 'fx-pre', { lastSeq: 7, state: 'idle', messages: ended })
  for (const id of ['agent-r', 'agent-pre']) w.rows[id] = [{ role: 'user', text: 'fix the parser', toolUses: [] }]
  w.api['agent-r'] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }, { type: 'text', text: reminder('also update the docs', 'rid-1') }] }]
  w.api['agent-pre'] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }, { type: 'text', text: reminder('a message lost before the update') }] }]

  await step($, 'agent-r', 0)
  await step($, 'agent-pre', 0)
  expect(inputs(w, 'fx-r')).toEqual([])
  expect(inputs(w, 'fx-pre')).toEqual([])
  expect(w.stored['agent:agent-pre']).toMatchObject({ queuedBaseline: true, queuedSent: [expect.stringMatching(/^h:/)] })

  // One queued after the restart still goes through.
  w.api['agent-r'].push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }, { type: 'text', text: reminder('and the changelog', 'rid-2') }] })
  w.fake.inputReplies.push({ ok: true, inputId: 'in-n', delivery: 'started' })
  w.sessions.get('fx-r')!.events.push(
    { type: 'user_input', seq: 8, inputId: 'in-n', text: 'and the changelog', sender: 'claude', delivery: 'started' },
    { type: 'turn_completed', seq: 9, status: 'completed', reason: 'end_turn', finalText: 'Changelog done.' },
  )
  const s = await step($, 'agent-r', 1)
  expect(inputs(w, 'fx-r')).toEqual([{ text: 'and the changelog', mode: 'auto', sender: 'claude', clientInputId: 'ci_q_r_rid-2' }])
  expect(textsOf(s.chunks)).toContain('Changelog done.')
  expect(w.bottomSteps).toEqual([])
})
