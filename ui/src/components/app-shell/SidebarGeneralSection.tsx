import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { MessageSquarePlus } from "lucide-react";
import type { Project } from "../../types/app";

/** General 分区（#646 B3.1）：扁平会话列表或缺失提示。 */
export default function SidebarGeneralSection({
  t,
  generalProject,
  handleNewSession,
  renderSessionRows,
}: {
  t: TFunction;
  generalProject: Project | null;
  handleNewSession: (event: React.MouseEvent, project: Project) => void;
  renderSessionRows: (project: Project, options: { flat?: boolean }) => ReactNode;
}) {
  return (
    <section className="pt-2">
      {generalProject ? (
        <>
          <div className="flex items-center px-3 pb-1">
            <span className="flex-1 text-[11px] font-medium tracking-[0.04em] text-neutral-500/90 uppercase dark:text-neutral-400/80">
              {t("sidebar:general.title", { defaultValue: "General" })}
            </span>
            <button
              type="button"
              onClick={event => handleNewSession(event, generalProject)}
              aria-label={t("sidebar:tooltips.newChat", { defaultValue: "New Chat" }) as string}
              title={t("sidebar:tooltips.newChat", { defaultValue: "New Chat" }) as string}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
          <div className="px-1">{renderSessionRows(generalProject, { flat: true })}</div>
        </>
      ) : (
        <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("sidebar:general.missing", {
            defaultValue: "No general workspace found",
          })}
        </div>
      )}
    </section>
  );
}
