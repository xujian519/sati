import type { ChatDigest } from "../context/ChatDigestBuilder.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../tool/AlwaysOnWorkspaceTool.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../tool/AlwaysOnChatHistoryTool.js";
import type {
  BuildDiscoveryPromptInput,
  BuildWorkspacePromptInput,
  BuildExecutionPromptInput,
  BuildReportPromptInput,
  BuildApplyPromptInput,
  ExistingPlanSummary,
} from "./discoveryPrompts.js";

export function buildDiscoveryPromptZh(input: BuildDiscoveryPromptInput): string {
  const codeAccessLines: string[] = input.workspace
    ? [
        `隔离工作区路径: ${input.workspace.cwd}`,
        `工作区策略: ${input.workspace.strategy}`,
        "此工作区是项目的隔离快照——可在其中自由使用 read_file / glob / bash。",
        `请勿 cd 到工作区外部的项目根目录 (${input.projectRoot})。`,
      ]
    : [
        `可使用 read_file / glob / bash 自由读取项目根目录: ${input.projectRoot}`,
      ];

  const headerLine = input.workspace
    ? `你正在为项目执行自主 Always-On 发现任务: ${input.projectRoot} (当前在隔离工作区中: ${input.workspace.cwd})`
    : `你正在为项目执行自主 Always-On 发现任务: ${input.projectRoot}`;

  const lines: string[] = [
    headerLine,
    "",
    "目标: 最多提出一个有价值的任务。",
    "任务范围包括但不限于: 丰富或补充内容、完成未竟工作、优化结构或布局、",
    "修复错误、提升用户体验, 以及用户在聊天记录中讨论过的任何有价值的事项。",
    "每个计划必须包含至少一个可自动验证的检查步骤",
    "(如: 文件存在、内容匹配预期模式、页面无错误渲染等)。",
    "如果未发现可执行的任务, 不要调用任何工具——仅以简短说明回复原因即可。",
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    ...codeAccessLines,
  ];

  lines.push("", ...formatChatDigestSectionZh(input.chatDigest));
  lines.push("", ...formatExistingPlansSectionZh(input.existingPlans));

  lines.push(
    "",
    `如果你发现了一个任务, 请调用 \`${ALWAYS_ON_PLAN_TOOL_NAME}\` 恰好一次, 提交格式严格的 markdown 计划。`,
    "计划结构要求 (自上而下):",
    "  - 一级标题: # <计划标题>",
    "  - 元数据引用块, 首行为 `Always-On Discovery Plan`, 后接键值行:",
    `    > id: plan_${input.runId}`,
    `    > sourceRunId: ${input.runId}`,
    `    > createdAt: ${input.createdAt}`,
    `    > projectRoot: ${input.projectRoot}`,
    "    > dedupeKey: <稳定标识符>",
    "  - 章节按以下顺序排列: ## Summary, ## Rationale, ## Context Signals, ## Proposed Change, ## Execution Steps, ## Verification。",
    "  - Summary 不超过 200 字符, 单段落。",
    "  - Context Signals: 至少一个 `-` 列表项。",
    "  - Execution Steps: 仅使用有序列表 (1., 2., …), 不使用无序列表。",
    "  - Verification: 至少一个 `-` 列表项, 每项必须可机器校验。",
    "",
    "硬性约束:",
    `  - 调用 \`${ALWAYS_ON_PLAN_TOOL_NAME}\` 超过一次将返回 plan_quota_exhausted。`,
    "  - 缺少必要章节、章节顺序错误、或包含模糊 'TODO' 措辞的计划将被拒绝。",
    "  - 不要包含 Risks 或 Rollback 章节。",
  );

  return lines.join("\n");
}

function formatChatDigestSectionZh(digest?: ChatDigest): string[] {
  if (!digest || digest.sessions.length === 0) {
    return [
      "未找到近期用户对话。请浏览工作区内容以发现有价值的任务。",
    ];
  }

  const lines: string[] = [
    "## 近期用户对话",
    "",
    "以下是近期用户-智能体对话的结构化摘要。",
    "这些是用户关注点的主要信号来源。",
    `如需查看某个会话的完整对话, 请使用 sessionId 调用 \`${ALWAYS_ON_CHAT_HISTORY_TOOL_NAME}\`。`,
    "",
  ];

  for (const session of digest.sessions) {
    const ts = session.lastModified.replace(/\.\d{3}Z$/, "Z");
    lines.push(`- [${ts}] "${session.title}" (sessionId: ${session.alias})`);
    for (const prompt of session.userPrompts) {
      const oneLiner = prompt.replace(/\n/g, " ").trim();
      lines.push(`  > ${oneLiner}`);
    }
    lines.push("");
  }

  return lines;
}

function formatExistingPlansSectionZh(plans?: ExistingPlanSummary[]): string[] {
  if (!plans || plans.length === 0) {
    return [];
  }

  const lines: string[] = [
    "## 已有 Always-On 计划 (请勿重复这些主题)",
    "",
  ];

  for (const plan of plans) {
    lines.push(`- [${plan.status}] "${plan.title}" (dedupeKey: ${plan.dedupeKey})`);
  }

  return lines;
}

export function buildWorkspacePromptZh(input: BuildWorkspacePromptInput): string {
  const lines: string[] = [
    "你正在为 Always-On 计划执行准备一个隔离工作区。",
    "",
    `项目根目录: ${input.projectRoot}`,
    "",
    "可用的工作区策略:",
    "  - `git-worktree`: 创建分离的 git worktree。速度快、空间占用少 (使用硬链接)。",
    "    要求项目是 git 仓库且至少有一次提交, 工作区无未提交更改。",
    "  - `snapshot-copy`: 复制项目目录 (在 APFS/btrfs 上使用 CoW)。适用于任何目录,",
    "    但占用更多磁盘空间。默认忽略 .git、node_modules、dist。",
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
  ];

  if (input.currentWorkspace) {
    lines.push(
      "",
      `上一次运行遗留的工作区仍然存在: ${input.currentWorkspace.cwd}`,
      `策略: ${input.currentWorkspace.strategy}`,
      "如果该目录仍在磁盘上, 你可以跳过工作区创建,",
      "直接回复说明即可, 无需调用工具。",
    );
  }

  lines.push(
    "",
    "## 执行步骤",
    "1. 检查项目根目录状态 (如 git 仓库可执行 `git status --porcelain`, 否则执行 `ls`)。",
    `2. 调用 \`${ALWAYS_ON_WORKSPACE_TOOL_NAME}\`, 传入选定的策略, 或传入 \`auto\` 让运行时自动选择。`,
    "3. 如果复用已有工作区, 仅需简短回复说明, 无需调用工具。",
  );

  return lines.join("\n");
}

export function buildExecutionPromptZh(input: BuildExecutionPromptInput): string {
  return [
    "你正在隔离工作区内执行一个 Always-On 发现计划。",
    `工作区策略: ${input.workspaceStrategy}`,
    `工作区路径: ${input.workspaceCwd}`,
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    "安全边界为工作区本身; 请勿 cd 到工作区外部, 请勿修改用户的项目根目录。",
    "",
    "## 计划",
    input.planMarkdown.trim(),
    "",
    "## 执行步骤",
    "1. 按顺序执行 Execution Steps 中的各项步骤。",
    "2. 运行 Verification 列表中的检查项并记录结果。",
    "3. 回复执行总结及验证结果。",
  ].join("\n");
}

export function buildReportPromptZh(input: BuildReportPromptInput): string {
  return [
    "你正在为已完成的 Always-On 计划执行撰写工作报告。",
    `工作区策略: ${input.workspaceStrategy}`,
    `工作区路径: ${input.workspaceCwd}`,
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    "",
    "## 已执行的计划",
    input.planMarkdown.trim(),
    "",
    "## 执行步骤",
    "1. 查看工作区中的变更 (如 `git diff --stat`、`ls`、阅读相关文件)。",
    "2. 总结执行情况: 执行了哪些步骤、修改了哪些文件、命令输出、验证结果。",
    `3. 调用 \`${ALWAYS_ON_REPORT_TOOL_NAME}\` 恰好一次, 提交完整的工作报告 markdown。`,
    "",
    "报告章节按以下顺序排列: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes。",
    "缺失的章节将由运行时自动补全。",
  ].join("\n");
}

export function buildApplyPromptZh(input: BuildApplyPromptInput): string {
  const { plan, projectName, projectRoot, diff } = input;
  const isGitWorktree = plan.workspace?.strategy === "git-worktree";

  const header = [
    `Always-On 应用变更到项目 "${projectName}"。`,
    "",
    "你的任务是将隔离工作区中的变更合并到项目根目录。",
    "",
    "不要进入计划模式。",
    "不要创建新计划——直接应用现有变更。",
    "",
    `计划: "${plan.title}" (${plan.id})`,
    `项目根目录: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    header.push(`隔离工作区: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  header.push("");

  if (isGitWorktree) {
    header.push(
      "## 应用策略",
      "",
      "工作区是 **git worktree**。使用 git 高效应用变更:",
      "",
      "1. 在工作区中暂存所有变更: `git -C <workspace> add -A`",
      "2. 生成二进制安全的补丁: `git -C <workspace> diff --cached HEAD --binary`",
      "3. 通过三方合并将补丁应用到项目根目录: 将补丁管道传入 `git -C <project_root> apply --3way`",
      "",
      "如果 `git apply --3way` 成功 (退出码 0), 则应用完成。",
      "",
      "如果 `git apply` 失败 (如 --3way 无法自动解决的冲突),",
      "则回退为使用 Edit 或 Write 工具逐文件手动应用。",
      "手动合并时, 如果项目根目录的文件已发生变化, 需智能合并双方的更改——不要盲目覆盖。",
      "如果无法解决冲突, 保留标准冲突标记 (<<<< / ==== / >>>>)。",
      "",
    );
  } else {
    header.push(
      "## 应用策略",
      "",
      "工作区是 **snapshot copy** (非 git worktree)。",
      "使用 Edit 或 Write 工具逐项仔细应用变更。",
      "如果项目根目录中的文件在计划执行后已被修改,",
      "需智能合并双方的更改——不要盲目覆盖。",
      "如果无法解决冲突, 保留标准冲突标记 (<<<< / ==== / >>>>)。",
      "",
    );
  }

  if (!diff.diff.trim()) {
    header.push("工作区未检测到差异。无需应用任何变更。");
    return header.join("\n");
  }

  if (diff.truncated) {
    header.push(
      `差异较大 (${diff.fileCount} 个文件), 已截断。`,
      "请从工作区目录读取相关文件进行对比和应用。",
      "",
      "截断后的差异 (前部内容):",
      "",
      diff.diff,
    );
  } else {
    header.push(
      `变更内容 (${diff.fileCount} 个文件):`,
      "",
      diff.diff,
    );
  }

  return header.join("\n");
}
