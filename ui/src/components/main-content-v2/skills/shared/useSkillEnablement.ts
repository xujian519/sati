import { useCallback } from "react";
import type { TFunction } from "i18next";
import { api } from "./api";
import type { Skill } from "./types";

type FlashToast = (toast: { kind: "success" | "error" | "info"; text: string }, ms?: number) => void;

/** 技能开关的写入 + 刷新 + 提示；从 SkillsV2 抽出以控制面板体积。 */
export function useSkillEnablement({
  projectPath,
  refresh,
  flashToast,
  t,
}: {
  projectPath: string | null;
  refresh: () => Promise<void>;
  flashToast: FlashToast;
  t: TFunction;
}) {
  return useCallback(
    async (skill: Skill) => {
      try {
        await api("/api/skills/preferences", {
          scope: skill.scope,
          slug: skill.slug,
          projectKey: skill.scope === "project" ? projectPath : undefined,
          enabled: skill.enabled === false,
        });
        await refresh();
        flashToast({
          kind: "success",
          text:
            skill.enabled === false
              ? (t("skillsTab.enabledSuccess", { defaultValue: "Enabled" }) as string)
              : (t("skillsTab.disabledSuccess", { defaultValue: "Disabled" }) as string),
        });
      } catch (e) {
        flashToast({ kind: "error", text: (e as Error).message });
      }
    },
    [projectPath, refresh, flashToast, t],
  );
}
