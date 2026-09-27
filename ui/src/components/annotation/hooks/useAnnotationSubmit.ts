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
import { ADD_CONTENT_REFERENCE_EVENT, createAnnotationContentReference } from "../../../types/contentReference";
import {
  annotationImageName,
  buildAnnotationDocument,
  type AnnotationDocument,
  type AnnotationHashAlgo,
  type AnnotationMark,
} from "../../../types/annotationReference";
import { referenceSurfaceOf, type AnnotatableSurface, type SurfaceSize } from "../surfaces/types";
import { blobToDataUrl, composeReviewSvg, rasterizePng } from "../utils/export";
import { saveAnnotation } from "../utils/sidecar";

/** 提交状态（供界面显示一行提示）。 */
export type AnnotationSubmitStatus = { tone: "info" | "ok" | "error"; text: string } | null;

export type UseAnnotationSubmitArgs = {
  projectName: string | undefined;
  /** 目标文件路径（编辑器给的形态，绝对或相对项目根）。 */
  targetPath: string | undefined;
  /** 引用里登记的源路径（供"打开引用"回到这个文件）。 */
  relativePath: string | undefined;
  fileName: string | undefined;
  mimeType: string;
  /** 已就绪的被标注面（提供种类、固有尺寸与审阅图底层）。 */
  surface: AnnotatableSurface | undefined;
  sha256: string | undefined;
  /** `sha256` 用的算法（非安全上下文退化为 FNV-1a 指纹）；随内容哈希一起落盘。 */
  hashAlgo: AnnotationHashAlgo | undefined;
  marks: readonly AnnotationMark[];
  summary: string;
  createdAt: string | null;
  /**
   * 文案翻译器。**键为 `annotator` 命名空间下的短键**（如 `"sent"`）——视图注入的实现
   * 自带命名空间前缀，因此这里不能写全键，否则会得到 `annotator.annotator.sent`
   * 这种拼废的键（i18next 缺失键时原样回显键名，界面上就会显示键而不是文案）。
   */
  t: (key: string, options?: { path?: string }) => string;
  /** 保存成功后的回调（视图据此记住首存时间并解除"文件已更新"提示）。 */
  onSaved: (createdAt: string) => void;
};

export type AnnotationSubmit = {
  busy: "saving" | "sending" | null;
  status: AnnotationSubmitStatus;
  run: (deliver: boolean) => Promise<void>;
};

/** 审阅图倍率：长边不超过 2400 像素，避免把上下文烧在一张图上。 */
function reviewScale(size: SurfaceSize): number {
  return Math.min(2, Math.max(1, 2400 / Math.max(size.width, size.height)));
}

/** 组装提交逻辑。 */
export function useAnnotationSubmit({
  projectName,
  targetPath,
  relativePath,
  fileName,
  mimeType,
  surface,
  sha256,
  hashAlgo,
  marks,
  summary,
  createdAt,
  t,
  onSaved,
}: UseAnnotationSubmitArgs): AnnotationSubmit {
  const [busy, setBusy] = useState<"saving" | "sending" | null>(null);
  const [status, setStatus] = useState<AnnotationSubmitStatus>(null);

  const buildDocument = useCallback((): AnnotationDocument | null => {
    if (surface === undefined || sha256 === undefined || targetPath === undefined || relativePath === undefined) {
      return null;
    }
    return buildAnnotationDocument({
      target: {
        kind: surface.kind,
        path: targetPath,
        relativePath,
        mediaType: mimeType,
        width: surface.size.width,
        height: surface.size.height,
        sha256,
        ...(hashAlgo === undefined ? {} : { hashAlgo }),
      },
      marks,
      summary,
      ...(createdAt === null ? {} : { createdAt }),
    });
  }, [createdAt, hashAlgo, marks, mimeType, relativePath, sha256, surface, summary, targetPath]);

  const run = useCallback(
    async (deliver: boolean) => {
      if (marks.length === 0) return;
      setBusy(deliver ? "sending" : "saving");
      setStatus({ tone: "info", text: t(deliver ? "sending" : "saving") });
      try {
        const document = buildDocument();
        if (document === null || surface === undefined) throw new Error(t("notReady"));

        const sidecarPath =
          projectName !== undefined && targetPath !== undefined
            ? await saveAnnotation(projectName, targetPath, document)
            : null;
        onSaved(document.createdAt);

        if (!deliver) {
          setStatus({ tone: "ok", text: t("saved", { path: sidecarPath ?? "" }) });
          return;
        }
        // 光栅化只为发送服务：仅保存时不做（它依赖画布解码，失败不该拖累落盘）。
        const scale = reviewScale(surface.size);
        const reviewBlob = await rasterizePng(
          composeReviewSvg(
            { markup: surface.reviewMarkup, width: surface.size.width, height: surface.size.height },
            marks,
          ),
          surface.size.width,
          surface.size.height,
          scale,
        );
        if (projectName === undefined || relativePath === undefined || fileName === undefined) {
          throw new Error(t("notReady"));
        }
        const reference = createAnnotationContentReference({
          selectionMode: "annotation",
          source: { projectName, relativePath, fileName, mimeType },
          renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
          locator: {
            surface: referenceSurfaceOf(surface.kind),
            width: surface.size.width,
            height: surface.size.height,
          },
          image: {
            name: annotationImageName(targetPath ?? fileName),
            mimeType: "image/png",
            width: Math.max(1, Math.round(surface.size.width * scale)),
            height: Math.max(1, Math.round(surface.size.height * scale)),
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
    [buildDocument, fileName, marks, onSaved, projectName, relativePath, surface, t, mimeType, targetPath],
  );

  return { busy, status, run };
}
