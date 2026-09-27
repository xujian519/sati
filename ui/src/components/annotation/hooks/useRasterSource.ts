/**
 * 把预览拿到的栅格图字节变成标注器可用的图面层。
 *
 * 与 SVG 面的差别只有两点：固有尺寸取自解码后的自然尺寸（SVG 取自 width/height 或 viewBox），
 * 以及审阅图的底层是一条嵌 data URL 的 `<image>`（SVG 面嵌的是整棵图）。**没有锚定**：
 * 栅格图没有图元层，"这条标注落在哪个部件上"无法解析，定位只能靠坐标与用户写的说明。
 */
import { useEffect, useState } from "react";
import type { AnnotationHashAlgo } from "../../../types/annotationReference";
import type { SurfaceSize } from "../surfaces/types";
import { annotationContentHash, bytesToDataUrl, rasterMediaType } from "../utils/export";

/** 栅格图面加载状态。 */
export type RasterSourceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      /** 图面固有尺寸（自然像素），标注坐标的参照系。 */
      size: SurfaceSize;
      /** 原图 data URL：既作屏上底图，也作审阅图的底层。 */
      dataUrl: string;
      sha256: string;
      hashAlgo: AnnotationHashAlgo;
    };

export type UseRasterSourceArgs = {
  blob: Blob | null;
  /** 读图失败的原因（来自预览的 blob 加载）。 */
  blobError: string | null;
  /** 预览是否仍在读图。 */
  loading: boolean;
  /** 读图失败时的兜底文案。 */
  failureMessage: string;
  /** 文件名：用于从扩展名推断媒体类型（blob 自带 type 时以 blob 为准）。 */
  fileName: string;
  /** 关掉时不做任何工作（另一种面在用时调用方仍会调用本钩子）。 */
  enabled: boolean;
};

/** 解码一张图，取它的自然尺寸。 */
async function decodeSize(dataUrl: string): Promise<SurfaceSize> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      reject(new Error("the image could not be decoded"));
    };
    image.src = dataUrl;
  });
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/**
 * 解析栅格图面。
 *
 * @returns 图面状态；图解不出来时给出错误态（含尺寸为 0 的畸形图）。
 */
export function useRasterSource({
  blob,
  blobError,
  loading,
  failureMessage,
  fileName,
  enabled,
}: UseRasterSourceArgs): RasterSourceState {
  const [state, setState] = useState<RasterSourceState>({ status: "loading" });

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
        const dataUrl = bytesToDataUrl(bytes, rasterMediaType(blob.type, fileName));
        const size = await decodeSize(dataUrl);
        if (size.width <= 0 || size.height <= 0) {
          if (!cancelled) setState({ status: "error", message: failureMessage });
          return;
        }
        const hash = await annotationContentHash(bytes);
        if (!cancelled) {
          setState({ status: "ready", size, dataUrl, sha256: hash.hex, hashAlgo: hash.algo });
        }
      } catch {
        // 解码失败与"不是图"在这里无法区分，统一给兜底文案（面板进错误态，不是空图面）。
        if (!cancelled) setState({ status: "error", message: failureMessage });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, blobError, enabled, fileName, failureMessage, loading]);

  return state;
}
