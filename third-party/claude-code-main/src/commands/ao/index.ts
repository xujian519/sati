import type { Command } from '../../commands.js'

const ao = {
  type: 'local-jsx',
  name: 'ao',
  description: 'List, run, or inspect Always-On cron jobs and discovery plans',
  argumentHint: '[list [cron|plan] | status <cron|plan> <id> | run <cron|plan> <id>]',
  load: () => import('./ao.js'),
} satisfies Command

export default ao
