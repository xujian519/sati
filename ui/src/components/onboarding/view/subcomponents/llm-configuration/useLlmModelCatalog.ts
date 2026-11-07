import { type Dispatch, type SetStateAction, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import type { CatalogProvider, CatalogProviderProtocol } from "../../../../../shared/catalogProviders";
import {
  fetchProviderModels,
  fetchRemoteDefaultModels,
  type ApiModelListItem,
} from "../../../../../shared/modelListApi";
import {
  hasUsableApiKey,
  modelUsesRemoteDefault,
  resolveLoadErrorKind,
  resolveNextModels,
  type ModelLoadContext,
  type ModelLoadMode,
} from "../llmModelLoading";
import type { ModelListStatus } from "./types";

type UseLlmModelCatalogParams = {
  selectedProvider: CatalogProvider | null;
  effectiveProviderId: string;
  effectiveProtocol: CatalogProviderProtocol;
  effectiveUrl: string;
  apiKey: string;
  isCustomMode: boolean;
  selectedProviderRequiresApiKey: boolean;
  canFetchModels: boolean;
  t: TFunction<"settings">;
  setApiModels: Dispatch<SetStateAction<ApiModelListItem[] | null>>;
  setModelListStatus: Dispatch<SetStateAction<ModelListStatus>>;
  setModelListMessage: Dispatch<SetStateAction<string>>;
  setSelectedModelId: Dispatch<SetStateAction<string>>;
};

/**
 * Model-list loading for the onboarding LLM step: auto-load on provider/URL
 * changes, the manual "fetch models" action, and the catalog fallback/error
 * semantics (delegated to llmModelLoading so they stay in one place).
 */
export function useLlmModelCatalog({
  selectedProvider,
  effectiveProviderId,
  effectiveProtocol,
  effectiveUrl,
  apiKey,
  isCustomMode,
  selectedProviderRequiresApiKey,
  canFetchModels,
  t,
  setApiModels,
  setModelListStatus,
  setModelListMessage,
  setSelectedModelId,
}: UseLlmModelCatalogParams) {
  const loadModels = useCallback(
    async (mode: ModelLoadMode, signal?: AbortSignal) => {
      if (!selectedProvider || !effectiveProviderId) return;
      const key = apiKey.trim();
      const ctx: ModelLoadContext = {
        providerId: effectiveProviderId,
        protocol: effectiveProtocol,
        url: effectiveUrl,
        apiKey: key,
        isCustomMode,
        requiresApiKey: selectedProviderRequiresApiKey,
      };
      const remoteDefault = modelUsesRemoteDefault(mode, ctx);
      if (!remoteDefault && !effectiveUrl) return;

      setModelListStatus("loading");
      setModelListMessage("");
      try {
        const models = remoteDefault
          ? await fetchRemoteDefaultModels(effectiveProviderId)
          : await fetchProviderModels({
              protocol: effectiveProtocol,
              baseUrl: effectiveUrl,
              apiKey: hasUsableApiKey(key) ? key : "",
              providerId: effectiveProviderId,
            });
        if (signal?.aborted) return;
        const nextModels = resolveNextModels(mode, ctx, selectedProvider, models);
        setApiModels(nextModels);
        setModelListStatus("idle");
        setSelectedModelId(current =>
          nextModels.length > 0 && !nextModels.some(model => model.id === current) ? nextModels[0].id : current,
        );
      } catch (error) {
        if (signal?.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        const kind = resolveLoadErrorKind(mode, ctx, selectedProvider);
        if (kind === "remote-default") {
          setApiModels(selectedProvider?.models ?? []);
          setModelListStatus("idle");
          setModelListMessage(t("llmSetup.remoteModelLoadFailed", { message }));
        } else if (kind === "local-fallback") {
          setApiModels(selectedProvider?.models ?? []);
          setModelListStatus("idle");
          setModelListMessage(t("llmSetup.localModelLoadFailed", { message }));
        } else {
          setModelListStatus("error");
          setModelListMessage(message);
        }
      }
    },
    [
      apiKey,
      effectiveProviderId,
      effectiveProtocol,
      effectiveUrl,
      isCustomMode,
      selectedProvider,
      selectedProviderRequiresApiKey,
      t,
      setApiModels,
      setModelListStatus,
      setModelListMessage,
      setSelectedModelId,
    ],
  );

  useEffect(() => {
    if (!selectedProvider) return;
    const key = apiKey.trim();
    const catalogNoKey = !isCustomMode && !key && selectedProviderRequiresApiKey;
    const blockedNoKey = !hasUsableApiKey(key) && !isCustomMode && selectedProviderRequiresApiKey;
    if (!catalogNoKey && !(effectiveProviderId && effectiveUrl && !blockedNoKey)) return;
    const controller = new AbortController();
    void loadModels("auto", controller.signal);
    return () => controller.abort();
  }, [
    apiKey,
    effectiveProviderId,
    effectiveUrl,
    isCustomMode,
    loadModels,
    selectedProvider,
    selectedProviderRequiresApiKey,
  ]);

  const handleFetchModels = useCallback(async () => {
    if (!canFetchModels) return;
    await loadModels("manual");
  }, [canFetchModels, loadModels]);

  return { handleFetchModels };
}
