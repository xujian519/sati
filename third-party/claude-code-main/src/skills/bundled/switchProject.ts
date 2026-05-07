import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  GATEWAY_STATE_DIR,
  gatewayStatePathFor,
  getGatewayContext,
  listProjects,
  parseArgs,
  type ProjectInfo,
} from './projectsShared.js'

function resolveProject(projects: ProjectInfo[], query: string): ProjectInfo | null {
  const lower = query.toLowerCase()
  return (
    projects.find(p => p.name === query) ||
    projects.find(p => p.displayName === query) ||
    projects.find(p => p.name.toLowerCase() === lower) ||
    projects.find(p => p.displayName.toLowerCase() === lower) ||
    projects.find(p => path.basename(p.path).toLowerCase() === lower) ||
    null
  )
}

async function performSwitch(rawArgs: string): Promise<string> {
  const tokens = parseArgs(rawArgs)
  if (tokens.length === 0) {
    return '**Missing project name.** Usage: `/switch-project <name>`. Run `/projects` to see available names.'
  }
  const query = tokens.join(' ')

  const projects = await listProjects()
  const match = resolveProject(projects, query)
  if (!match) {
    const names = projects.map(p => `- \`${p.name}\` (${p.displayName})`).join('\n') || '_(no projects)_'
    return [
      `**No project matches** \`${query}\`.`,
      '',
      'Known projects:',
      names,
    ].join('\n')
  }

  if (!existsSync(match.path)) {
    return `**Cannot switch:** project path \`${match.path}\` no longer exists. Use \`/add-project\` with a valid path.`
  }

  const ctx = getGatewayContext()
  if (ctx) {
    await fs.mkdir(GATEWAY_STATE_DIR, { recursive: true })
    const statePath = gatewayStatePathFor(ctx.userId, ctx.platform)
    const payload = {
      projectName: match.name,
      projectPath: match.path,
      projectDisplayName: match.displayName,
      updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(statePath, JSON.stringify(payload, null, 2), 'utf8')
    return [
      `**Switched to project** \`${match.displayName}\`.`,
      '',
      `- Path: \`${match.path}\``,
      `- Next message in this chat will run with this as the working directory.`,
    ].join('\n')
  }

  return [
    `**No switch needed in this context** — \`/switch-project\` only changes state when running under the gateway (IM).`,
    '',
    `You're currently in the TUI / claudecodeui, where the active project is set by the app itself (sidebar or CLI cwd).`,
    `Matched project for reference: \`${match.displayName}\` → \`${match.path}\`.`,
  ].join('\n')
}

export function registerSwitchProjectSkill(): void {
  registerBundledSkill({
    name: 'switch-project',
    description:
      'Switch the active project for the current gateway/IM conversation. When running in the TUI or claudecodeui this is a no-op (those UIs manage the active project themselves).',
    argumentHint: '<project name>',
    userInvocable: true,
    allowedTools: [],
    async getPromptForCommand(args) {
      const report = await performSwitch(args ?? '')
      return [
        {
          type: 'text',
          text: [
            `The user ran \`/switch-project ${args}\`. The skill handled the state update directly — just relay the result below.`,
            '',
            '## Result',
            '',
            report,
            '',
            'Respond with this result. Do not run any tools.',
          ].join('\n'),
        },
      ]
    },
  })
}
