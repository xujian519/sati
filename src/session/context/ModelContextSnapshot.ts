import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CanonicalMessage, CanonicalModelRequest, CanonicalToolSchema } from "../../model/index.js";

/**
 * 模型上下文只读快照（sidecar）。
 *
 * 目的：让用户看到模型**实际收到**的 system prompt / tools / messages。
 * 快照不进入 transcript、不参与重放、不广播到流式连接；只在显式请求时读取。
 *
 * 安全边界：
 * - 路径由 transcript 路径派生，固定后缀 `.context.json`；
 * - 写入 0600、原子 rename；
 * - 读取拒绝符号链接与非普通文件，并校验 JSON 形状；
 * - 媒体块（image/pdf/audio）的 `data` 一律替换为占位符；
 * - tool_result 的 `raw` 字段剥离（它可能内含完整媒体与未脱敏数据）。
 */
export type ModelContextSnapshot = {
  version: 1;
  turnId: string;
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt: string;
  tools: Array<Pick<CanonicalToolSchema, "name" | "description" | "inputSchema">>;
  messages: CanonicalMessage[];
  breakdown: ModelContextBreakdown;
  mediaOmitted: boolean;
};

export type ModelContextBreakdown = {
  systemPromptChars: number;
  toolsChars: number;
  messagesChars: number;
};

export type ModelContextSummary = Omit<ModelContextSnapshot, "systemPrompt" | "tools" | "messages">;

const SNAPSHOT_SUFFIX = ".context.json";

export function modelContextSnapshotPath(transcriptPath: string): string {
  return `${resolve(transcriptPath)}${SNAPSHOT_SUFFIX}`;
}

export function createModelContextSnapshot(
  request: CanonicalModelRequest,
  turnId: string,
  capturedAt: Date = new Date(),
): ModelContextSnapshot {
  let mediaOmitted = false;
  const messages = cloneJson(request.messages).map(message => {
    const content = message.content.map(block => {
      if (block.type === "image" || block.type === "pdf" || block.type === "audio") {
        mediaOmitted = true;
        const { data: _data, ...rest } = block;
        return { ...rest, data: "[media payload omitted]" };
      }
      if (block.type === "tool_result") {
        const { raw: _raw, ...rest } = block;
        return rest;
      }
      return block;
    });
    return { ...message, content };
  });

  const tools = (request.tools ?? []).map(tool => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: cloneJson(tool.inputSchema),
  }));

  return {
    version: 1,
    turnId,
    capturedAt: capturedAt.toISOString(),
    provider: request.provider,
    model: request.model,
    systemPrompt: request.systemPrompt ?? "",
    tools,
    messages,
    breakdown: {
      systemPromptChars: (request.systemPrompt ?? "").length,
      toolsChars: JSON.stringify(tools).length,
      messagesChars: JSON.stringify(messages).length,
    },
    mediaOmitted,
  };
}

export function summarizeModelContext(snapshot: ModelContextSnapshot): ModelContextSummary {
  const { systemPrompt: _systemPrompt, tools: _tools, messages: _messages, ...summary } = snapshot;
  return summary;
}

export async function writeModelContextSnapshot(transcriptPath: string, snapshot: ModelContextSnapshot): Promise<void> {
  if (!transcriptPath) {
    return;
  }
  const target = modelContextSnapshotPath(transcriptPath);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function readModelContextSnapshot(transcriptPath: string): Promise<ModelContextSnapshot | null> {
  if (!transcriptPath) {
    return null;
  }
  const target = modelContextSnapshotPath(transcriptPath);
  try {
    const stats = await lstat(target);
    // 符号链接可能指向 transcript 目录之外；快照只接受普通文件。
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return null;
    }
    const [dirReal, targetDirReal] = await Promise.all([
      realpath(dirname(resolve(transcriptPath))),
      realpath(dirname(target)),
    ]);
    if (dirReal !== targetDirReal) {
      return null;
    }
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    return parseSnapshot(parsed);
  } catch {
    // 缺失/坏 JSON/不可读都按「不可用」处理，由调用方给出空状态。
    return null;
  }
}

function parseSnapshot(value: unknown): ModelContextSnapshot | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  if (
    typeof value.turnId !== "string" ||
    typeof value.capturedAt !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.systemPrompt !== "string" ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.messages) ||
    typeof value.mediaOmitted !== "boolean"
  ) {
    return null;
  }
  const breakdown = isRecord(value.breakdown) ? value.breakdown : undefined;
  return {
    version: 1,
    turnId: value.turnId,
    capturedAt: value.capturedAt,
    provider: value.provider,
    model: value.model,
    systemPrompt: value.systemPrompt,
    tools: value.tools as ModelContextSnapshot["tools"],
    messages: value.messages as CanonicalMessage[],
    breakdown: {
      systemPromptChars: readNumber(breakdown?.systemPromptChars),
      toolsChars: readNumber(breakdown?.toolsChars),
      messagesChars: readNumber(breakdown?.messagesChars),
    },
    mediaOmitted: value.mediaOmitted,
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
