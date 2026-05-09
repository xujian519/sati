import type {
  Project,
  ProjectDiscoveryContextResponse,
} from '../types/app';

export type DiscoveryPromptLanguage = 'en' | 'zh-CN';

export function normalizeDiscoveryPromptLanguage(
  language?: string | null,
): DiscoveryPromptLanguage {
  return language === 'zh-CN' ? 'zh-CN' : 'en';
}

function getClaudeProjectStorePath(project: Project): string {
  const projectPath = project.fullPath || project.path || '';
  const unixHomeMatch = projectPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (unixHomeMatch?.[1]) {
    return `${unixHomeMatch[1]}/.claude/projects/${project.name}`;
  }

  const windowsHomeMatch = projectPath.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsHomeMatch?.[1]) {
    return `${windowsHomeMatch[1]}\\.claude\\projects\\${project.name}`;
  }

  return `~/.claude/projects/${project.name}`;
}

function buildEnglishAlwaysOnDiscoveryPrompt(
  project: Project,
  context: ProjectDiscoveryContextResponse,
): string {
  const workspacePath = project.fullPath || project.path || project.name;
  const claudeProjectStorePath = getClaudeProjectStorePath(project);
  const displayName = project.displayName || project.name;

  return [
    `Always-On discovery planning for project "${displayName}".`,
    '',
    'Your job is discovery only.',
    'Inspect the provided context, decide whether there are worthwhile follow-up tasks, and persist up to 3 structured discovery plans.',
    '',
    'Requirements:',
    `1. Inspect the current workspace at \`${workspacePath}\`.`,
    `2. Use the project store at \`${claudeProjectStorePath}\` as supporting context if needed.`,
    '3. Read the structured discovery context below instead of inventing your own context window.',
    '4. If there is no worthwhile follow-up work, explain why and stop without saving any plans.',
    '5. If there is worthwhile work, use `AlwaysOnDiscoveryPlan` to persist up to 3 plans.',
    '6. Every saved plan must include these markdown sections exactly:',
    '   - `## Context`',
    '   - `## Signals Reviewed`',
    '   - `## Proposed Work`',
    '   - `## Execution Steps`',
    '   - `## Verification`',
    '   - `## Approval And Execution`',
    '7. Use `approvalMode: "manual"` unless the work is clearly safe and suitable for auto-execution.',
    '8. Do not call `CronCreate`, do not execute the work now, and do not start background tasks.',
    '9. Language: if the structured context or plan `contextRefs.recentChats` includes recent chat records, infer the primary language of those recent chats. Use that language for your final reply and for every saved plan markdown body. If it differs from the Web UI language, recent chats win. If no recent chat language is discernible, use this prompt language.',
    '10. In your final reply, summarize what you reviewed and which discovery plan IDs were created or updated.',
    '',
    'Structured discovery context:',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ].join('\n');
}

function buildChineseAlwaysOnDiscoveryPrompt(
  project: Project,
  context: ProjectDiscoveryContextResponse,
): string {
  const workspacePath = project.fullPath || project.path || project.name;
  const claudeProjectStorePath = getClaudeProjectStorePath(project);
  const displayName = project.displayName || project.name;

  return [
    `Always-On 主动发现规划，项目为“${displayName}”。`,
    '',
    '你的任务只限于发现和规划。',
    '检查提供的上下文，判断是否存在值得后续跟进的任务，并最多保存 3 个结构化 discovery plans。',
    '',
    '要求：',
    `1. 检查当前工作区 \`${workspacePath}\`。`,
    `2. 如有需要，将项目存储目录 \`${claudeProjectStorePath}\` 作为辅助上下文。`,
    '3. 阅读下方结构化 discovery context，不要自行虚构上下文窗口。',
    '4. 如果没有值得跟进的工作，说明原因并停止，不要保存任何计划。',
    '5. 如果存在值得跟进的工作，使用 `AlwaysOnDiscoveryPlan` 最多保存 3 个计划。',
    '6. 每个保存的计划必须严格包含这些 Markdown 小节：',
    '   - `## Context`',
    '   - `## Signals Reviewed`',
    '   - `## Proposed Work`',
    '   - `## Execution Steps`',
    '   - `## Verification`',
    '   - `## Approval And Execution`',
    '7. 除非工作明显安全且适合自动执行，否则使用 `approvalMode: "manual"`。',
    '8. 不要调用 `CronCreate`，不要现在执行这些工作，也不要启动后台任务。',
    '9. 语言：如果结构化上下文或计划 `contextRefs.recentChats` 中包含近期聊天记录，推断这些近期聊天记录的主要语言。最终回复以及每个保存的计划 Markdown 正文都优先使用该语言。如果它与 Web UI 语言不同，以近期聊天语言为准。如果无法判断近期聊天语言，则使用当前提示词语言。',
    '10. 在最终回复中，总结你检查了什么，以及创建或更新了哪些 discovery plan ID。',
    '',
    '结构化 discovery context：',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ].join('\n');
}

export function buildAlwaysOnDiscoveryPrompt(
  project: Project,
  context: ProjectDiscoveryContextResponse,
  language?: string | null,
): string {
  return normalizeDiscoveryPromptLanguage(language) === 'zh-CN'
    ? buildChineseAlwaysOnDiscoveryPrompt(project, context)
    : buildEnglishAlwaysOnDiscoveryPrompt(project, context);
}
