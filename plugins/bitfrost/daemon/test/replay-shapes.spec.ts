// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// The replay's Grep and Glob shaping, lifted out of hooks/register.js (which
// exports nothing) and evaluated here; samples are ZCode's formatter output.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(HERE, '..', '..', 'hooks', 'register.js'), 'utf8')

const begin = source.indexOf('const isPathLine')
const end = source.indexOf('function nativeResult')
assert.ok(begin >= 0 && end > begin, 'grepResult and globResult not found in register.js')
const { grepResult, globResult }: { grepResult: (input: any, output: string) => any; globResult: (input: any, output: string) => any } =
  new Function(`${source.slice(begin, end)}\nreturn { grepResult, globResult }`)()

test('globResult reads a file list', () => {
  assert.deepEqual(globResult({}, 'src/a.ts\nsrc/b.ts'), { durationMs: 0, numFiles: 2, filenames: ['src/a.ts', 'src/b.ts'], truncated: false })
  assert.deepEqual(globResult({}, 'No files found'), { durationMs: 0, numFiles: 0, filenames: [], truncated: false })
  const note = '(Results are truncated. Consider using a more specific path or pattern.)'
  assert.deepEqual(globResult({}, `src/a.ts\n${note}`), { durationMs: 0, numFiles: 1, filenames: ['src/a.ts'], truncated: true })
})

test('globResult refuses what is not a file list', () => {
  assert.equal(globResult({}, 'Found 10 files'), null)
  assert.equal(globResult({}, ''), null)
  assert.equal(globResult({}, 'src/a.ts:12:foo'), null)
})

test('grepResult lists files by default', () => {
  assert.deepEqual(grepResult({}, 'Found 2 files\nsrc/a.ts\nsrc/b.ts'), { mode: 'files_with_matches', numFiles: 2, filenames: ['src/a.ts', 'src/b.ts'] })
  assert.deepEqual(grepResult({ output_mode: 'files_with_matches' }, 'Found 1 file\nsrc/a.ts'), { mode: 'files_with_matches', numFiles: 1, filenames: ['src/a.ts'] })
  assert.deepEqual(grepResult({}, 'No files found'), { mode: 'files_with_matches', numFiles: 0, filenames: [] })
  assert.deepEqual(
    grepResult({ head_limit: 100, offset: 10 }, 'Found 2 files limit: 100, offset: 10\nsrc/a.ts\nsrc/b.ts'),
    { mode: 'files_with_matches', numFiles: 2, filenames: ['src/a.ts', 'src/b.ts'], appliedLimit: 100, appliedOffset: 10 },
  )
})

test('grepResult refuses a file list whose header and lines disagree', () => {
  assert.equal(grepResult({}, 'Found 3 files\nsrc/a.ts\nsrc/b.ts'), null)
  assert.equal(grepResult({}, 'src/a.ts\nsrc/b.ts'), null)
  assert.equal(grepResult({ output_mode: 'summary' }, 'anything'), null)
})

test('grepResult reads counts', () => {
  assert.deepEqual(
    grepResult({ output_mode: 'count' }, 'src/a.ts:3\nsrc/b.ts:5\n\nFound 8 total occurrences across 2 files.'),
    { mode: 'count', numFiles: 2, filenames: [], numMatches: 8, content: 'src/a.ts:3\nsrc/b.ts:5' },
  )
  assert.deepEqual(
    grepResult({ output_mode: 'count' }, 'src/a.ts:1\n\nFound 1 total occurrence across 1 file.'),
    { mode: 'count', numFiles: 1, filenames: [], numMatches: 1, content: 'src/a.ts:1' },
  )
  assert.deepEqual(
    grepResult({ output_mode: 'count' }, 'No matches found'),
    { mode: 'count', numFiles: 0, filenames: [], numMatches: 0, content: '' },
  )
})

test('grepResult reads content lines', () => {
  const body = 'src/a.ts:12:foo bar\nsrc/b.ts:30:baz'
  assert.deepEqual(
    grepResult({ output_mode: 'content' }, body),
    { mode: 'content', numFiles: 2, filenames: [], numLines: 2, content: body },
  )
  assert.deepEqual(
    grepResult({ output_mode: 'content' }, 'src/a.ts:1:x\nsrc/a.ts:2:y'),
    { mode: 'content', numFiles: 1, filenames: [], numLines: 2, content: 'src/a.ts:1:x\nsrc/a.ts:2:y' },
  )
  assert.deepEqual(
    grepResult({ output_mode: 'content', '-n': false }, 'src/a.ts:foo'),
    { mode: 'content', numFiles: 1, filenames: [], numLines: 1, content: 'src/a.ts:foo' },
  )
})

test('grepResult reads pagination footers', () => {
  assert.deepEqual(
    grepResult({ output_mode: 'content', head_limit: 250 }, 'src/a.ts:1:x\n\n[Showing results with pagination = limit: 250, offset: 0]'),
    { mode: 'content', numFiles: 1, filenames: [], numLines: 1, content: 'src/a.ts:1:x', appliedLimit: 250, appliedOffset: 0 },
  )
  assert.deepEqual(
    grepResult({ output_mode: 'count', head_limit: 5 }, 'src/a.ts:3\n\nFound 3 total occurrences across 1 file. with pagination = limit: 5'),
    { mode: 'count', numFiles: 1, filenames: [], numMatches: 3, content: 'src/a.ts:3', appliedLimit: 5 },
  )
})

test('grepResult refuses content it cannot read confidently', () => {
  assert.deepEqual(
    grepResult({ output_mode: 'content' }, 'No matches found'),
    { mode: 'content', numFiles: 0, filenames: [], numLines: 0, numMatches: 0, content: '' },
  )
  assert.equal(grepResult({ output_mode: 'content' }, 'just some prose'), null)
  assert.equal(grepResult({ output_mode: 'content' }, 'src/a.ts:1:x\n\n[Showing results with pagination = everything]'), null)
  assert.equal(grepResult({ output_mode: 'count' }, 'src/a.ts:3\n\nFound prose.'), null)
  assert.equal(grepResult({ output_mode: 'count' }, 'src/a.ts:three\n\nFound 3 total occurrences across 1 file.'), null)
})
