// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for bitfrost update, against a local server that answers like GitHub.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { latestVersion, newer, update } from '../update.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-update-test-'))
const ran = path.join(dir, 'ran')
// Repos and their latest tag. /broken has a release but no installer in it.
const repos: Record<string, string | null> = { '/with': 'v0.9.1', '/without': null, '/broken': 'v0.9.2' }
const fetched: string[] = []

const server = http.createServer((req, res) => {
  fetched.push(`${req.method} ${req.url}`)
  const [, repo, ...rest] = req.url!.split('/')
  const tag = repos[`/${repo}`]
  if (tag === undefined) return res.writeHead(404).end()
  if (rest.join('/') === 'releases/latest') {
    return res.writeHead(302, { location: tag ? `https://github.com/o/r/releases/tag/${tag}` : 'https://github.com/o/r/releases' }).end()
  }
  if (tag && repo !== 'broken' && rest.join('/') === `releases/download/${tag}/install.sh`) {
    return res.writeHead(200).end(`echo "$@" > '${ran}'\n`)
  }
  res.writeHead(404).end()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

after(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('versions compare by number, not by text', () => {
  assert.ok(newer('0.10.0', '0.9.9'))
  assert.ok(newer('1.0', '0.99.99'))
  assert.ok(newer('0.8.3.1', '0.8.3'))
  assert.ok(!newer('0.8.3', '0.8.3'))
  assert.ok(!newer('0.8.3', '0.8.3.0'))
  assert.ok(!newer('0.8.2', '0.8.3'))
})

test('the latest version comes from the redirect, not the API', async () => {
  assert.strictEqual(await latestVersion(`${base}/with`), '0.9.1')
  await assert.rejects(latestVersion(`${base}/without`), /no release yet/)
  await assert.rejects(latestVersion(`${base}/missing`), /no such repository/)
})

test('an up to date install downloads nothing', async () => {
  fetched.length = 0
  assert.strictEqual(await update(`${base}/with`, '0.9.1'), 0)
  assert.strictEqual(await update(`${base}/with`, '1.0.0'), 0)
  assert.deepStrictEqual(fetched, ['HEAD /with/releases/latest', 'HEAD /with/releases/latest'])
  assert.ok(!fs.existsSync(ran))
})

test('a newer release runs its own installer for that version', async () => {
  assert.strictEqual(await update(`${base}/with`, '0.8.3'), 0)
  assert.strictEqual(fs.readFileSync(ran, 'utf8').trim(), '--version 0.9.1')
  fs.rmSync(ran)
})

test('no release, or a release without an installer, fails without running anything', async () => {
  assert.strictEqual(await update(`${base}/without`, '0.8.3'), 1)
  assert.strictEqual(await update(`${base}/broken`, '0.8.3'), 1)
  assert.ok(!fs.existsSync(ran))
})
