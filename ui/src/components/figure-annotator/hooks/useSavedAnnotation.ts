/**
 * 读回图旁边已保存的标注，并判断它是否已与当前图失配。
 *
 * 失配的含义：图在上次标注之后被重画（内容哈希变化），旧标注的**坐标**可能已经不准，
 * 但锚定（nodeId/ref）与文字仍然可读——所以不丢标注，只提示用户核对后再提交。
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_FIGURE_HASH_ALGO,
  type FigureAnnotationDocument,
  type FigureHashAlgo,
} from "../../../types/annotationReference";
import { readFigureAnnotation } from "../utils/sidecar";

/**
 * 已保存的标注是否与当前图失配。
 *
 * 算法不同时（如 sidecar 在有 Web Crypto 的环境下写了 SHA-256，当前在局域网 http 下只能算
 * FNV-1a）两份摘要**不可比**，按"未失配"处理：宁可漏一次提示，也不把假的"图变了"信号写进
 * 界面与提示词（提示词里那条告警会直接改变模型对坐标的信任度）。
 */
export function isSavedAnnotationStale(
  saved: FigureAnnotationDocument,
  currentSha256: string,
  currentHashAlgo: FigureHashAlgo,
): boolean {
  const savedAlgo = saved.figure.hashAlgo ?? DEFAULT_FIGURE_HASH_ALGO;
  if (savedAlgo !== currentHashAlgo) return false;
  return saved.figure.sha256 !== currentSha256;
}

export type UseSavedAnnotationArgs = {
  projectName: string | undefined;
  /** 图路径（编辑器给的形态）。 */
  figurePath: string | undefined;
  /** 当前图的哈希；图面就绪前为 undefined（此时不读、也没法判失配）。 */
  figureSha256: string | undefined;
  /** 该哈希用的算法。 */
  figureHashAlgo: FigureHashAlgo | undefined;
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
  figureHashAlgo,
  enabled,
}: UseSavedAnnotationArgs): SavedAnnotationState {
  const [state, setState] = useState<SavedAnnotationState>({ saved: null, stale: false });

  useEffect(() => {
    if (!enabled || !projectName || !figurePath || figureSha256 === undefined || figureHashAlgo === undefined) return;
    let cancelled = false;
    void (async () => {
      const saved = await readFigureAnnotation(projectName, figurePath);
      if (cancelled) return;
      setState({ saved, stale: saved !== null && isSavedAnnotationStale(saved, figureSha256, figureHashAlgo) });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, figurePath, figureSha256, figureHashAlgo]);

  return state;
}
