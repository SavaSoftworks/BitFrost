// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const waiting = new Map()
const cancels = new Map()
const cancelled = new Set()
let turn = 0
let next = 0
const options = structuredClone(scenario.newSession.result?.configOptions ?? [])
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const fill = (value, sid, cwd) => JSON.parse(JSON.stringify(value).replaceAll('$SESSION', sid).replaceAll('$CWD', cwd))

async function prompt(msg) {
  cancelled.delete(msg.params.sessionId)
  for (const step of scenario.turns[turn++] ?? []) {
    const value = fill(step, msg.params.sessionId, process.env.BITFROST_GROK_CWD)
    if (value.method) {
      if (value.request) {
        const id = next++
        const answer = new Promise((resolve) => waiting.set(id, resolve))
        send({ id, method: value.method, params: value.params })
        await answer
      } else send(value)
    } else if (value.waitCancel) {
      if (!cancelled.has(msg.params.sessionId)) await new Promise((resolve) => cancels.set(msg.params.sessionId, resolve))
      cancels.delete(msg.params.sessionId)
      return send({ id: msg.id, result: { stopReason: 'cancelled' } })
    } else if (value.crash) process.exit(value.crash)
    else if (value.delay) await new Promise((resolve) => setTimeout(resolve, value.delay))
    else if (value.error || value.result) return send({ id: msg.id, ...value })
  }
  send({ id: msg.id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(process.env.BITFROST_GROK_LOG, line + '\n')
  const msg = JSON.parse(line)
  const p = msg.params ?? {}
  if (!msg.method) {
    waiting.get(msg.id)?.(msg.result ?? msg.error)
    waiting.delete(msg.id)
    return
  }
  switch (msg.method) {
    case 'initialize': return send({ id: msg.id, result: scenario.initialize })
    case 'session/new':
    case 'session/load': return send({ id: msg.id, ...scenario.newSession })
    case 'session/set_config_option': {
      const option = options.find((o) => o.id === p.configId)
      if (option) option.currentValue = scenario.reportModel && option.category === 'model' ? scenario.reportModel : p.value
      return send({ id: msg.id, result: { configOptions: options } })
    }
    case 'session/prompt': return void prompt(msg)
    case 'session/cancel':
      cancelled.add(p.sessionId)
      return void cancels.get(p.sessionId)?.()
    case 'session/close': return send({ id: msg.id, result: {} })
    default: return send({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
})
