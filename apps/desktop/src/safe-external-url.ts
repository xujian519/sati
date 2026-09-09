/**
 * 外链协议门控（W6，借鉴 GenOffice safeExternalUrl）。
 *
 * 桌面壳中所有 shell.openExternal 调用统一经 openExternalSafely 收敛：
 * new URL() 解析 + 协议白名单（http/https），解析失败或非白名单协议
 * （file:/javascript:/自定义 scheme）一律拒绝并告警，绝不回退原始输入。
 * 防止渲染内容中的恶意链接把任意 scheme 交给操作系统打开。
 */
import { shell } from "electron";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 判定 url 是否为可安全交给操作系统的外链。 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * 安全打开外链：不安全时仅 console.warn 并返回 false。
 * 调用方不得在返回 false 时回退到原始输入直接打开。
 */
export function openExternalSafely(raw: string): boolean {
  if (!isSafeExternalUrl(raw)) {
    console.warn(`[safe-external-url] blocked non-whitelisted external URL: ${raw.slice(0, 120)}`);
    return false;
  }
  void shell.openExternal(raw);
  return true;
}
