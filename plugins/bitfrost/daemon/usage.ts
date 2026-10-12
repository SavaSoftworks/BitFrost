// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Turns one model's hourly usage rows into what the stats panel shows: today, the
// last 7 and 30 days, all time, today by the hour, and a daily series from first use.
import { dayOf } from './store.ts'

type Row = Record<string, any>
export type Totals = { sessions: number; closedSessions: number; sessionMs: number; turns: number; failedTurns: number; turnMs: number; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number }

// The longest daily series, and the shortest so a new model still shows a month.
const DAILY_MAX = 366
const DAILY_MIN = 30

const zero = (): Totals => ({ sessions: 0, closedSessions: 0, sessionMs: 0, turns: 0, failedTurns: 0, turnMs: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 })

function add(to: Totals, r: Row) {
  to.sessions += r.sessions ?? 0
  to.closedSessions += r.closed_sessions ?? 0
  to.sessionMs += r.session_ms ?? 0
  to.turns += r.turns ?? 0
  to.failedTurns += r.failed_turns ?? 0
  to.turnMs += r.turn_ms ?? 0
  to.requests += r.requests ?? 0
  to.inputTokens += r.input_tokens ?? 0
  to.outputTokens += r.output_tokens ?? 0
  to.cachedTokens += r.cached_tokens ?? 0
}

export function summarize(model: string, rows: Iterable<Row>, now = Date.now()) {
  const today = new Date(now)
  // Step calendar days, not 24 hours, so a clock change can't skip one.
  const daysAgo = (n: number) => dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).getTime())
  const todayKey = daysAgo(0)
  const weekFrom = daysAgo(6)
  const monthFrom = daysAgo(29)
  const seriesFrom = daysAgo(DAILY_MAX - 1)
  const out = { model, total: zero(), today: zero(), week: zero(), month: zero(), daily: [] as { day: string; sessions: number; tokens: number }[],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0 })), firstUsedAt: null as number | null, lastUsedAt: null as number | null }
  const byDay = new Map<string, { sessions: number; tokens: number }>()
  for (const r of rows) {
    const day = dayOf(r.hour)
    const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
    add(out.total, r)
    if (day === todayKey) {
      add(out.today, r)
      out.hourly[new Date(r.hour).getHours()].tokens += tokens
    }
    if (day >= weekFrom) add(out.week, r)
    if (day >= monthFrom) add(out.month, r)
    const d = byDay.get(day) ?? { sessions: 0, tokens: 0 }
    d.sessions += r.sessions ?? 0
    d.tokens += tokens
    byDay.set(day, d)
    if (r.first_at != null) out.firstUsedAt = out.firstUsedAt == null ? r.first_at : Math.min(out.firstUsedAt, r.first_at)
    if (r.last_at != null) out.lastUsedAt = out.lastUsedAt == null ? r.last_at : Math.max(out.lastUsedAt, r.last_at)
  }
  // Zero days are included so the series is evenly spaced, oldest first.
  const first = [...byDay.keys()].sort()[0] ?? monthFrom
  const start = first < seriesFrom ? seriesFrom : first > daysAgo(DAILY_MIN - 1) ? daysAgo(DAILY_MIN - 1) : first
  for (let n = DAILY_MAX - 1; n >= 0; n--) {
    const day = daysAgo(n)
    if (day >= start) out.daily.push({ day, ...(byDay.get(day) ?? { sessions: 0, tokens: 0 }) })
  }
  return out
}
