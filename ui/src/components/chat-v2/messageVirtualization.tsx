import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatMessage } from "../chat/types/types";
import type { RenderableMessageItem } from "./processGrouping";

/**
 * 虚拟化层：高度估算 → 前缀和 → 可视窗口计算，外加"测量回填 + 视口跟踪"这套运行时。
 *
 * 从 `MessagesPaneV2.tsx` 搬出（#159 N03a），**被搬代码逐字未改**（逐 token 比对见
 * `/tmp/n03a-move-proof.mjs`）。搬出前这些逻辑与进程分组、渲染分支混在同一个 1024 行的
 * 组件函数里；其中纯函数（`buildPrefixOffsets` / `getVirtualMessageWindow`）此前已被单测覆盖，
 * 但"窗口怎么随滚动/测量/条目增删演进"这一层没有任何测试。
 *
 * 三处运行时关注点（都随本层搬走，且**保持原来的相对顺序**）：
 * ① `handleMeasuredItemHeight` + RAF 合并的高度版本号；
 * ② 条目增删后清理已消失的测量值；
 * ③ 滚动/resize 的视口跟踪（`useLayoutEffect`，唯一一处）。
 */

export type VirtualMessageWindow = {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  totalHeight: number;
};

const MESSAGE_VIRTUALIZATION_THRESHOLD = 60;

const MESSAGE_WINDOW_OVERSCAN = 12;

const MESSAGE_GAP_PX = 16;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function getMessageTextLength(message: ChatMessage): number {
  const contentLength = typeof message.content === "string" ? message.content.length : 0;
  const toolInputLength = typeof message.toolInput === "string" ? message.toolInput.length : 0;
  const outputLength = typeof message.toolResult?.content === "string" ? message.toolResult.content.length : 0;
  return contentLength + Math.min(toolInputLength + outputLength, 2400);
}

/** 单条消息的初始高度估算（实测值到位前先用它撑起滚动条）。 */
// eslint-disable-next-line react-refresh/only-export-components -- 见文件头说明：本模块同时导出组件与纯函数
export function estimateMessageItemHeight(item: RenderableMessageItem): number {
  const textLength = getMessageTextLength(item.message);
  const roughLines = Math.ceil(textLength / 92);
  const baseHeight = item.message.type === "user" ? 64 : 92;
  const processSummaryCount = item.beforeProcessAttachments.length + item.afterProcessAttachments.length;
  const processSummaryHeight = processSummaryCount * 32;
  const runHeaderHeight = (item.beforeRunAttachment ? 34 : 0) + (item.afterRunAttachment ? 34 : 0);
  const attachmentHeight = Array.isArray(item.message.attachments) && item.message.attachments.length > 0 ? 56 : 0;
  const artifactCount = Array.isArray(item.message.artifacts) ? item.message.artifacts.length : 0;
  const artifactHeight = artifactCount > 0 ? Math.min(artifactCount, 3) * 64 + 34 : 0;
  const imageHeight = Array.isArray(item.message.images) && item.message.images.length > 0 ? 180 : 0;
  const toolHeight = item.message.isToolUse || item.message.toolName ? 140 : 0;

  return clampNumber(
    baseHeight +
      roughLines * 20 +
      runHeaderHeight +
      processSummaryHeight +
      attachmentHeight +
      artifactHeight +
      imageHeight +
      toolHeight +
      MESSAGE_GAP_PX,
    72,
    720,
  );
}

// P3-5：前缀和（itemHeights → 每项起始偏移）拆为可复用纯函数。调用方 useMemo
// 缓存（依赖 measuredItemHeights 引用，级联命中时稳定），避免每个滚动帧全量 O(N)
// 重建——虚拟滚动滚动事件频率远高于内容变化频率。
// eslint-disable-next-line react-refresh/only-export-components
export function buildPrefixOffsets(itemHeights: number[]): number[] {
  const prefixOffsets = [0];
  for (const height of itemHeights) {
    prefixOffsets.push(prefixOffsets[prefixOffsets.length - 1] + Math.max(1, height));
  }
  return prefixOffsets;
}

// eslint-disable-next-line react-refresh/only-export-components
export function getVirtualMessageWindow(
  itemHeights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = MESSAGE_WINDOW_OVERSCAN,
  prefixOffsets = buildPrefixOffsets(itemHeights),
): VirtualMessageWindow {
  if (itemHeights.length === 0) {
    return { startIndex: 0, endIndex: 0, topPadding: 0, bottomPadding: 0, totalHeight: 0 };
  }

  const totalHeight = prefixOffsets[prefixOffsets.length - 1];
  const safeScrollTop = clampNumber(Number.isFinite(scrollTop) ? scrollTop : 0, 0, totalHeight);
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900);
  const rawStart = Math.max(0, upperBound(prefixOffsets, safeScrollTop) - 1);
  const rawEnd = Math.min(itemHeights.length, upperBound(prefixOffsets, safeScrollTop + safeViewportHeight));
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(itemHeights.length, Math.max(startIndex + 1, rawEnd + overscan));

  return {
    startIndex,
    endIndex,
    topPadding: prefixOffsets[startIndex],
    bottomPadding: Math.max(0, totalHeight - prefixOffsets[endIndex]),
    totalHeight,
  };
}

/** 包裹单条消息并回填实测高度（ResizeObserver + RAF 节流）。 */
export function MeasuredMessageItem({
  itemKey,
  message,
  isLast,
  compactBottomSpacing = false,
  onHeightChange,
  children,
}: {
  itemKey: string;
  message: ChatMessage;
  isLast: boolean;
  compactBottomSpacing?: boolean;
  onHeightChange: (itemKey: string, height: number) => void;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = itemRef.current;
    if (!node) return undefined;

    const reportHeight = () => {
      onHeightChange(itemKey, node.getBoundingClientRect().height);
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    let rafId: number | null = null;
    const throttledReport = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reportHeight();
      });
    };

    const observer = new ResizeObserver(throttledReport);
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [itemKey, onHeightChange]);

  return (
    <div
      ref={itemRef}
      className={`chat-message ${isLast ? "" : compactBottomSpacing ? "pb-2" : "pb-4"}`}
      data-message-key={itemKey}
      data-message-timestamp={message.timestamp ? String(message.timestamp) : undefined}
    >
      {children}
    </div>
  );
}

type MessageVirtualizationOptions<T> = {
  /** 已带稳定 key 与估算高度的渲染项（keyedItems 的入参名刻意与被搬代码保持一致）。 */
  keyedItems: T[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
};

type MessageVirtualizationApi<T> = {
  /** 每项当前采用的高度（测得值优先，否则估算值）。 */
  measuredItemHeights: number[];
  shouldVirtualizeMessages: boolean;
  virtualWindow: VirtualMessageWindow;
  /** 窗口内的条目（不虚拟化时即全量）。 */
  windowedMessageItems: T[];
  handleMeasuredItemHeight: (itemKey: string, height: number) => void;
};

// eslint-disable-next-line react-refresh/only-export-components -- 本模块是虚拟化层：组件与 hook/纯函数同住，见文件头说明
export function useMessageVirtualization<T extends { itemKey: string; estimatedHeight: number }>({
  keyedItems: keyedMessageItems,
  scrollContainerRef,
}: MessageVirtualizationOptions<T>): MessageVirtualizationApi<T> {
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());

  const heightVersionRafRef = useRef<number | null>(null);

  const [heightVersion, setHeightVersion] = useState(0);
  const [scrollViewport, setScrollViewport] = useState({ scrollTop: 0, height: 0 });

  const measuredItemHeights = useMemo(() => {
    void heightVersion;
    return keyedMessageItems.map(item => measuredHeightsRef.current.get(item.itemKey) ?? item.estimatedHeight);
  }, [heightVersion, keyedMessageItems]);

  // 估算总高只算一次，供虚拟化判定与不虚拟化时的窗口高度共用（原先两处各扫一遍全表）。
  const estimatedTotalHeight = useMemo(
    () => keyedMessageItems.reduce((height, item) => height + item.estimatedHeight, 0),
    [keyedMessageItems],
  );

  const shouldVirtualizeMessages = useMemo(
    () =>
      keyedMessageItems.length > MESSAGE_VIRTUALIZATION_THRESHOLD ||
      // 少量超长回答可能比数百条短消息更重；40 条以上且估算总高超过 20000px 时提前启用
      // 虚拟化，常规小会话保持完整渲染以保留文本选择能力（上游 #568）。
      (keyedMessageItems.length > 40 && estimatedTotalHeight > 20_000),
    [keyedMessageItems.length, estimatedTotalHeight],
  );

  // P3-5：前缀和 useMemo 缓存——依赖 measuredItemHeights 引用而非 scrollTop，
  // 滚动 tick 不再每帧全量重算前缀和（级联命中：流式 process tick 引用稳定）。
  const prefixOffsets = useMemo(
    () => (shouldVirtualizeMessages ? buildPrefixOffsets(measuredItemHeights) : []),
    [measuredItemHeights, shouldVirtualizeMessages],
  );

  const virtualWindow = useMemo(
    () =>
      shouldVirtualizeMessages
        ? getVirtualMessageWindow(
            measuredItemHeights,
            scrollViewport.scrollTop,
            scrollViewport.height,
            MESSAGE_WINDOW_OVERSCAN,
            prefixOffsets,
          )
        : {
            startIndex: 0,
            endIndex: keyedMessageItems.length,
            topPadding: 0,
            bottomPadding: 0,
            // 全量渲染时组件不读 totalHeight（只有 padding/窗口索引参与渲染），
            // 复用估算总高即可，省掉一次全表求和。
            totalHeight: estimatedTotalHeight,
          },
    [
      estimatedTotalHeight,
      keyedMessageItems.length,
      measuredItemHeights,
      prefixOffsets,
      scrollViewport.height,
      scrollViewport.scrollTop,
      shouldVirtualizeMessages,
    ],
  );

  const windowedMessageItems = shouldVirtualizeMessages
    ? keyedMessageItems.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    : keyedMessageItems;

  const bumpHeightVersion = useCallback(() => {
    if (heightVersionRafRef.current !== null) return;
    heightVersionRafRef.current = requestAnimationFrame(() => {
      heightVersionRafRef.current = null;
      setHeightVersion(version => version + 1);
    });
  }, []);

  const handleMeasuredItemHeight = useCallback(
    (itemKey: string, height: number) => {
      const normalizedHeight = Math.max(1, Math.ceil(height));
      const currentHeight = measuredHeightsRef.current.get(itemKey);
      if (currentHeight !== undefined && Math.abs(currentHeight - normalizedHeight) < 2) {
        return;
      }

      measuredHeightsRef.current.set(itemKey, normalizedHeight);
      bumpHeightVersion();
    },
    [bumpHeightVersion],
  );

  useEffect(
    () => () => {
      if (heightVersionRafRef.current !== null) {
        cancelAnimationFrame(heightVersionRafRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const validKeys = new Set(keyedMessageItems.map(item => item.itemKey));
    let changed = false;

    for (const itemKey of measuredHeightsRef.current.keys()) {
      if (!validKeys.has(itemKey)) {
        measuredHeightsRef.current.delete(itemKey);
        changed = true;
      }
    }

    if (changed) {
      bumpHeightVersion();
    }
  }, [bumpHeightVersion, keyedMessageItems]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    let frame = 0;
    const updateViewport = () => {
      frame = 0;
      setScrollViewport({
        scrollTop: container.scrollTop,
        height: container.clientHeight,
      });
    };
    const scheduleViewportUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateViewport);
    };

    updateViewport();
    container.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (frame) cancelAnimationFrame(frame);
        container.removeEventListener("scroll", scheduleViewportUpdate);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleViewportUpdate);
    resizeObserver.observe(container);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener("scroll", scheduleViewportUpdate);
      resizeObserver.disconnect();
    };
  }, [scrollContainerRef]);

  return {
    measuredItemHeights,
    shouldVirtualizeMessages,
    virtualWindow,
    windowedMessageItems,
    handleMeasuredItemHeight,
  };
}
