// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Stands in for ZCode's CLI in tests: prints the fixture named by
// BITFROST_TEST_FIXTURE and makes the session store ZCode names.
import fs from 'node:fs'

const logFile = process.env.BITFROST_ZCODE_LOG
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }) + '\n')
if (process.env.ZCODE_SESSION_DB_PATH && !fs.existsSync(process.env.ZCODE_SESSION_DB_PATH)) fs.writeFileSync(process.env.ZCODE_SESSION_DB_PATH, 'fake session store')
const scenarioFile = process.env.BITFROST_ZCODE_SCENARIO
if (scenarioFile) {
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
  const resumed = process.argv.includes('--resume')
  for (const event of (resumed ? scenario.resumed : scenario.first) ?? []) console.log(JSON.stringify(event))
  if (!resumed && scenario.ignoreTerm) process.on('SIGTERM', () => {})
  if (!resumed && scenario.childFile) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: scenario.inheritPipes ? ['ignore', 'inherit', 'inherit'] : 'ignore' })
    fs.writeFileSync(scenario.childFile, String(child.pid))
  }
  if (!resumed && scenario.inheritPipes) process.exit(0)
  if (!resumed && scenario.wait) setInterval(() => {}, 1000)
} else {
  const fixture = process.env.BITFROST_TEST_FIXTURE
  if (!fixture) {
    console.error('fake-zcode: BITFROST_TEST_FIXTURE is not set')
    process.exit(2)
  }
  for (const line of fs.readFileSync(fixture, 'utf8').split('\n')) if (line.trim()) console.log(line)
}
