// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Terminal output for bitfrost update and uninstall, in the same style as install.sh.
import os from 'node:os'

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
export const bold = paint('1'), dim = paint('2'), green = paint('32'), yellow = paint('33'), blue = paint('1;34')
const red = (text: string) => (process.stderr.isTTY && !process.env.NO_COLOR ? `\x1b[1;31m${text}\x1b[0m` : text)

export const LABEL = 20 // the longest label, Helper runtime files
export const short = (p: string) => {
  const home = os.homedir()
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}
export const step = (text: string) => console.log(`${blue('::')} ${bold(text)}`)
export const done = (label: string, text: string) => console.log(`   ${green('✓')} ${label.padEnd(LABEL)}  ${dim(short(text))}`)
export const note = (text: string) => console.log(`   ${dim('-')} ${text}`)
export const warn = (text: string) => console.log(`   ${yellow('!')} ${text}`)
export const fail = (command: string, text: string) => console.error(`${red(`bitfrost ${command}:`)} ${text}`)

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

// Runs a slow step behind a spinner line, cut to the terminal width so it never wraps.
export async function task<T>(label: string, detail: string, job: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) return job()
  let i = 0
  const draw = () => {
    const room = (process.stdout.columns || 80) - 1 - (6 + LABEL)
    process.stdout.write(`\r\x1b[2K   ${blue(FRAMES[i++ % FRAMES.length])} ${label.padEnd(LABEL)}  ${dim(detail.slice(0, Math.max(0, room)))}`)
  }
  // Ctrl+C must not leave the cursor hidden.
  const quit = () => { process.stdout.write('\r\x1b[2K\x1b[?25h'); process.exit(130) }
  process.once('SIGINT', quit)
  process.stdout.write('\x1b[?25l')
  draw()
  const timer = setInterval(draw, 100)
  try {
    return await job()
  } finally {
    clearInterval(timer)
    process.removeListener('SIGINT', quit)
    process.stdout.write('\r\x1b[2K\x1b[?25h')
  }
}
