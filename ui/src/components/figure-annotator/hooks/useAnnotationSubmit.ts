/**
 * 提交一次标注。
 *
 * 两条出口共用前半段：先落盘 sidecar，再（可选）把标注送进当前会话。
 * 送达靠**既有的内容引用通路**——往 composer 派发一条 annotation 引用，之后由用户按发送键
 * 决定何时发出；本轮不引入"预览面板私自向会话投递消息"的新范式。
 *
 * 标注图不落盘：它以 data URL 挂在引用的 `image` 上（composer 侧载荷），提交时经
 * `contentReferenceImage` 变成普通多模态图片部分；结构化附件与提示块里都会被剥掉。
 */
import { useCallback, useState } from "react";
import { ADD_CONTENT_REFERENCE_EVENT, createFigureAnnotationContentReference } from "../../../types/contentReference";
import {
  buildFigureAnnotationDocument,
  figureAnnotationImageName,
  type FigureAnnotationDocument,
  type FigureAnnotationMark,
  type FigureHashAlgo,
} from "../../../types/annotationReference";
import { blobToDataUrl, composeReviewSvg, rasterizePng, type FigureLayer } from "../utils/export";
import { saveFigureAnnotation } from "../utils/sidecar";
import type { FigureIntrinsicSize } from "../utils/figure-dom";

/** 提交状态（供界面显示一行提示）。 */
export type AnnotationSubmitStatus = { tone: "info" | "ok" | "error"; text: string } | null;

export type UseAnnotationSubmitArgs = {
  projectName: string | undefined;
  /** 图路径（编辑器给的形态，绝对或相对项目根）。 */
  figurePath: string | undefined;
  /** 引用里登记的源路径（供"打开引用"回到这张图）。 */
  relativePath: string | undefined;
  fileName: string | undefined;
  mimeType: string;
  size: FigureIntrinsicSize | undefined;
  sha256: string | undefined;
  /** `sha256` 用的算法（非安全上下文退化为 FNV-1a 指纹）；随图哈希一起落盘。 */
  hashAlgo: FigureHashAlgo | undefined;
  layer: FigureLayer | undefined;
  marks: readonly FigureAnnotationMark[];
  summary: string;
  createdAt: string | null;
  /**
   * 文案翻译器。**键为 `figureAnnotator` 命名空间下的短键**（如 `"sent"`）——视图注入的实现
   * 自带命名空间前缀，因此这里不能写全键，否则会得到 `figureAnnotator.figureAnnotator.sent`
   * 这种拼废的键（i18next 缺失键时原样回显键名，界面上就会显示键而不是文案）。
   */
  t: (key: string, options?: { path?: string }) => string;
  /** 保存成功后的回调（视图据此记住首存时间并解除"图已重画"提示）。 */
  onSaved: (createdAt: string) => void;
};

export type AnnotationSubmit = {
  busy: "saving" | "sending" | null;
  status: AnnotationSubmitStatus;
  run: (deliver: boolean) => Promise<void>;
};

/** 审阅图倍率：长边不超过 2400 像素，避免把上下文烧在一张图上。 */
function reviewScale(size: FigureIntrinsicSize): number {
  return Math.min(2, Math.max(1, 2400 / Math.max(size.width, size.height)));
}

/** 组装提交逻辑。 */
export function useAnnotationSubmit({
  projectName,
  figurePath,
  relativePath,
  fileName,
  mimeType,
  size,
  sha256,
  hashAlgo,
  layer,
  marks,
  summary,
  createdAt,
  t,
  onSaved,
}: UseAnnotationSubmitArgs): AnnotationSubmit {
  const [busy, setBusy] = useState<"saving" | "sending" | null>(null);
  const [status, setStatus] = useState<AnnotationSubmitStatus>(null);

  const buildDocument = useCallback((): FigureAnnotationDocument | null => {
    if (size === undefined || sha256 === undefined || figurePath === undefined || relativePath === undefined) {
      return null;
    }
    return buildFigureAnnotationDocument({
      figure: {
        path: figurePath,
        relativePath,
        mediaType: mimeType,
        width: size.width,
        height: size.height,
        sha256,
        ...(hashAlgo === undefined ? {} : { hashAlgo }),
      },
      marks,
      summary,
      ...(createdAt === null ? {} : { createdAt }),
    });
  }, [createdAt, figurePath, hashAlgo, marks, mimeType, relativePath, sha256, size, summary]);

  const run = useCallback(
    async (deliver: boolean) => {
      if (marks.length === 0) return;
      setBusy(deliver ? "sending" : "saving");
      setStatus({ tone: "info", text: t(deliver ? "sending" : "saving") });
      try {
        const document = buildDocument();
        if (document === null || size === undefined) throw new Error(t("notReady"));

        const sidecarPath =
          projectName !== undefined && figurePath !== undefined
            ? await saveFigureAnnotation(projectName, figurePath, document)
            : null;
        onSaved(document.createdAt);

        if (!deliver) {
          setStatus({ tone: "ok", text: t("saved", { path: sidecarPath ?? "" }) });
          return;
        }
        // 光栅化只为发送服务：仅保存时不做（它依赖画布解码，失败不该拖累落盘）。
        const scale = reviewScale(size);
        const reviewBlob =
          layer === undefined
            ? undefined
            : await rasterizePng(composeReviewSvg(layer, marks), size.width, size.height, scale);
        if (reviewBlob === undefined) throw new Error(t("notReady"));
        if (projectName === undefined || relativePath === undefined || fileName === undefined) {
          throw new Error(t("notReady"));
        }
        const reference = createFigureAnnotationContentReference({
          selectionMode: "annotation",
          source: { projectName, relativePath, fileName, mimeType },
          renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
          locator: { surface: "figure", width: size.width, height: size.height },
          image: {
            name: figureAnnotationImageName(figurePath ?? fileName),
            mimeType: "image/png",
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            dataUrl: await blobToDataUrl(reviewBlob),
          },
          annotation: { document, sidecarPath },
        });
        window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: reference }));
        setStatus({ tone: "ok", text: t("sent") });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ tone: "error", text: `${t("failed")}${message}` });
      } finally {
        setBusy(null);
      }
    },
    [buildDocument, figurePath, fileName, layer, marks, onSaved, projectName, relativePath, size, t, mimeType],
  );

  return { busy, status, run };
}
