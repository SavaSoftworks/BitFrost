// Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
import type { TestContext } from 'node:test'
import { FEATURES, type Feature } from '../../features.ts'

// Synthetic future settings belong to tests, never the shipped feature registry.
export const TEST_SETTINGS: Feature[] = [
  { id: 'previewAppearance', title: 'Preview appearance', prompt: 'Which appearance would you prefer?', options: ['Classic', 'Compact', 'Spacious'] },
  { id: 'previewNotifications', title: 'Preview notifications', prompt: 'Which notifications would you prefer?', options: ['None', 'Important only', 'All activity'] },
  { id: 'previewHistory', title: 'Preview history', prompt: 'How would you prefer to group history?', options: ['By day', 'By project', 'By model'] },
  { id: 'previewStartup', title: 'Preview startup', prompt: 'Which page would you prefer on startup?', options: ['Home', 'Models', 'Sessions'] },
].map((setting): Feature => ({
  id: setting.id, key: setting.id, since: '0.9.2', title: setting.title,
  questions: [{ key: 'choice', type: 'choice', prompt: setting.prompt, label: setting.title,
    help: 'Test setting only. This choice does not change BitFrost behavior.',
    default: setting.options[0], options: setting.options.map((value) => ({ value, label: value })) }],
}))

export function useTestSettings(t: TestContext, additional = TEST_SETTINGS) {
  const original = [...FEATURES]
  // Keep the real conditional handback questions alongside four controlled steps.
  FEATURES.splice(0, FEATURES.length, ...original.filter((f) => f.id === 'handback'), ...additional)
  t.after(() => FEATURES.splice(0, FEATURES.length, ...original))
}
