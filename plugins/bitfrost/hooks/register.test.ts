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
const MAIN_ROWS = [{ role: 'user', text: 'please fix the failing test', toolUses: [] }]

// A fake bitfrostd: each POST /sessions takes the next scripted session the test queued.
const world = (on: any) => {
  const fake = {
    health: { version: '0.7.1', busy: false, configError: null as string | null },
    leaseReply: null as { status: number; body: any } | null, // null: a healthy lease
    agentsReply: { agents: [SOL], nameTable: NAME_TABLE },
    reviewReply: { isAnswered: true, text: 'ALLOW\nroutine work for the task.', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    queue: [] as { events: any[]; items: Record<string, any>; approvals: any[] }[],
  }
  const sessions = new Map<string, { events: any[]; items: Record<string, any>; approvals: any[] }>()
  const w = {
    fake,
    runs: [] as string[][],
    calls: [] as { method: string; path: string; body?: any; socketPath?: string }[],
    posts: {} as Record<string, any[]>, // daemon POSTs by path, bodies only
    uiLogs: [] as { text: string; to: string }[],
    asks: [] as any[], // questions that reached the ask dialog
    registered: [] as any[],
    bottomSteps: [] as any[],
    bottomSpawns: [] as any[],
    bottomTools: [] as any[],
    modelCalls: [] as any[],
    leaseId: null as string | null,
    rows: { '': MAIN_ROWS } as Record<string, any[]>, // '' is the main conversation
    api: {} as Record<string, any[]>,
  }
  let leaseN = 0
  let sessionN = 0
  let agentN = 0
  const nextAgentId = () => `agent-${++agentN}`

  mock.env(on, { HOME: '/home/user' }) // no XDG_RUNTIME_DIR: finding the daemon must not need it
  mock.clock(on)
  mock.store(on, {})

  on('fs.read', ($: any, e: any) => ({ value: JSON.stringify({ version: '0.7.1' }) }))
  on('process.run', ($: any, e: any) => {
    w.runs.push(e.argv)
    const stdout = e.argv[1] === 'socket' ? `${SOCK}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('http.fetch', ($: any, e: any) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.slice('http://bitfrost'.length).split('?')[0]
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    w.calls.push({ method, path, body, socketPath: e.init?.socketPath })
    if (method === 'POST') (w.posts[path] ??= []).push(body)
    let status = 200
    let reply: any = {}
    if (path === '/health') reply = fake.health
    else if (path === '/leases') {
      if (fake.leaseReply) ({ status, body: reply } = fake.leaseReply)
      else w.leaseId = reply.leaseId = `lease-${++leaseN}`
    } else if (path === '/agents') reply = fake.agentsReply
    else if (path === '/sessions') {
      const scripted = fake.queue.shift() ?? { events: [], items: {}, approvals: [] }
      const id = `fx-${++sessionN}`
      sessions.set(id, scripted)
      reply = { id }
    } else if (path.endsWith('/events')) {
      const sess = sessions.get(path.split('/')[2])
      const after = +(e.url.split('after=')[1]?.split('&')[0] ?? 0)
      reply = { events: (sess?.events ?? []).filter((ev) => ev.seq > after) }
    } else if (path.includes('/items/')) {
      const sess = sessions.get(path.split('/')[2])
      reply = { event: sess?.items[path.split('/').at(-1)] ?? null }
    } else if (path.endsWith('/approvals') && method === 'GET') {
      reply = { approvals: sessions.get(path.split('/')[2])?.approvals ?? [] }
    } else if (path.startsWith('/sessions/') && !sessions.has(path.split('/')[2])) {
      status = 404
      reply = { error: `no session ${path}` }
    }
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(reply) } }
  })

  on('session.id', () => ({ value: 'main-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.messages', ($: any, e: any) => ({ value: e.as === 'api' ? (w.api[e.agentId ?? ''] ?? []) : (w.rows[e.agentId ?? ''] ?? []) }))
  on('agent.register', ($: any, e: any) => {
    w.registered.push(e)
    return { value: { agent: e.name } }
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

  // The engine's own events: answer beneath the plugin, and record what falls through.
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.context', () => ({ blocks: [{ name: 'base', text: 'base context' }] }))
  on('agent.spawn', ($: any, e: any) => {
    w.bottomSpawns.push(e)
    return { model: e.model ?? SOL.model, agentId: nextAgentId() }
  })
  on('turn.step', async function* ($: any, e: any, next: any) {
    w.bottomSteps.push(e)
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
    return { result: { stdout: 'bottom tool', stderr: '', interrupted: false } }
  })

  return w
}

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
      prompt: 'unused: this agent runs in a foreign harness via bitfrost',
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

test('with no models to offer, the helper\'s hint reaches the user', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  const hint = 'opencode offers 120 models; list the ones you want in providers.opencode.models.'
  w.fake.agentsReply = { agents: [], nameTable: '', hint } as any
  await start($)
  const said = w.uiLogs.filter((l) => l.to !== 'debug' && l.text.includes('no models to offer'))
  expect(said).toHaveLength(1)
  expect(said[0].text).toContain(hint)
  expect(w.registered).toEqual([])
})

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
  expect(textsOf(s4.chunks)).toEqual(['Report delivered.'])
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

test('session.end returns the lease and drops the session\'s agents', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on)
  await start($)

  w.fake.queue.push({ events: [], items: {}, approvals: [] })
  const spawned = await spawn($, 'fix the failing test')
  expect(w.uiLogs.filter((l) => l.text.includes('bitfrost: spawning'))).toHaveLength(1)

  await $.session.end({ reason: 'other', sessionId: 'main-1' } as any)

  const deleted = w.calls.filter((c) => c.method === 'DELETE')
  expect(deleted.map((c) => c.path)).toEqual([`/leases/${w.leaseId}`])

  await step($, spawned.agentId, 0)
  expect(w.bottomSteps).toHaveLength(1)

  await spawn($, 'fix the failing test')
  expect(w.uiLogs.filter((l) => l.text.includes('bitfrost: spawning'))).toHaveLength(1)
  expect(w.bottomSpawns[1].description).toBe('fix the suite')

  const context = await $.prompt.context({ blocks: [{ name: 'base', text: 'base context' }] } as any)
  expect(context.blocks.map((b: any) => b.name)).toEqual(['base'])
})
