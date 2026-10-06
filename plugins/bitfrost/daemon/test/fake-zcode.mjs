// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for ZCode's CLI in tests: prints the fixture named by
// BITFROST_TEST_FIXTURE and makes the session store ZCode names.
import fs from 'node:fs'

const fixture = process.env.BITFROST_TEST_FIXTURE
if (!fixture) {
  console.error('fake-zcode: BITFROST_TEST_FIXTURE is not set')
  process.exit(2)
}
if (process.env.ZCODE_SESSION_DB_PATH) fs.writeFileSync(process.env.ZCODE_SESSION_DB_PATH, 'fake session store')
for (const line of fs.readFileSync(fixture, 'utf8').split('\n')) {
  if (line.trim()) console.log(line)
}
