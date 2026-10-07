// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.


export type FileChange = {
  path: string
  kind: 'add' | 'delete' | 'update'
  movePath?: string | null
  diff: string
}

export type EndReason = 'end_turn' | 'interrupted' | 'restarted' | 'stop_timeout' | 'daemon_restart' | 'permission_denied' | 'quota_exhausted' | 'rate_limited' | 'auth' | 'max_tokens' | 'max_requests' | 'refusal' | 'wrong_model' | 'crashed' | 'error'
export type Delivery = 'started' | 'steered' | 'queued' | 'restarted'

export type Decision = 'allow' | 'allow_session' | 'deny'

export type Question = {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[]
  allowOther: boolean
  secret: boolean
}

export type AgentEventBody =
  | { type: 'user_input'; inputId: string; clientInputId?: string; text: string; sender: 'claude' | 'user'; delivery: Delivery }
  | { type: 'input_consumed'; inputId: string; turnId: string }
  | { type: 'interrupt_requested'; source: string }
  | { type: 'input_dropped'; inputId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text'; itemId: string; text: string }
  | { type: 'reasoning'; itemId: string; text: string }
  | { type: 'command_started'; itemId: string; command: string; summary: string; cwd: string }
  | {
      type: 'command_completed'
      itemId: string
      command: string
      summary: string
      cwd: string
      output: string
      exitCode: number | null
      durationMs: number | null
      status: string
    }
  | { type: 'file_change'; itemId: string; changes: FileChange[]; status: string }
  | { type: 'tool'; itemId: string; name: string; input: unknown; output: string; status: string }
  // These tool names and inputs match Claude Code tools.
  | { type: 'tool_started'; itemId: string; name: string; input: unknown }
  | { type: 'tool_completed'; itemId: string; name: string; input: unknown; ok: boolean; output: string; display?: unknown }
  // Usage covers one model request, never the sum over a turn.
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  // Each plan replaces the previous plan in full.
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | {
      type: 'turn_completed'
      turnId: string
      status: 'completed' | 'interrupted' | 'failed'
      finalText: string
      error?: string
      reason: EndReason
      providerErrorCode?: string
      plan?: string
      continues?: boolean
    }
  | { type: 'session_failed'; error: string }
  // Optional tool and input fields match the corresponding Claude Code tool.
  | {
      type: 'approval_requested'
      approvalId: string
      itemId: string | null
      kind: 'command' | 'file_change' | 'permissions'
      title: string
      detail: string
      tool?: string
      input?: unknown
    }
  | { type: 'approval_resolved'; approvalId: string; decision: Decision }
  | { type: 'auto_reviewed'; itemId: string | null; action: string; decision: string; reason: string }
  | { type: 'question_asked'; questionId: string; questions: Question[] }
  | { type: 'question_answered'; questionId: string; how: 'answered' | 'deferred' }

export type AgentEvent = AgentEventBody & { seq: number; ts: number; ext?: Record<string, unknown> }
