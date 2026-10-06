// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import type { Decision, FileChange, Question } from '../events.ts'
export { globMatch } from '../registry.ts'

type Json = any

export type ToolCall = {
  kind: string
  title: string
  name: string | null
  rawInput: Json
  rawOutput: Json
  content: Json[]
  locations: Json[]
  status: string
  started: boolean
  done: boolean
}

export const FILE_KINDS = new Set(['edit', 'delete', 'move'])

export const blankTool = (): ToolCall => ({ kind: 'other', title: '', name: null, rawInput: {}, rawOutput: undefined, content: [], locations: [], status: 'pending', started: false, done: false })
export const objectOf = (v: Json): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const str = (v: Json): string | undefined => (typeof v === 'string' && v ? v : undefined)
export const isSelect = (category: string) => (o: Json) => o?.category === category && o.type === 'select'

export function choicesOf(option: Json): Json[] {
  return (option.options ?? []).flatMap((o: Json) => (Array.isArray(o.options) ? o.options : [o]))
}

// Ignore cwd-only inputs because opencode sends them before tool details.
export const hasInput = (t: ToolCall) => Object.keys(objectOf(t.rawInput)).some((k) => k !== 'cwd' && k !== 'workdir')

export function commandOf(t: ToolCall): string {
  const c = t.rawInput?.command ?? t.rawInput?.cmd
  if (Array.isArray(c)) return c.join(' ')
  if (typeof c === 'string') return c
  return t.title.replace(/^\$\s*/, '')
}

export function summaryOf(t: ToolCall, command: string): string {
  const said = str(t.rawInput?.description) ?? (t.title && t.title !== command && t.title !== `$ ${command}` ? t.title : undefined)
  if (said) return said
  const first = command.split('\n')[0]
  return first.length > 70 ? first.slice(0, 67) + '…' : first
}

export const cwdOf = (t: ToolCall, cwd: string) => str(t.rawInput?.cwd) ?? str(t.rawInput?.workdir) ?? cwd

export function outputOf(t: ToolCall): string {
  const texts = t.content.filter((c) => c?.type === 'content' && c.content?.type === 'text').map((c) => String(c.content.text))
  // Oh My Pi repeats the command in its output; remove that block.
  const kept = t.kind === 'execute' ? texts.filter((x) => x !== `$ ${commandOf(t)}`) : texts
  if (kept.length) return kept.join('\n')
  const o = t.rawOutput
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o.output === 'string') return o.output
  if (typeof o.stdout === 'string') return o.stdout + (o.stderr ? `\n${o.stderr}` : '')
  if (typeof o.error === 'string') return o.error
  if (Array.isArray(o.content)) return o.content.map((c: Json) => c?.text ?? '').join('\n')
  return JSON.stringify(o).slice(0, 4000)
}

export function exitCodeOf(o: Json): number | null {
  for (const v of [o?.exitCode, o?.exit_code, o?.metadata?.exit, o?.details?.exitCode]) if (typeof v === 'number') return v
  return null
}

export function fileChange(t: ToolCall, d: Json): FileChange {
  const added = d.oldText == null
  const movePath = t.kind === 'move' ? (str(t.rawInput?.newPath) ?? str(t.rawInput?.destination) ?? null) : null
  return {
    path: String(d.path ?? ''),
    kind: t.kind === 'delete' ? 'delete' : added ? 'add' : 'update',
    movePath,
    diff: unifiedDiff(d.oldText ?? null, t.kind === 'delete' ? '' : String(d.newText ?? '')),
  }
}

// Map app inputs to Claude Code tools so its permission rules can judge them.
export function claudeTool(kind: string, hint: string, raw: Json): { name: string; input: Json } | null {
  raw = objectOf(raw)
  const file = str(raw.file_path) ?? str(raw.filePath) ?? str(raw.filepath) ?? str(raw.absolute_path) ?? str(raw.path)
  const where = str(raw.path) ?? str(raw.dir_path)
  const h = hint.toLowerCase()
  if (kind === 'execute') {
    const c = raw.command ?? raw.cmd
    const command = Array.isArray(c) ? c.join(' ') : str(c)
    return command ? { name: 'Bash', input: { command, ...(str(raw.description) ? { description: raw.description } : {}) } } : null
  }
  if (kind === 'read' && file) {
    const extra = Object.fromEntries(['offset', 'limit'].filter((k) => typeof raw[k] === 'number').map((k) => [k, raw[k]]))
    return { name: 'Read', input: { file_path: file, ...extra } }
  }
  if (kind === 'edit' && file) {
    const before = raw.old_string ?? raw.oldString ?? raw.old_str
    const after = raw.new_string ?? raw.newString ?? raw.new_str
    if (typeof before === 'string' && typeof after === 'string') {
      return { name: 'Edit', input: { file_path: file, old_string: before, new_string: after, ...(raw.replace_all || raw.replaceAll ? { replace_all: true } : {}) } }
    }
    if (typeof raw.content === 'string') return { name: 'Write', input: { file_path: file, content: raw.content } }
  }
  if (kind === 'search' && str(raw.pattern)) {
    const glob = str(raw.include) ?? str(raw.glob)
    if (/grep|search_file_content/.test(h) || glob || raw.output_mode) {
      return { name: 'Grep', input: { pattern: raw.pattern, ...(where ? { path: where } : {}), ...(glob ? { glob } : {}) } }
    }
    if (/glob|find/.test(h)) return { name: 'Glob', input: { pattern: raw.pattern, ...(where ? { path: where } : {}) } }
  }
  if (kind === 'fetch' && str(raw.url)) return { name: 'WebFetch', input: { url: raw.url, prompt: str(raw.prompt) ?? '' } }
  if ((kind === 'fetch' || kind === 'search') && str(raw.query) && /search/.test(h)) return { name: 'WebSearch', input: { query: raw.query } }
  return null
}

export function asClaudeTool(t: ToolCall): { name: string; input: Json } {
  return claudeTool(t.kind, `${t.name ?? ''} ${t.title}`, t.rawInput) ?? { name: t.title || t.name || 'tool', input: objectOf(t.rawInput) }
}

export function describeAction(t: ToolCall, cwd: string) {
  const raw = objectOf(t.rawInput)
  const diff = t.content.find((c) => c?.type === 'diff')
  const file = str(diff?.path) ?? str(raw.file_path) ?? str(raw.filePath) ?? str(raw.filepath) ?? str(raw.path) ?? str(t.locations[0]?.path) ?? t.title
  let tool = claudeTool(t.kind, `${t.name ?? ''} ${t.title}`, raw)
  if (!tool && t.kind === 'edit' && diff) {
    tool = diff.oldText == null
      ? { name: 'Write', input: { file_path: diff.path, content: String(diff.newText ?? '') } }
      : { name: 'Edit', input: { file_path: diff.path, old_string: String(diff.oldText), new_string: String(diff.newText ?? '') } }
  }
  const [kind, title]: ['command' | 'file_change' | 'permissions', string] =
    t.kind === 'execute' ? ['command', `run \`${commandOf(t)}\``]
    : t.kind === 'edit' ? ['file_change', `${diff && diff.oldText == null ? 'create' : tool?.name === 'Write' ? 'write' : 'edit'} ${file}`]
    : t.kind === 'delete' ? ['file_change', `delete ${file}`]
    : t.kind === 'move' ? ['file_change', `move ${file} to ${str(raw.newPath) ?? str(raw.destination) ?? str(t.locations[1]?.path) ?? 'somewhere else'}`]
    : t.kind === 'read' ? ['permissions', `read ${file}`]
    : t.kind === 'fetch' && str(raw.url) ? ['permissions', `fetch ${raw.url}`]
    : str(raw.parentDir) ? ['permissions', `work outside its folder, in ${raw.parentDir}`]
    : ['permissions', `use ${t.title || t.name || 'a tool'}`]
  const said = t.title.replace(/^\$\s*/, '')
  const detail = [
    said && !title.includes(said) ? `It says: ${t.title}` : null,
    diff ? clip(unifiedDiff(diff.oldText ?? null, String(diff.newText ?? '')), 40) : null,
    !tool && t.kind !== 'execute' && Object.keys(raw).length ? `Input: ${JSON.stringify(raw).slice(0, 500)}` : null,
    `In ${cwd}`,
  ]
    .filter(Boolean)
    .join('\n')
  return { kind, title, detail, ...(tool ? { tool: tool.name, input: tool.input } : {}) }
}

function clip(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length > lines ? [...all.slice(0, lines), `… ${all.length - lines} more lines`].join('\n') : text
}

// Choose "once" options because bitfrost limits task grants to exact actions.
export function permissionOutcome(options: Json[], decision: Decision): Json {
  const o = options.find((x) => x?.kind === (decision === 'deny' ? 'reject_once' : 'allow_once'))
  return o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' }
}

// Match task grants by exact command, file path or full input.
export function grantKeyOf(t: ToolCall): string {
  const raw = objectOf(t.rawInput)
  const file = str(t.content.find((c) => c?.type === 'diff')?.path) ?? str(raw.file_path) ?? str(raw.filePath) ?? str(raw.filepath) ?? str(raw.path)
  if (t.kind === 'execute') return `execute:${commandOf(t)}`
  if (file && (FILE_KINDS.has(t.kind) || t.kind === 'read')) return `${t.kind}:${file}`
  return `${t.kind}:${t.name ?? t.title}:${JSON.stringify(raw)}`
}

const YES = /^(yes|y|true|approve|allow|accept|ok|confirm|proceed|continue)\b/i
const NO = /^(no|n|false|deny|reject|decline|cancel|abort|stop)\b/i

export function confirmShape(fields: [string, Json][]): { field: string; yes: Json; no: Json } | null {
  if (fields.length !== 1) return null
  const [field, s] = fields[0]
  if (s?.type === 'boolean') return { field, yes: true, no: false }
  const choices = s?.type === 'string' ? formChoices(s) : null
  if (choices?.length !== 2) return null
  const yes = choices.find((c) => YES.test(c.label))
  const no = choices.find((c) => NO.test(c.label))
  return yes && no && yes !== no ? { field, yes: yes.value, no: no.value } : null
}

function formChoices(s: Json): { value: Json; label: string; description: string }[] | null {
  const titled = s?.oneOf ?? s?.items?.anyOf
  if (Array.isArray(titled)) return titled.map((o: Json) => ({ value: o.const, label: String(o.title ?? o.const), description: o.description ?? '' }))
  const plain = s?.enum ?? s?.items?.enum
  if (Array.isArray(plain)) return plain.map((v: Json) => ({ value: v, label: String(v), description: '' }))
  return null
}

export function toQuestion(key: string, s: Json, message: string): Question {
  const choices = formChoices(s)
  const about = [s?.title, s?.description].filter(Boolean).join(': ')
  return {
    id: key,
    header: String(s?.title ?? key),
    question: [message, about].filter(Boolean).join('\n') || key,
    options: choices
      ? choices.map((c) => ({ label: c.label, description: c.description }))
      : s?.type === 'boolean' ? [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] : [],
    allowOther: !choices && s?.type !== 'boolean',
    secret: false,
  }
}

export function formContent(schema: Json, answers: Record<string, string[]> | null): Json | null {
  const out: Record<string, unknown> = {}
  for (const [key, s] of Object.entries<Json>(schema?.properties ?? {})) {
    const given = answers?.[key]
    if (!given?.length) continue
    const value = fieldValue(s, given)
    if (value !== undefined) out[key] = value
  }
  const missing = (schema?.required ?? []).some((k: string) => !(k in out))
  return missing || !Object.keys(out).length ? null : out
}

function fieldValue(s: Json, given: string[]): unknown {
  const choices = formChoices(s)
  const toValue = (text: string) => choices?.find((c) => c.label === text || String(c.value) === text)?.value ?? text
  if (s?.type === 'array') return given.map(toValue)
  const text = given.join(', ')
  if (s?.type === 'boolean') return /^(yes|y|true)$/i.test(text) ? true : /^(no|n|false)$/i.test(text) ? false : undefined
  if (s?.type === 'number' || s?.type === 'integer') {
    const n = Number(text)
    return Number.isFinite(n) ? (s.type === 'integer' ? Math.trunc(n) : n) : undefined
  }
  return choices ? toValue(given[0]) : text
}

// Match model families because a reseller's route does not identify the model's company.
const FAMILIES: [RegExp, string][] = [
  [/^claude/, 'Anthropic'],
  [/^(gpt|o\d|codex|chatgpt)/, 'OpenAI'],
  [/^(gemini|gemma|veo|lyria|imagen)/, 'Google'],
  [/^glm/, 'Z.ai'],
  [/^deepseek/, 'DeepSeek'],
  [/^(kimi|moonshot)/, 'Moonshot AI'],
  [/^(qwen|qwq)/, 'Alibaba'],
  [/^grok/, 'xAI'],
  [/^minimax/, 'MiniMax'],
  [/^mimo/, 'Xiaomi'],
  [/^(mistral|codestral|devstral|magistral|ministral)/, 'Mistral'],
  [/^llama/, 'Meta'],
  [/^nemotron/, 'NVIDIA'],
  [/^longcat/, 'Meituan'],
]

export function vendorOf(modelId: string): string {
  const parts = modelId.split('/')
  const name = parts[parts.length - 1].toLowerCase()
  for (const [pattern, vendor] of FAMILIES) if (pattern.test(name)) return vendor
  return parts.length > 1 ? parts[parts.length - 2] : 'unknown'
}

// Show one hunk with three context lines, even when changes are far apart.
export function unifiedDiff(oldText: string | null, newText: string): string {
  const a = linesOf(oldText ?? '')
  const b = linesOf(newText)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  if (pre === a.length && pre === b.length) return ''
  const from = Math.max(0, pre - 3)
  const tail = Math.min(suf, 3)
  const body = [
    ...a.slice(from, pre).map((l) => ` ${l}`),
    ...a.slice(pre, a.length - suf).map((l) => `-${l}`),
    ...b.slice(pre, b.length - suf).map((l) => `+${l}`),
    ...a.slice(a.length - suf, a.length - suf + tail).map((l) => ` ${l}`),
  ]
  const oldCount = a.length - suf + tail - from
  const newCount = b.length - suf + tail - from
  const at = (count: number) => (count ? from + 1 : from)
  return [`@@ -${at(oldCount)},${oldCount} +${at(newCount)},${newCount} @@`, ...body].join('\n')
}

const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))
