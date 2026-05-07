import { registerBundledSkill } from '../bundledSkills.js'
import { getGatewayContext, listProjects } from './projectsShared.js'

export function registerPwdSkill(): void {
  registerBundledSkill({
    name: 'pwd',
    description:
      'Tell the user the current working directory and (if it matches a registered Claude Code project) its display name.',
    userInvocable: true,
    allowedTools: [],
    async getPromptForCommand() {
      const cwd = process.cwd()
      const ctx = getGatewayContext()
      const projects = await listProjects()
      const match = projects.find(p => p.path === cwd)

      const lines: string[] = []
      lines.push(`- **Working directory:** \`${cwd}\``)
      if (match) {
        lines.push(`- **Project:** \`${match.displayName}\` (key: \`${match.name}\`)`)
      } else {
        lines.push(`- **Project:** _none registered_ — use \`/add-project ${cwd}\` to track it.`)
      }
      if (ctx) {
        lines.push(`- **Context:** gateway (user=\`${ctx.userId}\`, platform=\`${ctx.platform}\`)`)
      }

      return [
        {
          type: 'text',
          text: [
            'The user ran `/pwd`. The skill already gathered everything — relay the result without running any tools.',
            '',
            '## Result',
            '',
            lines.join('\n'),
            '',
            'Respond with this result verbatim (you may add a short human-friendly sentence). Do not run any tools.',
          ].join('\n'),
        },
      ]
    },
  })
}
