/**
 * 把预览拿到的 SVG 字节变成标注器可用的图面层。
 *
 * 三件事：字节 → 文本 → sanitize 后的 SVG 标记（内联用）、固有尺寸、内容哈希（识别"文件已被换过"）。
 */
import { useEffect, useState } from "react";
import type { AnnotationHashAlgo } from "../../../types/annotationReference";
import type { SurfaceSize } from "../surfaces/types";
import { annotationContentHash } from "../utils/export";
import { figureSvgMarkup, parseFigureSvg, svgIntrinsicSize } from "../utils/svg-hit-test";

/** 图面加载状态。 */
export type SvgFigureSourceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      /** 图面固有尺寸（像素），标注坐标的参照系。 */
      size: SurfaceSize;
      /** 已 sanitize 的 SVG 标记（根标签上带固有尺寸，内联与导出共用）。 */
      markup: string;
      /** 图内容哈希。 */
      sha256: string;
      /** 该哈希用的算法（非安全上下文退化为 FNV-1a 指纹）。 */
      hashAlgo: AnnotationHashAlgo;
    };

export type UseSvgFigureSourceArgs = {
  blob: Blob | null;
  /** 读图失败的原因（来自预览的 blob 加载）。 */
  blobError: string | null;
  /** 预览是否仍在读图。 */
  loading: boolean;
  /** 读图失败时的兜底文案。 */
  failureMessage: string;
  /** 关掉时不做任何工作（另一种面在用时调用方仍会调用本钩子）。 */
  enabled: boolean;
};

/**
 * 解析图面。
 *
 * @returns 图面状态；图不是可用的 SVG 时给出错误态而不是空图。
 */
export function useSvgFigureSource({
  blob,
  blobError,
  loading,
  failureMessage,
  enabled,
}: UseSvgFigureSourceArgs): SvgFigureSourceState {
  const [state, setState] = useState<SvgFigureSourceState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) {
      setState({ status: "loading" });
      return;
    }
    if (blobError !== null) {
      setState({ status: "error", message: blobError });
      return;
    }
    if (loading || blob === null) {
      setState({ status: "loading" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        const root = parseFigureSvg(text);
        if (root === undefined) {
          if (!cancelled) setState({ status: "error", message: failureMessage });
          return;
        }
        const size = svgIntrinsicSize(root);
        // 固有尺寸写回根标签：内联渲染与审阅图（嵌套 `<svg>`）都以它为准。
        root.setAttribute("width", String(size.width));
        root.setAttribute("height", String(size.height));
        const hash = await annotationContentHash(bytes);
        const result: SvgFigureSourceState = {
          status: "ready",
          size,
          markup: figureSvgMarkup(root),
          sha256: hash.hex,
          hashAlgo: hash.algo,
        };
        if (!cancelled) setState(result);
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, blobError, enabled, failureMessage, loading]);

  return state;
}
