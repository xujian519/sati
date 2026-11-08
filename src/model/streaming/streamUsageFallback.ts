/**
 * 流式 usage 计量的端点兼容降级（#847）。
 *
 * 背景：OpenAI 协议下**流式响应默认不返回 usage**，除非显式请求
 * `stream_options.include_usage`。Sati 的流式请求带上该字段后，provider 侧
 * 才能回报 token 计量——否则「调用成本」类结论无据。
 *
 * 但并非所有 OpenAI 兼容端点都认这个字段：不认的会回 400
 * （"Unknown parameter: stream_options" 之类）。本模块负责在这类端点上
 * **降级重试**一次（去掉该字段重发）——宁可不计量 token，也不能让请求整体失败。
 *
 * 降级判据刻意收紧：
 * - 仅流式请求才可能带该字段（构造侧保证，见 openai/request.ts）；
 * - 错误体须**明确点名** `stream_options` 才降级——否则 400 是真实参数错误，
 *   重试只会掩盖问题，且第二次请求同样会失败。
 */
import type { ProviderConfig } from "../protocol/canonical.js";

/** 请求体是否带有 `stream_options`（流式 usage 计量开关）。 */
export function hasStreamUsageOption(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const options = (body as Record<string, unknown>).stream_options;
  return typeof options === "object" && options !== null && !Array.isArray(options);
}

/** 去掉 `stream_options`（降级重试用；不改动原对象）。 */
export function stripStreamUsageOption(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { stream_options: _ignored, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * 400 错误体是否明确指向 `stream_options`（降级重试的判据）。
 *
 * 只有错误信息点名该字段才降级——否则 400 是真实参数错误。
 */
export async function mentionsStreamUsageOption(response: Response): Promise<boolean> {
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    // 响应体不可读（已消费/流已关闭）→ 不降级，按原始错误上抛。
    return false;
  }
  if (text.length === 0) return false;
  return /stream[_-]?options/i.test(text);
}

/**
 * 端点不认 `stream_options` 时的降级重试。
 *
 * 触发条件（全部满足才降级）：
 * - 流式请求（非流式不下发该字段）；
 * - 首次响应为 400；
 * - 请求体带 `stream_options`，且 provider 的 `extraBody` 未覆盖它
 *   （`extraBody` 是用户显式配置，不应被静默剥掉）；
 * - 错误体明确点名 `stream_options`。
 *
 * 降级后端点仍报错 → 保留首次响应（其错误体更贴近真实原因）。
 *
 * @param resend - 去掉 `stream_options` 后的重发动作（由调用方注入，携带端点回退逻辑）。
 */
export async function retryWithoutStreamUsageOption(
  provider: ProviderConfig,
  stream: boolean,
  fetchOptions: RequestInit,
  response: Response,
  resend: (fetchOptions: RequestInit) => Promise<Response>,
): Promise<Response> {
  if (!stream || response.status !== 400) return response;
  const body = parseBody(fetchOptions.body);
  if (!hasStreamUsageOption(body) || hasStreamUsageOption(provider.extraBody)) return response;
  if (!(await mentionsStreamUsageOption(response))) return response;

  const degraded = await resend({ ...fetchOptions, body: JSON.stringify(stripStreamUsageOption(body)) });
  return !degraded.ok && degraded.status === response.status ? response : degraded;
}

/** 解析请求体（JSON）；解析失败返回 undefined（不做降级）。 */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // 请求体非 JSON → 不降级（无从判断是否带 `stream_options`），按原响应上抛。
    return undefined;
  }
}
