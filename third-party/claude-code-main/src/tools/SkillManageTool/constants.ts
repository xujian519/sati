export const SKILL_MANAGE_TOOL_NAME = 'SkillManage'

/** Actions supported by SkillManage. Mirrors hermes-agent skill_manage. */
export const SKILL_MANAGE_ACTIONS = [
  'create',
  'patch',
  'edit',
  'delete',
  'write_file',
  'remove_file',
] as const

export type SkillManageAction = (typeof SKILL_MANAGE_ACTIONS)[number]

/** Supporting-file subdirectories agent writes may target. */
export const ALLOWED_SKILL_SUBDIRS = [
  'references',
  'templates',
  'scripts',
  'assets',
] as const

export type SkillScope = 'user' | 'project'
