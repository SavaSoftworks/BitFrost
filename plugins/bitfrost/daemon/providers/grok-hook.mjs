// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import http from 'node:http'

let input = ''
let finished = false
function deny(reason) {
  if (finished) return
  finished = true
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }))
  process.exitCode = 2
}

process.stdin.on('error', () => deny('BitFrost could not read the tool call.'))
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  if (!process.env.BITFROST_SOCKET || !process.env.BITFROST_GROK_TOKEN) return deny('This Grok process was not started by BitFrost.')
  const req = http.request({ socketPath: process.env.BITFROST_SOCKET, path: '/providers/grok/bridge', method: 'POST', headers: { 'content-type': 'application/json', 'x-bitfrost-token': process.env.BITFROST_GROK_TOKEN } }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('error', () => deny('BitFrost did not finish answering the tool call.'))
    res.on('end', () => {
      if (res.statusCode !== 200) return deny(`BitFrost refused the tool call (${res.statusCode}).`)
      let reply
      try { reply = JSON.parse(body) } catch { return deny('BitFrost returned an unreadable answer.') }
      if (!['allow', 'deny'].includes(reply?.decision)) return deny('BitFrost did not authorize the tool call.')
      if (finished) return
      finished = true
      process.stdout.write(JSON.stringify(reply))
    })
  })
  req.on('error', () => deny('BitFrost is not reachable.'))
  req.end(input)
})
