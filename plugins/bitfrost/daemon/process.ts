// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

// owner is the helper that started the group: its store, and its own pid and start time.
type Owner = { store: string; pid: number; startTime: string | null }
export type ProcessIdentity = { pgid: number; startTime: string | null; token: string; owner?: Owner }

let self: Owner | null = null

function stat(pid: number) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { pgid: Number(fields[2]), startTime: fields[19] }
}

function startTimeOf(pid: number): string | null {
  try {
    return process.platform === 'linux' ? stat(pid).startTime : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
  } catch { return null }
}

// The helper names its store once, so the groups it starts carry it as their owner.
export function ownProcesses(store: string) {
  let real = store
  try { real = fs.realpathSync(store) } catch {}
  self = { store: real, pid: process.pid, startTime: startTimeOf(process.pid) }
}

export function processIdentity(pgid: number, token: string): ProcessIdentity {
  return { pgid, startTime: startTimeOf(pgid), token, ...(self ? { owner: self } : {}) }
}

// A group is this helper's to stop when it started it, or a helper on the same store that is gone did.
// Another helper's groups, such as those listed in a copied store, are left alone.
function mine(owner: Owner | undefined) {
  if (!owner) return true
  if (!self || owner.store !== self.store) return false
  if (owner.pid === self.pid && owner.startTime === self.startTime) return true
  const now = startTimeOf(owner.pid)
  return now == null || now !== owner.startTime
}

export function killOwnedGroup(identity: ProcessIdentity, log: (text: string) => void = () => {}): boolean {
  if (!Number.isSafeInteger(identity?.pgid) || identity.pgid <= 1 || !identity.token || !mine(identity.owner)) return false
  let ours = false
  try {
    if (process.platform === 'linux') {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
          const pid = Number(name), info = stat(pid)
          if (info.pgid !== identity.pgid || (pid === identity.pgid && identity.startTime && info.startTime !== identity.startTime)) continue
          const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
          if (env.includes(`BITFROST_ZCODE_TURN=${identity.token}`)) { ours = true; break }
        } catch {}
      }
    } else if (process.platform === 'darwin') {
      const rows = execFileSync('ps', ['eww', '-axo', 'pid=,pgid=,command='], { encoding: 'utf8' })
      ours = rows.split('\n').some((row) => {
        const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
        if (!match || Number(match[2]) !== identity.pgid) return false
        if (Number(match[1]) === identity.pgid && identity.startTime && processIdentity(identity.pgid, identity.token).startTime !== identity.startTime) return false
        return match[3].split(/\s+/).includes(`BITFROST_ZCODE_TURN=${identity.token}`)
      })
    }
    if (ours) { process.kill(-identity.pgid, 'SIGKILL'); log(`stopped leftover ZCode process group ${identity.pgid}`); return true }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log(`could not stop process group ${identity.pgid}: ${(e as Error).message}`) }
  return false
}

export function killOwnedGroups(identities: ProcessIdentity[], log: (text: string) => void) {
  if (!identities.length) return
  let groups: Set<number> | null = null
  if (process.platform === 'linux') {
    groups = new Set()
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try { groups.add(stat(Number(name)).pgid) } catch {}
    }
  }
  for (const identity of identities) if (identity && Number.isSafeInteger(identity.pgid) && (!groups || groups.has(identity.pgid))) killOwnedGroup(identity, log)
}
