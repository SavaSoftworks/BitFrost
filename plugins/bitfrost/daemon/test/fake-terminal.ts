// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only

import { PassThrough, Writable } from 'node:stream'
import type { TestContext } from 'node:test'
import type { Terminal } from '../prompt.ts'

// Send one chunk per question after its data listener has been installed.
export function fakeTerminal(t: TestContext, replies: string[] = [], beforeReply?: (question: number) => void) {
  const rawModes: boolean[] = []
  let question = 0
  let text = ''
  let closed = 0
  const input = new PassThrough() as PassThrough & { setRawMode: (on: boolean) => void }
  input.setRawMode = (on) => {
    rawModes.push(on)
    if (on) {
      const current = question++
      if (current < replies.length) setImmediate(() => {
        if (input.destroyed) return
        beforeReply?.(current)
        input.write(replies[current])
      })
    }
  }
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } })
  const terminal: Terminal = { input, output, close() { closed++; input.destroy(); output.destroy() } }
  t.after(() => { input.destroy(); output.destroy() })
  return {
    terminal,
    rawModes,
    text: () => text,
    plainText: () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    closed: () => closed,
  }
}
