// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// bitfrost update: runs the newest release's installer when that release is newer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { VERSION } from './config.ts'

const REPO = process.env.BITFROST_REPO || 'SavaSoftworks/BitFrost'

export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

// GitHub redirects /releases/latest to the newest tag. No API call, so no rate limit.
export async function latestVersion(base: string): Promise<string> {
  const r = await fetch(`${base}/releases/latest`, { method: 'HEAD', redirect: 'manual' })
  const v = (r.headers.get('location') ?? '').split('/').pop()!.replace(/^v/, '')
  if (!/^\d+(\.\d+)*$/.test(v)) throw new Error(r.status === 404 ? 'no such repository' : 'no release yet')
  return v
}

export async function update(base = `https://github.com/${REPO}`, current = VERSION): Promise<number> {
  let latest: string
  try {
    latest = await latestVersion(base)
  } catch (e) {
    console.error(`bitfrost update: can't find the latest release at ${base}: ${(e as Error).message}`)
    return 1
  }
  if (!newer(latest, current)) {
    console.log(`bitfrost ${current} is up to date${latest === current ? '' : ` (latest release is ${latest})`}`)
    return 0
  }
  console.log(`bitfrost: updating ${current} -> ${latest}`)
  const url = `${base}/releases/download/v${latest}/install.sh`
  let script: string
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    script = await r.text()
  } catch (e) {
    console.error(`bitfrost update: can't download ${url}: ${(e as Error).message}`)
    return 1
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-update-'))
  try {
    const file = path.join(dir, 'install.sh')
    fs.writeFileSync(file, script)
    return spawnSync('sh', [file, '--version', latest], { stdio: 'inherit' }).status ?? 1
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
