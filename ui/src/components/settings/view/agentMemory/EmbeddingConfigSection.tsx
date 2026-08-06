import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SatiConfig } from "../modelPool/types";
import { patch } from "../modelPool/utils/patch";
import { FormRow, NumberInput, Select, TextInput } from "../../shared/components/Inputs";
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from "../../shared/view";
import {
  compactEmbedding,
  compactRerank,
  type MemoryEmbeddingConfig,
  type MemoryRerankConfig,
} from "./embeddingConfig";

type EmbeddingConfigSectionProps = {
  config: SatiConfig;
  onChange: (next: SatiConfig) => void;
};

// 端点方式：引用 model.providers 的已配置 provider，或直填 OpenAI 兼容 baseUrl。
const CUSTOM_ENDPOINT = "__custom__";
// 默认值需与 scripts/bootstrap-sati-config.mjs 的 memory 示例注释保持一致
// （bge-m3 / localhost:11434/v1 / localhost:8080 / topN 16），改动请同步两处。
const DEFAULT_EMBEDDING_MODEL = "bge-m3";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_RERANK_BASE_URL = "http://localhost:8080";

export default function EmbeddingConfigSection({ config, onChange }: EmbeddingConfigSectionProps) {
  const { t } = useTranslation("settings");
  const embedding = config.memory?.embedding;
  const enabled = Boolean(embedding?.enabled);
  const rerank = embedding?.rerank;
  const rerankEnabled = Boolean(rerank?.enabled);

  const providerIds = useMemo(() => Object.keys(config.model?.providers ?? {}), [config]);

  const endpointMode = embedding?.provider ? embedding.provider : CUSTOM_ENDPOINT;
  const endpointOptions = useMemo(() => {
    const options = providerIds.map(id => ({ value: id, label: id }));
    // 当前引用的 provider 不在列表里（配置被外部改动）时仍展示，避免选择态丢失。
    if (embedding?.provider && !providerIds.includes(embedding.provider)) {
      options.unshift({ value: embedding.provider, label: embedding.provider });
    }
    options.push({ value: CUSTOM_ENDPOINT, label: t("satiConfig.panels.memory.embedding.endpointCustom") });
    return options;
  }, [providerIds, embedding?.provider, t]);

  // 每次变更基于当前 embedding 构造新对象后整体写回，便于增删可选字段（patch 无法删键）。
  const applyEmbedding = (mutate: (draft: NonNullable<MemoryEmbeddingConfig>) => void) => {
    const draft: NonNullable<MemoryEmbeddingConfig> = { ...(config.memory?.embedding ?? {}) };
    mutate(draft);
    onChange(patch(config, ["memory", "embedding"], compactEmbedding(draft)));
  };

  const applyRerank = (mutate: (draft: NonNullable<MemoryRerankConfig>) => void) => {
    applyEmbedding(draft => {
      const rerankDraft: NonNullable<MemoryRerankConfig> = { ...(draft.rerank ?? {}) };
      mutate(rerankDraft);
      const compacted = compactRerank(rerankDraft);
      if (compacted) draft.rerank = compacted;
      else delete draft.rerank;
    });
  };

  const handleEnabled = (nextEnabled: boolean) => {
    applyEmbedding(draft => {
      draft.enabled = nextEnabled;
      if (nextEnabled) {
        // 启用时补齐最小有效配置，避免"enabled 但缺 model/端点"导致配置校验失败。
        if (!draft.model?.trim()) draft.model = DEFAULT_EMBEDDING_MODEL;
        if (!draft.provider && !draft.baseUrl?.trim()) draft.baseUrl = DEFAULT_OLLAMA_BASE_URL;
      }
    });
  };

  const handleEndpointMode = (value: string) => {
    applyEmbedding(draft => {
      if (value === CUSTOM_ENDPOINT) {
        delete draft.provider;
        if (!draft.baseUrl?.trim()) draft.baseUrl = DEFAULT_OLLAMA_BASE_URL;
      } else {
        draft.provider = value;
        delete draft.baseUrl;
        // apiKey 保留：可能是对 provider key 的覆盖，切回自定义端点时不应丢失。
      }
    });
  };

  const handleRerankEnabled = (nextEnabled: boolean) => {
    applyRerank(draft => {
      draft.enabled = nextEnabled;
      if (nextEnabled && !draft.provider && !draft.baseUrl?.trim()) {
        draft.baseUrl = DEFAULT_RERANK_BASE_URL;
      }
    });
  };

  const endpointIncomplete = enabled && !embedding?.provider && !embedding?.baseUrl?.trim();
  const modelIncomplete = enabled && !embedding?.model?.trim();

  return (
    <SettingsSection
      title={t("satiConfig.panels.memory.embedding.title")}
      description={t("satiConfig.panels.memory.embedding.description")}
    >
      <SettingsCard divided>
        <SettingsRow
          label={t("satiConfig.panels.memory.embedding.enabled.label")}
          description={t("satiConfig.panels.memory.embedding.enabled.description")}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t("satiConfig.panels.memory.embedding.enabled.label")}
            onChange={handleEnabled}
          />
        </SettingsRow>

        {enabled && (
          <>
            <FormRow
              label={t("satiConfig.panels.memory.embedding.endpoint.label")}
              description={t("satiConfig.panels.memory.embedding.endpoint.description")}
            >
              <Select value={endpointMode} options={endpointOptions} onChange={handleEndpointMode} />
            </FormRow>

            {endpointMode === CUSTOM_ENDPOINT && (
              <>
                <FormRow
                  label={t("satiConfig.panels.memory.embedding.baseUrl.label")}
                  description={t("satiConfig.panels.memory.embedding.baseUrl.description")}
                >
                  <TextInput
                    value={embedding?.baseUrl ?? ""}
                    placeholder={DEFAULT_OLLAMA_BASE_URL}
                    monospace
                    onChange={next =>
                      applyEmbedding(draft => {
                        if (next.trim()) draft.baseUrl = next;
                        else delete draft.baseUrl;
                      })
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.memory.embedding.apiKey.label")}
                  description={t("satiConfig.panels.memory.embedding.apiKey.description")}
                >
                  <TextInput
                    value={embedding?.apiKey ?? ""}
                    placeholder={t("satiConfig.panels.memory.embedding.apiKey.placeholder")}
                    monospace
                    onChange={next =>
                      applyEmbedding(draft => {
                        if (next.trim()) draft.apiKey = next;
                        else delete draft.apiKey;
                      })
                    }
                  />
                </FormRow>
              </>
            )}

            <FormRow
              label={t("satiConfig.panels.memory.embedding.model.label")}
              description={t("satiConfig.panels.memory.embedding.model.description")}
            >
              <TextInput
                value={embedding?.model ?? ""}
                placeholder={DEFAULT_EMBEDDING_MODEL}
                monospace
                onChange={next =>
                  applyEmbedding(draft => {
                    if (next.trim()) draft.model = next;
                    else delete draft.model;
                  })
                }
              />
            </FormRow>

            <FormRow
              label={t("satiConfig.panels.memory.embedding.dimensions.label")}
              description={t("satiConfig.panels.memory.embedding.dimensions.description")}
            >
              <NumberInput
                value={embedding?.dimensions}
                onChange={next =>
                  applyEmbedding(draft => {
                    if (next !== undefined && Number.isFinite(next) && next > 0) draft.dimensions = next;
                    else delete draft.dimensions;
                  })
                }
              />
            </FormRow>

            {(endpointIncomplete || modelIncomplete) && (
              <div className="mx-4 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("satiConfig.panels.memory.embedding.warningIncomplete")}
              </div>
            )}

            <div className="mx-4 mb-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
              {t("satiConfig.panels.memory.embedding.vectorsHint")}
            </div>

            <SettingsRow
              label={t("satiConfig.panels.memory.embedding.indexWiki.label")}
              description={t("satiConfig.panels.memory.embedding.indexWiki.description")}
            >
              <SettingsToggle
                checked={embedding?.indexWiki !== false}
                ariaLabel={t("satiConfig.panels.memory.embedding.indexWiki.label")}
                onChange={next =>
                  applyEmbedding(draft => {
                    draft.indexWiki = next;
                  })
                }
              />
            </SettingsRow>

            <SettingsRow
              label={t("satiConfig.panels.memory.embedding.rerank.enabled.label")}
              description={t("satiConfig.panels.memory.embedding.rerank.enabled.description")}
            >
              <SettingsToggle
                checked={rerankEnabled}
                ariaLabel={t("satiConfig.panels.memory.embedding.rerank.enabled.label")}
                onChange={handleRerankEnabled}
              />
            </SettingsRow>

            {rerankEnabled && (
              <>
                <FormRow
                  label={t("satiConfig.panels.memory.embedding.rerank.baseUrl.label")}
                  description={t("satiConfig.panels.memory.embedding.rerank.baseUrl.description")}
                >
                  <TextInput
                    value={rerank?.baseUrl ?? ""}
                    placeholder={DEFAULT_RERANK_BASE_URL}
                    monospace
                    onChange={next =>
                      applyRerank(draft => {
                        if (next.trim()) draft.baseUrl = next;
                        else delete draft.baseUrl;
                      })
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.memory.embedding.rerank.model.label")}
                  description={t("satiConfig.panels.memory.embedding.rerank.model.description")}
                >
                  <TextInput
                    value={rerank?.model ?? ""}
                    placeholder={t("satiConfig.panels.memory.embedding.rerank.model.placeholder")}
                    monospace
                    onChange={next =>
                      applyRerank(draft => {
                        if (next.trim()) draft.model = next;
                        else delete draft.model;
                      })
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("satiConfig.panels.memory.embedding.rerank.topN.label")}
                  description={t("satiConfig.panels.memory.embedding.rerank.topN.description")}
                >
                  <NumberInput
                    value={rerank?.topN}
                    placeholder="16"
                    onChange={next =>
                      applyRerank(draft => {
                        if (next !== undefined && Number.isFinite(next) && next > 0) draft.topN = next;
                        else delete draft.topN;
                      })
                    }
                  />
                </FormRow>
              </>
            )}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
