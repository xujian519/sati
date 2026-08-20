import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";

/**
 * 团队事件流（TeamEvent 滚动视图）。
 * ⚠️ 事件订阅由 Task 10 接线——本任务先做容器 + 空态：
 * 后续经 useSessionWatch 既有链路订阅团队事件后，在空态位置渲染事件列表即可。
 */
export function EventStream() {
  const { t } = useTranslation("teamPanel");
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-neutral-400 dark:text-neutral-500" />
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("events.title")}</h3>
      </div>
      <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        {t("events.empty")}
      </div>
    </section>
  );
}
