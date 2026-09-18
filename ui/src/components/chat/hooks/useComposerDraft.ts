import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { safeLocalStorage } from "../utils/chatStorage";
import type { ContentReference } from "../../../types/contentReference";

/**
 * 草稿持久化：输入框内容的防抖落盘、切换会话/项目时的换档与恢复、以及三条"必须同步落盘"的
 * 兜底路径（组件卸载、页面卸载、`sati:flush-drafts` 主动 flush）。
 *
 * 从 `useChatComposerState.ts` 搬出（#159 N01 缝 4c），**被搬代码逐字未改**
 * （逐 token 比对见 `/tmp/n01f-move-proof.mjs`）。
 *
 * 独立成一层（而不是塞进 `useComposerInput`）有两个理由：
 * ① 它的四个 effect 必须留在**原来的位置**——effect 的相对顺序有语义，塞进输入层会整体后移到
 *    autosize 之后；② 它还同时写**附件层**的四个 state（切会话时清空引用/附件/上传态/错误），
 *    塞进输入层会平白多出一条跨层依赖。
 */

/** 草稿落盘防抖窗口（ms）：击键停止 500ms 后才写 localStorage。 */
const DRAFT_SAVE_DEBOUNCE_MS = 500;

type ComposerDraftOptions = {
  /** 当前草稿键（项目名 + 会话 id）；为 null 表示不落盘。 */
  draftStorageKey: string | null;
  /** 记录"上一次的草稿键"，切换时先把旧草稿落盘（父级与提交层共用）。 */
  activeDraftStorageKeyRef: RefObject<string | null>;
  input: string;
  inputValueRef: RefObject<string>;
  setInput: Dispatch<SetStateAction<string>>;
  /** 附件层四件套：切会话时一并清空。 */
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  setDocumentReferences: Dispatch<SetStateAction<ContentReference[]>>;
  setUploadingImages: Dispatch<SetStateAction<Map<string, number>>>;
  setImageErrors: Dispatch<SetStateAction<Map<string, string>>>;
};

export function useComposerDraft({
  draftStorageKey,
  activeDraftStorageKeyRef,
  input,
  inputValueRef,
  setInput,
  setAttachedImages,
  setDocumentReferences,
  setUploadingImages,
  setImageErrors,
}: ComposerDraftOptions): void {
  // 未落盘的草稿（防抖窗口内）：卸载/页面卸载前同步 flush。
  const pendingDraftRef = useRef<{ key: string; value: string } | null>(null);
  const flushPendingDraft = () => {
    const pending = pendingDraftRef.current;
    if (!pending) return;
    pendingDraftRef.current = null;
    safeLocalStorage.setItem(pending.key, pending.value);
  };

  // 草稿防抖保存：连续击键不落盘（localStorage.setItem 是同步主线程 I/O），
  // 停顿 DRAFT_SAVE_DEBOUNCE_MS 后写一次。cleanup 只清 timer 不 flush——每次
  // input 变化（防抖重置）都会跑 cleanup，flush 会把上一版击键立即落盘、
  // 击穿防抖（回到每击键同步写盘）；flush 只保留给防抖届满（timer 回调）、
  // 真实卸载与页面卸载（下方两个 effect）。空输入同步删除（低频路径）。
  useEffect(() => {
    const key = activeDraftStorageKeyRef.current;
    if (!key) return;
    if (input === "") {
      pendingDraftRef.current = null;
      safeLocalStorage.removeItem(key);
      return;
    }
    pendingDraftRef.current = { key, value: input };
    const timer = setTimeout(() => {
      pendingDraftRef.current = null;
      safeLocalStorage.setItem(key, input);
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `activeDraftStorageKeyRef` 是本 hook 的入参（ref 对象，身份稳定）。
  }, [activeDraftStorageKeyRef, input]);

  // 组件真实卸载（路由切换/关闭）时 flush 未落盘草稿——empty-deps effect 的
  // cleanup 只在卸载执行，防抖 effect 的依赖重跑不会触发它。
  useEffect(() => flushPendingDraft, []);

  // 页面卸载（刷新/关闭）前 flush 未落盘草稿——整页关闭不触发组件卸载 cleanup，
  // 需 beforeunload 兜底。移动端与 bfcache 走 pagehide/visibilitychange（上游 #568）；
  // sati:flush-drafts 供「重新加载界面」按钮在 reload 前主动落盘（见 lib/uiDiagnostics）。
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushPendingDraft();
    };
    window.addEventListener("beforeunload", flushPendingDraft);
    window.addEventListener("pagehide", flushPendingDraft);
    window.addEventListener("sati:flush-drafts", flushPendingDraft);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", flushPendingDraft);
      window.removeEventListener("pagehide", flushPendingDraft);
      window.removeEventListener("sati:flush-drafts", flushPendingDraft);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  useEffect(() => {
    const previousKey = activeDraftStorageKeyRef.current;
    const previousInput = inputValueRef.current;
    if (previousKey && previousKey !== draftStorageKey) {
      if (previousInput !== "") safeLocalStorage.setItem(previousKey, previousInput);
      else safeLocalStorage.removeItem(previousKey);
    }

    activeDraftStorageKeyRef.current = draftStorageKey;
    const savedInput = draftStorageKey ? safeLocalStorage.getItem(draftStorageKey) || "" : "";
    setDocumentReferences([]);
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setInput(previous => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
    // 下列 setter / ref 都是入参（`useState` setter 与 ref 对象，身份稳定）；列入只为满足 exhaustive-deps。
  }, [
    activeDraftStorageKeyRef,
    draftStorageKey,
    inputValueRef,
    setAttachedImages,
    setDocumentReferences,
    setImageErrors,
    setInput,
    setUploadingImages,
  ]);
}
