// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const migrationRoot = fileURLToPath(new URL('../../migrations/', import.meta.url))
export const migrationBinary = process.env.BITFROST_MIGRATOR || path.join(migrationRoot, 'build', 'bitfrost-migrate')
export function migrate(file: string, versions = path.join(migrationRoot, 'versions'), binary = migrationBinary) {
  const result = spawnSync(binary, ['--db', file, '--migrations', versions,
    '--backup-dir', path.join(path.dirname(file), 'migration-backups')], { encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return result.stdout
}
