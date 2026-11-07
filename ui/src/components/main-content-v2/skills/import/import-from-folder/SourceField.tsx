/**
 * 来源选择区：原生目录选择、路径输入、扫描按钮与已选文件夹信息条。
 * JSX 与 className 从原组件逐字搬出，仅把闭包变量换为 props。
 */
import type { ChangeEvent, RefObject } from "react";
import { Folder, FolderSearch, Loader2, X } from "lucide-react";
import { cn } from "../../../../../lib/utils.js";
import { Field } from "../../shared/Field";
import { formatBytes } from "../../shared/format";
import type { PickedFiles, Translator } from "./types";

export function SourceField({
  batchMode,
  sourcePath,
  picked,
  scanning,
  fileInputRef,
  onPickFolder,
  onScan,
  onSourcePathChange,
  onFolderSelected,
  onClearPicked,
  t,
}: {
  batchMode: boolean;
  sourcePath: string;
  picked: PickedFiles;
  scanning: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFolder: () => void;
  onScan: () => void;
  onSourcePathChange: (value: string) => void;
  onFolderSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onClearPicked: () => void;
  t: Translator;
}) {
  return (
    <Field
      label={t("skillsTab.importSource", { defaultValue: "Source folder" })}
      hint={
        !batchMode
          ? (t("skillsTab.importSourceHintBoth", {
              defaultValue:
                "Pick a folder via the native dialog, or paste an absolute path. ~ is expanded server-side.",
            }) as string)
          : undefined
      }
    >
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={onPickFolder}
          disabled={batchMode}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition",
            batchMode
              ? "cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600"
              : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900",
          )}
        >
          <Folder className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{t("skillsTab.pickFolder", { defaultValue: "Pick folder…" })}</span>
        </button>
        <button
          type="button"
          onClick={onScan}
          disabled={!sourcePath.trim() || scanning || batchMode}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition",
            !sourcePath.trim() || scanning || batchMode
              ? "cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600"
              : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900",
          )}
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <FolderSearch className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          <span>
            {scanning
              ? t("skillsTab.scanning", { defaultValue: "Scanning…" })
              : t("skillsTab.scan", { defaultValue: "Scan" })}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          // SAFETY: webkitdirectory 为非标准属性（Chromium/WebKit/Firefox 支持，Safari 忽略），
          // React DOM 类型未声明该属性，故在此显式豁免类型检查。
          // @ts-expect-error webkitdirectory is non-standard but supported in Chromium/WebKit/Firefox.
          webkitdirectory=""
          multiple
          onChange={onFolderSelected}
          className="hidden"
        />
        <input
          type="text"
          value={sourcePath}
          onChange={e => onSourcePathChange(e.target.value)}
          placeholder="~/code/my-skill"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={picked !== null || batchMode}
          className={cn(
            "h-8 flex-1 rounded-md border bg-white px-2 font-mono text-[12px] outline-hidden focus:border-neutral-400 dark:bg-neutral-950 dark:focus:border-neutral-600",
            picked || batchMode
              ? "cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600"
              : "border-neutral-200 dark:border-neutral-800",
          )}
        />
      </div>
      {picked ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-neutral-100 px-2.5 py-1.5 text-[12px] dark:bg-neutral-900">
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium">{picked.rootName}</span>
            <span className="ml-2 text-neutral-500 dark:text-neutral-400">
              {picked.files.length} {t("skillsTab.files", { defaultValue: "files" })} ·{" "}
              {formatBytes(picked.manifest.reduce((acc, m) => acc + m.size, 0))}
            </span>
          </div>
          <button
            type="button"
            onClick={onClearPicked}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <X className="h-3 w-3" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
    </Field>
  );
}
