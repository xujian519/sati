import { useCallback, useState, type ClipboardEvent, type Dispatch, type SetStateAction } from "react";
import { logError, logWarn } from "../../../utils/logging";
import type { ContentReference } from "../../../types/contentReference";

/**
 * 附件层：拖拽/粘贴进来的图片、文档引用、上传进度与错误。
 *
 * 从 `useChatComposerState.ts` 整体搬出（#159 N01 缝 1），**被搬代码逐字未改**：
 * 四个 state、`resetAttachmentState`、`handleImageFiles`、`handlePaste`，以及附件相关的
 * 常量与纯函数（`MAX_ATTACHMENT*`、`AttachmentAddResult`/`addAttachmentFiles`）。
 *
 * 唯一改写点（缝 1 的环）：`handleImageFiles` 写 state 时要通知父级的"忙碌队列快照"，
 * 而那个同步器（`syncQueuedBusySendSnapshot`）**反过来要读附件状态**，两者互相依赖。
 * 故此处不直接持有它，而是接收一个**后绑定**的转发函数（父级在定义真正的同步器之后
 * 用 effect 把它填进 ref）。事件处理器一律在渲染提交之后执行，读到的是当前值——与原先
 * "闭包捕获最近一次渲染的 state"等价。选项刻意与被搬代码里的调用名同名，使搬移逐字不变。
 */

export const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENTS_ERROR_KEY = "__max_attachments__";

export type AttachmentAddResult = {
  files: File[];
  droppedCount: number;
};

export function addAttachmentFiles(
  currentFiles: File[],
  incomingFiles: File[],
  maxAttachments = MAX_ATTACHMENTS,
): AttachmentAddResult {
  const mergedFiles = [...currentFiles, ...incomingFiles];

  return {
    files: mergedFiles.slice(0, maxAttachments),
    droppedCount: Math.max(0, mergedFiles.length - maxAttachments),
  };
}

type AttachmentUploadOptions = {
  /** 后绑定：父级用 ref 转发到真正的 `syncQueuedBusySendSnapshot`（见文件头说明）。 */
  syncQueuedBusySendSnapshot: (updates: { attachedImages?: File[]; documentReferences?: ContentReference[] }) => void;
};

type AttachmentUploadApi = {
  attachedImages: File[];
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  documentReferences: ContentReference[];
  setDocumentReferences: Dispatch<SetStateAction<ContentReference[]>>;
  uploadingImages: Map<string, number>;
  setUploadingImages: Dispatch<SetStateAction<Map<string, number>>>;
  imageErrors: Map<string, string>;
  setImageErrors: Dispatch<SetStateAction<Map<string, string>>>;
  /** 附件/引用状态清理四件套（提交、slash 命令、清空输入共用）。 */
  resetAttachmentState: () => void;
  handleImageFiles: (files: File[]) => void;
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
};

export function useAttachmentUpload({ syncQueuedBusySendSnapshot }: AttachmentUploadOptions): AttachmentUploadApi {
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [documentReferences, setDocumentReferences] = useState<ContentReference[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());

  const resetAttachmentState = useCallback(() => {
    setAttachedImages([]);
    setDocumentReferences([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
  }, []);

  const handleImageFiles = useCallback(
    (files: File[]) => {
      const validFiles = files.filter(file => {
        try {
          if (!file || typeof file !== "object") {
            logWarn("Invalid file object:", file);
            return false;
          }

          if (typeof file.size !== "number" || file.size > MAX_ATTACHMENT_SIZE_BYTES) {
            const fileName = file.name || "Unknown file";
            setImageErrors(previous => {
              const next = new Map(previous);
              next.set(fileName, "File too large (max 20MB)");
              return next;
            });
            return false;
          }

          return true;
        } catch (error) {
          logError("Error validating file:", error, file);
          return false;
        }
      });

      setImageErrors(previous => {
        if (!previous.has(MAX_ATTACHMENTS_ERROR_KEY)) return previous;
        const next = new Map(previous);
        next.delete(MAX_ATTACHMENTS_ERROR_KEY);
        return next;
      });

      if (validFiles.length > 0) {
        setAttachedImages(previous => {
          const result = addAttachmentFiles(previous, validFiles);
          if (result.droppedCount > 0) {
            setImageErrors(previousErrors => {
              const next = new Map(previousErrors);
              next.set(
                MAX_ATTACHMENTS_ERROR_KEY,
                `Only the first ${MAX_ATTACHMENTS} attachments were added; ${result.droppedCount} file${result.droppedCount === 1 ? "" : "s"} skipped.`,
              );
              return next;
            });
          }
          syncQueuedBusySendSnapshot({ attachedImages: result.files });
          return result.files;
        });
      }
    },
    [syncQueuedBusySendSnapshot],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      const pastedFiles: File[] = [];

      items.forEach(item => {
        if (item.kind !== "file") return;
        const file = item.getAsFile();
        if (file) {
          pastedFiles.push(file);
        }
      });

      if (pastedFiles.length > 0) {
        handleImageFiles(pastedFiles);
        event.preventDefault();
        return;
      }

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        if (files.length > 0) {
          handleImageFiles(files);
          event.preventDefault();
        }
      }
    },
    [handleImageFiles],
  );

  return {
    attachedImages,
    setAttachedImages,
    documentReferences,
    setDocumentReferences,
    uploadingImages,
    setUploadingImages,
    imageErrors,
    setImageErrors,
    resetAttachmentState,
    handleImageFiles,
    handlePaste,
  };
}
