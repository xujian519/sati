/**
 * 请求重建 invariant（阶段四 T2；派发点对拍为 2026-09-16 修复，issue #360）。
 *
 * 每次 LLM 请求发送前，AgentLoop 依据路由决策与请求内容生成 request_header
 * 快照（provider/model/输出上限/system 与工具摘要）落 transcript（log-only）。
 * 快照记录的是 **loop 装配态**：路由决策级改写（夹取输出上限、剥离子代理标记）
 * 与逐 attempt 降级发生在其后，故快照与「实际上网形态」本可不同。
 *
 * 对拍分两处，职责不同：
 * - `verifyRequestHeaderSnapshot` / `verifyRequestReconstruction` 是**比较器**：
 *   期望值由调用方给定的 `(request, decision)` 派生。测试与离线审计使用。
 * - `verifyDispatchedRequest` 是**生产判据**：在 router 的派发点（首字节之前）
 *   拿到实际请求，要求它与落盘快照的差异**只落在本次派发的改写标签声明的字段**
 *   内，否则 fail-loud。两侧由不同入参派生，故该判据不是恒真——未声明的改写
 *   （例如某天 router 里多出一处静默的工具集过滤）会在此暴露。
 *
 * ⚠️ 历史教训（#360）：修复前生产路径用 `(request, decision)` 既生成快照又做比对，
 * 被调函数只读入参，比对恒等 ⇒ 除 `onRequestHeader` await 窗口内的入参原地改写
 * 外永不触发，给出的是**虚假保证**。原注释所称「篡改（如路由后 maxOutputTokens
 * 被改）必报」在旧实现下不成立；现已由派发点对拍兑现。
 */
import { createHash } from "node:crypto";
import type { CanonicalModelRequest } from "../../model/index.js";
import type { RouterDecision, RouterDispatchReport, RouterTransformTag } from "../../router/index.js";
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
 * 注意它只是**比较器**：期望值在此由传入的 `(request, decision)` 派生，因此
 * 在调用方用同一对入参既生成快照又调用本函数时，比对必然相等（恒真）。生产
 * 路径不得这样用——生产用 `verifyDispatchedRequest`（派发点、两侧不同源）。
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
 * 与 `verifyRequestHeaderSnapshot` 同源：期望值仍由传入的 `(request, decision)`
 * 派生，故对「落盘快照 ≠ 实际发送请求」这类漂移**不具备**检测能力（它多出来的
 * 只是「落盘-读回」的序列化保真）。issue #360 曾把生产路径改用它，经核码否决：
 * 两侧依旧同源，恒真问题不变；生产改用 `verifyDispatchedRequest`。
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

/** 快照参与比对的字段名（取自 `AgentRequestHeaderSnapshot` 的键）。 */
export type RequestHeaderField = keyof AgentRequestHeaderSnapshot;

/** 字段的稳定顺序：错误信息与断言里的字段序以此为准。 */
const REQUEST_HEADER_FIELDS = [
  "provider",
  "model",
  "maxOutputTokens",
  "systemPromptDigest",
  "toolSchemaDigest",
  "messageCount",
] as const satisfies readonly RequestHeaderField[];

/**
 * 改写标签 → 该改写**获准**改掉的快照字段。
 *
 * `Record<RouterTransformTag, …>` 的穷尽性由类型系统强制：新增一个标签却忘记在
 * 此登记字段会直接编译失败——「改写必须声明」这条契约不靠注释承重。
 */
const ALLOWED_FIELDS_BY_TRANSFORM: Record<RouterTransformTag, readonly RequestHeaderField[]> = {
  fallbackAttempt: ["provider", "model"],
  mediaDowngraded: ["messageCount"],
  subagentTagStripped: ["messageCount"],
  maxOutputTokensClamped: ["maxOutputTokens"],
  "requestPatch:messages": ["messageCount"],
  "requestPatch:tools": ["toolSchemaDigest"],
  "requestPatch:systemPrompt": ["systemPromptDigest"],
};

/**
 * 两份快照的字段级差异（按 {@link REQUEST_HEADER_FIELDS} 的稳定顺序）。
 *
 * @param left - 一侧快照。
 * @param right - 另一侧快照。
 * @returns 取值不等的字段名，保序。
 */
export function diffRequestHeaderSnapshots(
  left: AgentRequestHeaderSnapshot,
  right: AgentRequestHeaderSnapshot,
): RequestHeaderField[] {
  return REQUEST_HEADER_FIELDS.filter(field => left[field] !== right[field]);
}

/** `verifyDispatchedRequest` 的观测结果（通过时返回，供调用方断言与记录）。 */
export type DispatchVerification = {
  /** 落盘快照与派发实况的**全部**差异字段。 */
  diverged: RequestHeaderField[];
  /** 其中已被本次派发的改写标签声明过的字段。 */
  declared: RequestHeaderField[];
};

/**
 * 生产判据：落盘快照 vs 派发实况（两侧**不同源**，故不是恒真比对）。
 *
 * 派发侧由 `buildRequestHeaderSnapshot(report.request, report.decision)` 现算——
 * 请求来自 router 在首字节前一刻的实际派发对象，决策来自该 attempt 的有效决策；
 * 落盘侧由 AgentLoop 在发送前装配态下算得。要求：实测差异 ⊆ 本次派发的改写标签
 * 所声明的字段集。未声明的差异即「有改写没声明」——正是旧实现永远发现不了的那类
 * （见模块头注释 #360 的教训）。
 *
 * @param args.persisted - AgentLoop 发送前落盘的请求头快照。
 * @param args.report - router 在派发点给出的实况报告。
 * @returns 观测到的差异与其中已声明的部分。
 * @throws {RequestReconstructionInvariantError} 存在未声明的差异字段时。
 */
export function verifyDispatchedRequest(args: {
  persisted: AgentRequestHeaderSnapshot;
  report: RouterDispatchReport;
}): DispatchVerification {
  const dispatched = buildRequestHeaderSnapshot(args.report.request, args.report.decision);
  const diverged = diffRequestHeaderSnapshots(args.persisted, dispatched);
  const allowed = new Set<RequestHeaderField>(args.report.transforms.flatMap(tag => ALLOWED_FIELDS_BY_TRANSFORM[tag]));
  const declared = diverged.filter(field => allowed.has(field));
  const undeclared = diverged.filter(field => !allowed.has(field));
  if (undeclared.length > 0) {
    const transforms = args.report.transforms.length === 0 ? "none" : args.report.transforms.join(", ");
    throw new RequestReconstructionInvariantError(
      undeclared,
      "dispatched request diverges from the persisted request_header in undeclared field(s): " +
        `${undeclared.join(", ")} (declared transforms: ${transforms})`,
    );
  }
  return { diverged, declared };
}
