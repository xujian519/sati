import { existsSync } from 'node:fs'
import path from 'node:path'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  encodeProjectName,
  expandHome,
  loadProjectConfig,
  parseArgs,
  saveProjectConfig,
} from './projectsShared.js'

async function performAddProject(rawArgs: string): Promise<string> {
  const tokens = parseArgs(rawArgs)
  if (tokens.length === 0) {
    return '**Missing path.** Usage: `/add-project <absolute-or-~-path> [displayName]`.'
  }

  const [rawPath, ...rest] = tokens
  const displayName = rest.length > 0 ? rest.join(' ') : null
  const absolutePath = path.resolve(expandHome(rawPath))

  if (!existsSync(absolutePath)) {
    return `**Path does not exist:** \`${absolutePath}\`.\nCreate the directory first, or pass a valid path.`
  }

  const projectName = encodeProjectName(absolutePath)
  const config = await loadProjectConfig()

  if (config[projectName]) {
    const existing = config[projectName]
    const who = existing.manuallyAdded ? 'manually added' : 'auto-discovered'
    return `**Already configured** (${who}): \`${existing.originalPath ?? absolutePath}\` (project key: \`${projectName}\`). Nothing to do.`
  }

  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath,
    ...(displayName ? { displayName } : {}),
  }
  await saveProjectConfig(config)

  return [
    `**Added project** \`${displayName ?? path.basename(absolutePath)}\`:`,
    '',
    `- Path: \`${absolutePath}\``,
    `- Project key: \`${projectName}\``,
    '',
    `Use \`/switch-project ${projectName}\` (gateway / IM) or open it in Claude Code / claudecodeui to start working in it.`,
  ].join('\n')
}

export function registerAddProjectSkill(): void {
  registerBundledSkill({
    name: 'add-project',
    description:
      'Register an existing local directory as a Claude Code project so it appears in the TUI project picker, gateway /projects, and the claudecodeui sidebar.',
    argumentHint: '<path> [displayName]',
    userInvocable: true,
    allowedTools: [],
    async getPromptForCommand(args) {
      const report = await performAddProject(args ?? '')
      return [
        {
          type: 'text',
          text: [
            `The user ran \`/add-project ${args}\`. The operation was executed directly on disk by the skill — your job is just to relay the result to the user.`,
            '',
            '## Result',
            '',
            report,
            '',
            'Respond with exactly this result (you may tighten the wording). Do not run any tools.',
          ].join('\n'),
        },
      ]
    },
  })
}
