import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import enTeamPanel from "../../i18n/locales/en/teamPanel.json";
import zhTeamPanel from "../../i18n/locales/zh-CN/teamPanel.json";

// 浮标药丸团队数在 zh-CN 依赖 i18next 复数 key（teamCount_other）；zh 资源若
// 用无后缀 key，t("pill.teamCount", { count }) 会 miss 并回落英文。本测试
// 锁定 en/zh 双语的复数解析与插值。

function makeI18n(lng: "en" | "zh-CN") {
  const instance = createInstance();
  instance.init({
    lng,
    defaultNS: "teamPanel",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { [lng]: { teamPanel: lng === "zh-CN" ? zhTeamPanel : enTeamPanel } },
  });
  return instance;
}

describe("teamPanel pill.teamCount i18n", () => {
  it("resolves singular/plural in en", () => {
    const t = makeI18n("en").t;
    expect(t("pill.teamCount", { count: 1 })).toBe("1 team");
    expect(t("pill.teamCount", { count: 3 })).toBe("3 teams");
  });

  it("resolves plural key in zh-CN (teamCount_other, 中文无单复数变化)", () => {
    const t = makeI18n("zh-CN").t;
    expect(t("pill.teamCount", { count: 1 })).toBe("1 个团队");
    expect(t("pill.teamCount", { count: 3 })).toBe("3 个团队");
  });
});
