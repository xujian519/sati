import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import enCommon from "../../i18n/locales/en/common.json";
import zhCommon from "../../i18n/locales/zh-CN/common.json";

// Closest browser substitute for the AppShell delete dialogs: resolve the
// exact i18n keys they render and assert both languages produce the expected
// text (catches a missing key or a broken {{count}}/{{projectName}}
// interpolation at runtime).

function makeI18n(lng: "en" | "zh-CN") {
  const instance = createInstance();
  instance.init({
    lng,
    defaultNS: "common",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { [lng]: { common: lng === "zh-CN" ? zhCommon : enCommon } },
  });
  return instance;
}

describe("AppShellV2 delete dialogs i18n", () => {
  it("resolves every dialog key and interpolates count/projectName in en", () => {
    const t = makeI18n("en").t;
    expect(t("deleteDialogs.projectTitle")).toBe("Delete project?");
    expect(t("deleteDialogs.projectDescription")).toBe(
      "This removes the project from Sati and deletes its session metadata.",
    );
    expect(t("deleteDialogs.projectSessionsRemovedCount", { count: 1 })).toBe("1 session");
    expect(t("deleteDialogs.projectSessionsRemovedCount", { count: 3 })).toBe("3 sessions");
    expect(t("deleteDialogs.projectSessionsRemovedTail")).toBe("will also be removed.");
    expect(t("deleteDialogs.projectFilesOnDiskBefore")).toBe("Files on disk are");
    expect(t("deleteDialogs.projectFilesOnDiskNegation")).toBe("not");
    expect(t("deleteDialogs.projectFilesOnDiskAfter")).toBe("deleted — only Sati's reference to them.");
    expect(t("deleteDialogs.sessionTitle")).toBe("Delete conversation?");
    expect(t("deleteDialogs.sessionDescription", { projectName: "My Project" })).toBe(
      "This removes the conversation from My Project.",
    );
    expect(t("deleteDialogs.deleting")).toBe("Deleting…");
    expect(t("deleteDialogs.deleteSession")).toBe("Delete conversation");
    expect(t("deleteDialogs.errorDeleteProject")).toBe("Failed to delete project");
    expect(t("deleteDialogs.errorDeleteSession")).toBe("Failed to delete conversation");
  });

  it("resolves every dialog key and interpolates count/projectName in zh-CN", () => {
    const t = makeI18n("zh-CN").t;
    expect(t("deleteDialogs.projectTitle")).toBe("删除项目？");
    expect(t("deleteDialogs.projectDescription")).toBe("这将从 Sati 移除该项目并删除其会话元数据。");
    expect(t("deleteDialogs.projectSessionsRemovedCount", { count: 1 })).toBe("1 个会话");
    expect(t("deleteDialogs.projectSessionsRemovedCount", { count: 3 })).toBe("3 个会话");
    expect(t("deleteDialogs.projectSessionsRemovedTail")).toBe("也将被移除。");
    expect(t("deleteDialogs.projectFilesOnDiskBefore")).toBe("磁盘上的文件");
    expect(t("deleteDialogs.projectFilesOnDiskNegation")).toBe("不会");
    expect(t("deleteDialogs.projectFilesOnDiskAfter")).toBe("被删除——仅删除 Sati 对它们的引用。");
    expect(t("deleteDialogs.sessionTitle")).toBe("删除会话？");
    expect(t("deleteDialogs.sessionDescription", { projectName: "我的项目" })).toBe("这将从 我的项目 中移除该会话。");
    expect(t("deleteDialogs.deleting")).toBe("删除中…");
    expect(t("deleteDialogs.deleteSession")).toBe("删除会话");
    expect(t("deleteDialogs.errorDeleteProject")).toBe("删除项目失败");
    expect(t("deleteDialogs.errorDeleteSession")).toBe("删除会话失败");
  });
});
