// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
// Build-time registration only. Migration policy and processing stay in COBOL.
import fs from 'node:fs'
import path from 'node:path'
import { readDbVersion } from '../plugins/bitfrost/daemon/db-version.ts'

const [source, versions, output, manifest = new URL('../package.json', import.meta.url)] = process.argv.slice(2)
if (!source || !versions || !output) throw new Error('Expected source, versions and output directories')
const dbVersion = readDbVersion(manifest)
const entries = fs.readdirSync(versions, { withFileTypes: true })
for (const entry of entries) {
  if (!entry.isDirectory() || !/^v[1-9][0-9]*$/.test(entry.name))
    throw new Error(`Invalid migration directory: ${entry.name}; expected vN`)
}
const ordered = entries.sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))
if (!ordered.length || ordered.length > 256) throw new Error('Expected between 1 and 256 migration versions')
const handlers = ordered.map((entry, index) => {
  const version = index + 1
  if (entry.name !== `v${version}`) throw new Error(`Missing v${version}; migration versions must be consecutive from v1`)
  const dir = path.join(versions, entry.name)
  const code = fs.readFileSync(path.join(dir, 'main.cob'), 'utf8')
  const program = `MIGRATION-V${version}`
  if (!new RegExp(`^\\s*PROGRAM-ID\\.\\s+${program}\\.\\s*$`, 'm').test(code))
    throw new Error(`${entry.name}/main.cob must declare PROGRAM-ID. ${program}.`)
  fs.accessSync(path.join(dir, 'plan'))
  return { version, code, program }
})
if (handlers.length !== dbVersion) {
  throw new Error(`package.json dbVersion=${dbVersion} requires migrations v1 through v${dbVersion}; found ${handlers.length} versions`)
}
for (const name of ['schema.sql', 'indexes.sql']) {
  fs.accessSync(path.join(versions, `v${dbVersion}`, name))
}
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(output, 'registry.cpy'),
  `       78  COMPILED-VERSION-COUNT VALUE ${dbVersion}.\n`)
fs.writeFileSync(path.join(output, 'dispatch.cpy'),
  '               EVALUATE STEP-INDEX\n' + handlers.map(({ version, program }) =>
    `                   WHEN ${version}\n` +
    `                       CALL "${program}" USING BY REFERENCE\n` +
    '                           VERSION-DIR SOURCE-VERSION\n' +
    '                           ERROR-MESSAGE\n').join('') +
  '               END-EVALUATE\n')
fs.writeFileSync(path.join(output, 'combined.cob'),
  fs.readFileSync(path.join(source, 'runner.cob'), 'utf8') + '\n' +
  fs.readFileSync(path.join(source, 'files.cob'), 'utf8') +
  '\n       END PROGRAM MIGRATION-IO.\n' +
  handlers.map(({ code, program }) => `${code}\n       END PROGRAM ${program}.\n`).join('') +
  '       END PROGRAM BITFROST-MIGRATE.\n')
