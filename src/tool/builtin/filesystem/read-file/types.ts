import type { SatiToolRuntimeContext } from "../../../protocol/types.js";
import type { SatiPathSafetyResult } from "../pathSafety.js";

export type ReadFileInput = {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
};

export type ReadKind = "text" | "image" | "pdf" | "notebook";

/** 已通过 workspace 安全解析的目标路径（`resolveSatiWorkspacePath` 的成功分支）。 */
export type ReadResolvedTarget = Extract<SatiPathSafetyResult, { ok: true }>;

export type ReadFileStat = {
  size: number;
  mtimeMs: number;
};

/** 各读取分支共用的入参：去重登记由调用方（`read_file` 主流程）统一负责。 */
export type ReadFileHandlerContext = {
  input: ReadFileInput;
  context: SatiToolRuntimeContext;
  resolved: ReadResolvedTarget;
  fileStat: ReadFileStat;
  kind: ReadKind;
  markRead: (mtimeMs: number) => void;
};
