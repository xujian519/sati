import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Info, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { authenticatedFetch } from "../../../../../utils/api";
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from "../../../shared/view";
import { FormRow, SecretTextInput, Select, TextInput } from "../../../shared/components/Inputs";
import { MASK } from "../../../shared/utils/secret";
import type { SatiConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";
import { hasUsableSecret, isMaskedSecret } from "../../modelPool/utils/providerRefs";
import { isOptionalFeatureEnabled } from "../../../shared/utils/optionalFeature";
import {
  isWebSearchApiKeyRequired,
  webSearchConfigForProvider,
  type WebSearchProvider,
} from "../utils/webSearchConfig";

type ToolsSectionProps = {
  config: SatiConfig;
  onChange: (next: SatiConfig) => void;
};

type CustomProviderAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
type CustomProviderMethod = "GET" | "POST";
type TestStatus = "idle" | "testing" | "success" | "error";
/** 专利能力开关的三态：auto = 交回工作区判据（删除该键）。 */
type PatentDomainChoice = "auto" | "on" | "off";
type WebSearchConfig = NonNullable<NonNullable<SatiConfig["tools"]>["webSearch"]>;
type CustomProviderConfig = NonNullable<WebSearchConfig["customProvider"]>;

export default function ToolsSection({ config, onChange }: ToolsSectionProps) {
  const { t } = useTranslation("settings");
  const glmDefaultEndpoint = "https://api.z.ai/api/paas/v4/web_search";
  const ws = config.tools?.webSearch ?? {};
  // 段缺失 = 关（上游 #588）：运行期未配置的搜索不再自我唤醒（曾可从
  // GLM_WEB_SEARCH_API_KEY / TAVILY_API_KEY 推断），面板必须同判据。
  const enabled = isOptionalFeatureEnabled(config.tools?.webSearch);
  const paperSearchEnabled = isOptionalFeatureEnabled(config.tools?.paperSearch);
  const provider: WebSearchProvider = ws.provider === "tavily" || ws.provider === "custom" ? ws.provider : "glm";
  const apiKey = typeof ws.apiKey === "string" ? ws.apiKey : "";
  const endpoint = typeof ws.endpoint === "string" ? ws.endpoint : "";
  const custom = ws.customProvider ?? {};
  const apiKeyRequired = isWebSearchApiKeyRequired(ws);
  const hasConfiguredApiKey = hasUsableSecret(apiKey) || isMaskedSecret(apiKey);
  const endpointValue = endpoint || (provider === "glm" ? glmDefaultEndpoint : "");
  const endpointPlaceholder =
    provider === "custom"
      ? "https://example.com/search"
      : provider === "tavily"
        ? "https://api.tavily.com/search"
        : glmDefaultEndpoint;

  const patentDomainValue: PatentDomainChoice =
    config.tools?.patentDomain === true ? "on" : config.tools?.patentDomain === false ? "off" : "auto";

  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("");

  /**
   * 三态写回：`auto` 是**删除键**而不是写 `false`。写入具体值会把"按工作区判定"
   * 冻结成永久结论——专利项目在设置页保存一次后就再也拿不到专利工具，且没有任何
   * 提示（工作区判据见 `src/pilot/workspace/patentSignals.ts`）。
   */
  const setPatentDomain = (value: PatentDomainChoice) => {
    const nextTools = { ...(config.tools ?? {}) };
    if (value === "auto") {
      delete nextTools.patentDomain;
    } else {
      nextTools.patentDomain = value === "on";
    }
    onChange({ ...config, tools: Object.keys(nextTools).length > 0 ? nextTools : undefined });
  };

  const resetTest = () => {
    setTestStatus("idle");
    setTestMessage("");
  };

  const setProvider = (nextProvider: WebSearchProvider) => {
    // 只写 tools.webSearch 子键：整段替换 tools 会丢掉面板不渲染的兄弟段
    // （tools.paperSearch），并在保存时把它从配置文件里抹掉。
    onChange(patch(config, ["tools", "webSearch"], webSearchConfigForProvider(ws, nextProvider, glmDefaultEndpoint)));
    resetTest();
  };

  const setField = (field: "apiKey" | "endpoint", value: string) => {
    const trimmed = value;
    const nextWs: WebSearchConfig = { ...ws };
    nextWs.provider = provider;
    if (trimmed === "") {
      delete nextWs[field];
    } else {
      nextWs[field] = trimmed;
    }
    const nextWebSearch = Object.keys(nextWs).length > 0 ? nextWs : undefined;
    onChange(patch(config, ["tools", "webSearch"], nextWebSearch));
    resetTest();
  };

  const setCustomField = (field: keyof CustomProviderConfig, value: string) => {
    const nextWs: WebSearchConfig = {
      ...ws,
      provider: "custom",
      customProvider: { ...(ws.customProvider ?? {}) } as CustomProviderConfig,
    };
    if (value === "") {
      delete nextWs.customProvider?.[field];
    } else if (field === "auth") {
      nextWs.customProvider![field] = value as CustomProviderAuth;
    } else if (field === "method") {
      nextWs.customProvider![field] = value as CustomProviderMethod;
    } else {
      nextWs.customProvider![field] = value;
    }
    if (Object.keys(nextWs.customProvider ?? {}).length === 0) {
      delete nextWs.customProvider;
    }
    onChange(patch(config, ["tools", "webSearch"], nextWs));
    resetTest();
  };

  const handleTest = async () => {
    const trimmedKey = hasUsableSecret(apiKey) ? apiKey.trim() : isMaskedSecret(apiKey) ? MASK : "";
    if (apiKeyRequired && !trimmedKey) {
      setTestStatus("error");
      setTestMessage(t("satiConfig.panels.tools.test.needsKey"));
      return;
    }
    setTestStatus("testing");
    setTestMessage("");
    try {
      const res = await authenticatedFetch("/api/config/test-web-search", {
        method: "POST",
        body: JSON.stringify({
          provider,
          apiKey: trimmedKey,
          endpoint: endpointValue.trim(),
          customProvider: custom,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus("success");
        setTestMessage(
          t("satiConfig.panels.tools.test.success", {
            count: data.organicCount ?? 0,
            latency: data.latencyMs ?? 0,
          }),
        );
      } else {
        setTestStatus("error");
        setTestMessage(
          t("satiConfig.panels.tools.test.failedPrefix", {
            error: data.error || "unknown",
          }),
        );
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(
        t("satiConfig.panels.tools.test.failedPrefix", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <SettingsSection>
      <p className="text-sm text-muted-foreground">{t("satiConfig.panels.tools.description")}</p>
      <SettingsCard divided>
        <SettingsRow
          label={t("satiConfig.panels.tools.enabled.label")}
          description={t("satiConfig.panels.tools.enabled.description")}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t("satiConfig.panels.tools.enabled.label")}
            onChange={value => {
              onChange(patch(config, ["tools", "webSearch", "enabled"], value));
              resetTest();
            }}
          />
        </SettingsRow>

        {enabled && (
          <>
            <FormRow
              label={t("satiConfig.panels.tools.provider.label")}
              description={t("satiConfig.panels.tools.provider.description")}
            >
              <Select
                value={provider}
                options={[
                  { value: "glm", label: t("satiConfig.panels.tools.provider.glm") },
                  { value: "tavily", label: t("satiConfig.panels.tools.provider.tavily") },
                  { value: "custom", label: t("satiConfig.panels.tools.provider.custom") },
                ]}
                onChange={value => setProvider(value === "custom" ? "custom" : value === "tavily" ? "tavily" : "glm")}
              />
            </FormRow>
            <FormRow
              label={t("satiConfig.panels.tools.apiKey.label")}
              description={t("satiConfig.panels.tools.apiKey.description")}
            >
              <SecretTextInput
                value={apiKey}
                emptyPlaceholder={t("satiConfig.panels.tools.apiKey.placeholder")}
                maskedPlaceholder={t("satiConfig.panels.tools.apiKey.maskedPlaceholder")}
                monospace
                onChange={value => setField("apiKey", value)}
              />
              {isMaskedSecret(apiKey) && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  {t("satiConfig.panels.tools.apiKey.keyHidden")}
                </p>
              )}
            </FormRow>
            <FormRow
              label={t("satiConfig.panels.tools.endpoint.label")}
              description={t("satiConfig.panels.tools.endpoint.description")}
            >
              <TextInput
                value={endpointValue}
                placeholder={endpointPlaceholder}
                monospace
                onChange={value => setField("endpoint", value)}
              />
            </FormRow>

            {provider === "custom" && (
              <>
                <FormRow
                  label={t("satiConfig.panels.tools.custom.name.label")}
                  description={t("satiConfig.panels.tools.custom.name.description")}
                >
                  <TextInput
                    value={custom.name ?? ""}
                    placeholder="My Search"
                    onChange={value => setCustomField("name", value)}
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.tools.custom.auth.label")}
                  description={t("satiConfig.panels.tools.custom.auth.description")}
                >
                  <Select
                    value={custom.auth ?? "bearer"}
                    options={[
                      { value: "bearer", label: t("satiConfig.panels.tools.custom.auth.bearer") },
                      {
                        value: "bodyApiKey",
                        label: t("satiConfig.panels.tools.custom.auth.bodyApiKey"),
                      },
                      {
                        value: "queryApiKey",
                        label: t("satiConfig.panels.tools.custom.auth.queryApiKey"),
                      },
                      { value: "none", label: t("satiConfig.panels.tools.custom.auth.none") },
                    ]}
                    onChange={value => setCustomField("auth", value)}
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.tools.custom.method.label")}
                  description={t("satiConfig.panels.tools.custom.method.description")}
                >
                  <Select
                    value={custom.method ?? "POST"}
                    options={[
                      { value: "POST", label: "POST" },
                      { value: "GET", label: "GET" },
                    ]}
                    onChange={value => setCustomField("method", value)}
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.tools.custom.params.label")}
                  description={t("satiConfig.panels.tools.custom.params.description")}
                >
                  <div className="grid gap-2 md:grid-cols-2">
                    <TextInput
                      value={custom.queryParam ?? ""}
                      placeholder="query"
                      monospace
                      onChange={value => setCustomField("queryParam", value)}
                    />
                    <TextInput
                      value={custom.apiKeyParam ?? ""}
                      placeholder="api_key"
                      monospace
                      onChange={value => setCustomField("apiKeyParam", value)}
                    />
                  </div>
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.tools.custom.mapping.label")}
                  description={t("satiConfig.panels.tools.custom.mapping.description")}
                >
                  <div className="grid gap-2 md:grid-cols-2">
                    <TextInput
                      value={custom.resultsPath ?? ""}
                      placeholder="data.items"
                      monospace
                      onChange={value => setCustomField("resultsPath", value)}
                    />
                    <TextInput
                      value={custom.titleField ?? ""}
                      placeholder="title"
                      monospace
                      onChange={value => setCustomField("titleField", value)}
                    />
                    <TextInput
                      value={custom.urlField ?? ""}
                      placeholder="url"
                      monospace
                      onChange={value => setCustomField("urlField", value)}
                    />
                    <TextInput
                      value={custom.snippetField ?? ""}
                      placeholder="snippet"
                      monospace
                      onChange={value => setCustomField("snippetField", value)}
                    />
                    <TextInput
                      value={custom.sourceField ?? ""}
                      placeholder="source"
                      monospace
                      onChange={value => setCustomField("sourceField", value)}
                    />
                    <TextInput
                      value={custom.publishedAtField ?? ""}
                      placeholder="publishedAt"
                      monospace
                      onChange={value => setCustomField("publishedAtField", value)}
                    />
                  </div>
                </FormRow>
              </>
            )}

            <div className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testStatus === "testing" || (apiKeyRequired && !hasConfiguredApiKey)}
                >
                  {testStatus === "testing" ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {testStatus === "testing"
                    ? t("satiConfig.panels.tools.test.testing")
                    : t("satiConfig.panels.tools.test.button")}
                </Button>
                {testStatus === "success" && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {testMessage}
                  </span>
                )}
                {testStatus === "error" && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                    <XCircle className="h-3.5 w-3.5" />
                    {testMessage}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </SettingsCard>
      <SettingsCard divided>
        <SettingsRow
          label={t("satiConfig.panels.tools.paperSearch.enabled.label")}
          description={t("satiConfig.panels.tools.paperSearch.enabled.description")}
        >
          <SettingsToggle
            checked={paperSearchEnabled}
            ariaLabel={t("satiConfig.panels.tools.paperSearch.enabled.label")}
            onChange={value => onChange(patch(config, ["tools", "paperSearch", "enabled"], value))}
          />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard divided>
        <FormRow
          label={t("satiConfig.panels.tools.patentDomain.label")}
          description={t("satiConfig.panels.tools.patentDomain.description")}
        >
          <Select
            value={patentDomainValue}
            ariaLabel={t("satiConfig.panels.tools.patentDomain.label")}
            options={[
              { value: "auto", label: t("satiConfig.panels.tools.patentDomain.auto") },
              { value: "on", label: t("satiConfig.panels.tools.patentDomain.on") },
              { value: "off", label: t("satiConfig.panels.tools.patentDomain.off") },
            ]}
            onChange={value => setPatentDomain(value as PatentDomainChoice)}
          />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}
