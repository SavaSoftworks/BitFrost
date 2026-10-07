// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for an ACP app in tests: it plays the scenario file named on its
// command line and logs what it receives to BITFROST_ACP_LOG.
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const logFile = process.env.BITFROST_ACP_LOG
let nextId = 0 // opencode numbers its own requests from 0
const waiting = new Map()
const cancelled = new Set()
const cancelWaiters = new Map()
let options = structuredClone(scenario.newSession?.result?.configOptions ?? [])
let turnIndex = 0
let sessionIndex = 0

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const fill = (value, sessionId) => JSON.parse(JSON.stringify(value).replaceAll('$SESSION', sessionId))
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

function setOption(configId, value) {
  const option = options.find((o) => o.id === configId)
  if (!option) return { error: { code: -32602, message: `unknown config option: ${configId}` } }
  if (option.category === 'model') {
    option.currentValue = scenario.reportModel ?? value
    options = options.filter((o) => o.category !== 'thought_level')
    const level = scenario.levels?.[value]
    if (level) options.push(structuredClone(level))
  } else {
    const values = option.options.map((o) => o.value)
    if (!values.includes(value)) return { error: { code: -32602, message: `no such value: ${value}` } }
    option.currentValue = value
  }
  return { result: { configOptions: options } }
}

async function runTurn(id, sessionId) {
  cancelled.delete(sessionId)
  const loaded = process.env.BITFROST_ACP_MARK && fs.existsSync(process.env.BITFROST_ACP_MARK)
  const steps = (loaded ? scenario.afterRestart ?? scenario.turns : scenario.turns)[turnIndex++] ?? []
  let result = { stopReason: 'end_turn' }
  const play = async (list) => {
    for (const step of list) {
      if (step.update) send({ method: 'session/update', params: { sessionId, update: fill(step.update, sessionId) } })
      else if (step.delay) await new Promise((resolve) => setTimeout(resolve, step.delay))
      else if (step.ask) {
        const answer = await ask(step.ask, fill(step.params, sessionId))
        const picked = answer.outcome?.optionId ? step.params.options.find((o) => o.optionId === answer.outcome.optionId)?.kind : (answer.outcome?.outcome ?? answer.action)
        await play(step.then?.[picked] ?? [])
      } else if (step.waitCancel) {
        if (!cancelled.has(sessionId)) await new Promise((resolve) => cancelWaiters.set(sessionId, resolve))
        result = { stopReason: 'cancelled' }
        return
      } else if (step.crash !== undefined) {
        const mark = process.env.BITFROST_ACP_MARK
        if (!mark || !fs.existsSync(mark)) {
          if (mark) fs.writeFileSync(mark, 'crashed')
          process.exit(step.crash)
        }
      } else if (step.respond) result = step.respond
    }
  }
  await play(steps)
  send({ id, result })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (logFile) fs.appendFileSync(logFile, line + '\n')
  const msg = JSON.parse(line)
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? msg.error)
    waiting.delete(msg.id)
    return
  }
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: scenario.initialize })
    case 'session/load':
      if (scenario.ignoreLoad) return
      if (scenario.loadDelay) return setTimeout(() => send({ id: msg.id, ...structuredClone(scenario.newSession) }), scenario.loadDelay)
      return send({ id: msg.id, ...structuredClone(scenario.newSession) })
    case 'session/new': {
      const answer = structuredClone(scenario.newSession)
      if (answer.result && scenario.uniqueSessions) answer.result.sessionId += `_${++sessionIndex}`
      if (scenario.newDelay) return setTimeout(() => send({ id: msg.id, ...answer }), scenario.newDelay)
      return send({ id: msg.id, ...answer })
    }
    case 'session/set_config_option': {
      const answer = setOption(p.configId, p.value)
      if (answer.result && options.find((o) => o.id === p.configId)?.category === 'model') {
        send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options } } })
      }
      return send({ id: msg.id, ...answer })
    }
    case 'session/set_model':
    case 'session/close':
    case 'session/delete':
      return send({ id: msg.id, result: {} })
    case 'session/prompt':
      return void runTurn(msg.id, p.sessionId)
    case 'session/cancel':
      if (scenario.ignoreCancel) return
      cancelled.add(p.sessionId)
      cancelWaiters.get(p.sessionId)?.()
      cancelWaiters.delete(p.sessionId)
      return
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } })
  }
})
