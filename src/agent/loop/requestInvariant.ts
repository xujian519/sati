/**
 * 请求重建 invariant（阶段四 T2）。
 *
 * 每次 LLM 请求发送前，AgentLoop 依据路由决策与请求内容生成 request_header
 * 快照（provider/model/输出上限/system 与工具摘要）落 transcript（log-only）。
 * 对拍器用「快照 + 当前请求 + 决策」重建期望值并逐字段比对：正常回路零误报、
 * 篡改（如路由后 maxOutputTokens 被改）必报。与 dsh 的 request-reconstruction
 * invariant 对应——Sati 的请求由决策唯一决定，重建比对即「模型可见 = 已记录」
 * 的请求侧验证。
 */
import { createHash } from "node:crypto";
import type { CanonicalModelRequest } from "../../model/index.js";
import type { RouterDecision } from "../../router/index.js";
import type { AgentRequestHeaderSnapshot, AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";

/** 对拍失败：快照与重建期望值存在字段级分歧。 */
export class RequestReconstructionInvariantError extends Error {
  /** 分歧字段名（稳定、可路由）。 */
  readonly mismatchedFields: string[];

  constructor(mismatchedFields: string[], message: string) {
    super(message);
    this.name = "RequestReconstructionInvariantError";
    this.mismatchedFields = mismatchedFields;
  }
}

/**
 * 摘要函数：raw 键剥离后的稳定 sha256。与重放 seam 的 stableSerialize 语义一致
 * （undefined 跳过、raw 丢弃），使同一请求在录制/重放/对拍三处产出同摘要。
 *
 * @param value - 参与摘要的值（JSON 安全，raw 会被剥离）。
 * @returns sha256 hex。
 */
export function digestForReplay(value: unknown): string {
  const serialized =
    JSON.stringify(value, (_key, item) => {
      if (_key === "raw") return undefined;
      if (item === undefined) return undefined;
      return item;
    }) ?? "null";
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * 从请求与路由决策生成发送前请求头快照。
 *
 * provider/model 取自决策（实际路由目标，含 fallback 语义之外的 loop 层选择），
 * 其余字段取请求本身。
 *
 * @param request - 发送给 router 的请求。
 * @param decision - 已解析的路由决策。
 * @returns 可落 transcript 的快照。
 */
export function buildRequestHeaderSnapshot(
  request: CanonicalModelRequest,
  decision: RouterDecision,
): AgentRequestHeaderSnapshot {
  return {
    provider: decision.provider,
    model: decision.model,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    systemPromptDigest: digestForReplay(request.systemPrompt ?? null),
    toolSchemaDigest: digestForReplay(
      request.tools?.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })) ?? null,
    ),
    messageCount: request.messages.length,
  };
}

/**
 * 对拍：快照与「当前请求 + 决策」的重建期望值逐字段比对。
 *
 * @param snapshot - 已持久化（或即将持久化）的快照。
 * @param request - 当前请求。
 * @param decision - 当前路由决策。
 */
export function verifyRequestHeaderSnapshot(
  snapshot: AgentRequestHeaderSnapshot,
  request: CanonicalModelRequest,
  decision: RouterDecision,
): void {
  const expected = buildRequestHeaderSnapshot(request, decision);
  const fields = [
    "provider",
    "model",
    "maxOutputTokens",
    "systemPromptDigest",
    "toolSchemaDigest",
    "messageCount",
  ] as const;
  const mismatched: string[] = [];
  for (const field of fields) {
    if (snapshot[field] !== expected[field]) {
      mismatched.push(field);
    }
  }
  if (mismatched.length > 0) {
    throw new RequestReconstructionInvariantError(
      mismatched,
      "request header snapshot diverges from the reconstructed request (" + mismatched.join(", ") + ")",
    );
  }
}

/**
 * 从 transcript 条目独立重建并验证最近一次请求头快照。
 *
 * @param entries - 会话 transcript 条目（含 request_header 参考条目）。
 * @param request - 对拍的目标请求。
 * @param decision - 对拍的目标路由决策。
 * @returns 验证通过的快照。
 */
export function verifyRequestReconstruction(
  entries: readonly AgentTranscriptEntry[],
  request: CanonicalModelRequest,
  decision: RouterDecision,
): AgentRequestHeaderSnapshot {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type === "request_header") {
      verifyRequestHeaderSnapshot(entry.header, request, decision);
      return entry.header;
    }
  }
  throw new RequestReconstructionInvariantError(
    [],
    "no request_header entry found in the transcript to reconstruct from",
  );
}
