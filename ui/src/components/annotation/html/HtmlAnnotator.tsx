/**
 * HTML 标注器（H3）：在沙箱 iframe 上复用标注内核（画布 / 工具条 / 侧板 / 提交 / 已存标注读回）。
 *
 * 与图片族的两处差别：
 * - 面固定 1024×768（D5-b），iframe 内部滚动由桥接消息驱动、坐标恒为文档坐标；
 * - 锚定来自桥接快照（父页已做源解析复核），未覆盖即无锚点。
 *
 * 不复制内核：模式切换由外层「查看 | 标注」标签承担，工具条只保留绘制相关控件。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { annotationTargetFingerprint } from "../../../types/annotationReference";
import { nextMarkId, useAnnotatorState } from "../hooks/useAnnotatorState";
import { useAnnotationSubmit } from "../hooks/useAnnotationSubmit";
import { useSavedAnnotation } from "../hooks/useSavedAnnotation";
import type { AnnotatableSurface } from "../surfaces/types";
import { isTypingTarget } from "../utils/shortcut";
import AnnotationSidePanel from "../view/AnnotationSidePanel";
import { AnnotatorCanvas } from "../view/AnnotatorCanvas";
import AnnotatorToolbar from "../view/AnnotatorToolbar";
import { HTML_ANNOTATION_RENDER_HEIGHT, HTML_ANNOTATION_RENDER_WIDTH } from "./constants";
import { useHtmlAnnotator } from "./useHtmlAnnotator";

const HINT_CLASS = "px-2 py-0.5 text-[11px] text-neutral-500 dark:text-neutral-400";
const LOADING_CLASS = "p-4 text-xs text-neutral-500 dark:text-neutral-400";

export type HtmlAnnotatorProps = {
  projectName?: string;
  filePath: string;
  fileName: string;
  /** 预览 URL（含预览凭据）；`annotate` 参数与 nonce 由本组件追加。 */
  previewUrl: string;
  title: string;
};

export default function HtmlAnnotator({
  projectName,
  filePath,
  fileName,
  previewUrl,
  title,
}: HtmlAnnotatorProps): ReactNode {
  const { t } = useTranslation("codeEditor");
  const translate = useCallback(
    (key: string, options?: { count?: number; path?: string }): string => t(`annotator.${key}`, options) as string,
    [t],
  );

  const runtime = useHtmlAnnotator({ projectName, filePath, previewUrl });
  const size = useMemo(() => ({ width: HTML_ANNOTATION_RENDER_WIDTH, height: HTML_ANNOTATION_RENDER_HEIGHT }), []);
  const surface = useMemo<AnnotatableSurface>(() => ({ kind: "html", size: { ...size } }), [size]);

  const sha256 = runtime.source.status === "ready" ? runtime.source.sha256 : null;
  const annotator = useAnnotatorState({
    targetFingerprint: sha256 === null ? undefined : annotationTargetFingerprint({ sha256, hashAlgo: "sha256" }),
  });

  // 进入标注面即为绘制模式；「查看 | 标注」的切换由外层标签承担。
  const setMode = annotator.setMode;
  useEffect(() => {
    setMode("annotate");
  }, [setMode]);

  const savedState = useSavedAnnotation({
    projectName,
    targetPath: filePath,
    targetSha256: sha256 ?? undefined,
    targetHashAlgo: "sha256",
    enabled: runtime.source.status === "ready" && sha256 !== null,
  });
  const seededRef = useRef(false);
  const [seedSkipped, setSeedSkipped] = useState(0);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (seededRef.current || savedState.saved === null) return;
    seededRef.current = true;
    setStale(savedState.stale);
    if (annotator.touched) {
      setSeedSkipped(savedState.saved.marks.length);
      return;
    }
    annotator.seed(savedState.saved);
  }, [annotator, savedState]);

  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitWidth, setFitWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scaledRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = (): void => {
      setFitWidth(stage.clientWidth - 24);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, []);

  const scale = useMemo(() => {
    if (zoom !== "fit") return zoom;
    if (fitWidth <= 0) return 1;
    return Math.min(1.5, Math.max(0.05, fitWidth / size.width));
  }, [fitWidth, size.width, zoom]);

  const markSaved = annotator.markSaved;
  const submit = useAnnotationSubmit({
    projectName,
    targetPath: filePath,
    relativePath: filePath,
    fileName,
    mimeType: "text/html",
    surface,
    sha256: sha256 ?? undefined,
    hashAlgo: "sha256",
    marks: annotator.marks,
    summary: annotator.summary,
    createdAt: annotator.createdAt,
    t: translate,
    onSaved: useCallback(
      (createdAt: string) => {
        markSaved(createdAt);
        setStale(false);
      },
      [markSaved],
    ),
  });
  const runSubmit = submit.run;

  // 不透明源下父页不能直接滚动 iframe：滚轮事件转成消息，由桥接在文档内滚动。
  const { scrollBy } = runtime;
  useEffect(() => {
    const host = scaledRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      scrollBy(event.deltaX, event.deltaY);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
    };
  }, [scrollBy]);

  const undo = annotator.undo;
  const redo = annotator.redo;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      if ((event.key !== "z" && event.key !== "Z") || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [redo, undo]);

  if (runtime.source.status === "error") {
    return <div className={LOADING_CLASS}>{runtime.source.message}</div>;
  }

  const snapshot = runtime.snapshot;
  const runtimeCount = snapshot === null ? 0 : snapshot.elements.filter(element => element.origin === "runtime").length;
  const notices: string[] = [];
  if (!runtime.ready) notices.push(translate("htmlWaiting"));
  if (snapshot?.truncated) notices.push(translate("htmlTruncated"));
  if (runtimeCount > 0) notices.push(translate("htmlRuntime"));
  if (runtime.source.status === "ready" && runtime.source.hashUnavailable) notices.push(translate("htmlNoCrypto"));
  notices.push(translate("htmlExternal"));

  const submitStatus = submit.status;
  return (
    <div className="flex h-full min-h-0 flex-col text-neutral-700 dark:text-neutral-200">
      <AnnotatorToolbar
        annotator={annotator}
        zoom={zoom}
        scale={scale}
        busy={submit.busy}
        regionMode={false}
        onRegionReference={() => {}}
        onSubmit={deliver => {
          void runSubmit(deliver);
        }}
        onZoomChange={setZoom}
        translate={translate}
        showModeToggle={false}
        showRegionReference={false}
      />

      {stale ? (
        <div className="shrink-0 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          {translate("stale")}
        </div>
      ) : null}
      {seedSkipped > 0 ? (
        <div className="shrink-0 bg-neutral-100 px-2 py-1.5 text-[12px] text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          {translate("seedSkipped", { count: seedSkipped })}
        </div>
      ) : null}
      {submitStatus === null ? null : (
        <div
          className={`shrink-0 px-2 py-1.5 text-[12px] ${
            submitStatus.tone === "error"
              ? "text-red-600 dark:text-red-400"
              : submitStatus.tone === "ok"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          {submitStatus.text}
        </div>
      )}

      <div ref={stageRef} className="min-h-0 flex-1 overflow-auto">
        <div className="relative mx-auto my-3" style={{ width: size.width * scale, height: size.height * scale }}>
          <div
            ref={scaledRef}
            className="relative"
            style={{
              width: size.width,
              height: size.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <div ref={runtime.frameHostRef} className="absolute inset-0">
              <iframe
                ref={runtime.iframeRef}
                src={runtime.annotateUrl}
                title={`Annotate: ${title}`}
                className="block h-full w-full border-0 bg-white"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                onLoad={runtime.handleFrameLoad}
              />
            </div>
            <AnnotatorCanvas
              width={size.width}
              height={size.height}
              marks={annotator.marks}
              tool={annotator.tool}
              color={annotator.color}
              containerRef={runtime.frameHostRef}
              {...(runtime.ready ? { hitTest: runtime.hitTest } : {})}
              scrollX={runtime.scroll[0]}
              scrollY={runtime.scroll[1]}
              selectedId={annotator.selectedId}
              onSelect={annotator.setSelectedId}
              onAdd={annotator.addMark}
              onRemove={annotator.removeMark}
              nextId={nextMarkId}
            />
          </div>
        </div>
      </div>

      {notices.length === 0 ? null : (
        <div className="shrink-0">
          {notices.map(notice => (
            <div key={notice} className={HINT_CLASS}>
              {notice}
            </div>
          ))}
        </div>
      )}

      {annotator.mode === "annotate" ? <AnnotationSidePanel annotator={annotator} translate={translate} /> : null}
    </div>
  );
}
