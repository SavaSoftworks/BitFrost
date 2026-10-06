// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import type { ProviderFactory } from '../provider.ts'
import { codexProvider } from './codex.ts'
import { zcodeProvider } from './zcode.ts'
import { geminiProvider, ompProvider, opencodeProvider } from './acp-agents.ts'

export const PROVIDERS: ProviderFactory[] = [codexProvider, zcodeProvider, opencodeProvider, ompProvider, geminiProvider]
