/**
 * 上传限额单一事实源。
 *
 * 原先 50MB / 20 文件散落在 services/uploads.js 的三处（multer limits、中间件
 * 参数、错误文案），改一处漏一处会让"报错说 50MB、实际拦在别处"这类不一致无法
 * 被发现；前端也只能靠猜。集中后桌面端 / Web 端要分别调参只需改这里。
 */

const MB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  /** 单文件上限（字节）。 */
  maxFileBytes: 50 * MB,
  /** 单次请求的文件数上限。 */
  maxFileCount: 20,
};

export const UPLOAD_LIMIT_MESSAGES = {
  fileTooLarge: `File too large. Maximum size is ${UPLOAD_LIMITS.maxFileBytes / MB}MB.`,
  tooManyFiles: `Too many files. Maximum is ${UPLOAD_LIMITS.maxFileCount} files.`,
};

/** 对外公开的形状（`GET /api/upload/limits`）——前端据此在选文件前给出提示。 */
export function publicUploadLimits() {
  return {
    maxFileBytes: UPLOAD_LIMITS.maxFileBytes,
    maxFileCount: UPLOAD_LIMITS.maxFileCount,
  };
}
