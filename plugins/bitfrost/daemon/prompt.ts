// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Questions on the terminal. They read /dev/tty, not stdin, since curl | sh
// gives the installer the script itself as its input.
import fs from 'node:fs'
import tty from 'node:tty'
import type { Option, Question } from './features.ts'

export type Terminal = { input: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown }; output: NodeJS.WritableStream; close: () => void }

const COLOR = !process.env.NO_COLOR
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = paint('1'), dim = paint('2'), cyan = paint('36')

// The user's terminal, or null when there is none to ask on.
export function openTerminal(): Terminal | null {
  let fd: number
  try {
    fd = fs.openSync('/dev/tty', 'r+')
  } catch {
    return null
  }
  if (!tty.isatty(fd)) {
    fs.closeSync(fd)
    return null
  }
  const input = new tty.ReadStream(fd)
  const output = new tty.WriteStream(fd)
  return {
    input,
    output,
    close: () => {
      input.destroy()
      output.destroy()
    },
  }
}

// Ctrl+C or Ctrl+D while asking.
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

// Reads keypresses until done returns true, in raw mode so arrows arrive at once.
function keys(term: Terminal, onKey: (key: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = term.input
    input.setRawMode?.(true)
    input.resume()
    const finish = (err?: Error) => {
      input.removeListener('data', onData)
      input.setRawMode?.(false)
      input.pause()
      if (err) reject(err)
      else resolve()
    }
    // An escape sequence can arrive split across reads, so an unfinished one waits for the rest.
    let held = ''
    const onData = (chunk: Buffer | string) => {
      const text = held + String(chunk)
      const tail = text.match(/\x1b(?:\[[0-9;]*|O)?$/)
      held = tail ? tail[0] : ''
      // Escape sequences stay whole; plain keys come one at a time.
      for (const key of (tail ? text.slice(0, tail.index) : text).match(/\x1b\[[0-9;]*[A-Za-z]|\x1bO[A-Za-z]|[\s\S]/g) ?? []) {
        if (key === '\x03' || key === '\x04') return finish(new Cancelled())
        if (onKey(key)) return finish()
      }
    }
    input.on('data', onData)
  })
}

// The question, then the hint with its choices, then the answer typed after > and Enter.
export async function confirm(term: Terminal, q: Question & { type: 'confirm' }): Promise<boolean> {
  const out = term.output
  const input = `${cyan('>')} `
  out.write(`\n${bold(q.prompt)}\n${q.help ? `${dim(q.help)} ` : ''}${q.default ? '[Y/n]' : '[y/N]'}\n${input}`)
  let typed = ''
  let answer = q.default
  await keys(term, (key) => {
    if (key === '\r' || key === '\n') {
      const t = typed.trim().toLowerCase()
      if (t === '') answer = q.default
      else if (t === 'y' || t === 'yes') answer = true
      else if (t === 'n' || t === 'no') answer = false
      else {
        // Anything else clears the answer to type again.
        out.write(`\r\x1b[2K${input}`)
        typed = ''
        return false
      }
      return true
    }
    if (key === '\x7f' || key === '\b') {
      if (typed) {
        typed = typed.slice(0, -1)
        out.write('\b \b')
      }
      return false
    }
    if (key.length === 1 && key >= ' ') {
      typed += key
      out.write(key)
    }
    return false
  })
  out.write(`\r\x1b[2K${input}${answer ? 'yes' : 'no'}\n`)
  return answer
}

export async function choose(term: Terminal, q: Question & { type: 'choice' }, options: Option[]): Promise<string> {
  const out = term.output
  let at = Math.max(0, options.findIndex((o) => o.value === q.default))
  const line = (o: Option, i: number) => (i === at ? `${cyan('>')} ${bold(o.label)}` : `  ${o.label}`) + (o.hint ? `  ${dim(o.hint)}` : '')
  const draw = (first: boolean) => {
    if (!first) out.write(`\x1b[${options.length}A`)
    for (const [i, o] of options.entries()) out.write(`\r\x1b[2K${line(o, i)}\n`)
  }
  out.write(`\n${bold(q.prompt)}${q.help ? `\n${dim(q.help)}` : ''}\n${dim('Up and down to move, Enter to pick.')}\n\n`)
  out.write('\x1b[?25l')
  draw(true)
  try {
    await keys(term, (key) => {
      if (key === '\r' || key === '\n') return true
      if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') at = (at + options.length - 1) % options.length
      else if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') at = (at + 1) % options.length
      else return false
      draw(false)
      return false
    })
  } finally {
    out.write('\x1b[?25h')
  }
  return options[at]!.value
}

// Asks one question on the terminal.
export function asker(term: Terminal) {
  return (q: Question, options: Option[]): Promise<unknown> => (q.type === 'confirm' ? confirm(term, q) : choose(term, q, options))
}
