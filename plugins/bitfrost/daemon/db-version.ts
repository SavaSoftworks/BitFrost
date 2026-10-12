// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'

export function readDbVersion(file: string | URL): number {
  const dbVersion = JSON.parse(fs.readFileSync(file, 'utf8'))?.dbVersion
  if (!Number.isInteger(dbVersion) || dbVersion < 1 || dbVersion > 256) {
    throw new Error('package.json dbVersion must be an integer between 1 and 256')
  }
  return dbVersion
}

// Release builds bundle the root package.json for standalone plugin copies.
// Source checkouts read the editable root directly.
const bundled = new URL('../package.json', import.meta.url)
export const DB_VERSION = readDbVersion(fs.existsSync(bundled) ? bundled : new URL('../../../package.json', import.meta.url))
