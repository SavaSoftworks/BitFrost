// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Sends one ZCode tool call to the bitfrost helper and prints its answer. If
// the helper can't be reached the call is denied (exit 2), never allowed.
import http from 'node:http'

let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  const req = http.request(
    {
      socketPath: process.env.BITFROST_SOCKET,
      path: '/zcode/hook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bitfrost-token': process.env.BITFROST_ZCODE_TOKEN },
    },
    (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (res.statusCode !== 200) return deny(`bitfrost refused the call (${res.statusCode})`)
        if (body.trim()) process.stdout.write(body)
        process.exit(0)
      })
    },
  )
  req.on('error', () => deny('bitfrost is not reachable'))
  req.end(input)
})

function deny(reason) {
  process.stderr.write(reason)
  process.exit(2)
}
