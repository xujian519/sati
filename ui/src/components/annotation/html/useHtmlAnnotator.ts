/**
 * HTML 标注面的运行时状态（H3）：把沙箱 iframe 里桥接发出的**不可信**快照变成可用的锚定面。
 *
 * 组装四件事：
 * - `annotate=1` + nonce 的 iframe 地址（nonce 由父页生成，经 URL 注入桥接）；
 * - 消息监听：只认本帧 `contentWindow` 的 source、本挂载点的 nonce，再做类型/长度校验；
 * - 源解析复核：用 `useHtmlSource` 的源文本把候选 selector 复核成 `static`/`runtime`；
 * - 滚动同步：桥接的轻量 `scroll` 消息更新偏移，父页经 `scrollBy` 命令驱动沙箱内滚动
 *   （不透明源下父页读不到也滚不动 iframe）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SurfaceHitTest } from "../surfaces/types";
import { HTML_ANNOTATION_CHANNEL } from "./constants";
import {
  anchorAtSnapshotPoint,
  isHtmlAnnotationSource,
  readHtmlScrollMessage,
  readHtmlSnapshotMessage,
  validateSnapshotAgainstSource,
  type HtmlSnapshot,
} from "./snapshot";
import { useHtmlSource, type HtmlSourceState } from "./useHtmlSource";

/** 父页生成的 nonce（hex；服务端按 `[A-Za-z0-9_-]{8,64}` 校验）。 */
export function createHtmlAnnotationNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** 在预览 URL 后追加标注参数（保留既有 query）。 */
export function buildAnnotateUrl(previewUrl: string, nonce: string): string {
  const separator = previewUrl.includes("?") ? "&" : "?";
  return `${previewUrl}${separator}annotate=1&sati_nonce=${encodeURIComponent(nonce)}`;
}

export type HtmlAnnotatorRuntime = {
  /** 挂到沙箱 iframe 上。 */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** 挂到 iframe 的同几何容器上；`AnnotatorCanvas` 以它为坐标原点。 */
  frameHostRef: RefObject<HTMLDivElement | null>;
  /** iframe 的 src（带 annotate 参数与 nonce）。 */
  annotateUrl: string;
  /** 快照是否已就绪（就绪前禁止落笔与命中测试）。 */
  ready: boolean;
  /** 复核后的快照（无则 null）。 */
  snapshot: HtmlSnapshot | null;
  /** 当前滚动偏移（文档坐标 = 视口坐标 + scroll）。 */
  scroll: readonly [number, number];
  /** 源文件状态（sha256 与源文本）。 */
  source: HtmlSourceState;
  /** 命中测试（快照最小包围盒；未覆盖即无锚点）。ready 前调用返回 undefined。 */
  hitTest: SurfaceHitTest;
  /** 在沙箱文档内滚动（父页无法直接操作不透明源 iframe 的滚动）。 */
  scrollBy: (dx: number, dy: number) => void;
  /** 请求桥接重新测量。 */
  remeasure: () => void;
  /** iframe 每次 load（含沙箱内导航）都调用：快照随之失效，直到新快照到达。 */
  handleFrameLoad: () => void;
};

export type UseHtmlAnnotatorArgs = {
  projectName: string | undefined;
  filePath: string;
  previewUrl: string;
};

/** HTML 标注面的运行时状态。 */
export function useHtmlAnnotator({ projectName, filePath, previewUrl }: UseHtmlAnnotatorArgs): HtmlAnnotatorRuntime {
  const nonce = useMemo(() => createHtmlAnnotationNonce(), []);
  const expected = useMemo(() => ({ channel: HTML_ANNOTATION_CHANNEL, nonce }), [nonce]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const [rawSnapshot, setRawSnapshot] = useState<HtmlSnapshot | null>(null);
  const [scroll, setScroll] = useState<readonly [number, number]>([0, 0]);

  const source = useHtmlSource(projectName, filePath);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      if (!isHtmlAnnotationSource(event, frameWindow)) return;
      const snapshot = readHtmlSnapshotMessage(event.data, expected);
      if (snapshot !== null) {
        setRawSnapshot(snapshot);
        setScroll(snapshot.scroll);
        return;
      }
      const update = readHtmlScrollMessage(event.data, expected);
      if (update !== null) setScroll(update.scroll);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [expected]);

  const snapshot = useMemo(() => {
    if (rawSnapshot === null || source.status !== "ready") return null;
    return validateSnapshotAgainstSource(rawSnapshot, source.sourceText);
  }, [rawSnapshot, source]);

  const hitTest = useCallback<SurfaceHitTest>(
    (container, clientX, clientY, scaleX, scaleY) => {
      if (snapshot === null) return undefined;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return undefined;
      const x = (clientX - rect.left) * scaleX + scroll[0];
      const y = (clientY - rect.top) * scaleY + scroll[1];
      return anchorAtSnapshotPoint(snapshot, x, y);
    },
    [snapshot, scroll],
  );

  const postToFrame = useCallback(
    (message: Record<string, unknown>): void => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      if (frameWindow === null) return;
      frameWindow.postMessage({ channel: HTML_ANNOTATION_CHANNEL, nonce, ...message }, "*");
    },
    [nonce],
  );

  const scrollBy = useCallback(
    (dx: number, dy: number): void => {
      postToFrame({ type: "scrollBy", dx, dy });
    },
    [postToFrame],
  );

  const remeasure = useCallback((): void => {
    postToFrame({ type: "remeasure" });
  }, [postToFrame]);

  const handleFrameLoad = useCallback((): void => {
    // 每次 load（含沙箱内导航）：旧快照与旧滚动偏移一律作废，直到新快照到达。
    setRawSnapshot(null);
    setScroll([0, 0]);
  }, []);

  return {
    iframeRef,
    frameHostRef,
    annotateUrl: useMemo(() => buildAnnotateUrl(previewUrl, nonce), [previewUrl, nonce]),
    ready: snapshot !== null,
    snapshot,
    scroll,
    source,
    hitTest,
    scrollBy,
    remeasure,
    handleFrameLoad,
  };
}
