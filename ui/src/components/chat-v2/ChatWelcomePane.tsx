import type React from "react";
import type { TFunction } from "i18next";
import { MessageSquare } from "lucide-react";
import type { Project } from "../../types/app";

/**
 * welcome 空态（#646 B2.6）：`forceWelcome` / 未开始会话时的两种布局——
 * 窄面板 compact 版与大标题 hero 版。composerSlot 由父级装配后原样嵌入，
 * 两分支的 DOM、class 与 i18n key 均与搬迁前一致。
 */
export default function ChatWelcomePane({
  compact,
  selectedProject,
  composerSlot,
  t,
}: {
  compact: boolean;
  selectedProject: Project | null;
  composerSlot: React.ReactNode;
  t: TFunction<"chat", undefined>;
}) {
  const projectName = selectedProject?.displayName || selectedProject?.name || "";
  if (compact) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-white dark:bg-neutral-950">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            <MessageSquare className="h-4 w-4" strokeWidth={1.8} />
          </div>
          <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
            {t("workspace.emptyTitle", { defaultValue: "Ask Sati about this project" })}
          </p>
          <p className="mt-1 max-w-56 text-[12px] leading-5 text-neutral-400 dark:text-neutral-500">
            {t("workspace.emptyDescription", {
              defaultValue: "Reference a workspace file with @ when you want it included.",
            })}
          </p>
        </div>
        {composerSlot}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-[720px]">
          <h1 className="mb-8 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
            {selectedProject
              ? t("welcome.greetingWithProject", {
                  project: projectName,
                  defaultValue: `What's on the plan today?`,
                })
              : t("welcome.noProject", {
                  defaultValue: "Pick a project from the sidebar to get started",
                })}
          </h1>
          {composerSlot}
        </div>
      </div>
    </div>
  );
}
