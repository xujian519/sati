import type { Command } from '../../commands.js'

const stub = {
  type: 'local-jsx' as const,
  name: 'break-cache',
  description: 'Internal command (stub)',
  isEnabled: () => false,
  load: () => Promise.resolve({ default: () => null }),
} satisfies Command

export default stub
