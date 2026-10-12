// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for "crush server". Usage: fake-crush.mjs <fixture.json> server -H unix://<sock> -D <dir>
// Each prompt plays the next turn from the fixture. Steps:
//   {emit}        send one event; $SID, $RUN and $CWD are filled in
//   {permission}  send a permission request and wait for its grant, then play allow or deny
//   {hook}        run the PreToolUse hooks from the task's crush.json, then play allow, deny or none
//   {question}    send a question batch and wait, then play answered or cancelled
//   {waitCancel}  wait for the cancel call
//   {complete}    send run_complete for this run
//   {crash}       exit with that code
// Requests go to $BITFROST_CRUSH_LOG as JSON lines. After a crash, $BITFROST_CRUSH_MARK
// exists and later processes play afterCrash instead of turns.
import fs from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'

const [fixturePath, ...args] = process.argv.slice(2)
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
const host = args[args.indexOf('-H') + 1]
const sock = host.replace(/^unix:\/\//, '')
const LOG = process.env.BITFROST_CRUSH_LOG
const MARK = process.env.BITFROST_CRUSH_MARK
const crashed = MARK && fs.existsSync(MARK)
const turns = (crashed && fixture.afterCrash) || fixture.turns || []

const log = (entry) => LOG && fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
log({ start: args, pid: process.pid, env: Object.fromEntries(['BITFROST_SOCKET', 'BITFROST_CRUSH_TOKEN', 'CRUSH_CACHE_DIR', 'CRUSH_SERVER_IDLE_TIMEOUT'].map((k) => [k, process.env[k]])) })

let workspace = null
let selected = null
let turnIndex = 0
let run = null
const streams = []
const waiters = new Map()
const sessions = new Map()

function send(ev) {
  let text = JSON.stringify(ev)
  if (run) text = text.replaceAll('$RUN', run.id)
  text = text.replaceAll('$SID', 'ses_1').replaceAll('$CWD', workspace?.path ?? '')
  for (const s of streams) s.write(`data: ${text}\n\n`)
}

const wait = (key) => new Promise((resolve) => waiters.set(key, resolve))
const wake = (key, value) => {
  const w = waiters.get(key)
  if (!w) return false
  waiters.delete(key)
  w(value)
  return true
}

async function runHooks(step) {
  const cfg = JSON.parse(fs.readFileSync(`${workspace.data_dir}/crush.json`, 'utf8'))
  const payload = JSON.stringify({ event: 'PreToolUse', session_id: 'ses_1', cwd: workspace.path, tool_name: step.tool_name, tool_input: step.tool_input }).replaceAll('$CWD', workspace.path)
  let decision = 'none'
  let reason = ''
  for (const h of cfg.hooks?.PreToolUse ?? []) {
    if (h.matcher && !new RegExp(h.matcher).test(step.tool_name)) continue
    const out = await new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', h.command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(payload)
    })
    let parsed = {}
    try { parsed = out.stdout.trim() ? JSON.parse(out.stdout) : {} } catch {}
    const d = out.code === 2 ? 'deny' : parsed.decision ?? 'none'
    if (d === 'deny') [decision, reason] = ['deny', out.code === 2 ? out.stderr : parsed.reason ?? '']
    else if (d === 'allow' && decision !== 'deny') decision = 'allow'
    log({ hook: h.name, tool: step.tool_name, code: out.code, decision: d, reason: parsed.reason ?? out.stderr })
  }
  return { decision, reason }
}

async function play(steps) {
  for (const step of steps) {
    if (run.cancelled && !step.complete) return finish({ cancelled: true })
    if (step.emit) send(step.emit)
    else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep))
    else if (step.crash !== undefined) {
      if (MARK) fs.writeFileSync(MARK, 'crashed')
      process.exit(step.crash)
    } else if (step.permission) {
      send({ type: 'permission_request', payload: { type: 'created', payload: step.permission } })
      const action = await wait(`grant:${step.permission.id}`)
      if (action === 'cancelled') return finish({ cancelled: true })
      send({ type: 'permission_notification', payload: { type: 'created', payload: { tool_call_id: step.permission.tool_call_id, granted: action !== 'deny', denied: action === 'deny' } } })
      await play(action === 'deny' ? step.deny ?? [] : step.allow ?? [])
      if (run.done) return
    } else if (step.hook) {
      const { decision, reason } = await runHooks(step.hook)
      if (run.cancelled) return finish({ cancelled: true })
      const branch = (step[decision] ?? []).map((s) => JSON.parse(JSON.stringify(s).replaceAll('$REASON', JSON.stringify(reason).slice(1, -1))))
      await play(branch)
      if (run.done) return
    } else if (step.question) {
      send({ type: 'question_batch_request', payload: { type: 'created', payload: step.question } })
      const how = await wait('question')
      if (how === 'cancelled-turn') return finish({ cancelled: true })
      send({ type: 'question_batch_notification', payload: { type: 'created', payload: { batch_id: step.question.id } } })
      await play(how === 'answered' ? step.answered ?? [] : step.cancelled ?? [])
      if (run.done) return
    } else if (step.waitCancel) {
      if (!run.cancelled) await wait('cancel')
      return finish({ cancelled: true })
    } else if (step.complete) return finish(step.complete)
  }
}

function finish(fields) {
  if (run.done) return
  run.done = true
  send({ type: 'run_complete', payload: { type: 'updated', payload: { session_id: 'ses_1', run_id: run.id, message_id: '', ...fields } } })
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://crush')
    const body = data ? JSON.parse(data) : undefined
    if (url.pathname !== '/v1/health') log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    const sub = workspace && url.pathname.startsWith(`/v1/workspaces/${workspace.id}`) ? url.pathname.slice(`/v1/workspaces/${workspace.id}`.length) : null
    if (url.pathname === '/v1/health') return reply(res, 200)
    if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
      workspace = { id: 'ws_1', path: body.path, data_dir: body.data_dir, client_id: body.client_id }
      return reply(res, 200, workspace)
    }
    if (sub === null) return reply(res, 404, { message: 'workspace not found' })
    if (req.method === 'GET' && sub === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      streams.push(res)
      res.on('close', () => streams.splice(streams.indexOf(res), 1))
      return
    }
    if (req.method === 'GET' && sub === '/config') return reply(res, 200, { ...fixture.config, models: selected ? { large: selected, small: selected } : fixture.config?.models })
    if (req.method === 'POST' && sub === '/config/model') {
      if (body.model_type === 'large') selected = body.model
      return reply(res, 200)
    }
    if (req.method === 'POST' && sub === '/agent/update') return reply(res, 200)
    if (req.method === 'GET' && sub === '/agent') {
      const cfg = fixture.agentModel ?? selected
      return reply(res, 200, { is_busy: !!run && !run.done, is_ready: true, model: { id: cfg?.model }, model_cfg: cfg })
    }
    if (req.method === 'POST' && sub === '/sessions') {
      const s = { id: 'ses_1', parent_session_id: '', title: body?.title ?? '', message_count: 0, prompt_tokens: 0, completion_tokens: 0 }
      sessions.set(s.id, s)
      send({ type: 'session', payload: { type: 'created', payload: s } })
      return reply(res, 200, s)
    }
    const session = sub.match(/^\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && session) {
      const known = sessions.get(session[1]) ?? fixture.sessions?.[session[1]]
      return known ? reply(res, 200, known) : reply(res, 404, { message: 'session not found' })
    }
    if (req.method === 'POST' && sub === '/agent') {
      const steps = turns[turnIndex++]
      if (!steps) return reply(res, 500, { message: 'the fixture has no more turns' })
      run = { id: body.run_id, cancelled: false, done: false }
      reply(res, 202)
      play(steps).catch((e) => log({ error: e.message }))
      return
    }
    if (req.method === 'POST' && /^\/agent\/sessions\/[^/]+\/cancel$/.test(sub)) {
      if (run) run.cancelled = true
      for (const key of [...waiters.keys()]) wake(key, key === 'question' ? 'cancelled-turn' : key === 'cancel' ? true : 'cancelled')
      return reply(res, 200)
    }
    if (req.method === 'POST' && sub === '/permissions/grant') {
      const resolved = wake(`grant:${body.permission.id}`, body.action)
      return reply(res, 200, { resolved })
    }
    if (req.method === 'POST' && sub === '/questions/answer') return reply(res, 200, { resolved: wake('question', 'answered') })
    if (req.method === 'POST' && sub === '/questions/cancel') return reply(res, 200, { resolved: wake('question', 'cancelled') })
    if (req.method === 'DELETE' && sub === '') return reply(res, 200)
    reply(res, 404, { message: `no route ${req.method} ${url.pathname}` })
  })
})

try { fs.rmSync(sock, { force: true }) } catch {}
server.listen(sock)
const stop = () => process.exit(0)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
