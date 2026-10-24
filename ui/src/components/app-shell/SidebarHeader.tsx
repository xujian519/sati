import type { TFunction } from "i18next";
import { PanelLeftClose } from "lucide-react";
import satiLogoDark from "../../assets/sati-logo-white.png";
import satiLogoLight from "../../assets/sati-logo.png";

/** 侧栏品牌头（#646 B3.1）：logo 点击回根路径 + 可选收起按钮。 */
export default function SidebarHeader({
  t,
  onCollapse,
  onDeselectProject,
  navigate,
}: {
  t: TFunction;
  onCollapse?: () => void;
  onDeselectProject?: () => void;
  navigate: (to: string) => void;
}) {
  return (
    <div className="flex h-16 items-center justify-between pr-4 pl-2">
      <div className="flex min-w-0 shrink items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (onDeselectProject) {
              onDeselectProject();
            } else {
              navigate("/");
            }
          }}
          aria-label="正念智能体"
          title="正念智能体"
          className="group flex min-w-0 shrink items-center gap-2.5 rounded-lg p-1 transition hover:opacity-90 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500/30"
        >
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-brand-100 to-brand-200 shadow-xs ring-1 ring-brand-300/40 transition group-hover:shadow-md dark:from-brand-500/20 dark:to-brand-700/30 dark:ring-brand-500/30">
            <img
              src={satiLogoLight}
              alt="正念智能体"
              className="h-full w-full shrink-0 object-cover select-none dark:hidden"
              draggable={false}
            />
            <img
              src={satiLogoDark}
              alt="正念智能体"
              className="hidden h-full w-full shrink-0 object-cover select-none dark:block"
              draggable={false}
            />
          </span>
          <span className="truncate text-[15.5px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            正念智能体
          </span>
        </button>
      </div>
      {onCollapse ? (
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t("sidebar:tooltips.hideSidebar", { defaultValue: "Hide sidebar" }) as string}
          title={t("sidebar:tooltips.hideSidebar", { defaultValue: "Hide sidebar" }) as string}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
