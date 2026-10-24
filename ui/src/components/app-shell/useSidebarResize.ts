import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { createFrameBatcher } from "../../utils/frameBatcher";

// Resizable sidebar width — clamped to a sensible range and persisted across
// reloads. Drag-handle on the right edge mutates this on the fly.
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 248;
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-v2-width";
/**
 * 拖拽阈值：指针移动超过这么多像素才算真的在拖拽。
 *
 * 按下即进入拖拽态会立刻挂上全屏遮罩（见下方的 `fixed inset-0 z-[60]` 覆盖层），
 * 分隔条的 onDoubleClick 从此再也收不到事件——双击复位宽度会失效。
 */
const RESIZE_DRAG_THRESHOLD_PX = 3;

/** 侧栏宽度：持久化、拖拽采样按帧合并、双击复位。 */
export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  });
  const [isResizing, setIsResizing] = useState(false);

  // 拖拽清理句柄：卸载时若仍在拖拽，监听器不能留在 document 上（上游 #568）。
  const widthDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => widthDragCleanupRef.current?.(), []);

  const handleResizeStart = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      widthDragCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      let latestWidth = startWidth;
      let dragStarted = false;

      // 指针采样按帧合并：拖拽期间不落盘，也不让每次 mousemove 都触发
      // 一次 React 渲染（上游 #568）。
      const moveBatch = createFrameBatcher((e: globalThis.MouseEvent) => {
        // 超过阈值才进入拖拽态：否则遮罩会盖住分隔条，双击复位失效。
        if (!dragStarted) {
          if (Math.abs(e.clientX - startX) < RESIZE_DRAG_THRESHOLD_PX) return;
          dragStarted = true;
          setIsResizing(true);
        }
        latestWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)));
        setSidebarWidth(latestWidth);
      });
      const onMove = moveBatch.schedule;
      const cleanup = () => {
        moveBatch.cancel();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        widthDragCleanupRef.current = null;
      };
      const onUp = () => {
        moveBatch.flush();
        cleanup();
        setIsResizing(false);
        // 落盘最终宽度：直接用合并器记录的最新值，不再回读 DOM。
        try {
          window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(latestWidth)));
        } catch {
          // localStorage may be unavailable in some environments — ignore.
        }
      };
      widthDragCleanupRef.current = cleanup;

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  }, []);

  return { sidebarWidth, isResizing, handleResizeStart, resetSidebarWidth };
}
