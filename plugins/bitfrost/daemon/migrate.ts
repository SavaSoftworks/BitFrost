// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
// Installation coordination only. All database migration work runs in COBOL.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, DATA_LOCK, takeLock } from './config.ts'
import { DB_VERSION } from './db-version.ts'

export async function migrateDatabase(stop: () => Promise<string | null>, installer = false) {
  const root = fileURLToPath(new URL('../migrations/', import.meta.url))
  const binary = process.env.BITFROST_MIGRATOR ||
    [path.join(root, 'bin', 'bitfrost-migrate'), path.join(root, 'build', 'bitfrost-migrate')].find((file) => fs.existsSync(file))
  if (!binary) throw new Error('Migration binary is missing; reinstall this release or run release/build-migrations.sh in a source checkout')
  const why = await stop()
  if (why) throw new Error(`Cannot migrate: ${why}; let agents finish, then run the installer again`)
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(DATA_DIR, 0o700)
  if (!takeLock(DATA_LOCK)) throw new Error('Another process owns this database; stop its BitFrost daemon before installing')
  const owner = installer ? process.ppid : process.pid
  const backupDir = process.env.BITFROST_BACKUP_DIR || path.join(os.homedir(), 'bitfrost-db-backups')
  try {
    if (installer) {
      // The shell retains this lock through activation and plugin installation,
      // so even 0.9.1 cannot reopen the upgraded database in the intervening gap.
      const transfer = `${DATA_LOCK}.${process.pid}`
      try {
        fs.writeFileSync(transfer, String(owner), { mode: 0o600, flag: 'wx' })
        fs.renameSync(transfer, DATA_LOCK)
      } finally { fs.rmSync(transfer, { force: true }) }
    }
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ['--db', path.join(DATA_DIR, 'bitfrost.db'),
        '--migrations', path.join(root, 'versions'), '--backup-dir', backupDir,
        '--target-version', String(DB_VERSION),
        '--lock-owner', String(owner)], { stdio: 'inherit' })
      const terminate = () => child.kill('SIGTERM')
      process.on('SIGINT', terminate)
      process.on('SIGTERM', terminate)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        process.off('SIGINT', terminate)
        process.off('SIGTERM', terminate)
        if (code === 0) resolve()
        else reject(new Error(`Database migration failed${signal ? ` (${signal})` : ''}; installation stopped`))
      })
    })
  } finally {
    if (!installer) {
      try { if (fs.readFileSync(DATA_LOCK, 'utf8') === String(owner)) fs.rmSync(DATA_LOCK) } catch {}
    }
  }
}
