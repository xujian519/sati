/**
 * 标注面板：打开一张图片，在图上直接圈画标注，然后把"标注图 + 逐条说明"交给智能体。
 *
 * 它接管**图片族**（SVG 与栅格）的编辑器预览，因此同一个文件类型上只有一个入口：打开图片
 * 就是这个面板，"框选一块发给智能体"是面板内的一个模式（区域引用），不再另设第二个入口。
 * 动机：专利与检索场景里的返工意见常常是"这个标号指错了""这里少一个件""这条线该连到那边"
 * ——用文字描述既慢又容易误解，而在图上直接画，就能把"图面坐标 + 落在哪个图元上 + 用户那句话"
 * 一起交给智能体。
 *
 * 两种面的差别集中在 `AnnotatableSurface`：SVG 能内联成活 DOM，标注因而可锚定到具体图元
 * （`nodeId`/`ref` → FigureSpec 节点）；栅格图没有图元层，标注只带坐标与用户写的说明。
 *
 * 不改原文件：标注写在文件旁边（`<文件名>.annot.json`）。附图改图仍由智能体改生成源
 * （FigureSpec / 脚本 / SVG）；栅格图的标注是一份审阅意见，没有生成源可改。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { annotationTargetFingerprint } from "../../../types/annotationReference";
import { ADD_CONTENT_REFERENCE_EVENT } from "../../../types/contentReference";
import type { CodeEditorFile } from "../../code-editor/types/types";
import FallbackContent from "../../code-editor/view/binary-file/components/atoms/FallbackContent";
import { useFileBlob } from "../../code-editor/view/binary-file/hooks/use-file-blob";
import { useObjectUrl } from "../../code-editor/view/binary-file/hooks/use-object-url";
import RegionSelectionOverlay, {
  type CapturedRegion,
} from "../../code-editor/view/subcomponents/RegionSelectionOverlay";
import { isSvgPath } from "../constants/annotator";
import { useAnnotationSubmit } from "../hooks/useAnnotationSubmit";
import { nextMarkId, useAnnotatorState } from "../hooks/useAnnotatorState";
import { useRasterSource } from "../hooks/useRasterSource";
import { useSavedAnnotation } from "../hooks/useSavedAnnotation";
import { useSvgFigureSource } from "../hooks/useSvgFigureSource";
import type { AnnotatableSurface } from "../surfaces/types";
import { rasterMediaType } from "../utils/export";
import { buildRegionReference } from "../utils/regionReference";
import { isTypingTarget } from "../utils/shortcut";
import { anchorAtPoint, parseFigureSvg } from "../utils/svg-hit-test";
import AnnotationSidePanel from "./AnnotationSidePanel";
import { AnnotatorCanvas } from "./AnnotatorCanvas";
import AnnotatorToolbar from "./AnnotatorToolbar";

export type AnnotatorProps = {
  projectName?: string;
  file: CodeEditorFile;
  /** 兜底视图的标题 / 说明（与相邻预览组件同形）。 */
  title: string;
  message: string;
  onClose: () => void;
};

/** 图面就绪前的占位高度：避免工具栏在载入期间跳动。 */
const LOADING_CLASS = "p-4 text-xs text-neutral-500 dark:text-neutral-400";

/**
 * 标注面板。
 *
 * @returns 标注器界面；图面读不出来时退回与相邻预览一致的兜底视图。
 */
export default function Annotator({ projectName, file, title, message, onClose }: AnnotatorProps): ReactNode {
  const { t } = useTranslation("codeEditor");
  const translate = useCallback(
    (key: string, options?: { count?: number; path?: string }): string => t(`annotator.${key}`, options) as string,
    [t],
  );

  const isSvg = isSvgPath(file.name);
  const { blob, errorMessage, loading } = useFileBlob(projectName, file.path, true);
  const failureMessage = translate("loadFailed");
  // 两个来源钩子都调用（Hooks 规则），由 `enabled` 保证只有一种面真的做事。
  const svgSource = useSvgFigureSource({
    blob,
    blobError: errorMessage,
    loading,
    failureMessage,
    enabled: isSvg,
  });
  const rasterSource = useRasterSource({
    blob,
    blobError: errorMessage,
    loading,
    failureMessage,
    fileName: file.name,
    enabled: !isSvg,
  });

  const surface = useMemo((): AnnotatableSurface | undefined => {
    if (isSvg) {
      if (svgSource.status !== "ready") return undefined;
      return { kind: "figure-svg", size: svgSource.size, reviewMarkup: svgSource.markup, hitTest: anchorAtPoint };
    }
    if (rasterSource.status !== "ready") return undefined;
    const { width, height } = rasterSource.size;
    // 审阅图的底层就是原图的 data URL；base64 里不含 `"` 或 `<`，属性插值安全。
    return {
      kind: "image",
      size: rasterSource.size,
      reviewMarkup: `<image x="0" y="0" width="${width}" height="${height}" href="${rasterSource.dataUrl}"/>`,
    };
  }, [isSvg, rasterSource, svgSource]);

  const sourceHash = isSvg
    ? svgSource.status === "ready"
      ? { sha256: svgSource.sha256, hashAlgo: svgSource.hashAlgo }
      : undefined
    : rasterSource.status === "ready"
      ? { sha256: rasterSource.sha256, hashAlgo: rasterSource.hashAlgo }
      : undefined;
  const mimeType = isSvg ? "image/svg+xml" : rasterMediaType(blob?.type ?? "", file.name);
  const previewUrl = isSvg ? undefined : rasterSource.status === "ready" ? rasterSource.dataUrl : undefined;

  const annotator = useAnnotatorState({
    targetFingerprint: sourceHash === undefined ? undefined : annotationTargetFingerprint(sourceHash),
  });
  const [stale, setStale] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitWidth, setFitWidth] = useState(0);
  /**
   * 区域模式：在图上框选一块，作为既有的「图片区域」引用交给智能体。
   *
   * 它与标注是两条不同的引用，所以入口显式分开，不同时抢指针手势（见 2026-09-28 决策记录）。
   */
  const [regionMode, setRegionMode] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const figureHostRef = useRef<HTMLDivElement | null>(null);
  const regionHostRef = useRef<HTMLDivElement | null>(null);
  const regionImageRef = useRef<HTMLImageElement | null>(null);
  // 区域模式下图面用普通 `<img>`：共享的选区捕获走 html2canvas，而它不认 shadow root。
  const regionImageUrl = useObjectUrl(regionMode ? blob : null);

  const commitRegion = useCallback(
    (capture: CapturedRegion) => {
      const reference = buildRegionReference({
        projectName,
        relativePath: file.path,
        fileName: file.name,
        mimeType,
        fileSize: blob?.size,
        surface: isSvg ? "figure" : "image",
        capture,
      });
      window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: reference }));
      setRegionMode(false);
    },
    [blob, file.name, file.path, isSvg, mimeType, projectName],
  );

  const savedState = useSavedAnnotation({
    projectName,
    targetPath: file.path,
    targetSha256: sourceHash?.sha256,
    targetHashAlgo: sourceHash?.hashAlgo,
    enabled: sourceHash !== undefined,
  });

  // 已保存的标注只灌一次：之后用户自己的编辑不会被再次覆盖。
  const seededRef = useRef(false);
  const [seedSkipped, setSeedSkipped] = useState(0);
  useEffect(() => {
    if (seededRef.current || savedState.saved === null) return;
    seededRef.current = true;
    // 读回是异步的：用户可能在它返回前就落了笔，此时灌入会把刚画的内容整体替换掉
    // （不是合并）。这时不灌并如实告知；重新打开该文件即可载入。
    if (annotator.touched) {
      setSeedSkipped(savedState.saved.marks.length);
      return;
    }
    annotator.seed(savedState.saved);
    setStale(savedState.stale);
  }, [annotator, savedState]);

  const size = surface?.size;
  const markSaved = annotator.markSaved;
  const submit = useAnnotationSubmit({
    projectName,
    targetPath: file.path,
    relativePath: file.path,
    fileName: file.name,
    mimeType,
    surface,
    sha256: sourceHash?.sha256,
    hashAlgo: sourceHash?.hashAlgo,
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

  // SVG 面：图上内联真实的 SVG 元素（而不是 <img>），因为只有活的 DOM 才知道标注落在哪个图元上。
  // 放进 shadow root：SVG 自带的 `<style>` 是**文档级**样式表，不隔离就能重排整个界面。
  useEffect(() => {
    const host = figureHostRef.current;
    if (host === null || !isSvg || svgSource.status !== "ready") return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const root = parseFigureSvg(svgSource.markup);
    if (root === undefined) return;
    // shadow root 里没有 Tailwind 的样式，块级与禁选直接写成内联样式。
    root.style.display = "block";
    root.style.userSelect = "none";
    shadow.replaceChildren(root);
  }, [isSvg, svgSource]);

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
  }, [surface?.kind, size?.width]);

  // Ctrl/Cmd+Z 撤销（带 Shift 为重做）。挂在 window 上，所以要避开正在打字的输入框。
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

  const scale = useMemo(() => {
    if (size === undefined) return 1;
    if (zoom !== "fit") return zoom;
    if (fitWidth <= 0) return 1;
    return Math.min(1.5, Math.max(0.05, fitWidth / size.width));
  }, [fitWidth, size, zoom]);

  const failedMessage = isSvg
    ? svgSource.status === "error"
      ? svgSource.message
      : null
    : rasterSource.status === "error"
      ? rasterSource.message
      : null;
  if (failedMessage !== null) {
    return <FallbackContent title={title} message={failedMessage || message} onClose={onClose} />;
  }
  if (size === undefined) {
    return <div className={LOADING_CLASS}>{translate("loading")}</div>;
  }

  const drawing = annotator.mode === "annotate";
  const submitStatus = submit.status;
  return (
    <div className="flex h-full min-h-0 flex-col text-neutral-700 dark:text-neutral-200">
      <AnnotatorToolbar
        annotator={annotator}
        zoom={zoom}
        scale={scale}
        busy={submit.busy}
        regionMode={regionMode}
        onRegionReference={() => setRegionMode(mode => !mode)}
        onSubmit={deliver => {
          void runSubmit(deliver);
        }}
        onZoomChange={setZoom}
        translate={translate}
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
            className="relative"
            style={{
              width: size.width,
              height: size.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            {regionMode ? (
              // 区域模式：普通 `<img>` 接管图面（捕获引擎才拿得到像素），绘制覆盖层同时卸载，
              // 避免两套手势抢同一块画布。
              <div ref={regionHostRef} className="absolute inset-0">
                <img
                  ref={regionImageRef}
                  src={regionImageUrl ?? undefined}
                  alt={file.name}
                  width={size.width}
                  height={size.height}
                  className="block"
                  draggable={false}
                />
              </div>
            ) : (
              <>
                {isSvg ? (
                  <div ref={figureHostRef} />
                ) : (
                  <img
                    src={previewUrl}
                    alt={file.name}
                    width={size.width}
                    height={size.height}
                    className="absolute inset-0 block select-none"
                    draggable={false}
                  />
                )}
                <AnnotatorCanvas
                  width={size.width}
                  height={size.height}
                  marks={annotator.marks}
                  tool={drawing ? annotator.tool : "select"}
                  color={annotator.color}
                  containerRef={figureHostRef}
                  {...(surface?.hitTest === undefined ? {} : { hitTest: surface.hitTest })}
                  selectedId={annotator.selectedId}
                  onSelect={annotator.setSelectedId}
                  onAdd={annotator.addMark}
                  onRemove={annotator.removeMark}
                  nextId={nextMarkId}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {regionMode ? (
        <RegionSelectionOverlay
          active
          hostRef={regionHostRef}
          resolveTarget={element => {
            const image = element?.closest<HTMLImageElement>("img");
            if (!image || image !== regionImageRef.current) return null;
            return { element: image, surface: isSvg ? "figure" : "page" };
          }}
          onCommit={commitRegion}
          onCancel={() => setRegionMode(false)}
        />
      ) : null}

      {drawing ? <AnnotationSidePanel annotator={annotator} translate={translate} /> : null}
    </div>
  );
}
