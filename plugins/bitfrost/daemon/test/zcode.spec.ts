// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Replay tests for ZCodeAdapter: fake-zcode.mjs prints a recorded run, and
// the events the adapter turns it into are checked.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZCodeAdapter } from '../providers/zcode.ts'
import { Session } from '../session.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.BITFROST_TEST_FIXTURE = path.join(HERE, 'fixtures', 'zcode', 'flash-basic.jsonl')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(desc: string, ready: () => boolean) {
  const deadline = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`)
    await sleep(20)
  }
}

async function replay(model: string): Promise<any[]> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-zcode-test-'))
  const adapter = new ZCodeAdapter(
    {
      electron: process.execPath,
      cli: path.join(HERE, 'fake-zcode.mjs'),
      builtinProviderConfig: path.join(runDir, 'builtin.json'),
      runDir,
      sessionDb: path.join(runDir, 'zcode-sessions.sqlite'),
      socket: path.join(runDir, 'bitfrostd.sock'),
      bridgeInstalled: () => true,
    },
    () => {},
  )
  const session = new Session({ id: '', harness: 'zcode', agent: 'test', model, cwd: runDir, state: 'idle' })
  await adapter.spawnSession(session, { model, cwd: runDir, prompt: 'Read f.txt, then run `wc -l f.txt`, then reply with one word.', canAskUser: true })
  await until('the turn to complete', () => session.events.some((e) => e.type === 'turn_completed'))
  assert.ok(fs.existsSync(path.join(runDir, 'zcode-sessions.sqlite')))
  return session.events.filter((e) => !['user_input','input_consumed'].includes(e.type))
}

test('a flash run replays as one completed turn', async () => {
  const events = await replay('GLM-5.3-Flash')
  assert.deepStrictEqual(events.map((e) => e.type), [
    'turn_started',
    'usage',
    'tool_started',
    'tool_completed',
    'usage',
    'tool_started',
    'tool_completed',
    'text',
    'usage',
    'turn_completed',
  ])
  const started = events.filter((e) => e.type === 'tool_started')
  assert.deepStrictEqual(started.map((e) => e.name), ['Read', 'Bash'])
  assert.ok(String(started[0].input.file_path).endsWith('f.txt'))
  assert.deepStrictEqual(started[1].input, { command: 'wc -l f.txt', description: 'Count lines in f.txt' })
  const finished = events.filter((e) => e.type === 'tool_completed')
  assert.deepStrictEqual(finished.map((e) => e.ok), [true, true])
  assert.strictEqual(finished[0].output, '1\ta\n2\tb\n3\t')
  assert.strictEqual(finished[1].output, '2 f.txt')
  // One usage per model request, so never the sum over the whole turn.
  const usage = events.filter((e) => e.type === 'usage')
  assert.deepStrictEqual(usage.map((e) => e.inputTokens), [18250, 18323, 18356])
  assert.ok(usage.every((e) => e.inputTokens !== 54929))
  const done = events[events.length - 1]
  assert.strictEqual(done.type, 'turn_completed')
  assert.strictEqual(done.status, 'completed')
  assert.strictEqual(done.finalText, '2')
})

test('a turn that ran a different model than the one asked for fails', async () => {
  const events = await replay('GLM-5.3')
  const done = events.find((e) => e.type === 'turn_completed')
  assert.strictEqual(done.status, 'failed')
  assert.match(done.error, /GLM-5\.3-Flash/)
  assert.match(done.error, /instead of GLM-5\.3/)
  assert.deepStrictEqual(events.map((e) => e.type), ['turn_started', 'turn_completed'])
})

function fake(t: any, scenario: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bitfrost-zcode-phase1-'))
  const scenarioFile = path.join(dir,'scenario.json')
  const logFile = path.join(dir,'sent.jsonl')
  fs.writeFileSync(scenarioFile,JSON.stringify(scenario))
  process.env.BITFROST_ZCODE_SCENARIO = scenarioFile
  process.env.BITFROST_ZCODE_LOG = logFile
  const adapter = new ZCodeAdapter({ electron:process.execPath,cli:path.join(HERE,'fake-zcode.mjs'),builtinProviderConfig:path.join(dir,'builtin.json'),runDir:dir,sessionDb:path.join(dir,'zcode-sessions.sqlite'),socket:path.join(dir,'socket'),bridgeInstalled:() => true },() => {})
  t.after(() => { adapter.dispose(); delete process.env.BITFROST_ZCODE_SCENARIO; delete process.env.BITFROST_ZCODE_LOG; fs.rmSync(dir,{ recursive:true,force:true }) })
  const session = new Session({ id:'',harness:'zcode',agent:'test',model:'GLM-test',cwd:dir,state:'idle' })
  const sent = () => fs.existsSync(logFile) ? fs.readFileSync(logFile,'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  return { adapter,session,dir,sent }
}

const native = { type:'session.updated',sessionId:'native-zcode',payload:{} }

test('ZCode disables subagents, workflows, and scheduled runs with one CLI argument on initial and resumed turns', async (t) => {
  const run = fake(t, { first: [native], wait: true, resumed: [{ type: 'turn.completed', payload: { response: 'Done.' } }] })
  await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello', canAskUser: true })
  await until('native session', () => !!run.session.nativeRef?.zcodeSessionId)
  await run.session.deliver(run.adapter, 'continue', 'interrupt')
  await until('both turns', () => run.session.events.filter((e) => e.type === 'turn_completed').length === 2)
  for (const { args } of run.sent()) {
    const i = args.indexOf('--disallowed-tools')
    assert.ok(i >= 0)
    assert.equal(args[i + 1], 'Agent,CreateWorkflow,AmendWorkflow,CronCreate,OffPeakCreate')
    assert.equal(args[i + 2], '--output-format')
    assert.equal(args[args.indexOf('--cwd') + 1], run.dir)
    assert.equal(args[args.indexOf('--mode') + 1], 'edit')
  }
  assert.equal(run.sent().length, 2)
})

test('ZCode bridge denies subagents, workflows, and scheduled runs before harmless scopes, grants, or approvals', async (t) => {
  for (const canAskUser of [true, false]) {
    await t.test(canAskUser ? 'edit' : 'yolo', async (t) => {
      const run = fake(t, { first: [native], wait: true })
      await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello', canAskUser })
      await until('native session', () => !!run.session.nativeRef?.zcodeSessionId)
      const state = (run.adapter as any).states.get(run.session.info.id)
      for (const tool of ['Agent', 'CreateWorkflow', 'AmendWorkflow', 'CronCreate', 'OffPeakCreate']) {
        state.grants.add(`${tool}:{}`)
        for (const scope of ['none', 'workspace', undefined]) {
          const reply = await Promise.race([
            run.adapter.bridge(state.token, { tool_name: tool, tool_input: {}, sideEffectScope: scope }),
            sleep(200).then(() => null),
          ])
          assert.equal(reply?.hookSpecificOutput.permissionDecision, 'deny')
          assert.match(reply.hookSpecificOutput.permissionDecisionReason, /BitFrost subagents.*disabled/)
          assert.ok(reply.hookSpecificOutput.permissionDecisionReason.includes(tool))
        }
      }
      assert.deepEqual(run.adapter.pendingApprovals(run.session), [])
      assert.equal(run.session.events.some((e) => e.type === 'approval_requested'), false)
      const args = run.sent()[0].args
      assert.equal(args[args.indexOf('--disallowed-tools') + 1], 'Agent,CreateWorkflow,AmendWorkflow,CronCreate,OffPeakCreate')
    })
  }
})

const builtInInput = { url: 'https://www.unix.com/man-page/osx/1/diff/', retain_images: false }
const builtInSummary = '**webReader_result_summary:** [{"text":{"title":"diff(1)  [osx man page]","url":"https://www.unix.com/man-page/osx/1/diff/"}}]'
const builtInPrelude = 'The macOS man page confirms the behavior since the libdiff import is recent.'
const builtInAnswer = '## Review: uncommitted changes\n\nNo issues found.'
const builtInBlock = '**🌐 Z.ai Built-in Tool: webReader**\n\n**Input:**\n```json\n' + JSON.stringify(builtInInput) + '\n```\n*Executing on server...*\n**Output:**\n' + builtInSummary
const builtInResponse = builtInPrelude + builtInBlock + '\n                                                ' + builtInAnswer

test('ZCode splits streamed built-in tools and keeps only the final answer through completion snapshots', async (t) => {
  for (const kind of ['text_end', 'finish']) {
    await t.test(kind, async (t) => {
      const run = fake(t, { first: [native,
        { type: 'model.streaming', payload: { kind: 'text_delta', assistantMessageId: 'a', delta: builtInResponse.slice(0, 120) } },
        { type: 'model.streaming', payload: { kind: 'text_delta', assistantMessageId: 'a', delta: builtInResponse.slice(120) } },
        { type: 'model.streaming', seq: 3, payload: { kind, assistantMessageId: 'a' } },
        { type: 'model.streaming', seq: 4, payload: { kind: 'finish', assistantMessageId: 'a' } },
        { type: 'turn.completed', payload: { response: builtInResponse } },
        { type: 'result', response: builtInResponse },
      ] })
      await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
      await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
      const events: any[] = run.session.events.filter((e) => !['user_input', 'input_consumed'].includes(e.type))
      assert.deepEqual(events.map((e) => e.type), ['turn_started', 'text', 'tool_started', 'tool_completed', 'text', 'turn_completed'])
      assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), [builtInPrelude, builtInAnswer])
      const started = events.find((e) => e.type === 'tool_started')
      const completed = events.find((e) => e.type === 'tool_completed')
      assert.equal(started.name, 'webReader')
      assert.deepEqual(started.input, builtInInput)
      assert.equal(completed.itemId, started.itemId)
      assert.equal(completed.name, 'webReader')
      assert.deepEqual(completed.input, builtInInput)
      assert.equal(completed.output, builtInSummary)
      assert.equal(completed.ok, true)
      assert.equal(events.at(-1).finalText, builtInAnswer)
    })
  }
})

test('ZCode splits built-in tools supplied only by turn.completed or result', async (t) => {
  for (const type of ['turn.completed', 'result']) {
    await t.test(type, async (t) => {
      const event = type === 'result' ? { type, response: builtInResponse } : { type, payload: { response: builtInResponse } }
      const run = fake(t, { first: [native, event] })
      await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
      await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
      assert.equal((run.session.events.at(-1) as any).finalText, builtInAnswer)
      assert.deepEqual(run.session.events.filter((e) => e.type === 'text').map((e) => e.text), [builtInPrelude, builtInAnswer])
      const tools: any[] = run.session.events.filter((e) => e.type === 'tool_started' || e.type === 'tool_completed')
      assert.deepEqual(tools.map((e) => e.name), ['webReader', 'webReader'])
      assert.equal(tools[1].output, builtInSummary)
    })
  }
})

test('ZCode accepts optional built-in formatting, missing output, and invalid JSON across multiple blocks', async (t) => {
  const first = builtInBlock.replace('🌐 ', '').replace('```json', '```').replace('**Output:**\n', '')
  const second = '**Z.ai Built-in Tool: webSearch**\n**Input:**\n```\n{invalid json}\n```'
  const response = 'Before.' + first + '\n   Between.\n' + second + '\n   Final answer.\n'
  const run = fake(t, { first: [native, { type: 'result', response }] })
  await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
  await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
  assert.equal((run.session.events.at(-1) as any).finalText, 'Final answer.')
  assert.deepEqual(run.session.events.filter((e) => e.type === 'text').map((e) => e.text), ['Before.', 'Between.', 'Final answer.'])
  const tools: any[] = run.session.events.filter((e) => e.type === 'tool_completed')
  assert.deepEqual(tools.map((e) => [e.name, e.input, e.output]), [
    ['webReader', builtInInput, builtInSummary],
    ['webSearch', '{invalid json}', ''],
  ])
})

test('ZCode leaves ordinary text and incomplete built-in-looking blocks unchanged', async (t) => {
  const cases = [
    ['plain text', '  Plain answer.\n'],
    ['missing input', '**🌐 Z.ai Built-in Tool: webReader**\nMissing input.'],
    ['unrecognized fence language', builtInBlock.replace('```json', '```text') + '\nAnswer.'],
    ['unclosed fence', '**Z.ai Built-in Tool: webReader**\n**Input:**\n```json\n{}\nAnswer.'],
    ['invalid closing fence', builtInBlock.replace('\n```\n', '\n```not a closing fence\n') + '\nAnswer.'],
  ]
  for (const [name, response] of cases) {
    await t.test(name, async (t) => {
      const run = fake(t, { first: [native,
        { type: 'model.streaming', payload: { kind: 'text_delta', assistantMessageId: 'a', delta: response } },
        { type: 'model.streaming', seq: 2, payload: { kind: 'text_end', assistantMessageId: 'a' } },
        { type: 'turn.completed', payload: { response } },
        { type: 'result', response },
      ] })
      await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
      await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
      assert.equal((run.session.events.at(-1) as any).finalText, response)
      assert.deepEqual(run.session.events.filter((e) => e.type === 'text').map((e) => e.text), [response.trim()])
      assert.equal(run.session.events.some((e) => e.type === 'tool_started' || e.type === 'tool_completed'), false)
    })
  }
})

test('turn.failed uses the structured provider error instead of stderr, including 1005 vs 3002 vs 1006', async (t) => {
  const { classifyZCodeError } = await import('../providers/zcode.ts')
  const cases = [['1005','quota_exhausted'],['3002','rate_limited'],['1006','auth'],['1113','quota_exhausted'],['1321','quota_exhausted'],['2056','quota_exhausted'],['20097','quota_exhausted'],['insufficient_quota','quota_exhausted'],['credit_balance_exhausted','quota_exhausted'],['daily_spend_limit_exceeded','quota_exhausted'],['429','rate_limited'],['1305','rate_limited'],['3007','auth'],['403','auth'],['other','error']]
  for (const [code,reason] of cases) assert.equal(classifyZCodeError(code),reason)
  for (const [code,reason] of cases.slice(0,3)) {
    const run = fake(t,{ first:[native,{ type:'turn.failed',payload:{ error:{ attribution:{ providerErrorCode:code },reason:'provider refused',retryable:false } } }] })
    await run.adapter.spawnSession(run.session,{ model:'GLM-test',cwd:run.dir,prompt:'hello' })
    await until('failure',() => run.session.events.some((e) => e.type === 'turn_completed'))
    const done: any = run.session.events.at(-1)
    assert.deepEqual([done.status,done.reason,done.providerErrorCode,done.error],['failed',reason,code,'provider refused'])
    assert.equal(done.plan,'account:zai-individual-coding-plan')
    assert.equal(run.session.nativeRef.zcodeSessionId,'native-zcode')
  }
})

test('session.updated model_request_failed carries the same classification', async (t) => {
  const run = fake(t,{ first:[native,{ type:'session.updated',payload:{ kind:'model_request_failed',error:{ message:'Credits exhausted',attribution:{ providerErrorCode:1005 } } } }] })
  await run.adapter.spawnSession(run.session,{ model:'GLM-test',cwd:run.dir,prompt:'hello' })
  await until('failure',() => run.session.events.some((e) => e.type === 'turn_completed'))
  assert.equal((run.session.events.at(-1) as any).reason,'quota_exhausted')
})

test('the fake steering wheel restarts ZCode in the same native session with a receipt', async (t) => {
  const run = fake(t,{ first:[native,{ type:'model.streaming',payload:{ kind:'text_delta',assistantMessageId:'a',delta:'partial' } }],wait:true,resumed:[native,{ type:'turn.completed',payload:{ response:'Continued.' } }] })
  await run.adapter.spawnSession(run.session,{ model:'GLM-test',cwd:run.dir,prompt:'original' })
  await until('native id',() => !!run.session.nativeRef?.zcodeSessionId)
  const receipt = await run.session.deliver(run.adapter,'new requirement','interrupt')
  assert.equal(receipt.delivery,'restarted')
  await until('both turns',() => run.session.events.filter((e) => e.type === 'turn_completed').length === 2)
  const turns: any[] = run.session.events.filter((e) => e.type === 'turn_completed')
  assert.deepEqual([turns[0].status,turns[0].reason,turns[0].continues,turns[0].finalText],['interrupted','restarted',true,'partial'])
  assert.equal(turns[1].finalText,'Continued.')
  const args = run.sent()[1].args
  assert.equal(args[args.indexOf('--resume')+1],'native-zcode')
  assert.match(args[args.indexOf('-p')+1],/lead interrupted.*\nnew requirement/)
  const consumed: any = run.session.events.find((e) => e.type === 'input_consumed' && e.inputId === receipt.inputId)
  assert.equal(consumed.turnId,turns[1].turnId)
})

test('stop escalates and kills ZCode and its child process group', async (t) => {
  const childFile = path.join(os.tmpdir(),`bitfrost-child-${process.pid}.pid`)
  t.after(() => fs.rmSync(childFile,{ force:true }))
  const run = fake(t,{ first:[native],wait:true,ignoreTerm:true,childFile })
  await run.adapter.spawnSession(run.session,{ model:'GLM-test',cwd:run.dir,prompt:'hold' })
  await until('child',() => fs.existsSync(childFile))
  await sleep(80)
  assert.equal(await run.session.stop(run.adapter,'host',{ graceMs:30,killMs:2000 }),'forced')
  const pid = Number(fs.readFileSync(childFile,'utf8'))
  const alive = () => {
    try {
      process.kill(pid,0)
      if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2] === 'Z') return false
      return true
    } catch { return false }
  }
  await until('child to exit',() => !alive())
  assert.equal(run.session.info.state,'idle')
})

test('ZCode sessionDbFor preserves its existing database and WAL', async (t) => {
  const { sessionDbFor } = await import('../providers/zcode.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bitfrost-zcode-db-'))
  t.after(() => fs.rmSync(dir,{ recursive:true,force:true }))
  const db = sessionDbFor(dir)
  fs.writeFileSync(db,'persistent history')
  fs.writeFileSync(`${db}-wal`,'pending history')
  assert.equal(sessionDbFor(dir),db)
  assert.equal(fs.readFileSync(db,'utf8'),'persistent history')
  assert.equal(fs.readFileSync(`${db}-wal`,'utf8'),'pending history')
})

test('ZCode rehydrates from the store and resumes its native session with the saved effort', async (t) => {
  const { Store } = await import('../store.ts')
  const run = fake(t,{ first:[native],wait:true,resumed:[native,{ type:'turn.completed',payload:{ response:'Resumed.' } }] })
  const store = new Store(path.join(run.dir,'bitfrost.db'))
  const s = new Session({ id:'',harness:'zcode',agent:'test',model:'GLM-test',cwd:run.dir,state:'idle' },store)
  const next = new ZCodeAdapter((run.adapter as any).config,() => {})
  t.after(() => { next.dispose(); store.close() })
  await run.adapter.spawnSession(s,{ model:'GLM-test',effort:'high',cwd:run.dir,prompt:'first',canAskUser:true })
  await until('native ref to persist',() => !!s.nativeRef?.zcodeSessionId)
  assert.equal(await s.stop(run.adapter,'host'),'graceful')
  run.adapter.disposeSession(s)
  const restored = Session.load(s.info.id,store)!
  assert.equal(restored.info.state,'detached')
  assert.equal((await restored.deliver(next,'continue')).delivery,'started')
  await until('resumed completion',() => restored.events.filter((e) => e.type === 'turn_completed').length === 2)
  const args = run.sent()[1].args
  assert.equal(args[args.indexOf('--resume')+1],'native-zcode')
  assert.equal(args[args.indexOf('--mode')+1],'edit')
  const choice = JSON.parse(fs.readFileSync((next as any).states.get(s.info.id).choiceFile,'utf8'))
  assert.equal(choice.config.defaultModelSelection.options.reasoningLevel,'high')
  assert.equal(store.messages(s.info.id).turns[0].finalText,'Resumed.')
})

test('a retried ZCode model_request_failed does not replace a successful end reason', async (t) => {
  const run = fake(t,{ first:[native,{ type:'session.updated',payload:{ type:'model_request_failed',providerErrorCode:'3002',retryable:true,message:'Busy' } },{ type:'turn.completed',payload:{ response:'Recovered.' } }] })
  await run.adapter.spawnSession(run.session,{ model:'GLM-test',cwd:run.dir,prompt:'hello' })
  await until('recovery',() => run.session.events.some((e) => e.type === 'turn_completed'))
  assert.equal((run.session.events.at(-1) as any).reason,'end_turn')
})

test('ZCode business codes take precedence over HTTP status and match the code table ZCode uses', async (t) => {
  const { classifyZCodeError } = await import('../providers/zcode.ts')
  // As ZCode's own table: 1113 balance, 1304 rate limit, 1120 and unknown codes plain errors.
  assert.equal(classifyZCodeError('1113'), 'quota_exhausted')
  assert.equal(classifyZCodeError('1304'), 'rate_limited')
  for (const code of ['1000', '1004', '1110', '1120']) assert.equal(classifyZCodeError(code), 'error')
  for (const code of [1308, 1310]) {
    const run = fake(t, { first: [native, { type: 'turn.failed', payload: { error: { statusCode: 429, code, message: 'business limit' } } }] })
    await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
    await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
    const end: any = run.session.events.at(-1)
    assert.deepEqual([end.reason, end.providerErrorCode], ['quota_exhausted', String(code)])
  }
})

test('ZCode attach defaults to edit and keeps an existing private native session database', async (t) => {
  const run = fake(t, { resumed: [{ type: 'turn.completed', payload: { response: 'Resumed.' } }] })
  const file = path.join(run.dir, 'zcode-sessions.sqlite')
  fs.writeFileSync(file, 'existing sessions', { mode: 0o644 })
  run.session.info.id = 'saved'
  run.session.info.state = 'detached'
  run.session.nativeRef = { zcodeSessionId: 'old' }
  await run.session.deliver(run.adapter, 'continue')
  await until('completion', () => run.session.events.some((e) => e.type === 'turn_completed'))
  const args = run.sent()[0].args
  assert.equal(args[args.indexOf('--mode') + 1], 'edit')
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing sessions')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('ZCode finalizes after process exit even when a child retains the output pipes', async (t) => {
  const childFile = path.join(os.tmpdir(), `bitfrost-pipes-${process.pid}`)
  const run = fake(t, { first: [native, { type: 'turn.completed', payload: { response: 'Finished.' } }], childFile, inheritPipes: true })
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(childFile, 'utf8')), 'SIGKILL') } catch {}
    fs.rmSync(childFile, { force: true })
  })
  await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
  const began = Date.now()
  await until('completion with inherited pipes', () => run.session.events.some((e) => e.type === 'turn_completed'))
  assert.ok(Date.now() - began < 2500)
  assert.equal(run.session.info.state, 'idle')
  assert.equal((run.session.events.at(-1) as any).finalText, 'Finished.')
  run.adapter.disposeSession(run.session)
  const pid = Number(fs.readFileSync(childFile, 'utf8'))
  await until('child cleanup', () => {
    try { process.kill(pid, 0); return /^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
  })
})

test('each ZCode turn persists a process identity and only a matching owned process group is killed', async (t) => {
  const { Store } = await import('../store.ts')
  const { killOwnedGroup } = await import('../process.ts')
  const run = fake(t, { first: [native], wait: true, ignoreTerm: true })
  const store = new Store(path.join(run.dir, 'bitfrost.db'))
  t.after(() => store.close())
  const s = new Session({ ...run.session.info }, store)
  await run.adapter.spawnSession(s, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
  await until('native session', () => !!s.nativeRef?.zcodeSessionId)
  const turn = store.unfinished()[0]
  assert.equal(turn.pgid, run.sent()[0].pid)
  const identity = JSON.parse(turn.process_identity)
  assert.equal(killOwnedGroup({ ...identity, token: 'different process' }), false)
  assert.equal(killOwnedGroup({ ...identity, startTime: '0' }), false)
  assert.equal(killOwnedGroup(identity), true)
  await until('killed turn', () => s.activeTurnId === null)
})

test('ZCode deferred questions never wait on a hung stop and preserve queued lead input', async (t) => {
  const run = fake(t, { first: [native], wait: true })
  await run.adapter.spawnSession(run.session, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
  await until('native session', () => !!run.session.nativeRef?.zcodeSessionId)
  const state = (run.adapter as any).states.get(run.session.info.id)
  const question = run.adapter.bridge(state.token, { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [] }] } })
  const input = await run.session.deliver(run.adapter, 'The lead answer.')
  let options: any
  run.session.stop = (_provider, _source, value) => { options = value; return new Promise(() => {}) }
  const answer = await Promise.race([run.adapter.answerQuestion(run.session, run.adapter.pendingQuestions(run.session)[0], null, true), sleep(100).then(() => 'blocked')])
  assert.equal(answer, true)
  assert.equal(options.preserveQueue, true)
  assert.equal(run.session.events.filter((e) => e.type === 'input_dropped' && e.inputId === input.inputId).length, 0)
  await question
})

test('a ZCode tool without a name is stored safely and a restart before a native id starts over with the earlier messages', async (t) => {
  const { Store } = await import('../store.ts')
  const run = fake(t, { first: [native,
    { type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'unnamed', input: {} } },
    { type: 'tool.updated', payload: { kind: 'started', toolCallId: 'unnamed' } },
    { type: 'tool.updated', payload: { kind: 'result', toolCallId: 'unnamed', result: { content: 'Done.' } } },
  ] })
  const store = new Store(path.join(run.dir, 'bitfrost.db'))
  t.after(() => store.close())
  const s = new Session({ ...run.session.info }, store)
  await run.adapter.spawnSession(s, { model: 'GLM-test', cwd: run.dir, prompt: 'hello' })
  await until('stored completion', () => s.activeTurnId === null)
  assert.equal(store.degraded, false)
  assert.equal(store.message(s.info.id, 'unnamed')!.name, 'tool')
  const early = fake(t, { first: [], wait: true })
  await early.adapter.spawnSession(early.session, { model: 'GLM-test', cwd: early.dir, prompt: 'hello' })
  await until('process launch', () => early.sent().length > 0)
  const input = await early.session.deliver(early.adapter, 'continue', 'interrupt')
  await until('fresh run', () => early.sent().length === 2)
  const args = early.sent()[1].args
  assert.equal(args.includes('--resume'), false)
  assert.match(args[args.indexOf('-p') + 1], /^hello\n\n[\s\S]*continue$/)
  await until('input consumed', () => early.session.events.some((e) => e.type === 'input_consumed' && e.inputId === input.inputId))
  assert.equal(early.session.events.some((e) => e.type === 'session_failed'), false)
})
