/**
 * 读回图旁边已保存的标注，并判断它是否已与当前图失配。
 *
 * 失配的含义：图在上次标注之后被重画（内容哈希变化），旧标注的**坐标**可能已经不准，
 * 但锚定（nodeId/ref）与文字仍然可读——所以不丢标注，只提示用户核对后再提交。
 */
import { useEffect, useState } from "react";
import type { FigureAnnotationDocument } from "../../../types/annotationReference";
import { readFigureAnnotation } from "../utils/sidecar";

export type UseSavedAnnotationArgs = {
  projectName: string | undefined;
  /** 图路径（编辑器给的形态）。 */
  figurePath: string | undefined;
  /** 当前图的哈希；图面就绪前为 undefined（此时不读、也没法判失配）。 */
  figureSha256: string | undefined;
  enabled: boolean;
};

export type SavedAnnotationState = {
  /** 已保存的文档（没有则 null）。 */
  saved: FigureAnnotationDocument | null;
  /** 已保存的标注是否与当前图失配。 */
  stale: boolean;
};

/** 读取已保存的标注。 */
export function useSavedAnnotation({
  projectName,
  figurePath,
  figureSha256,
  enabled,
}: UseSavedAnnotationArgs): SavedAnnotationState {
  const [state, setState] = useState<SavedAnnotationState>({ saved: null, stale: false });

  useEffect(() => {
    if (!enabled || !projectName || !figurePath || figureSha256 === undefined) return;
    let cancelled = false;
    void (async () => {
      const saved = await readFigureAnnotation(projectName, figurePath);
      if (cancelled) return;
      setState({ saved, stale: saved !== null && saved.figure.sha256 !== figureSha256 });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, figurePath, figureSha256]);

  return state;
}
