import { logWarn } from "../utils/logging";

/**
 * 前端诊断环形缓冲（上游 #568）。只记录事件名与数值/布尔/短字符串指标，
 * 供崩溃后从 sessionStorage 取回现场。
 */

const STORAGE_KEY = "sati:ui-diagnostics";
const LIMIT = 20;
/** 落盘节流窗口：错误风暴下把 O(事件数) 次同步存储写入压到 ~4 次/秒。 */
const FLUSH_DELAY_MS = 250;

type Diagnostic = { at: string; event: string; metrics: Record<string, number | boolean | string> };

// Deliberately exclude prompts, model replies, paths, credentials and session IDs.
//
// 内存环形缓冲 + 节流落盘：记录点在 window-error / unhandledrejection 这类本身就会
// 高频重复的热路径上，逐条 parse+stringify+setItem 会随错误风暴线性放大同步存储
// 写入（把"要诊断的卡顿"变成新的卡顿源）。代价是最多丢掉硬崩溃前 250ms 内的诊断。
const ring: Diagnostic[] = [];
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) ring.push(...saved.slice(-LIMIT));
  } catch {
    /* Diagnostics must never break recovery. */
  }
}

/** 立即把环形缓冲写入 sessionStorage（重载/卸载前调用，绕过节流）。 */
export function flushUiDiagnostics(): void {
  // 先补水：本页若没记录过任何事件就落盘空数组，会把上一页的崩溃现场抹掉。
  hydrate();
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ring));
  } catch {
    /* Diagnostics must never break recovery. */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushUiDiagnostics();
  }, FLUSH_DELAY_MS);
}

export function recordUiDiagnostic(event: string, metrics: Diagnostic["metrics"] = {}) {
  const item: Diagnostic = { at: new Date().toISOString(), event, metrics };
  logWarn("[Sati UI]", item);
  hydrate();
  ring.push(item);
  if (ring.length > LIMIT) ring.splice(0, ring.length - LIMIT);
  scheduleFlush();
}

export function reloadUi() {
  // 先让 composer 落盘草稿，再重载；否则未提交的输入会随页面一起消失。
  window.dispatchEvent(new Event("sati:flush-drafts"));
  recordUiDiagnostic("manual-reload");
  // 节流窗口内的诊断必须赶在重载前落盘，否则这次重载的现场就丢了。
  flushUiDiagnostics();
  window.location.reload();
}

export function registerUiDiagnostics() {
  const onError = (event: ErrorEvent) =>
    recordUiDiagnostic("window-error", {
      errorName: event.error instanceof Error ? event.error.name : "Error",
      line: event.lineno || 0,
      column: event.colno || 0,
    });
  const onRejection = (event: PromiseRejectionEvent) =>
    recordUiDiagnostic("unhandled-rejection", {
      errorName: event.reason instanceof Error ? event.reason.name : "Unknown",
    });
  // pagehide 是移动端/关标签页唯一可靠的收尾时机（unload 常被忽略且会禁用 bfcache）。
  const onPageHide = () => flushUiDiagnostics();
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("pagehide", onPageHide);
  };
}
