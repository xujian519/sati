/**
 * 「从文件夹导入技能」的共享类型：原先定义在 `ImportFromFolder.tsx` 顶部，拆分后
 * 供 hook、展示子组件与入口共同引用（声明逐字未改，仅集中到本模块）。
 */
import type { useTranslation } from "react-i18next";

/** 父级传下来的翻译函数类型（与 Skills 面板其余子组件一致）。 */
export type Translator = ReturnType<typeof useTranslation>["t"];

export type ImportScope = "user" | "project";

export type ImportMode = "copy" | "symlink";

type ValidationIssue = { code: string; message: string };

export type ValidationResult = {
  ok: boolean;
  hardFails: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: { fileCount: number; totalBytes: number };
  frontmatter: Record<string, unknown> | null;
  sourcePath?: string;
};

export type PickedFiles = {
  rootName: string;
  files: File[];
  manifest: { relativePath: string; size: number }[];
  skillMd: string | null;
} | null;

export type BatchCandidate = {
  folderName: string;
  hasSkillMd: boolean;
  name: string | null;
  description: string | null;
  fileCount: number;
  totalSize: number;
  files: File[];
  sourcePath?: string;
};

export type BatchResultStatus = "pending" | "importing" | "success" | "error";

export type BatchResult = { folderName: string; status: BatchResultStatus; error?: string };
