import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import {
  ArrowLeft,
  ArrowRightLeft,
  Download,
  Folder,
  FolderInput,
  Globe,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { Project } from "../../types/app";
import { useTheme } from "../../contexts/ThemeContext";
import { UI_TIMEOUTS } from "../../constants/timeouts";
import { zincDarkTheme, zincLightTheme } from "../code-editor/utils/zincThemes";
import { cn } from "../../lib/utils.js";
import { Field } from "./skills/shared/Field";
import { ScopeSelector } from "./skills/shared/ScopeSelector";
import type { NewModalCreated, Skill, SkillScope } from "./skills/shared/types";
import { api } from "./skills/shared/api";
import { ImportFromFolder } from "./skills/import/ImportFromFolder";

type SkillsV2Props = {
  selectedProject: Project | null;
  projects: Project[];
  compact?: boolean;
};

type SkillsListResponse = {
  builtin: Skill[];
  user: Skill[];
  project: Skill[];
  projectPath: string | null;
  isGeneralCwd: boolean;
};

type SearchResult = { slug: string; name: string; score: number | null };

type InstallResponse = {
  ok: boolean;
  slug: string;
  scope: "user" | "project";
  installPath: string;
  installed: boolean;
  skill: Skill | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  needsForce: boolean;
};

type ToastState = { kind: "success" | "error" | "info"; text: string } | null;

// ---------------------------------------------------------------------------

function projectCwd(p: Project | null): string | null {
  if (!p) return null;
  return p.fullPath || p.path || null;
}

function isGeneralProject(p: Project | null): boolean {
  if (!p) return false;
  return p.name === "general" || p.displayName === "general";
}

// ---------------------------------------------------------------------------

export default function SkillsV2({ selectedProject, projects, compact = false }: SkillsV2Props) {
  const { t } = useTranslation();
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };

  const cwd = projectCwd(selectedProject);
  const localGeneralCwd = isGeneralProject(selectedProject);

  const [skills, setSkills] = useState<SkillsListResponse | null>(null);
  const [serverGeneralCwdPath, setServerGeneralCwdPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<SkillScope | null>(null);
  const [editorContent, setEditorContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const serverGeneralCwd = Boolean(cwd && serverGeneralCwdPath === cwd);
  const generalCwd = localGeneralCwd || serverGeneralCwd;
  const effectiveProjectPath = generalCwd ? null : cwd;

  const flashToast = useCallback((toastValue: ToastState, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SkillsListResponse>("/api/skills/list", {
        projectPath: effectiveProjectPath,
      });
      setSkills(data);
      setServerGeneralCwdPath(prev => {
        if (!cwd) return null;
        if (data.isGeneralCwd) return cwd;
        if (effectiveProjectPath === null && (localGeneralCwd || prev === cwd)) return prev;
        return prev === cwd ? null : prev;
      });
    } catch (e) {
      flashToast({ kind: "error", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [cwd, effectiveProjectPath, flashToast, localGeneralCwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (generalCwd && activeScope === "project") {
      setActiveScope(null);
      setActiveSlug(null);
    }
  }, [activeScope, generalCwd]);

  const activeSkill = useMemo(() => {
    if (!skills || !activeSlug) return null;
    const list = activeScope === "builtin" ? skills.builtin : activeScope === "project" ? skills.project : skills.user;
    return list.find(s => s.slug === activeSlug) ?? null;
  }, [skills, activeSlug, activeScope]);

  // Load SKILL.md when active skill changes
  useEffect(() => {
    if (!activeSkill) {
      setEditorContent("");
      setOriginalContent("");
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    api<{ content: string }>("/api/skills/read", {
      skillPath: activeSkill.skillDir,
      projectPath: effectiveProjectPath,
    })
      .then(data => {
        if (cancelled) return;
        setEditorContent(data.content);
        setOriginalContent(data.content);
      })
      .catch(e => {
        if (cancelled) return;
        flashToast({ kind: "error", text: (e as Error).message });
        setEditorContent("");
        setOriginalContent("");
      })
      .finally(() => {
        if (!cancelled) setEditorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSkill, effectiveProjectPath, flashToast]);

  const isDirty = editorContent !== originalContent;

  const handleSave = useCallback(async () => {
    if (!activeSkill) return;
    setSaving(true);
    try {
      const result = await api<{ ok: boolean; skill: Skill }>("/api/skills/write", {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
        content: editorContent,
      });
      setOriginalContent(editorContent);
      // Patch the skill in-place so list metadata (name/desc) refreshes.
      setSkills(prev => {
        if (!prev) return prev;
        const updateIn = (list: Skill[]) =>
          list.map(s =>
            s.slug === activeSkill.slug && s.scope === activeSkill.scope
              ? { ...s, ...result.skill, scope: activeSkill.scope }
              : s,
          );
        return {
          ...prev,
          user: updateIn(prev.user),
          project: updateIn(prev.project),
        };
      });
      flashToast({ kind: "success", text: t("skillsTab.savedSuccess", { defaultValue: "Saved" }) });
    } catch (e) {
      flashToast({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [activeSkill, editorContent, effectiveProjectPath, flashToast, t]);

  const handleDelete = useCallback(async () => {
    if (!activeSkill || activeSkill.readonly) return;
    if (
      !window.confirm(
        t("skillsTab.confirmDelete", {
          defaultValue: "Delete this skill? This will remove the entire folder.",
          name: activeSkill.name,
        }) as string,
      )
    ) {
      return;
    }
    try {
      await api("/api/skills/delete", {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
      });
      setActiveSlug(null);
      setActiveScope(null);
      await refresh();
      flashToast({ kind: "success", text: t("skillsTab.deletedSuccess", { defaultValue: "Deleted" }) });
    } catch (e) {
      flashToast({ kind: "error", text: (e as Error).message });
    }
  }, [activeSkill, effectiveProjectPath, refresh, flashToast, t]);

  const handleSelect = useCallback(
    (skill: Skill) => {
      if (isDirty) {
        if (!window.confirm(t("skillsTab.discardUnsaved", { defaultValue: "Discard unsaved changes?" }) as string)) {
          return;
        }
      }
      setActiveSlug(skill.slug);
      setActiveScope(skill.scope);
    },
    [isDirty, t],
  );

  // ------------------------------------------------------------------------

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t("skillsTab.pickProject", { defaultValue: "Open a project to manage its skills." })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950">
      <Header
        cwd={cwd}
        generalCwd={generalCwd}
        loading={loading}
        onRefresh={refresh}
        onNew={() => setShowNew(true)}
        compact={compact}
        t={t}
      />

      <div className="flex min-h-0 flex-1">
        {!compact || !activeSkill ? (
          <SkillsList
            skills={skills}
            loading={loading}
            activeSlug={activeSlug}
            activeScope={activeScope}
            generalCwd={generalCwd}
            onSelect={handleSelect}
            selectedSkill={activeSkill}
            effectiveProjectPath={effectiveProjectPath}
            projects={projects}
            refresh={refresh}
            flashToast={flashToast}
            setActiveSlug={setActiveSlug}
            setActiveScope={setActiveScope}
            compact={compact}
            t={t}
          />
        ) : null}
        {!compact || activeSkill ? (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !compact && "border-l border-neutral-200 dark:border-neutral-800",
            )}
          >
            {compact && activeSkill ? (
              <button
                type="button"
                onClick={() => {
                  if (
                    isDirty &&
                    !window.confirm(
                      t("skillsTab.discardUnsaved", { defaultValue: "Discard unsaved changes?" }) as string,
                    )
                  )
                    return;
                  setActiveSlug(null);
                  setActiveScope(null);
                }}
                className="flex h-9 shrink-0 items-center gap-1.5 border-b border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t("skillsTab.backToSkills", { defaultValue: "Back to skills" })}</span>
              </button>
            ) : null}
            {activeSkill ? (
              <SkillDetail
                skill={activeSkill}
                content={editorContent}
                onChange={setEditorContent}
                isDirty={isDirty}
                loading={editorLoading}
                saving={saving}
                isDarkMode={isDarkMode}
                onSave={handleSave}
                onDelete={handleDelete}
                onRevert={() => setEditorContent(originalContent)}
                compact={compact}
                t={t}
              />
            ) : (
              <EmptyState t={t} />
            )}
          </div>
        ) : null}
      </div>

      {showNew ? (
        <NewSkillModal
          onClose={() => setShowNew(false)}
          onCreated={async created => {
            await refresh();
            setActiveSlug(created.slug);
            setActiveScope(created.scope);
            setShowNew(false);
            flashToast({
              kind: "success",
              text: t("skillsTab.installedSuccess", { defaultValue: "Installed", name: created.name }),
            });
          }}
          projectAvailable={Boolean(effectiveProjectPath)}
          projectPath={effectiveProjectPath}
          t={t}
        />
      ) : null}

      {toast ? (
        <div
          className={cn(
            "pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg",
            toast.kind === "success" && "bg-emerald-600 text-white",
            toast.kind === "error" && "bg-red-600 text-white",
            toast.kind === "info" && "bg-neutral-800 text-white",
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  cwd,
  generalCwd,
  loading,
  onRefresh,
  onNew,
  compact,
  t,
}: {
  cwd: string | null;
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
  onNew: () => void;
  compact: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 dark:border-neutral-800",
        compact ? "px-3" : "px-6",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.75} />
        {generalCwd ? (
          <span>{t("skillsTab.generalChat", { defaultValue: "General chat — built-in and user skills" })}</span>
        ) : (
          <span className="truncate">{cwd}</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t("skillsTab.refresh", { defaultValue: "Refresh" }) as string}
          aria-label={t("skillsTab.refresh", { defaultValue: "Refresh" }) as string}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{t("skillsTab.newSkill", { defaultValue: "New" })}</span>
        </button>
      </div>
    </div>
  );
}

type MoveTarget = { scope: "user"; projectPath: null } | { scope: "project"; projectPath: string };

function SkillsList({
  skills,
  loading,
  activeSlug,
  activeScope,
  generalCwd,
  onSelect,
  selectedSkill,
  effectiveProjectPath,
  projects,
  refresh,
  flashToast,
  setActiveSlug,
  setActiveScope,
  compact,
  t,
}: {
  skills: SkillsListResponse | null;
  loading: boolean;
  activeSlug: string | null;
  activeScope: SkillScope | null;
  generalCwd: boolean;
  onSelect: (s: Skill) => void;
  selectedSkill: Skill | null;
  effectiveProjectPath: string | null;
  projects: Project[];
  refresh: () => Promise<void>;
  flashToast: (t: ToastState, ms?: number) => void;
  setActiveSlug: (slug: string | null) => void;
  setActiveScope: (scope: SkillScope | null) => void;
  compact: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const handleDeleteSkill = useCallback(
    async (skill: Skill) => {
      if (skill.readonly) return;
      if (
        !window.confirm(
          t("skillsTab.confirmUninstall", {
            defaultValue: 'Uninstall "{{name}}"? This will remove the entire skill folder.',
            name: skill.name,
          }) as string,
        )
      ) {
        return;
      }
      try {
        await api("/api/skills/delete", {
          skillPath: skill.skillDir,
          projectPath: effectiveProjectPath,
        });
        if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
          setActiveSlug(null);
          setActiveScope(null);
        }
        await refresh();
        flashToast({
          kind: "success",
          text: t("skillsTab.uninstallSuccess", { defaultValue: 'Uninstalled "{{name}}"', name: skill.name }) as string,
        });
      } catch (e) {
        flashToast({ kind: "error", text: (e as Error).message });
      }
    },
    [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveSlug, setActiveScope, t],
  );

  const handleMoveSkill = useCallback(
    async (skill: Skill, target: MoveTarget) => {
      if (skill.readonly) return;
      try {
        await api("/api/skills/import", {
          sourcePath: skill.skillDir,
          slug: skill.slug,
          scope: target.scope,
          projectPath: target.projectPath,
          mode: "copy",
          force: false,
        });
        await api("/api/skills/delete", {
          skillPath: skill.skillDir,
          projectPath: effectiveProjectPath,
        });
        if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
          setActiveScope(target.scope);
        }
        await refresh();
        const label = target.scope === "user" ? "User" : target.projectPath.split("/").pop() || "Project";
        flashToast({
          kind: "success",
          text: t("skillsTab.moveSuccess", {
            defaultValue: 'Moved "{{name}}" to {{scope}}',
            name: skill.name,
            scope: label,
          }) as string,
        });
      } catch (e) {
        flashToast({ kind: "error", text: (e as Error).message });
      }
    },
    [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveScope, t],
  );

  const moveTargets = useMemo((): { label: string; target: MoveTarget }[] => {
    const targets: { label: string; target: MoveTarget }[] = [];
    targets.push({ label: "User (global)", target: { scope: "user", projectPath: null } });
    for (const project of projects) {
      const path = project.fullPath || project.path || null;
      if (!path) continue;
      if (project.name === "general" || project.displayName === "general") continue;
      targets.push({
        label: project.displayName || project.name,
        target: { scope: "project", projectPath: path },
      });
    }
    return targets;
  }, [projects]);

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col",
        compact ? "w-full" : "w-72 border-r border-neutral-200 dark:border-neutral-800",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]">
        {loading && !skills ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t("skillsTab.loading", { defaultValue: "Loading…" })}</span>
          </div>
        ) : (
          <>
            {!generalCwd && skills?.project && skills.project.length > 0 ? (
              <ListSection
                title={t("skillsTab.projectScope", { defaultValue: "Project Skills" })}
                items={skills.project}
                activeSlug={activeScope === "project" ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills?.user && skills.user.length > 0 ? (
              <ListSection
                title={t("skillsTab.userScope", { defaultValue: "User Skills" })}
                items={skills.user}
                activeSlug={activeScope === "user" ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills?.builtin && skills.builtin.length > 0 ? (
              <BuiltinSkillsNotice count={skills.builtin.length} t={t} />
            ) : null}
            {skills &&
            skills.builtin.length === 0 &&
            skills.user.length === 0 &&
            (generalCwd || skills.project.length === 0) ? (
              <div className="px-4 py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
                {t("skillsTab.empty", { defaultValue: 'No skills yet. Click "New" to install or create one.' })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

type ContextMenuState = { skill: Skill; x: number; y: number } | null;

// Built-in skills ship with the app and are read-only, so instead of a
// clickable list (which implies editability) we show a short notice.
function BuiltinSkillsNotice({ count, t }: { count: number; t: ReturnType<typeof useTranslation>["t"] }) {
  return (
    <div className="mb-2">
      <div className="px-4 py-1 text-xxs tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
        {t("skillsTab.builtinScope", { defaultValue: "Built-in Skills" })}{" "}
        <span className="text-neutral-300 dark:text-neutral-600">· {count}</span>
      </div>
      <div className="mx-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xxs leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400">
        {t("skillsTab.builtinNotice", {
          defaultValue:
            "Built-in skills ship with the app and are read-only. To modify one, copy it to your user skills first.",
        })}
      </div>
    </div>
  );
}

function ListSection({
  title,
  items,
  activeSlug,
  onSelect,
  onDelete,
  onMove,
  moveTargets,
  currentProjectPath,
  t,
}: {
  title: string;
  items: Skill[];
  activeSlug: string | null;
  onSelect: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  onMove: (s: Skill, target: MoveTarget) => void;
  moveTargets: { label: string; target: MoveTarget }[];
  currentProjectPath: string | null;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleClose = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === "Escape") {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
        return;
      }
      if (e instanceof MouseEvent && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener("mousedown", handleClose);
    document.addEventListener("keydown", handleClose);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("keydown", handleClose);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, skill: Skill) => {
    if (skill.readonly) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ skill, x: e.clientX, y: e.clientY });
    setShowMoveSubmenu(false);
  }, []);

  const filteredMoveTargets = useMemo(() => {
    if (!ctxMenu) return [];
    const skill = ctxMenu.skill;
    if (skill.readonly) return [];
    return moveTargets.filter(mt => {
      if (skill.scope === "user" && mt.target.scope === "user") return false;
      if (skill.scope === "project" && mt.target.scope === "project" && mt.target.projectPath === currentProjectPath)
        return false;
      return true;
    });
  }, [ctxMenu, moveTargets, currentProjectPath]);

  return (
    <div className="mb-2">
      <div className="px-4 py-1 text-xxs tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
        {title} <span className="text-neutral-300 dark:text-neutral-600">· {items.length}</span>
      </div>
      <ul className="space-y-0.5 px-2">
        {items.map(s => {
          const isActive = activeSlug === s.slug;
          return (
            <li key={`${s.scope}:${s.slug}`} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(s)}
                onContextMenu={s.readonly ? undefined : e => handleContextMenu(e, s)}
                className={cn(
                  "block w-full truncate rounded-md px-2 py-1.5 pr-8 text-left text-[13px] transition-colors",
                  isActive
                    ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                    : "text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900/60",
                )}
                title={s.description || s.name}
              >
                <div className="flex items-center gap-1.5 truncate font-medium">
                  <span className="truncate">{s.name}</span>
                  {s.version ? (
                    <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      v{s.version}
                    </span>
                  ) : null}
                  {s.template ? (
                    <span className="shrink-0 rounded bg-brand-100 px-1 py-px text-[10px] text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                      {s.template.mode ?? "html"}
                    </span>
                  ) : null}
                  {s.overriddenBy ? (
                    <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {t("skillsTab.overridden", { defaultValue: "overridden" })}
                    </span>
                  ) : null}
                  {s.overridesBuiltin ? (
                    <span className="shrink-0 rounded bg-violet-100 px-1 py-px text-[10px] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                      {t("skillsTab.override", { defaultValue: "override" })}
                    </span>
                  ) : null}
                </div>
                {s.description ? (
                  <div className="mt-0.5 line-clamp-1 text-xxs text-neutral-500 dark:text-neutral-400">
                    {s.description}
                  </div>
                ) : null}
              </button>
              {!s.readonly ? (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(s);
                  }}
                  className="absolute top-1/2 right-1.5 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-400 group-hover:inline-flex hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  title={t("skillsTab.delete", { defaultValue: "Delete" }) as string}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {ctxMenu ? (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[180px] rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {filteredMoveTargets.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                onMouseEnter={() => setShowMoveSubmenu(true)}
                onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span className="flex items-center gap-2">
                  <ArrowRightLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>{t("skillsTab.moveTo", { defaultValue: "Move to…" })}</span>
                </span>
                <span className="text-neutral-400">›</span>
              </button>
              {showMoveSubmenu ? (
                <div className="absolute top-0 left-full z-[101] ml-1 max-h-[240px] min-w-[160px] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
                  {filteredMoveTargets.map(mt => (
                    <button
                      key={mt.target.scope + ":" + (mt.target.projectPath || "user")}
                      type="button"
                      onClick={() => {
                        const skill = ctxMenu.skill;
                        setCtxMenu(null);
                        setShowMoveSubmenu(false);
                        onMove(skill, mt.target);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      {mt.target.scope === "user" ? (
                        <Globe className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-brand-500" strokeWidth={1.75} />
                      )}
                      <span className="truncate">{mt.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const skill = ctxMenu.skill;
              setCtxMenu(null);
              setShowMoveSubmenu(false);
              onDelete(skill);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t("skillsTab.delete", { defaultValue: "Delete" })}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ t }: { t: ReturnType<typeof useTranslation>["t"] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
      <Sparkles className="h-8 w-8 text-neutral-300 dark:text-neutral-700" strokeWidth={1.5} />
      <div>{t("skillsTab.selectHint", { defaultValue: "Pick a skill on the left to view or edit its SKILL.md." })}</div>
    </div>
  );
}

const SCOPE_STYLES: Record<
  SkillScope,
  { labelKey: string; labelDefault: string; className: string; darkClassName: string }
> = {
  builtin: {
    labelKey: "skillsTab.scopeBuiltin",
    labelDefault: "Built-in",
    className: "bg-neutral-200 text-neutral-700",
    darkClassName: "dark:bg-neutral-800 dark:text-neutral-300",
  },
  project: {
    labelKey: "skillsTab.scopeProject",
    labelDefault: "Project",
    className: "bg-brand-100 text-brand-700",
    darkClassName: "dark:bg-brand-950/60 dark:text-brand-300",
  },
  user: {
    labelKey: "skillsTab.scopeUser",
    labelDefault: "User",
    className: "bg-amber-100 text-amber-800",
    darkClassName: "dark:bg-amber-950/60 dark:text-amber-300",
  },
};

function ScopeBadge({ scope, t }: { scope: SkillScope; t: ReturnType<typeof useTranslation>["t"] }) {
  const style = SCOPE_STYLES[scope];
  return (
    <span
      className={cn("rounded px-1.5 py-0.5 text-[10px] tracking-wider uppercase", style.className, style.darkClassName)}
    >
      {t(style.labelKey, { defaultValue: style.labelDefault })}
    </span>
  );
}

function SkillDetail({
  skill,
  content,
  onChange,
  isDirty,
  loading,
  saving,
  isDarkMode,
  onSave,
  onDelete,
  onRevert,
  compact,
  t,
}: {
  skill: Skill;
  content: string;
  onChange: (v: string) => void;
  isDirty: boolean;
  loading: boolean;
  saving: boolean;
  isDarkMode: boolean;
  onSave: () => void;
  onDelete: () => void;
  onRevert: () => void;
  compact: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn("shrink-0 border-b border-neutral-200 py-3 dark:border-neutral-800", compact ? "px-4" : "px-6")}
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{skill.name}</h2>
          <ScopeBadge scope={skill.scope} t={t} />
          {skill.version ? (
            <span className="text-xxs text-neutral-500 dark:text-neutral-400">v{skill.version}</span>
          ) : null}
        </div>
        {skill.description ? (
          <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{skill.description}</p>
        ) : null}
        {skill.template ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[skill.template.mode, skill.template.scenario, skill.template.surface, skill.template.designSystem]
              .filter(Boolean)
              .map(tag => (
                <span
                  key={tag}
                  className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                >
                  {tag}
                </span>
              ))}
          </div>
        ) : null}
        <div className="mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
          {skill.skillDir}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t("skillsTab.loading", { defaultValue: "Loading…" })}</span>
          </div>
        ) : (
          <CodeMirror
            value={content}
            onChange={onChange}
            editable={!skill.readonly}
            extensions={[markdown(), EditorView.lineWrapping]}
            theme={isDarkMode ? zincDarkTheme : zincLightTheme}
            height="100%"
            style={{ height: "100%", fontSize: "13px" }}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              indentOnInput: true,
              autocompletion: false,
              searchKeymap: true,
            }}
          />
        )}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 py-2 dark:border-neutral-800",
          compact ? "flex-wrap px-3" : "px-6",
        )}
      >
        {skill.readonly ? (
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {skill.overriddenBy
              ? t("skillsTab.builtinOverriddenBy", {
                  defaultValue: "Read-only · overridden by {{scope}} skill",
                  scope:
                    skill.overriddenBy === "project"
                      ? t("skillsTab.scopeProject", { defaultValue: "Project" })
                      : t("skillsTab.scopeUser", { defaultValue: "User" }),
                })
              : t("skillsTab.builtinReadOnly", { defaultValue: "Read-only built-in skill" })}
          </span>
        ) : (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t("skillsTab.delete", { defaultValue: "Delete" })}</span>
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {!skill.readonly && isDirty ? (
            <button
              type="button"
              onClick={onRevert}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t("skillsTab.revert", { defaultValue: "Revert" })}
            </button>
          ) : null}
          {!skill.readonly ? (
            <button
              type="button"
              onClick={onSave}
              disabled={!isDirty || saving}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              <span>
                {saving
                  ? t("skillsTab.saving", { defaultValue: "Saving…" })
                  : t("skillsTab.save", { defaultValue: "Save" })}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NewSkillModal({
  onClose,
  onCreated,
  projectAvailable,
  projectPath,
  t,
}: {
  onClose: () => void;
  onCreated: (created: NewModalCreated) => void;
  projectAvailable: boolean;
  projectPath: string | null;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [tab, setTab] = useState<"install" | "import" | "create">("install");
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[560px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">{t("skillsTab.newTitle", { defaultValue: "New Skill" })}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label={t("skillsTab.close", { defaultValue: "Close" }) as string}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-5 dark:border-neutral-800">
          <ModalTab active={tab === "install"} onClick={() => setTab("install")} icon={Download}>
            {t("skillsTab.tabInstall", { defaultValue: "Install from ClawHub" })}
          </ModalTab>
          <ModalTab active={tab === "import"} onClick={() => setTab("import")} icon={FolderInput}>
            {t("skillsTab.tabImport", { defaultValue: "Import folder" })}
          </ModalTab>
          <ModalTab active={tab === "create"} onClick={() => setTab("create")} icon={PencilLine}>
            {t("skillsTab.tabCreate", { defaultValue: "Write my own" })}
          </ModalTab>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "install" ? (
            <InstallFromClawHub
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onInstalled={onCreated}
              t={t}
            />
          ) : tab === "import" ? (
            <ImportFromFolder
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onImported={onCreated}
              t={t}
            />
          ) : (
            <CreateFromScratch
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onCreated={onCreated}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ModalTab({
  active,
  onClick,
  children,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon: typeof Download;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition-colors",
        active
          ? "border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {children}
    </button>
  );
}

function InstallFromClawHub({
  projectAvailable,
  projectPath,
  onInstalled,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onInstalled: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<"user" | "project">(projectAvailable ? "project" : "user");
  const [installing, setInstalling] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [forceForSlug, setForceForSlug] = useState<string | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!projectAvailable && scope === "project") setScope("user");
  }, [projectAvailable, scope]);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const data = await api<{ results: SearchResult[] }>("/api/skills/clawhub/search", { query });
        setResults(data.results);
      } catch (e) {
        setErrorText((e as Error).message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, UI_TIMEOUTS.SKILL_SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  const install = useCallback(
    async (slug: string, force = false) => {
      setInstalling(slug);
      setErrorText(null);
      try {
        const effectiveScope = projectAvailable ? scope : "user";
        const r = await api<InstallResponse>("/api/skills/clawhub/install", {
          slug,
          scope: effectiveScope,
          projectPath: effectiveScope === "project" ? projectPath : null,
          force,
        });
        if (r.installed) {
          onInstalled({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
          return;
        }
        if (r.needsForce) {
          setForceForSlug(slug);
          setErrorText(
            t("skillsTab.flaggedSuspicious", {
              defaultValue: '"{{slug}}" is flagged as suspicious by VirusTotal. Re-confirm to install with --force.',
              slug,
            }),
          );
          return;
        }
        setErrorText(r.stderr || r.stdout || `Install failed (exit ${r.exitCode})`);
      } catch (e) {
        setErrorText((e as Error).message);
      } finally {
        setInstalling(null);
      }
    },
    [projectAvailable, scope, projectPath, onInstalled, t],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
        <div className="relative flex flex-1 items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-neutral-400" strokeWidth={1.75} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("skillsTab.searchPlaceholder", { defaultValue: "Search clawhub.com…" }) as string}
            className="h-8 w-full rounded-md border border-neutral-200 bg-white pr-2 pl-8 text-[13px] outline-hidden focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
          />
          {searching ? (
            <Loader2 className="absolute right-2.5 h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
          ) : null}
        </div>
        <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
      </div>

      {errorText ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {errorText}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 && !searching ? (
          <div className="flex h-full items-center justify-center text-xxs text-neutral-500 dark:text-neutral-400">
            {query.trim()
              ? t("skillsTab.noResults", { defaultValue: "No results." })
              : t("skillsTab.searchHint", { defaultValue: "Type to search clawhub.com." })}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {results.map(r => {
              const isForce = forceForSlug === r.slug;
              const isInstalling = installing === r.slug;
              return (
                <li key={r.slug} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium">{r.name}</span>
                      <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{r.slug}</span>
                      {r.score ? (
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-600">
                          · {r.score.toFixed(2)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isInstalling}
                    onClick={() => install(r.slug, isForce)}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-white transition disabled:opacity-50",
                      isForce
                        ? "bg-amber-600 hover:bg-amber-500"
                        : "bg-neutral-900 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300",
                    )}
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                    <span>
                      {isInstalling
                        ? t("skillsTab.installing", { defaultValue: "Installing…" })
                        : isForce
                          ? t("skillsTab.installForce", { defaultValue: "Install (force)" })
                          : t("skillsTab.install", { defaultValue: "Install" })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function CreateFromScratch({
  projectAvailable,
  projectPath,
  onCreated,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onCreated: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"user" | "project">(projectAvailable ? "project" : "user");
  const [creating, setCreating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!projectAvailable && scope === "project") setScope("user");
  }, [projectAvailable, scope]);

  const slugValid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug);
  const canSubmit = slugValid && (description.trim().length > 0 || body.trim().length > 0);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setCreating(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : "user";
      const r = await api<{ ok: boolean; slug: string; scope: "user" | "project"; skill: Skill }>(
        "/api/skills/create",
        {
          slug,
          name: name.trim() || slug,
          description,
          body,
          scope: effectiveScope,
          projectPath: effectiveScope === "project" ? projectPath : null,
        },
      );
      onCreated({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [canSubmit, slug, name, description, body, projectAvailable, scope, projectPath, onCreated]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={t("skillsTab.fieldSlug", { defaultValue: "Slug" })}
            hint={t("skillsTab.slugHint", { defaultValue: "Folder name, e.g. my-skill" }) as string}
          >
            <input
              type="text"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="my-skill"
              className={cn(
                "h-8 w-full rounded-md border bg-white px-2 font-mono text-[13px] outline-hidden dark:bg-neutral-950",
                slugValid || !slug
                  ? "border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600"
                  : "border-red-300 dark:border-red-800",
              )}
            />
          </Field>
          <Field label={t("skillsTab.fieldName", { defaultValue: "Display name" })}>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={
                slug || (t("skillsTab.fieldNamePlaceholder", { defaultValue: "Optional, defaults to slug" }) as string)
              }
              className="h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-[13px] outline-hidden focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            />
          </Field>
        </div>
        <Field
          label={t("skillsTab.fieldDescription", { defaultValue: "Description" })}
          hint={
            t("skillsTab.descHint", {
              defaultValue: "Shown in the slash menu — describe what this skill does and when to invoke it.",
            }) as string
          }
        >
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-[13px] outline-hidden focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
          />
        </Field>
        <Field
          label={t("skillsTab.fieldBody", { defaultValue: "Initial body (Markdown)" })}
          hint={
            t("skillsTab.bodyHint", { defaultValue: "Optional. Edit in detail later from the main view." }) as string
          }
        >
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[12px] outline-hidden focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            placeholder={"# My Skill\n\nDescribe what this skill does..."}
          />
        </Field>
        <div className="mt-3">
          <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
        </div>
        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || creating}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          <span>
            {creating
              ? t("skillsTab.creating", { defaultValue: "Creating…" })
              : t("skillsTab.create", { defaultValue: "Create skill" })}
          </span>
        </button>
      </div>
    </div>
  );
}
