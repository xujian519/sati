import { authenticatedFetch } from "../../../utils/api";
import { logError } from "../../../utils/logging";
import { safeLocalStorage } from "../utils/chatStorage";
import type { Project } from "../../../types/app";
import type { SlashCommand } from "./useSlashCommands";

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

export const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    logError("Error parsing command history:", error);
    return {};
  }
};

export const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

/**
 * 拉取项目的斜杠命令清单并排序：置顶命令按服务端给定顺序，其余按本地使用次数降序。
 *
 * 从 `useSlashCommands` 的加载 effect 整体搬出（#646 B2.4），请求/映射/排序逐字未改；
 * hook 只保留 `selectedProject` 为空时的清空分支与错误兜底。
 */
export async function loadSlashCommands(project: Project): Promise<SlashCommand[]> {
  const response = await authenticatedFetch("/api/commands/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectPath: project.path,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch commands");
  }

  const data = await response.json();
  const allCommands: SlashCommand[] = [
    ...((data.builtIn || []) as SlashCommand[]).map(command => ({
      ...command,
      type: "built-in",
    })),
    ...((data.custom || []) as SlashCommand[]).map(command => ({
      ...command,
      type: "custom",
    })),
  ];

  // Pinned commands always come first in fixed server-defined order;
  // backend returns them as `data.pinned` for that exact ordering.
  // Other commands fall back to usage-history sort.
  const pinnedOrderIndex = new Map<string, number>();
  ((data.pinned || []) as SlashCommand[]).forEach((command, index) => {
    pinnedOrderIndex.set(command.name, index);
  });

  const parsedHistory = readCommandHistory(project.name);
  const sortedCommands = [...allCommands].sort((commandA, commandB) => {
    const aPinnedIdx = pinnedOrderIndex.has(commandA.name) ? (pinnedOrderIndex.get(commandA.name) as number) : -1;
    const bPinnedIdx = pinnedOrderIndex.has(commandB.name) ? (pinnedOrderIndex.get(commandB.name) as number) : -1;
    if (aPinnedIdx !== -1 || bPinnedIdx !== -1) {
      if (aPinnedIdx === -1) return 1;
      if (bPinnedIdx === -1) return -1;
      return aPinnedIdx - bPinnedIdx;
    }
    const commandAUsage = parsedHistory[commandA.name] || 0;
    const commandBUsage = parsedHistory[commandB.name] || 0;
    return commandBUsage - commandAUsage;
  });

  return sortedCommands;
}
