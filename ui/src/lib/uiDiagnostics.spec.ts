import { afterEach, beforeEach, expect, it, vi } from "vitest";

type DiagnosticsModule = typeof import("./uiDiagnostics");

/**
 * 模块持有环形缓冲、"已补水"标记与节流计时器等模块级状态，落盘又是延迟的。
 * 每个用例都重建模块实例，避免上一个用例的缓冲与标记泄漏进来。
 */
async function loadModule(): Promise<DiagnosticsModule> {
  vi.resetModules();
  return import("./uiDiagnostics");
}

function stored(): { event: string; metrics: Record<string, unknown> }[] {
  return JSON.parse(sessionStorage.getItem("sati:ui-diagnostics") ?? "[]");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it("keeps a bounded history and never stores the message body of thrown errors", async () => {
  const { recordUiDiagnostic, registerUiDiagnostics, flushUiDiagnostics } = await loadModule();
  for (let i = 0; i < 30; i++) recordUiDiagnostic("layout", { messages: i });
  const unregister = registerUiDiagnostics();
  window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("private prompt and secret"), lineno: 12 }));
  unregister();
  flushUiDiagnostics();

  const entries = stored();
  expect(entries).toHaveLength(20);
  expect(entries.at(-1)).toMatchObject({
    event: "window-error",
    metrics: { errorName: "TypeError", line: 12, column: 0 },
  });
  expect(sessionStorage.getItem("sati:ui-diagnostics")).not.toContain("private prompt");
});

it("coalesces a burst of diagnostics into a single trailing storage write", async () => {
  const { recordUiDiagnostic } = await loadModule();
  // jsdom 的 sessionStorage 是 Proxy，实例级 spy 收不到调用，必须挂在 Storage 原型上。
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  for (let i = 0; i < 50; i++) recordUiDiagnostic("layout", { messages: i });

  expect(setItem).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(stored()).toHaveLength(20);
});

it("flushes on demand and cancels the pending trailing write", async () => {
  const { recordUiDiagnostic, flushUiDiagnostics } = await loadModule();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  recordUiDiagnostic("manual-reload");

  flushUiDiagnostics();
  expect(stored()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(setItem).toHaveBeenCalledTimes(1);
});

it("hydrates the previous page's diagnostics before persisting new ones", async () => {
  const previous = { at: "2026-01-01T00:00:00.000Z", event: "previous-page", metrics: { rows: 3 } };
  sessionStorage.setItem("sati:ui-diagnostics", JSON.stringify([previous]));

  const { recordUiDiagnostic, flushUiDiagnostics } = await loadModule();
  recordUiDiagnostic("chat-empty-viewport", { renderedRows: 0 });
  flushUiDiagnostics();

  expect(stored()).toHaveLength(2);
  expect(stored()[0]).toEqual(previous);
});
