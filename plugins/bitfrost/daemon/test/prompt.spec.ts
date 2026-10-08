// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import test from 'node:test'
import assert from 'node:assert/strict'
import { Cancelled, choose, confirm, openTerminal } from '../prompt.ts'
import type { Question } from '../features.ts'
import { fakeTerminal } from './fake-terminal.ts'

const confirmation: Question & { type: 'confirm' } = { type: 'confirm', key: 'enabled', prompt: 'Enable?', help: 'Optional setting', default: false }
const choice: Question & { type: 'choice' } = { type: 'choice', key: 'model', prompt: 'Which model?', help: 'Pick a family', default: 'sonnet', options: [] }
const options = [
  { value: 'haiku', label: 'Haiku', hint: 'Fast' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
]

test('confirm accepts yes/no line input and Enter takes either default', { timeout: 2000 }, async (t) => {
  const cases: [string, boolean, boolean][] = [
    ['y\r', false, true], [' YES \n', false, true], ['n\r', true, false], ['No\r', true, false],
    ['\r', false, false], ['\n', true, true],
  ]
  for (const [keys, fallback, expected] of cases) {
    const fake = fakeTerminal(t, [keys])
    assert.equal(await confirm(fake.terminal, { ...confirmation, default: fallback }), expected)
    // The question, then the hint and choices, then the answer after >.
    assert.match(fake.plainText(), fallback ? /^\nEnable\?\nOptional setting \[Y\/n\]\n> / : /^\nEnable\?\nOptional setting \[y\/N\]\n> /)
    assert.match(fake.plainText(), expected ? /> yes\n$/ : /> no\n$/)
    assert.deepEqual(fake.rawModes, [true, false])
    assert.equal(fake.terminal.input.listenerCount('data'), 0)
    assert.equal(fake.terminal.input.isPaused(), true)
  }
})

test('confirm without help shows only its choices on the hint line', { timeout: 2000 }, async (t) => {
  const fake = fakeTerminal(t, ['\r'])
  assert.equal(await confirm(fake.terminal, { ...confirmation, help: undefined }), false)
  assert.match(fake.plainText(), /^\nEnable\?\n\[y\/N\]\n> /)
})

test('confirm clears invalid input to type again and Backspace edits the current answer', { timeout: 2000 }, async (t) => {
  const invalid = fakeTerminal(t, ['maybe\ryes\r'])
  assert.equal(await confirm(invalid.terminal, confirmation), true)
  assert.equal(invalid.plainText().match(/Enable\?/g)?.length, 1)
  for (const erase of ['\x7f', '\b']) {
    const fake = fakeTerminal(t, [`${erase}nx${erase}${erase}yes\r`])
    assert.equal(await confirm(fake.terminal, confirmation), true)
    assert.ok(fake.text().includes('\b \b'))
  }
})

test('choose marks and preselects the default, displays hints, and Enter picks it', { timeout: 2000 }, async (t) => {
  const fake = fakeTerminal(t, ['\r'])
  assert.equal(await choose(fake.terminal, choice, options), 'sonnet')
  assert.match(fake.plainText(), /> Sonnet/)
  assert.match(fake.plainText(), /Haiku  Fast/)
  assert.match(fake.plainText(), /Pick a family/)
  assert.deepEqual(fake.rawModes, [true, false])
  assert.equal(fake.terminal.input.listenerCount('data'), 0)
  assert.equal(fake.terminal.input.isPaused(), true)
  assert.ok(fake.text().includes('\x1b[?25l'))
  assert.ok(fake.text().endsWith('\x1b[?25h'))
})

test('choose handles arrow keys and k/j, wraps both ways, and ignores other keys', { timeout: 2000 }, async (t) => {
  const cases: [string, string][] = [
    ['\x1b[B\r', 'opus'], ['\x1b[A\r', 'haiku'], ['\x1bOB\r', 'opus'], ['\x1bOA\r', 'haiku'],
    ['j\r', 'opus'], ['k\r', 'haiku'], ['jj\r', 'haiku'], ['kk\r', 'opus'], ['x\t\r', 'sonnet'],
  ]
  for (const [keys, expected] of cases) {
    const fake = fakeTerminal(t, [keys])
    assert.equal(await choose(fake.terminal, choice, options), expected, JSON.stringify(keys))
    assert.match(fake.plainText(), new RegExp(`> ${options.find((o) => o.value === expected)!.label}`))
  }
})

test('choose starts at the first option when its default is absent or unknown', { timeout: 2000 }, async (t) => {
  for (const fallback of [undefined, 'unknown']) {
    const fake = fakeTerminal(t, ['\r'])
    assert.equal(await choose(fake.terminal, { ...choice, default: fallback }, options), 'haiku')
    assert.match(fake.plainText(), /> Haiku/)
  }
})

test('Ctrl+C and Ctrl+D reject both prompts with Cancelled and restore terminal state', { timeout: 2000 }, async (t) => {
  for (const key of ['\x03', '\x04']) {
    for (const kind of ['confirm', 'choose']) {
      const fake = fakeTerminal(t, [key])
      const answer = kind === 'confirm' ? confirm(fake.terminal, confirmation) : choose(fake.terminal, choice, options)
      await assert.rejects(answer, Cancelled)
      assert.deepEqual(fake.rawModes, [true, false])
      assert.equal(fake.terminal.input.listenerCount('data'), 0)
      assert.equal(fake.terminal.input.isPaused(), true)
      assert.equal(fake.closed(), 0) // The caller owns the terminal.
      if (kind === 'choose') assert.ok(fake.text().endsWith('\x1b[?25h'))
    }
  }
})

test('choose keeps an arrow key that arrives split across reads', { timeout: 2000 }, async (t) => {
  const fake = fakeTerminal(t)
  const input = fake.terminal.input as unknown as NodeJS.WritableStream
  const picked = choose(fake.terminal, choice, options)
  setImmediate(() => {
    input.write('\x1b')
    setImmediate(() => {
      input.write('[')
      setImmediate(() => input.write('B\r'))
    })
  })
  assert.equal(await picked, 'opus')
})

test('openTerminal asks nothing when output is not a terminal', (t) => {
  // A piped stdout has no isTTY at all, so set it and put back what was there.
  const had = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  t.after(() => (had ? Object.defineProperty(process.stdout, 'isTTY', had) : delete (process.stdout as any).isTTY))
  assert.equal(openTerminal(), null)
})
