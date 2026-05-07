import type { Command } from '../../commands.js'

export const resetLimits = {
  type: 'local-jsx' as const,
  name: 'reset-limits',
  description: 'Internal command (stub)',
  isEnabled: () => false,
  load: () => Promise.resolve({ default: () => null }),
} satisfies Command

export const resetLimitsNonInteractive = {
  type: 'local-jsx' as const,
  name: 'reset-limits-noninteractive',
  description: 'Internal command (stub)',
  isEnabled: () => false,
  load: () => Promise.resolve({ default: () => null }),
} satisfies Command
