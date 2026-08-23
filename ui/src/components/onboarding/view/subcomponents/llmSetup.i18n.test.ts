import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import enSettings from "../../../../i18n/locales/en/settings.json";
import zhSettings from "../../../../i18n/locales/zh-CN/settings.json";

// Closest browser substitute for the LLM setup step: resolve the llmSetup keys
// it renders and assert both languages produce text (catches a missing key or a
// broken {{protocol}}/{{url}}/{{message}} interpolation at runtime).

function makeI18n(lng: "en" | "zh-CN") {
  const instance = createInstance();
  instance.init({
    lng,
    defaultNS: "settings",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { [lng]: { settings: lng === "zh-CN" ? zhSettings : enSettings } },
  });
  return instance;
}

const KEYS = [
  "title",
  "subtitle",
  "providerLabel",
  "custom",
  "customHint",
  "customProviderId",
  "customProviderIdHint",
  "protocol",
  "baseUrl",
  "apiKeyLabel",
  "apiKeyOptional",
  "apiKeyNotRequired",
  "modelLabel",
  "fetchingModels",
  "fetchModels",
  "showAdvancedToggle",
  "hideAdvancedToggle",
  "apiBaseUrl",
  "testConnectionFirst",
  "testConnection",
  "testing",
  "saving",
  "save",
  "connectedSuccessfully",
  "connectionFailed",
  "failedToSave",
  "saveFailed",
  "missingProviderId",
];

describe("LlmConfigurationStep llmSetup i18n", () => {
  it("resolves every llmSetup key and interpolates in en", () => {
    const t = makeI18n("en").t;
    for (const key of KEYS) {
      const value = t(`llmSetup.${key}`);
      expect(value).not.toBe(`llmSetup.${key}`);
      expect(value.length).toBeGreaterThan(0);
    }
    expect(t("llmSetup.protocolLabel")).toBe("Protocol: ");
    expect(t("llmSetup.defaultUrlLabel")).toBe("Default URL: ");
    expect(t("llmSetup.remoteModelLoadFailed", { message: "boom" })).toBe(
      "Using bundled model list. Remote model list unavailable: boom",
    );
    expect(t("llmSetup.localModelLoadFailed", { message: "boom" })).toBe(
      "Using bundled model list. Local model list unavailable: boom",
    );
  });

  it("resolves every llmSetup key and interpolates in zh-CN", () => {
    const t = makeI18n("zh-CN").t;
    for (const key of KEYS) {
      const value = t(`llmSetup.${key}`);
      expect(value).not.toBe(`llmSetup.${key}`);
      expect(value.length).toBeGreaterThan(0);
    }
    expect(t("llmSetup.protocolLabel")).toBe("协议：");
    expect(t("llmSetup.defaultUrlLabel")).toBe("默认 URL：");
    expect(t("llmSetup.remoteModelLoadFailed", { message: "boom" })).toBe("使用内置模型列表。远程模型列表不可用：boom");
    expect(t("llmSetup.localModelLoadFailed", { message: "boom" })).toBe("使用内置模型列表。本地模型列表不可用：boom");
  });
});
