/**
 * 工具执行证据观测接口（通用层，无领域知识）。
 *
 * SatiEvidenceCollector 由 ToolRuntime 在每次工具执行后调用（成功/失败均记录），
 * 实现方（如专利域 EvidenceExtension）把它转成证据账本（Ledger）——
 * 证据闭环"自动收集"阶段的基础。设计对齐 Mady agentcore/evidence/receipt.go。
 */

export type SatiEvidenceReceipt = {
  /** 工具调用 id（与 SatiToolResult.toolCallId 对应） */
  toolCallId: string;
  turnId: string;
  toolName: string;
  /** 工具入参（原始） */
  args: unknown;
  success: boolean;
  startedAt: string;
  /** 涉及的文件路径（可定位证据来源；无则省略） */
  path?: string;
  /** 是否写操作（write_file/edit_file/bash 等）；false = 读/检索 */
  write: boolean;
  /** 工具结果文本摘录（供证据 snippet 复用） */
  resultText?: string;
};

export type SatiEvidenceCollector = {
  recordReceipt(receipt: SatiEvidenceReceipt): void;
};

const WRITE_TOOL_PREFIXES = [
  "write_",
  "edit_",
  "append_",
  "create_",
  "delete_",
  "move_",
  "copy_",
  "rename_",
  "mkdir_",
  "patch_",
];
const PATH_KEYS = ["path", "file_path", "file", "target_path", "destination", "output_path"];

function extractPath(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

function isWriteTool(toolName: string, args: Record<string, unknown>): boolean {
  if (WRITE_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix))) return true;
  // bash 等执行类工具：仅当带写入意图时标记（保守判定，避免误标检索）
  if (toolName === "bash" || toolName === "execute_code") {
    const cmd = args["command"] ?? args["code"] ?? "";
    if (typeof cmd === "string" && /(>|>>|tee|sed\s+-i|mv|cp|rm|mkdir|touch)/.test(cmd)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从工具执行上下文构造 Receipt（通用适配器，无领域知识）。
 * - path：从常见路径字段提取（可定位证据来源）
 * - write：按写工具白名单/写入意图判定
 * - resultText：结果摘录（截断至 2000 字符）
 */
export function receiptFromToolExecution(input: {
  toolCallId: string;
  turnId: string;
  toolName: string;
  args: unknown;
  success: boolean;
  startedAt: string;
  resultText?: string;
}): SatiEvidenceReceipt {
  const args = input.args ?? {};
  const record = isRecord(args) ? args : {};
  const path = extractPath(record);
  return {
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    toolName: input.toolName,
    args,
    success: input.success,
    startedAt: input.startedAt,
    ...(path !== undefined ? { path } : {}),
    write: isWriteTool(input.toolName, record),
    ...(input.resultText !== undefined && input.resultText.length > 0
      ? { resultText: input.resultText.slice(0, 2000) }
      : {}),
  };
}
