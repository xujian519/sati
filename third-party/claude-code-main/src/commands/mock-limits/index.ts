import type { Command } from '../../commands.js'

const stub = {
  type: 'local-jsx' as const,
  name: 'mock-limits',
  description: 'Internal command (stub)',
  isEnabled: () => false,
  load: () => Promise.resolve({ default: () => null }),
} satisfies Command

export default stub
