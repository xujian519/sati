import { createServer, type Server, type Socket } from "node:net";
import type { SatiToolRuntimeContext } from "../protocol/types.js";
import { contentToText, type SatiToolResult } from "../protocol/result.js";
import { createLogger } from "../../telemetry/index.js";
import type { ExecuteCodeToolCallLogEntry } from "./executeCode.js";

const logger = createLogger("execute_code");

/**
 * execute_code 允许的 Sati 工具白名单（工具主体与 RPC 层共用）。
 * 解析逻辑收敛于此，避免"允许列表"与"可用 helper 列表"漂移。
 * web_fetch 与 web_search 同受 webSearch 开关控制（禁用时 execute_code
 * 不得绕过全局 web 禁令联网）。
 */
export const EXECUTE_CODE_BASE_ALLOWED_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "bash",
] as const;

export function resolveExecuteCodeAllowedTools(options: { webSearch?: boolean }): ReadonlySet<string> {
  const allowed = new Set<string>(EXECUTE_CODE_BASE_ALLOWED_TOOLS);
  if (options.webSearch !== false) {
    allowed.add("web_search");
    allowed.add("web_fetch");
  }
  return allowed;
}

type RpcRequest = {
  token?: unknown;
  tool?: unknown;
  args?: unknown;
};

export type RpcResponse = {
  content?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
  code?: string;
};

export async function handleExecuteCodeRpcLineForTests(
  line: string,
  options: {
    expectedToken?: string;
    executeTool?: NonNullable<SatiToolRuntimeContext["executeTool"]>;
    webSearch?: boolean;
  } = {},
): Promise<RpcResponse> {
  return handleRpcLine(line, {
    context: {
      sessionId: "test-session",
      turnId: "test-turn",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        rules: { allow: [], deny: [], ask: [] },
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
      },
    },
    executeTool:
      options.executeTool ??
      (async () => {
        throw new Error("executeTool should not be called by this test.");
      }),
    maxToolCalls: 50,
    toolCallLog: [],
    nextToolCall: () => 1,
    canCallTool: () => true,
    expectedToken: options.expectedToken,
    allowedTools: resolveExecuteCodeAllowedTools({ webSearch: options.webSearch }),
  });
}

export function createRpcServer(options: {
  context: SatiToolRuntimeContext;
  executeTool: NonNullable<SatiToolRuntimeContext["executeTool"]>;
  maxToolCalls: number;
  toolCallLog: ExecuteCodeToolCallLogEntry[];
  nextToolCall: () => number;
  canCallTool: () => boolean;
  expectedToken?: string;
  allowedTools: ReadonlySet<string>;
}): Server {
  return createServer(socket => {
    let buffer = "";
    // 串行化请求处理：data 事件可能交错到达，promise 链保证响应顺序与
    // 共享 buffer 的消费互不干扰（同一时刻在途请求仍只有一个）。
    let queue: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("error", error => {
      logger.error(`RPC socket error: ${error.message}`);
    });
    const takeLines = (): string[] => {
      const lines: string[] = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        lines.push(line);
        index = buffer.indexOf("\n");
      }
      return lines;
    };
    socket.on("data", chunk => {
      buffer += chunk;
      queue = queue
        .then(() => processBufferedRequests(socket, takeLines, options))
        .catch(error => {
          // 兜底：处理链异常不应成为 unhandled rejection，也不应中断后续请求
          logger.error(`RPC processing failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
  });
}

async function processBufferedRequests(
  socket: Socket,
  takeLines: () => string[],
  options: {
    context: SatiToolRuntimeContext;
    executeTool: NonNullable<SatiToolRuntimeContext["executeTool"]>;
    maxToolCalls: number;
    toolCallLog: ExecuteCodeToolCallLogEntry[];
    nextToolCall: () => number;
    canCallTool: () => boolean;
    expectedToken?: string;
    allowedTools: ReadonlySet<string>;
  },
): Promise<void> {
  for (const rawLine of takeLines()) {
    const line = rawLine.trim();
    if (!line) continue;
    let response: RpcResponse;
    try {
      response = await handleRpcLine(line, options);
    } catch (error) {
      // 兜底：任何非预期异常都必须写回响应，否则 Python 端 recv 会一直
      // 阻塞到 300s 超时，子进程挂起。
      response = {
        error: `Unexpected RPC failure: ${error instanceof Error ? error.message : String(error)}`,
        code: "rpc_internal_error",
      };
    }
    try {
      await writeRpcResponse(socket, response);
    } catch {
      // socket 已断开（Python 端退出）：剩余请求已无接收方，停止处理。
      return;
    }
  }
}

/**
 * 写一行 RPC 响应并处理背压：`socket.write` 返回 false 表示内核缓冲区已满，
 * 需等待 `drain` 事件后再继续，否则大响应会无限堆积内存。
 */
function writeRpcResponse(socket: Socket, response: RpcResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = `${JSON.stringify(response)}\n`;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const ok = socket.write(payload, error => finish(error ?? undefined));
    if (!ok) {
      socket.once("drain", () => finish());
    }
  });
}

async function handleRpcLine(
  line: string,
  options: {
    context: SatiToolRuntimeContext;
    executeTool: NonNullable<SatiToolRuntimeContext["executeTool"]>;
    maxToolCalls: number;
    toolCallLog: ExecuteCodeToolCallLogEntry[];
    nextToolCall: () => number;
    canCallTool: () => boolean;
    expectedToken?: string;
    allowedTools: ReadonlySet<string>;
  },
): Promise<RpcResponse> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch (error) {
    return {
      error: `Invalid RPC request: ${error instanceof Error ? error.message : String(error)}`,
      code: "invalid_rpc",
    };
  }

  const toolName = typeof request.tool === "string" ? request.tool : "";
  const args = isRecord(request.args) ? request.args : {};
  if (options.expectedToken && request.token !== options.expectedToken) {
    return { error: "Invalid execute_code RPC token.", code: "invalid_rpc_token" };
  }
  if (!options.allowedTools.has(toolName)) {
    return { error: `Tool '${toolName}' is not available in execute_code.`, code: "tool_not_allowed" };
  }
  if (!options.canCallTool()) {
    return {
      error: `Tool call limit reached (${options.maxToolCalls}). No more tool calls allowed in this execution.`,
      code: "tool_call_limit_reached",
    };
  }

  const sequence = options.nextToolCall();
  const started = Date.now();
  const outerId = options.context.currentToolCallId ?? "execute_code";
  let result: SatiToolResult;
  try {
    result = await options.executeTool(
      { id: `${outerId}:code:${sequence}`, name: toolName, input: args },
      { currentToolCallId: `${outerId}:code:${sequence}` },
    );
  } catch (error) {
    // 嵌套工具执行意外抛异常（正常路径应返回 error result）：仍要写回响应，
    // 否则 Python 端 recv 永久阻塞、子进程挂起至超时。
    options.toolCallLog.push({ tool: toolName, duration_ms: Date.now() - started, ok: false });
    return {
      error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      code: "rpc_internal_error",
    };
  }
  const ok = result.type === "success";
  options.toolCallLog.push({ tool: toolName, duration_ms: Date.now() - started, ok });
  return toolResultToRpcResponse(result);
}

function toolResultToRpcResponse(result: SatiToolResult): RpcResponse {
  const content = result.content.map(contentToText).join("\n");
  if (result.type === "error") {
    const details = formatToolErrorDetails(result);
    return {
      error: details ? `${result.error.message}\n${details}` : result.error.message,
      code: result.error.code,
      content,
      metadata: result.metadata,
    };
  }
  return {
    content,
    data: result.data,
    metadata: result.metadata,
  };
}

function formatToolErrorDetails(result: Extract<SatiToolResult, { type: "error" }>): string | undefined {
  const issues = result.error.details?.issues;
  if (!Array.isArray(issues)) return undefined;
  const messages = issues
    .map(issue => (isRecord(issue) && typeof issue.message === "string" ? issue.message : undefined))
    .filter((message): message is string => !!message);
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
