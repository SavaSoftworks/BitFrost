// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import path from 'node:path'
import type { ProviderFactory } from '../provider.ts'
import { AcpProvider, type AcpAgentSpec } from './acp.ts'

// Ask before writes, commands and web use; deny subagents because they never ask.
const OPENCODE_PERMISSION = {
  edit: 'ask',
  bash: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
  external_directory: 'ask',
  doom_loop: 'ask',
  task: 'deny',
}

export const OPENCODE: AcpAgentSpec = {
  id: 'opencode',
  displayName: 'opencode',
  vendor: null,
  binary: 'opencode',
  args: ['acp'],
  // OPENCODE_PERMISSION overrides config; the content form covers older versions.
  env: {
    OPENCODE_PERMISSION: JSON.stringify(OPENCODE_PERMISSION),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: OPENCODE_PERMISSION }),
  },
  loginCommand: 'opencode auth login',
  optIn: true,
  gates: 'all',
  note: "Serves many companies' models, named provider/model. Denying a request ends opencode's turn. An agent's own `permission` block in the user's opencode config still applies on top.",
}

export const OMP: AcpAgentSpec = {
  id: 'omp',
  displayName: 'Oh My Pi',
  vendor: null,
  binary: 'omp',
  args: ['acp', '--approval-mode', 'always-ask'],
  configOverlay: {
    flag: '--config',
    file: 'omp-overlay.yml',
    body: {
      // Disable the advisor because it uses a second model, sometimes another company's.
      advisor: { enabled: false, subagents: false },
      // Disable subagents because they choose their own models.
      task: { maxRecursionDepth: 0 },
      // Disable prewalk because it switches to a cheaper model mid-task.
      prewalk: { enabled: false },
      // Ask through both permission requests and forms so neither path skips approval.
      tools: { approvalMode: 'always-ask' },
    },
  },
  loginCommand: 'omp',
  optIn: true,
  // Report only commands, deletes and moves until broader form approvals are seen live.
  gates: 'destructive',
  note: "Serves many companies' models, named provider/model. Starts with thinking off unless an effort is chosen. A command may be asked about twice: once as a permission request, once as a yes/no form.",
}

export const GEMINI: AcpAgentSpec = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  vendor: 'Google',
  binary: 'gemini',
  // Use default mode to ask before edits, commands and fetches despite user settings.
  args: ['--acp', '--approval-mode', 'default'],
  loginCommand: 'gemini',
  optIn: true,
  gates: 'all',
  note: 'Lists its models the older way (no thought levels) and takes session/set_model.',
}

function acpFactory(spec: AcpAgentSpec): ProviderFactory {
  return {
    id: spec.id,
    optIn: spec.optIn,
    create(env) {
      const bin = env.config.bin ?? env.resolveBinary(spec.binary)
      if (!bin) return null
      const args = [...spec.args]
      if (spec.configOverlay) {
        const file = path.join(env.runDir, spec.configOverlay.file)
        fs.mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, JSON.stringify(spec.configOverlay.body, null, 2) + '\n', { mode: 0o600 })
        args.push(spec.configOverlay.flag, file)
      }
      const models = Array.isArray(env.config.models) ? env.config.models.map(String) : null
      return new AcpProvider(spec, { bin, args, env: spec.env ?? {} }, { log: env.log, record: env.recorder(spec.id), runDir: env.runDir, models })
    },
  }
}

export const opencodeProvider = acpFactory(OPENCODE)
export const ompProvider = acpFactory(OMP)
export const geminiProvider = acpFactory(GEMINI)
