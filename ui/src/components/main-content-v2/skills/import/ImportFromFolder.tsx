import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Folder,
  FolderInput,
  FolderSearch,
  Loader2,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { authenticatedFetch } from "../../../../utils/api";
import { api } from "../shared/api";
import { cn } from "../../../../lib/utils.js";
import { Field } from "../shared/Field";
import { ScopeSelector } from "../shared/ScopeSelector";
import { formatBytes } from "../shared/format";
import type { NewModalCreated, Skill } from "../shared/types";
import { BatchImportPanel } from "./BatchImportPanel";
import { parseFrontmatterFields, stripRootPrefix } from "./frontmatter";

/**
 * 从文件夹导入技能：两（三）种输入模式——picked（浏览器给的 File 对象，走 multipart）、
 * typed（绝对路径，走 JSON /import，支持 copy/symlink）、batch（扫描父目录下的多个技能）。
 *
 * 从 `SkillsV2.tsx` 整体搬出（#159 UI-APP-N01 切片 A），**被搬代码逐字未改**
 * （逐 token 比对见 `/tmp/n04a-move-proof.mjs`）。原文件 2525 行里它一个人占 853 行。
 */

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

export function ImportFromFolder({
  projectAvailable,
  projectPath,
  onImported,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onImported: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  // Two input modes:
  //  - picked:    user clicked "Pick folder…" and the browser handed us
  //               File objects with webkitRelativePath. Always uses the
  //               multipart upload endpoint; symlink mode is unavailable
  //               because we don't have an absolute filesystem path.
  //  - typed:     user typed an absolute path; uses the JSON /import
  //               endpoint and supports both copy + symlink modes.
  const [sourcePath, setSourcePath] = useState("");
  const [picked, setPicked] = useState<PickedFiles>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [scope, setScope] = useState<"user" | "project">(projectAvailable ? "project" : "user");
  const [mode, setMode] = useState<"copy" | "symlink">("copy");
  const [force, setForce] = useState(false);
  const [importing, setImporting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const validationDebounceRef = useRef<number | undefined>(undefined);

  // Batch import state
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[] | null>(null);
  const [batchParentName, setBatchParentName] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [batchImporting, setBatchImporting] = useState(false);
  const [batchResults, setBatchResults] = useState<Map<string, BatchResult>>(new Map());
  const [batchDone, setBatchDone] = useState(false);
  const [scanning, setScanning] = useState(false);

  const batchMode = batchCandidates !== null;

  useEffect(() => {
    if (!projectAvailable && scope === "project") setScope("user");
  }, [projectAvailable, scope]);
  const selectedCount = selectedFolders.size;

  // Slug auto-fill: from picked-folder name OR typed-path basename.
  useEffect(() => {
    if (slugTouched) return;
    if (picked) {
      setSlug(picked.rootName);
      return;
    }
    const cleaned = sourcePath.trim().replace(/\/+$/, "");
    setSlug(cleaned ? cleaned.split("/").filter(Boolean).pop() || "" : "");
  }, [picked, sourcePath, slugTouched]);

  // Force "copy" when in picked mode (no source path on disk → can't symlink).
  useEffect(() => {
    if (picked && mode === "symlink") setMode("copy");
  }, [picked, mode]);

  // Validate on input change. Debounced so typing doesn't hammer the API.
  useEffect(() => {
    if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    setErrorText(null);
    if (!picked && !sourcePath.trim()) {
      setValidation(null);
      return;
    }
    setValidating(true);
    validationDebounceRef.current = window.setTimeout(
      async () => {
        try {
          const body = picked ? { skillMdContent: picked.skillMd ?? "", files: picked.manifest } : { sourcePath };
          const r = await api<ValidationResult>("/api/skills/validate", body);
          setValidation(r);
        } catch (e) {
          setValidation(null);
          setErrorText((e as Error).message);
        } finally {
          setValidating(false);
        }
      },
      picked ? 50 : 400,
    );
    return () => {
      if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    };
  }, [picked, sourcePath]);

  const slugValid = !slug || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug);
  const hasInput = picked !== null || sourcePath.trim().length > 0;
  const canSubmit = hasInput && slugValid && !importing && !validating && validation?.ok === true;

  const handlePickFolder = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList);
    const firstPath = files[0]?.webkitRelativePath || "";
    const rootName = firstPath.split("/")[0] || "";

    // Check if root directory directly has SKILL.md (single skill import)
    const rootSkillFile = files.find(f => {
      const rel = f.webkitRelativePath || f.name;
      return stripRootPrefix(rel, rootName) === "SKILL.md";
    });

    if (rootSkillFile) {
      // Single skill — existing flow
      const manifest: { relativePath: string; size: number }[] = files.map(f => {
        const rel = f.webkitRelativePath || f.name;
        return { relativePath: stripRootPrefix(rel, rootName), size: f.size };
      });
      const skillMd = await rootSkillFile.text();
      setPicked({ rootName, files, manifest, skillMd });
      setSourcePath("");
      setSlugTouched(false);
      if (event.target) event.target.value = "";
      return;
    }

    // No root SKILL.md — check subdirectories for batch mode
    const subDirMap = new Map<string, File[]>();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const stripped = stripRootPrefix(rel, rootName);
      const firstSeg = stripped.split("/")[0];
      if (!firstSeg || !stripped.includes("/")) continue;
      if (!subDirMap.has(firstSeg)) subDirMap.set(firstSeg, []);
      subDirMap.get(firstSeg)!.push(f);
    }

    const candidates: BatchCandidate[] = [];
    for (const [folderName, folderFiles] of subDirMap) {
      const skillFile = folderFiles.find(f => {
        const rel = f.webkitRelativePath || f.name;
        const prefix = rootName ? rootName + "/" + folderName : folderName;
        return stripRootPrefix(rel, prefix) === "SKILL.md";
      });

      let name: string | null = null;
      let description: string | null = null;
      if (skillFile) {
        const content = await skillFile.text();
        const parsed = parseFrontmatterFields(content);
        name = parsed.name;
        description = parsed.description;
      }

      candidates.push({
        folderName,
        hasSkillMd: !!skillFile,
        name,
        description,
        fileCount: folderFiles.length,
        totalSize: folderFiles.reduce((acc, f) => acc + f.size, 0),
        files: folderFiles,
      });
    }

    candidates.sort((a, b) => {
      if (a.hasSkillMd !== b.hasSkillMd) return a.hasSkillMd ? -1 : 1;
      return a.folderName.localeCompare(b.folderName);
    });

    setBatchCandidates(candidates);
    setBatchParentName(rootName);
    const skillNames = candidates.filter(c => c.hasSkillMd).map(c => c.folderName);
    setSelectedFolders(new Set(skillNames));
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
    setSourcePath("");
    setPicked(null);
    if (event.target) event.target.value = "";
  }, []);

  const clearPicked = useCallback(() => {
    setPicked(null);
    setValidation(null);
    setSlugTouched(false);
  }, []);

  const clearBatch = useCallback(() => {
    setBatchCandidates(null);
    setBatchParentName("");
    setSelectedFolders(new Set());
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
  }, []);

  const handleScan = useCallback(async () => {
    if (!sourcePath.trim()) return;
    setScanning(true);
    try {
      const r = await api<{
        parentPath: string;
        folders: Array<{
          folderName: string;
          hasSkillMd: boolean;
          name: string | null;
          description: string | null;
          sourcePath: string;
          fileCount: number;
          totalSize: number;
        }>;
      }>("/api/skills/scan", { parentPath: sourcePath.trim() });
      const candidates: BatchCandidate[] = r.folders.map(f => ({
        ...f,
        files: [],
      }));
      setBatchCandidates(candidates);
      setBatchParentName(sourcePath.trim().split("/").filter(Boolean).pop() || sourcePath.trim());
      const skillNames = candidates.filter(c => c.hasSkillMd).map(c => c.folderName);
      setSelectedFolders(new Set(skillNames));
      setBatchResults(new Map());
      setBatchDone(false);
      setBatchImporting(false);
      setPicked(null);
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [sourcePath]);

  const handleToggleFolder = useCallback((folderName: string) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    if (!batchCandidates) return;
    const skills = batchCandidates.filter(c => c.hasSkillMd);
    const allSelected = skills.every(c => selectedFolders.has(c.folderName));
    if (allSelected) {
      setSelectedFolders(new Set());
    } else {
      setSelectedFolders(new Set(skills.map(c => c.folderName)));
    }
  }, [batchCandidates, selectedFolders]);

  const submitBatch = useCallback(async () => {
    if (!batchCandidates || selectedCount === 0) return;
    setBatchImporting(true);
    setBatchDone(false);
    const selected = batchCandidates.filter(c => c.hasSkillMd && selectedFolders.has(c.folderName));

    const results = new Map<string, BatchResult>();
    for (const c of selected) {
      results.set(c.folderName, { folderName: c.folderName, status: "pending" });
    }
    setBatchResults(new Map(results));

    let successCount = 0;
    for (const candidate of selected) {
      results.set(candidate.folderName, { folderName: candidate.folderName, status: "importing" });
      setBatchResults(new Map(results));

      try {
        const effectiveScope = projectAvailable ? scope : "user";
        if (candidate.sourcePath) {
          // Scan mode — use path-based import
          await api<{ ok: boolean }>("/api/skills/import", {
            sourcePath: candidate.sourcePath,
            slug: candidate.folderName,
            scope: effectiveScope,
            projectPath: effectiveScope === "project" ? projectPath : null,
            mode,
            force,
          });
        } else {
          // Pick folder mode — use multipart upload
          const rootName = batchParentName;
          const formData = new FormData();
          const paths: string[] = [];
          const prefix = rootName + "/" + candidate.folderName;
          for (const file of candidate.files) {
            formData.append("files", file);
            const rel = file.webkitRelativePath || file.name;
            paths.push(stripRootPrefix(rel, prefix));
          }
          formData.append("paths", JSON.stringify(paths));
          formData.append("slug", candidate.folderName);
          formData.append("scope", effectiveScope);
          if (effectiveScope === "project" && projectPath) formData.append("projectPath", projectPath);
          if (force) formData.append("force", "true");

          const r = await authenticatedFetch("/api/skills/import-upload", {
            method: "POST",
            body: formData,
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
          }
        }
        results.set(candidate.folderName, { folderName: candidate.folderName, status: "success" });
        successCount++;
      } catch (e) {
        results.set(candidate.folderName, {
          folderName: candidate.folderName,
          status: "error",
          error: (e as Error).message,
        });
      }
      setBatchResults(new Map(results));
    }

    setBatchImporting(false);
    setBatchDone(true);

    if (successCount > 0) {
      onImported({
        slug: selected[0].folderName,
        name: selected[0].name || selected[0].folderName,
        scope: projectAvailable ? scope : "user",
      });
    }
  }, [
    batchCandidates,
    selectedCount,
    selectedFolders,
    projectAvailable,
    scope,
    projectPath,
    mode,
    force,
    batchParentName,
    onImported,
  ]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setImporting(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : "user";
      if (picked) {
        // Multipart upload path. We send the relativePath array as a
        // separate JSON field because multer drops folder paths from
        // multipart filenames.
        const formData = new FormData();
        for (let i = 0; i < picked.files.length; i++) {
          // The browser put webkitRelativePath on the File; multer only
          // surfaces basename. Append with a stable name and ferry paths
          // alongside.
          formData.append("files", picked.files[i]);
        }
        formData.append("paths", JSON.stringify(picked.manifest.map(m => m.relativePath)));
        if (slug) formData.append("slug", slug);
        formData.append("scope", effectiveScope);
        if (effectiveScope === "project" && projectPath) formData.append("projectPath", projectPath);
        if (force) formData.append("force", "true");

        const r = await authenticatedFetch("/api/skills/import-upload", {
          method: "POST",
          body: formData,
        });
        const data = await r.json().catch(() => ({}) as Record<string, unknown>);
        if (!r.ok) {
          if (data.validation) setValidation(data.validation as ValidationResult);
          throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
        }
        const result = data as { slug: string; scope: "user" | "project"; skill: Skill | null };
        onImported({ slug: result.slug, name: result.skill?.name || result.slug, scope: result.scope });
      } else {
        // Path-based path. /api/skills/import runs the same validator
        // server-side, so a hardFail still blocks here.
        const r = await api<{
          ok: boolean;
          slug: string;
          scope: "user" | "project";
          skillPath: string;
          skill: Skill | null;
          mode: string;
          validation?: ValidationResult;
        }>("/api/skills/import", {
          sourcePath,
          slug: slug || undefined,
          scope: effectiveScope,
          projectPath: effectiveScope === "project" ? projectPath : null,
          mode,
          force,
        });
        onImported({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/already exists/i.test(msg) && !force) {
        setErrorText(
          msg + " " + t("skillsTab.importEnableForce", { defaultValue: 'Enable "Overwrite" to replace it.' }),
        );
      } else {
        setErrorText(msg);
      }
    } finally {
      setImporting(false);
    }
  }, [canSubmit, picked, sourcePath, slug, projectAvailable, scope, projectPath, mode, force, onImported, t]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Source: pick or paste */}
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
              onClick={handlePickFolder}
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
              onClick={handleScan}
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
              onChange={handleFolderSelected}
              className="hidden"
            />
            <input
              type="text"
              value={sourcePath}
              onChange={e => {
                setSourcePath(e.target.value);
                if (picked) setPicked(null);
                if (batchMode) clearBatch();
              }}
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
                onClick={clearPicked}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                <X className="h-3 w-3" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </Field>

        {/* ---- Batch mode: candidate list ---- */}
        {batchMode ? (
          <BatchImportPanel
            candidates={batchCandidates}
            parentName={batchParentName}
            selectedFolders={selectedFolders}
            importing={batchImporting}
            results={batchResults}
            done={batchDone}
            scope={scope}
            onScopeChange={setScope}
            projectAvailable={projectAvailable}
            force={force}
            onForceChange={setForce}
            onToggleFolder={handleToggleFolder}
            onToggleAll={handleToggleAll}
            onClear={clearBatch}
            t={t}
          />
        ) : (
          <>
            {/* ---- Single import mode (existing UI) ---- */}
            <Field
              label={t("skillsTab.importSlug", { defaultValue: "Slug (target folder name)" })}
              hint={
                t("skillsTab.importSlugHint", {
                  defaultValue: "Defaults to the source folder name. Edit to override.",
                }) as string
              }
            >
              <input
                type="text"
                value={slug}
                onChange={e => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                placeholder="my-skill"
                className={cn(
                  "h-8 w-full rounded-md border bg-white px-2 font-mono text-[12px] outline-hidden dark:bg-neutral-950",
                  slugValid
                    ? "border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600"
                    : "border-red-300 dark:border-red-800",
                )}
              />
            </Field>

            <Field label={t("skillsTab.importMode", { defaultValue: "Import mode" })}>
              <div className="flex flex-col gap-1.5 text-[12px]">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === "copy"}
                    onChange={() => setMode("copy")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{t("skillsTab.importModeCopy", { defaultValue: "Copy" })}</span>
                    <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                      {t("skillsTab.importModeCopyHint", {
                        defaultValue: "— independent copy, edits live in the skills folder.",
                      })}
                    </span>
                  </span>
                </label>
                <label
                  className={cn("flex items-start gap-2", picked ? "cursor-not-allowed opacity-50" : "cursor-pointer")}
                >
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === "symlink"}
                    disabled={picked !== null}
                    onChange={() => setMode("symlink")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{t("skillsTab.importModeSymlink", { defaultValue: "Symlink" })}</span>
                    <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                      {picked
                        ? t("skillsTab.symlinkUnavailable", {
                            defaultValue: "— unavailable for picker uploads (no source path on disk).",
                          })
                        : t("skillsTab.importModeSymlinkHint", {
                            defaultValue:
                              "— edits in the source folder propagate live; deleting the source breaks the skill.",
                          })}
                    </span>
                  </span>
                </label>
              </div>
            </Field>

            <ValidationPanel result={validation} validating={validating} t={t} />

            <div className="mt-4 flex items-center justify-between gap-3">
              <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />
                <span>{t("skillsTab.importForce", { defaultValue: "Overwrite if exists" })}</span>
              </label>
            </div>
          </>
        )}

        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
        {batchMode ? (
          batchDone ? (
            <button
              type="button"
              onClick={() => {
                clearBatch();
                onImported({ slug: "", name: "", scope });
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t("skillsTab.batchDone", { defaultValue: "Done" })}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={submitBatch}
              disabled={selectedCount === 0 || batchImporting}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {batchImporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              <span>
                {batchImporting
                  ? t("skillsTab.importing", { defaultValue: "Importing…" })
                  : t("skillsTab.importNSkills", { defaultValue: "Import {{count}} skills", count: selectedCount })}
              </span>
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            <span>
              {importing
                ? t("skillsTab.importing", { defaultValue: "Importing…" })
                : t("skillsTab.importAction", { defaultValue: "Import skill" })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function ValidationPanel({
  result,
  validating,
  t,
}: {
  result: ValidationResult | null;
  validating: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (!result && !validating) return null;
  return (
    <div className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 text-[12px] font-medium dark:border-neutral-800">
        <ShieldCheck className="h-3.5 w-3.5 text-neutral-500" strokeWidth={1.75} />
        <span>{t("skillsTab.complianceCheck", { defaultValue: "Compliance check" })}</span>
        {validating ? (
          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
        ) : result?.ok ? (
          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" strokeWidth={1.75} />
        ) : (
          <XCircle className="ml-auto h-3.5 w-3.5 text-red-600 dark:text-red-500" strokeWidth={1.75} />
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[12px]">
        {result?.stats ? (
          <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
            <span>
              {result.stats.fileCount} {t("skillsTab.files", { defaultValue: "files" })}
            </span>
            <span>·</span>
            <span>{formatBytes(result.stats.totalBytes)}</span>
            {result.frontmatter && (result.frontmatter as { name?: string }).name ? (
              <>
                <span>·</span>
                <span className="truncate">
                  name: <span className="font-mono">{(result.frontmatter as { name: string }).name}</span>
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {result?.hardFails && result.hardFails.length > 0 ? (
          <ul className="space-y-1">
            {result.hardFails.map((iss, i) => (
              <li key={`f${i}`} className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
                <XCircle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.warnings && result.warnings.length > 0 ? (
          <ul className="space-y-1">
            {result.warnings.map((iss, i) => (
              <li key={`w${i}`} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.ok && (!result.warnings || result.warnings.length === 0) ? (
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
            <span>{t("skillsTab.complianceClean", { defaultValue: "All checks passed." })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
