import path from "node:path";
import { realpathSync } from "node:fs";
import { resolveRealWritePath } from "../../tool/builtin/filesystem/pathSafety.js";
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
    // allow 规则授权的是「工作区内」这个范围：若路径经符号链接落到工作区外，
    // 词法命中不等于授权成立。
    return isFileInputInsideWorkspace(input, context, rule.behavior === "allow");
  }

  if (!rule.pattern) return true;
  if (!matchRulePattern(rule, toolName, input, context)) return false;

  // 带 pattern 的 allow 规则同样要过真实落点：pattern 常取自**词法**路径（如
  // writePermissions 的 buildRecursiveFileWriteRule 铸造的会话授予），工作区内的一个
  // 软链就能借它放行越界写入。deny/ask 不参与（命中即生效，否则显式规则会被逃逸路径
  // 绕过）；词法本就在 root 外的授予（用户显式批准的外部目录）不受此约束——见
  // docs/notes/implemented/2026-10-10-write-path-symlink-escape.md。
  if (rule.behavior === "allow" && FILE_WRITE_TOOLS.has(toolName)) {
    if (!rule.pattern.startsWith(TEXT_PATTERN_PREFIX)) {
      return isRealLandingInsideRoots(input, context);
    }
    // `text:` 规则只声明「内容」不声明「位置」，因此它没有可授予的越界落点：输入带路径
    // 时要求词法与真实落点都在工作区内（否则它就是越界写入的通行证）；输入不带路径时
    // 没有位置可授权，维持纯内容匹配（写工具随后会以缺 file_path 拒绝该调用）。
    return resolveInputFilePath(input, context) === undefined ? true : isFileInputInsideWorkspace(input, context, true);
  }

  return true;
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
  collectStringValues(input, values, new Set<object>());
  return values.join(" ");
}

function collectStringValues(value: unknown, out: string[], seen: Set<object>): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return; // 循环引用防护（含数组自引用）
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collectStringValues(item, out, seen);
      return;
    }
    for (const item of Object.values(value)) collectStringValues(item, out, seen);
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

function isFileInputInsideWorkspace(
  input: unknown,
  context: PermissionContext | undefined,
  resolveSymlinks: boolean,
): boolean {
  const filePath = resolveInputFilePath(input, context);
  if (!filePath || !context) return false;
  const roots = [context.cwd, ...context.additionalWorkingDirectories].map(root => path.resolve(root));
  if (!roots.some(root => isPathWithinRoot(filePath, root))) return false;
  if (!resolveSymlinks) return true;
  // 工作区内的软链仍可把写入引到别处。
  const realFilePath = resolveRealWritePath(filePath);
  if (!realFilePath) return false;
  return roots.map(safeRealpath).some(root => isPathWithinRoot(realFilePath, root));
}

function safeRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    // 不存在/断链 → 按未解析路径处理（与 pathSafety 的宽松侧一致）。
    return value;
  }
}

/**
 * 写目标**词法**落在某个 root 内时，其真实落点也必须在某个 root 内。词法本就在
 * root 外的位置（用户显式批准的外部目录）不由这条判定——那里的授权范围是调用方给的
 * 绝对路径、不是「工作区」，一并收紧只会让会话授予失效、退化成反复弹窗。
 */
function isRealLandingInsideRoots(input: unknown, context: PermissionContext | undefined): boolean {
  const filePath = resolveInputFilePath(input, context);
  if (!filePath || !context) return false;
  const roots = [context.cwd, ...context.additionalWorkingDirectories].map(root => path.resolve(root));
  if (!roots.some(root => isPathWithinRoot(filePath, root))) return true;
  const realFilePath = resolveRealWritePath(filePath);
  if (!realFilePath) return false;
  // 根侧用同一逐组件解析：根不存在（用假 cwd 的用例）或根本身是软链时，两侧才可比。
  return roots.some(root => isPathWithinRoot(realFilePath, resolveRealWritePath(root) ?? safeRealpath(root)));
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
