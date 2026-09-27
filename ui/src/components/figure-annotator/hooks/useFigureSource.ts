/**
 * 把预览拿到的图字节变成标注器可用的图面层。
 *
 * 三件事：字节 → 文本 → sanitize 后的 SVG 标记（内联用）、固有尺寸、内容哈希（识别"图已被重画"）。
 */
import { useEffect, useState } from "react";
import { sha256Hex } from "../utils/export";
import { figureSvgMarkup, parseFigureSvg, svgIntrinsicSize, type FigureIntrinsicSize } from "../utils/figure-dom";

/** 图面加载状态。 */
export type FigureSourceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      /** 图面固有尺寸（像素），标注坐标的参照系。 */
      size: FigureIntrinsicSize;
      /** 已 sanitize 的 SVG 标记（根标签上带固有尺寸，内联与导出共用）。 */
      markup: string;
      /** 图内容哈希。 */
      sha256: string;
    };

export type UseFigureSourceArgs = {
  blob: Blob | null;
  /** 读图失败的原因（来自预览的 blob 加载）。 */
  blobError: string | null;
  /** 预览是否仍在读图。 */
  loading: boolean;
  /** 读图失败时的兜底文案。 */
  failureMessage: string;
};

/**
 * 解析图面。
 *
 * @returns 图面状态；图不是可用的 SVG 时给出错误态而不是空图。
 */
export function useFigureSource({ blob, blobError, loading, failureMessage }: UseFigureSourceArgs): FigureSourceState {
  const [state, setState] = useState<FigureSourceState>({ status: "loading" });

  useEffect(() => {
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
        const result: FigureSourceState = {
          status: "ready",
          size,
          markup: figureSvgMarkup(root),
          sha256: await sha256Hex(bytes),
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
  }, [blob, blobError, loading, failureMessage]);

  return state;
}
