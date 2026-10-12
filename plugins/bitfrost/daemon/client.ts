// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Talks to the helper over its socket, and starts it when it isn't up.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LOG, RUN_DIR, SOCKET } from './config.ts'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bitfrostd.ts')

export function call(method: string, urlPath: string, timeout = 1000, body?: unknown): Promise<{ status: number; body: any } | null> {
  return new Promise((resolve) => {
    // Avoid pooled connections to a helper that may have exited.
    const req = http.request({ socketPath: SOCKET, path: urlPath, method, timeout, agent: false }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        let parsed: any = null
        try {
          parsed = JSON.parse(data)
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => (req.destroy(), resolve(null)))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export const get = async (urlPath: string, timeout = 1000) => {
  const r = await call('GET', urlPath, timeout)
  return r?.status === 200 ? r.body : null
}

export const health = () => get('/health')

// Returns false when the helper did not come up.
export async function start(): Promise<boolean> {
  if (await health()) return true
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const out = fs.openSync(LOG, 'a')
  const child = spawn(process.execPath, [...process.execArgv, ENTRY, 'serve'], { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  fs.closeSync(out)
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await health()) return true
  }
  return false
}
