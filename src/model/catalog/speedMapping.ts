import type { ModelSpeed } from "../protocol/capabilities.js";

/**
 * 模型速度档推断（2026-09，对齐 PilotDeck desktop-v2026.09.02 #524 的
 * speedMapping 思路）。
 *
 * speed 是静态 catalog 维度（按各厂商官方定位分档，不做 tokens/s 实测），
 * 用于路由/UI 的场景选择参考。65 个内置模型不逐条标注：命名规则覆盖
 * 绝大多数（mini/flash/turbo/haiku/lite → fast；max/pro/opus/o 系推理 →
 * deep），不规则命名的模型经 `CatalogModelEntry.speed` 显式覆盖。
 */

/** deep 优先于 fast：o3-mini 这类"推理+mini"按推理定位归 deep；max/mini 需排除 MiniMax 品牌名两段。 */
const DEEP_SPEED_RE = /(^o\d|^o\d-|(?<!mini)max|pro($|[-.\d])|opus|reasoning|reasoner|thinking|-r\d($|-)|ultra)/i;

const FAST_SPEED_RE = /(mini(?!max)|flash|lite|turbo|haiku|highspeed|-air|flashx|instant|nano)/i;

/** 按模型 id 推断速度档；catalog 条目的显式 speed 优先。 */
export function inferModelSpeed(modelId: string, entrySpeed?: ModelSpeed): ModelSpeed {
  if (entrySpeed) return entrySpeed;
  const id = modelId.trim();
  if (!id) return "balanced";
  if (DEEP_SPEED_RE.test(id)) return "deep";
  if (FAST_SPEED_RE.test(id)) return "fast";
  return "balanced";
}
