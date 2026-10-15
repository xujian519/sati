import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "../../../../types/app";
import { requestUrlTicket } from "../../../../utils/api";
import { useTheme } from "../../../../contexts/ThemeContext";

type MemoryPanelProps = {
  selectedProject: Project | null;
};

function normalizeMemoryLocale(language: string | undefined): "zh" | "en" {
  return language === "zh-CN" ? "zh" : "en";
}

function normalizeMemoryTheme(isDarkMode: boolean): "light" | "dark" {
  return isDarkMode ? "dark" : "light";
}

const MEMORY_PANEL_TEXT: Record<
  "zh" | "en",
  {
    emptyProject: string;
    unavailable: string;
    title: string;
  }
> = {
  zh: {
    emptyProject: "请选择一个项目查看 Memory。",
    unavailable: "身份验证和项目上下文准备完成后，Memory 面板才可用。",
    title: "Memory 面板",
  },
  en: {
    emptyProject: "Select a project to inspect memory.",
    unavailable: "Memory dashboard is unavailable until auth and project context are ready.",
    title: "Memory Dashboard",
  },
};

function buildMemoryDashboardUrl(
  project: Project,
  locale: "zh" | "en",
  theme: "light" | "dark",
  ticket: string | null,
): string | null {
  const projectPath = project.fullPath || project.path;

  if (!projectPath) {
    return null;
  }

  const params = new URLSearchParams({ projectPath, locale, theme });
  if (ticket) {
    params.set("ticket", ticket);
  }

  return `/memory-dashboard/index.html?${params.toString()}`;
}

export default function MemoryPanel({ selectedProject }: MemoryPanelProps) {
  const { i18n } = useTranslation();
  const { isDarkMode } = useTheme();
  const memoryLocale = normalizeMemoryLocale(i18n.language);
  const memoryTheme = normalizeMemoryTheme(isDarkMode);
  const text = MEMORY_PANEL_TEXT[memoryLocale];

  const projectPath = selectedProject?.fullPath || selectedProject?.path;
  // Dashboard is loaded in an <iframe> (no custom headers), so it authenticates with a
  // short-lived, purpose-scoped ("dashboard") url-ticket instead of the session JWT (#626).
  const [dashboardTicket, setDashboardTicket] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setDashboardTicket(null);
      return undefined;
    }
    let alive = true;
    requestUrlTicket("dashboard")
      .then((ticket: string) => {
        if (alive) setDashboardTicket(ticket);
      })
      .catch(() => {
        if (alive) setDashboardTicket(null);
      });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {text.emptyProject}
      </div>
    );
  }

  const dashboardUrl = buildMemoryDashboardUrl(selectedProject, memoryLocale, memoryTheme, dashboardTicket);
  if (!dashboardUrl || !dashboardTicket) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {text.unavailable}
      </div>
    );
  }

  // Outer shell mirrors MainAreaV2's chrome (white / neutral-950) so the
  // iframe blends seamlessly when the V2 dashboard is rendered full-screen
  // — avoids the dark-mode "two-tone" line + legacy overlap that showed up
  // when Memory was previously paired with chat in a split pane.
  return (
    <div className="h-full w-full bg-white dark:bg-neutral-950">
      <iframe
        key={`${selectedProject.fullPath || selectedProject.path || "memory"}:${memoryLocale}:${memoryTheme}`}
        title={text.title}
        src={dashboardUrl}
        className="block h-full w-full border-0 bg-white dark:bg-neutral-950"
      />
    </div>
  );
}
