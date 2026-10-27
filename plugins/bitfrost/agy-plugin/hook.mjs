// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Sends one Antigravity hook call to the BitFrost helper and prints its answer.
// A tool call the helper doesn't explicitly allow or deny is blocked (exit 2), never
// allowed; other hooks fall back to no opinion.
import http from 'node:http'

const hook = process.argv[2] ?? ''
let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  let payload
  try { payload = JSON.parse(input || '{}') } catch { return fail('Antigravity sent a hook call BitFrost could not read') }
  const req = http.request(
    {
      socketPath: process.env.BITFROST_SOCKET,
      path: '/providers/agy/bridge',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bitfrost-token': process.env.BITFROST_AGY_TOKEN },
    },
    (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (res.statusCode !== 200) return fail(`BitFrost refused the call (${res.statusCode})`)
        if (hook === 'PreToolUse') {
          let reply
          try { reply = JSON.parse(body) } catch { return fail('BitFrost did not answer the tool call') }
          if (!['allow', 'deny'].includes(reply?.decision)) return fail('BitFrost did not authorize the tool call')
        }
        if (body.trim()) process.stdout.write(body)
        process.exit(0)
      })
    },
  )
  req.on('error', () => fail('BitFrost is not reachable'))
  req.end(JSON.stringify({ hook, input: payload }))
})

function fail(reason) {
  if (hook !== 'PreToolUse') process.exit(0)
  process.stderr.write(reason)
  process.exit(2)
}
