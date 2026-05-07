import { registerBundledSkill } from '../bundledSkills.js'
import { formatProjectList, listProjects } from './projectsShared.js'

export function registerListProjectsSkill(): void {
  registerBundledSkill({
    name: 'projects',
    aliases: ['list-projects'],
    description:
      'List every Claude Code project visible to the TUI, gateway, and claudecodeui (discovered from ~/.claude/projects and ~/.claude/project-config.json).',
    userInvocable: true,
    allowedTools: [],
    async getPromptForCommand() {
      const projects = await listProjects()
      const table = formatProjectList(projects)

      return [
        {
          type: 'text',
          text: [
            'The user ran `/projects`. The project list below was read directly from disk by the skill — relay it to the user without running any tools.',
            '',
            '## Projects',
            '',
            table,
            '',
            projects.length > 0
              ? `Tell the user: to switch (when on the gateway/IM side), run \`/switch-project <name>\`. Use the value from the "#" column's adjacent key if they ask. Otherwise just present the table.`
              : `Tell the user to add one with \`/add-project <path>\` or \`/clone-repo <git-url>\`.`,
          ].join('\n'),
        },
      ]
    },
  })
}
