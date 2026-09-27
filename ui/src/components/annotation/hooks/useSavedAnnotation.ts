/**
 * 读回目标文件旁边已保存的标注，并判断它是否已与当前文件失配。
 *
 * 失配的含义：文件在上次标注之后被换过（内容哈希变化），旧标注的**坐标**可能已经不准，
 * 但锚定（nodeId/ref）与文字仍然可读——所以不丢标注，只提示用户核对后再提交。
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_ANNOTATION_HASH_ALGO,
  type AnnotationDocument,
  type AnnotationHashAlgo,
} from "../../../types/annotationReference";
import { readAnnotation } from "../utils/sidecar";

/**
 * 已保存的标注是否与当前文件失配。
 *
 * 算法不同时（如 sidecar 在有 Web Crypto 的环境下写了 SHA-256，当前在局域网 http 下只能算
 * FNV-1a）两份摘要**不可比**，按"未失配"处理：宁可漏一次提示，也不把假的"文件变了"信号写进
 * 界面与提示词（提示词里那条告警会直接改变模型对坐标的信任度）。
 */
export function isSavedAnnotationStale(
  saved: AnnotationDocument,
  currentSha256: string,
  currentHashAlgo: AnnotationHashAlgo,
): boolean {
  const savedAlgo = saved.target.hashAlgo ?? DEFAULT_ANNOTATION_HASH_ALGO;
  if (savedAlgo !== currentHashAlgo) return false;
  return saved.target.sha256 !== currentSha256;
}

export type UseSavedAnnotationArgs = {
  projectName: string | undefined;
  /** 目标文件路径（编辑器给的形态）。 */
  targetPath: string | undefined;
  /** 当前文件的内容哈希；面就绪前为 undefined（此时不读、也没法判失配）。 */
  targetSha256: string | undefined;
  /** 该哈希用的算法。 */
  targetHashAlgo: AnnotationHashAlgo | undefined;
  enabled: boolean;
};

export type SavedAnnotationState = {
  /** 已保存的文档（没有则 null）。 */
  saved: AnnotationDocument | null;
  /** 已保存的标注是否与当前文件失配。 */
  stale: boolean;
};

/** 读取已保存的标注。 */
export function useSavedAnnotation({
  projectName,
  targetPath,
  targetSha256,
  targetHashAlgo,
  enabled,
}: UseSavedAnnotationArgs): SavedAnnotationState {
  const [state, setState] = useState<SavedAnnotationState>({ saved: null, stale: false });

  useEffect(() => {
    if (!enabled || !projectName || !targetPath || targetSha256 === undefined || targetHashAlgo === undefined) return;
    let cancelled = false;
    void (async () => {
      const saved = await readAnnotation(projectName, targetPath);
      if (cancelled) return;
      setState({ saved, stale: saved !== null && isSavedAnnotationStale(saved, targetSha256, targetHashAlgo) });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, targetPath, targetSha256, targetHashAlgo]);

  return state;
}
