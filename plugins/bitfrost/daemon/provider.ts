// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Each provider runs model requests through its app, which keeps all credentials.
// Stop a turn if the app runs a different model.
import type { Decision } from './events.ts'
import type { Session } from './session.ts'

type Json = any

export type HarnessModel = {
  harness: string
  harnessName?: string
  provider: string // Company serving the model.
  model: string
  displayName: string
  description: string
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}

export type SpawnRequest = {
  model: string
  effort?: string
  cwd: string
  prompt: string
  developerInstructions?: string
  canAskUser?: boolean
  autoReview?: boolean
  title?: string
  ephemeral?: boolean
}

export type ProviderCapabilities = {
  steer: boolean // Join mid-turn input to the running turn.
  autoReview: boolean
  questions: boolean
  // Report which actions reach approval_requested; other actions run without asking.
  gates: 'all' | 'destructive'
}

export interface Provider {
  readonly id: string
  readonly displayName: string
  // Set for an app serving its own company's models; omit for apps serving many companies.
  readonly vendor?: string
  readonly capabilities: ProviderCapabilities
  readonly location: string
  // Restart when these files change; defaults to location.
  readonly watch?: string[]
  // Restart if the app has moved to another location.
  moved?(): boolean

  listModels(): Promise<HarnessModel[]>
  spawnSession(session: Session, req: SpawnRequest): Promise<string>
  sendInput(session: Session, text: string): Promise<'started' | 'steered' | 'queued'>
  attach?(session: Session, nativeRef: any): Promise<void>
  kill?(session: Session): boolean
  isBusy?(session: Session): boolean
  interrupt(session: Session): Promise<void>
  setAutoMode?(session: Session): void
  dispose?(): void
  // Release adapter state only after the session stops.
  disposeSession?(session: Session): void

  pendingApprovals(session: Session): string[]
  resolveApproval(session: Session, approvalId: string, decision: Decision, reason?: string): boolean
  pendingQuestions(session: Session): string[]
  // Map question IDs to answers; defer pauses the turn until the lead agent replies.
  answerQuestion(session: Session, questionId: string, answers: Record<string, string[]> | null, defer: boolean): Promise<boolean>

  // Handle an app hook call; return null for no reply.
  bridge?(token: string, payload: Json): Promise<Json | null>
}

export type ProviderEnv = {
  runDir: string
  dataDir?: string
  socket: string
  log: (msg: string) => void
  config: Json // This provider's entry in config.json.
  resolveBinary: (name: string) => string | null
  // Save raw app output as test fixtures when BITFROST_RECORD_DIR is set.
  recorder: (name: string) => ((line: string) => void) | null
}

export type ProviderFactory = {
  id: string
  // Enable only when config.json explicitly turns this provider on.
  optIn?: boolean
  create(env: ProviderEnv): Provider | null
  setup?(env: ProviderEnv): void
  // Undoes setup, for bitfrost uninstall, and says what it changed. dryRun only says.
  uninstall?(dryRun?: boolean): { label: string; path: string }[]
}
