// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Writes assets/logo.svg: the config screen's small pixel logo, with its scrolling
// mosaic and drifting particles, as a looping animated SVG for the README.
// Run: node assets/make-logo.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Same glyphs, palette and hash as tui/src/fx.
// Small caps: B and F are full height, the rest are one cell shorter on the same baseline.
const BOLD = {
  B: [62, 62, 51, 51, 62, 62, 51, 51, 62, 62], F: [63, 63, 48, 48, 62, 62, 48, 48, 48, 48],
  I: [63, 63, 12, 12, 12, 12, 63, 63], T: [63, 63, 12, 12, 12, 12, 12, 12],
  R: [62, 62, 51, 51, 62, 62, 54, 51], O: [30, 30, 51, 51, 51, 51, 30, 30],
  S: [31, 31, 48, 30, 30, 3, 62, 62],
}
const PALETTE = ['#4cb5f6', '#2f95ea', '#2b7bdc']
const tileHash = (v) => {
  v = (v ^ (v >>> 16)) >>> 0
  v = Math.imul(v, 0x7feb352d) >>> 0
  v = (v ^ (v >>> 15)) >>> 0
  v = Math.imul(v, 0x846ca68b) >>> 0
  return (v ^ (v >>> 16)) >>> 0
}

const TEXT = 'BITFROST'
const COLUMNS = 6
const ROWS = 10
const TILE = 3
const SPEED = 3 // mosaic pixels per second, leftward
const PERIOD_TILES = 20 // the mosaic repeats after this many tiles, so it loops
const TRAIL = 26 // room left of the logo for particles
const MARGIN = 3
const LOOP = 6 // seconds before the particle pattern repeats
const RATE = 18 // particles per second
const SCALE = 6 // display size per pixel

const logoWidth = TEXT.length * (COLUMNS + 1) - 1
// Equal room on the right keeps the word centered on the page.
const width = TRAIL * 2 + logoWidth
const height = ROWS + MARGIN * 2
const ox = TRAIL
const oy = MARGIN

// The letter shapes, as one clip path of pixel squares.
const letters = []
TEXT.split('').forEach((ch, i) => {
  const top = ROWS - BOLD[ch].length
  BOLD[ch].forEach((bits, line) => {
    const row = top + line
    for (let col = 0; col < COLUMNS; col++) {
      if (bits & (1 << (COLUMNS - col - 1))) letters.push(`<rect x="${ox + i * (COLUMNS + 1) + col}" y="${oy + row}" width="1" height="1"/>`)
    }
  })
})

// A mosaic strip one period wider than the logo, wrapping its hash so the scroll loops.
const tilesAcross = Math.ceil(logoWidth / TILE) + PERIOD_TILES + 1
const tilesDown = Math.ceil(ROWS / TILE)
const tiles = []
for (let ty = 0; ty < tilesDown; ty++) {
  for (let tx = 0; tx < tilesAcross; tx++) {
    const wx = tx % PERIOD_TILES
    const color = PALETTE[tileHash((wx ^ Math.imul(ty, 0x9e3779b9)) >>> 0) % PALETTE.length]
    tiles.push(`<rect x="${ox + tx * TILE}" y="${oy + ty * TILE}" width="${TILE}" height="${TILE}" fill="${color}"/>`)
  }
}
const shift = PERIOD_TILES * TILE
const scrollSeconds = shift / SPEED

// Particles leave the logo's left edge on a fixed schedule, snapped to whole pixels.
let seed = 0x91f2ab
const particles = []
const count = LOOP * RATE
for (let n = 0; n < count; n++) {
  seed = tileHash(seed)
  const fraction = (seed & 65535) / 65535
  const speed = 4 + fraction * 9
  const drift = Math.sin(speed) * 1.5
  const life = 0.5 + fraction * 1.4
  const start = (n / RATE) % LOOP
  const y0 = oy + fraction * ROWS
  const color = PALETTE[tileHash(seed ^ 0x5bd1e995) % PALETTE.length]
  const steps = Math.max(2, Math.ceil(life * 12))
  const xs = []
  const ys = []
  const opacity = []
  for (let s = 0; s <= steps; s++) {
    const t = (life * s) / steps
    xs.push(Math.round(ox - 1 - speed * t))
    ys.push(Math.round(y0 + drift * t))
    opacity.push(String(+Math.max(0, Math.min(1, (life - t) / 1.6)).toFixed(2)))
  }
  // One keyframe list spans the loop. A particle that runs past the end carries on at
  // the start of the next loop, so every particle keeps its own speed.
  const frames = xs.map((x, s) => ({ at: (start + (life * s) / steps) % LOOP, x, y: ys[s], o: opacity[s] }))
  frames.push({ at: (start + life) % LOOP, x: xs.at(-1), y: ys.at(-1), o: '0' })
  frames.sort((a, b) => a.at - b.at)
  // Before its first keyframe each loop, a particle is in the state the last one left it.
  if (frames[0].at > 0) frames.unshift({ ...frames.at(-1), at: 0 })
  const keyTimes = []
  for (const f of frames) {
    const t = Math.max(f.at / LOOP, keyTimes.length ? keyTimes.at(-1) + 0.0001 : 0)
    keyTimes.push(Math.min(t, 0.9999))
  }
  keyTimes[0] = 0
  const times = keyTimes.map((t) => t.toFixed(4)).join(';')
  const values = (key) => frames.map((f) => f[key]).join(';')
  particles.push(
    `<rect width="1" height="1" fill="${color}" opacity="0">` +
      `<animate attributeName="x" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite" keyTimes="${times}" values="${values('x')}"/>` +
      `<animate attributeName="y" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite" keyTimes="${times}" values="${values('y')}"/>` +
      `<animate attributeName="opacity" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite" keyTimes="${times}" values="${values('o')}"/>` +
      `</rect>`,
  )
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * SCALE}" height="${height * SCALE}" shape-rendering="crispEdges" role="img" aria-label="BitFrost">
<title>BitFrost</title>
<style>.mosaic{animation:scroll ${scrollSeconds}s steps(${shift}) infinite}@keyframes scroll{to{transform:translateX(-${shift}px)}}@media (prefers-reduced-motion:reduce){.mosaic{animation:none}}</style>
<defs><clipPath id="letters">${letters.join('')}</clipPath></defs>
<g clip-path="url(#letters)"><g class="mosaic">${tiles.join('')}</g></g>
<g>${particles.join('')}</g>
</svg>
`
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logo.svg')
fs.writeFileSync(out, svg)
console.log(`${out}: ${(svg.length / 1024).toFixed(1)} KB`)
