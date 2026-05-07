export type AlwaysOnDiscoveryPromptLanguage = 'en' | 'zh-CN'

export function normalizeAlwaysOnDiscoveryPromptLanguage(
  language?: string | null,
): AlwaysOnDiscoveryPromptLanguage {
  return language === 'zh-CN' ? 'zh-CN' : 'en'
}

function buildEnglishAlwaysOnDiscoveryPrompt(projectRoot: string): string {
  return [
    `Always-On discovery planning for project at \`${projectRoot}\`.`,
    '',
    'Your job is discovery only.',
    'Inspect the workspace and decide whether there are worthwhile follow-up tasks.',
    '',
    'Requirements:',
    '1. If there is no worthwhile follow-up work, explain why and stop without saving plans.',
    '2. If there is worthwhile work, use `AlwaysOnDiscoveryPlan` to persist up to 3 plans.',
    '3. Every saved plan must include `## Context`, `## Signals Reviewed`, `## Proposed Work`, `## Execution Steps`, `## Verification`, and `## Approval And Execution`.',
    '4. Use `approvalMode: "manual"` unless the work is clearly safe and suitable for auto-execution.',
    '5. Do not call `CronCreate`, do not execute the work now, and do not start background tasks.',
    '6. Language: if context refs or recent chat records are available, infer the primary language of those recent chats. Use that language for your final reply and for every saved plan markdown body. If it differs from the UI or prompt language, recent chats win. If no recent chat language is discernible, use this prompt language.',
    '7. In your final reply, summarize what you reviewed and which discovery plan IDs were created or updated.',
  ].join('\n')
}

function buildChineseAlwaysOnDiscoveryPrompt(projectRoot: string): string {
  return [
    `Always-On 主动发现规划，项目路径为 \`${projectRoot}\`。`,
    '',
    '你的任务只限于发现和规划。',
    '检查工作区，判断是否存在值得后续跟进的任务。',
    '',
    '要求：',
    '1. 如果没有值得跟进的工作，说明原因并停止，不要保存计划。',
    '2. 如果存在值得跟进的工作，使用 `AlwaysOnDiscoveryPlan` 最多保存 3 个计划。',
    '3. 每个保存的计划必须包含 `## Context`、`## Signals Reviewed`、`## Proposed Work`、`## Execution Steps`、`## Verification` 和 `## Approval And Execution`。',
    '4. 除非工作明显安全且适合自动执行，否则使用 `approvalMode: "manual"`。',
    '5. 不要调用 `CronCreate`，不要现在执行这些工作，也不要启动后台任务。',
    '6. 语言：如果 context refs 或近期聊天记录可用，推断这些近期聊天记录的主要语言。最终回复以及每个保存的计划 Markdown 正文都优先使用该语言。如果它与 Web UI 或当前提示词语言不同，以近期聊天语言为准。如果无法判断近期聊天语言，则使用当前提示词语言。',
    '7. 在最终回复中，总结你检查了什么，以及创建或更新了哪些 discovery plan ID。',
  ].join('\n')
}

export function buildAlwaysOnDiscoveryPrompt(
  projectRoot: string,
  language?: string | null,
): string {
  return normalizeAlwaysOnDiscoveryPromptLanguage(language) === 'zh-CN'
    ? buildChineseAlwaysOnDiscoveryPrompt(projectRoot)
    : buildEnglishAlwaysOnDiscoveryPrompt(projectRoot)
}
