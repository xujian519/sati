/**
 * run 级规则包快照：给每条 run 记录回答「这一轮用的是哪版规则包」。
 *
 * 与 `rule_check(scope:"pack")` 的缓存键同源（都由 `computeRulePackFingerprint`
 * 产出），但**每次 run 重新计算**：gateway 之类的长驻进程会跨 run 存活，模块级
 * 缓存会让后续 run 顶着旧指纹落盘——那正好让「规则升级后复核历史结论」失效。
 *
 * 指纹是全函数（读取失败降级为占位符，不抛错）；`version` 只读项目清单显式声明
 * 的值，读取/解析失败时缺省，不阻断 run（指纹里已能看出清单不可解析）。
 */

import { readFileSync } from "node:fs";
import { computeRulePackFingerprint, parseRulePackManifest, resolveRulePackManifestPath } from "../../rule/index.js";
import type { RunRulePackInfo } from "./types.js";

/** 解析本次 run 的规则包快照；`manifestPath` 仅测试注入用。 */
export function resolveRunRulePack(options: { manifestPath?: string } = {}): RunRulePackInfo {
  const fingerprint = computeRulePackFingerprint({ manifestPath: options.manifestPath });
  const version = readDeclaredVersion(options.manifestPath);
  return version === undefined ? { fingerprint } : { fingerprint, version };
}

/** 读取清单显式声明的 version；无清单、读不到或解析失败均返回 undefined。 */
function readDeclaredVersion(manifestPath?: string): string | undefined {
  const path = resolveRulePackManifestPath(manifestPath);
  if (path === null) return undefined;
  try {
    return parseRulePackManifest(readFileSync(path, "utf8")).version;
  } catch {
    // 清单不可解析时指纹已记 "unparsable"；版本缺失不阻断 run。
    return undefined;
  }
}
