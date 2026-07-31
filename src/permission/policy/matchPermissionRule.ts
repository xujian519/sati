import path from "node:path";
import type { PermissionContext, PermissionRule } from "../protocol/types.js";

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_PATH_PATTERN_TOOLS = new Set(["read_file", "send_attachment", "write_file", "edit_file"]);

/**
 * `text:` 前缀约定（宪法规则 policy-bridge 使用）：pattern 视为关键词 OR 组，
 * 对工具输入序列化文本做包含匹配（无视工具类型）。保持原有 bash/文件路径
 * pattern 语义不变。
 */
const TEXT_PATTERN_PREFIX = "text:";

export function matchPermissionRule(
  rule: PermissionRule,
  toolName: string,
  input?: unknown,
  context?: PermissionContext,
): boolean {
  if (!matchesToolName(rule.toolName, toolName)) {
    return false;
  }

  if (FILE_WRITE_TOOLS.has(toolName) && !rule.pattern) {
    return isFileInputInsideWorkspace(input, context);
  }

  return rule.pattern ? matchRulePattern(rule, toolName, input, context) : true;
}

function matchesToolName(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true;
  return ruleToolName.includes("*") && wildcardToRegExp(ruleToolName).test(toolName);
}

function matchRulePattern(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
  context: PermissionContext | undefined,
): boolean {
  if (!rule.pattern) return true;
  if (rule.pattern.startsWith(TEXT_PATTERN_PREFIX)) {
    return matchTextPattern(rule.pattern.slice(TEXT_PATTERN_PREFIX.length), input);
  }
  if (toolName === "bash") return matchBashPattern(rule.pattern, input);
  if (FILE_PATH_PATTERN_TOOLS.has(toolName)) return matchFilePathPattern(rule.pattern, input, context);
  return true;
}

/**
 * 文本包含匹配：序列化工具输入中**用户可控的字符串值**（不含 JSON key 名），
 * 双向 toLowerCase 归一后检查 `|` 分隔的关键词任一包含（大小写不敏感）。
 * 输入无字符串值时不匹配（不误伤无输入的工具）。
 */
function matchTextPattern(pattern: string, input: unknown): boolean {
  const serialized = serializeInput(input).toLowerCase();
  if (!serialized) return false;
  const keywords = pattern
    .split("|")
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
  return keywords.some(keyword => serialized.includes(keyword));
}

/** 递归收集对象/数组中的全部字符串值（不含 key），拼接为空格分隔文本。 */
function serializeInput(input: unknown): string {
  const values: string[] = [];
  collectStringValues(input, values);
  return values.join(" ");
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStringValues(item, out);
  }
}

function matchBashPattern(pattern: string, input: unknown): boolean {
  const command = readCommand(input);
  if (!command) return false;
  const normalizedPattern = pattern.replace(/:\*$/, "*");
  return wildcardToRegExp(normalizedPattern).test(command);
}

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" ? command.trim() : "";
  }
  return "";
}

function matchFilePathPattern(pattern: string, input: unknown, context: PermissionContext | undefined): boolean {
  const filePath = resolveInputFilePath(input, context);
  return filePath ? wildcardToRegExp(normalizePathForPattern(pattern)).test(normalizePathForPattern(filePath)) : false;
}

function isFileInputInsideWorkspace(input: unknown, context: PermissionContext | undefined): boolean {
  const filePath = resolveInputFilePath(input, context);
  if (!filePath || !context) return false;
  return [context.cwd, ...context.additionalWorkingDirectories]
    .map(root => path.resolve(root))
    .some(root => isPathWithinRoot(filePath, root));
}

function resolveInputFilePath(input: unknown, context: PermissionContext | undefined): string | undefined {
  const filePath = readFilePath(input);
  if (!filePath || filePath.includes("\0") || !context) return undefined;
  return path.resolve(path.isAbsolute(filePath) ? filePath : path.join(context.cwd, filePath));
}

function readFilePath(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as { file_path?: unknown; filePath?: unknown };
  const filePath = record.file_path ?? record.filePath;
  return typeof filePath === "string" ? filePath.trim() : "";
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePathForPattern(value: string): string {
  return value.replace(/\\/g, "/");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
