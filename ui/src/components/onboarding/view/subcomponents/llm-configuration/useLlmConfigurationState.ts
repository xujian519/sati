import { useCallback, useEffect, useState } from "react";
import {
  findCatalogProviderByUrl,
  type CatalogProvider,
  type CatalogProviderProtocol,
} from "../../../../../shared/catalogProviders";
import type { ApiModelListItem } from "../../../../../shared/modelListApi";
import { authenticatedFetch } from "../../../../../utils/api";
import { hasUsableApiKey, requiresApiKey } from "../llmModelLoading";
import { CUSTOM_PROVIDER_ID, DEFAULT_PROVIDER, defaultModelForProvider } from "./constants";
import type { ModelListStatus, TestStatus } from "./types";

/**
 * Owns every synchronous piece of onboarding LLM state (form fields, catalog
 * selection, test feedback and model-list status) plus the derived values the
 * async actions share. Kept separate from the network hooks so each one can be
 * read on its own.
 */
export function useLlmConfigurationState() {
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(DEFAULT_PROVIDER);
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelForProvider(DEFAULT_PROVIDER));
  const [customModelId, setCustomModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [modelListStatus, setModelListStatus] = useState<ModelListStatus>("idle");
  const [modelListMessage, setModelListMessage] = useState("");

  // Inputs that are only relevant when the user picks the "+" (custom) tile.
  const [customProviderId, setCustomProviderId] = useState("");
  const [customProtocol, setCustomProtocol] = useState<CatalogProviderProtocol>("openai");

  const isCustomMode = selectedProvider?.id === CUSTOM_PROVIDER_ID;
  const selectedModels = apiModels ?? selectedProvider?.models ?? [];
  const selectedDefaultUrl = selectedProvider?.defaultUrl ?? "";

  useEffect(() => {
    (async () => {
      try {
        const res = await authenticatedFetch("/api/config/provider");
        if (!res.ok) return;
        const data = await res.json();
        if (!data.exists || !data.provider) return;

        const p = data.provider;
        const existingKeyIsUsable = hasUsableApiKey(p.apiKey);
        if (!existingKeyIsUsable) return;
        setApiKey(p.apiKey);
        if (p.baseUrl) {
          const match = findCatalogProviderByUrl(p.baseUrl);
          if (match) {
            setSelectedProvider(match);
            setSelectedModelId(p.model || defaultModelForProvider(match));
          }
        }
      } catch {
        /* no existing config */
      }
    })();
  }, []);

  const effectiveUrl = customUrl.trim() || selectedProvider?.defaultUrl || "";
  const effectiveModelId = customModelId.trim() || selectedModelId;
  const effectiveProtocol: CatalogProviderProtocol = isCustomMode
    ? customProtocol
    : (selectedProvider?.protocol ?? "openai");
  const effectiveProviderId = isCustomMode ? customProviderId.trim() : (selectedProvider?.id ?? "");
  const selectedProviderRequiresApiKey = requiresApiKey(selectedProvider);
  const canFetchModels = Boolean(selectedProvider && effectiveProviderId && effectiveUrl);
  const canTest = Boolean(
    selectedProvider &&
      (!selectedProviderRequiresApiKey || apiKey.trim()) &&
      effectiveModelId &&
      effectiveProviderId &&
      (!isCustomMode || effectiveUrl.trim()),
  );

  useEffect(() => {
    setApiModels(null);
    setModelListStatus("idle");
    setModelListMessage("");
  }, [effectiveProviderId, effectiveUrl, effectiveProtocol]);

  const setTestResult = useCallback((status: TestStatus, message: string) => {
    setTestStatus(status);
    setTestMessage(message);
  }, []);

  const clearTestResult = useCallback(() => {
    setTestStatus("idle");
    setTestMessage("");
  }, []);

  const handleProviderSelect = useCallback((provider: CatalogProvider) => {
    setSelectedProvider(prev => {
      // Switching to a different provider should not carry over the API key
      // from the previously selected one (otherwise users adding a 2nd
      // provider re-save their Anthropic key under OpenAI).
      if (prev?.id !== provider.id) {
        setApiKey("");
      }
      return provider;
    });
    setSelectedModelId(defaultModelForProvider(provider));
    setApiModels(null);
    setModelListStatus("idle");
    setModelListMessage("");
    setCustomModelId("");
    setCustomUrl("");
    setCustomProviderId("");
    setCustomProtocol("openai");
    setTestStatus("idle");
    setTestMessage("");
  }, []);

  const handleCustomProviderIdChange = (value: string) => {
    setCustomProviderId(value);
    clearTestResult();
  };

  const handleCustomProtocolChange = (value: CatalogProviderProtocol) => {
    setCustomProtocol(value);
    clearTestResult();
  };

  const handleCustomUrlChange = (value: string) => {
    setCustomUrl(value);
    clearTestResult();
  };

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    clearTestResult();
  };

  const handleSelectedModelChange = (value: string) => {
    setSelectedModelId(value);
    setCustomModelId("");
    clearTestResult();
  };

  const handleCustomModelIdChange = (value: string) => {
    setCustomModelId(value);
    clearTestResult();
  };

  const toggleAdvanced = () => setShowAdvanced(current => !current);

  return {
    selectedProvider,
    selectedModelId,
    customModelId,
    apiKey,
    customUrl,
    showAdvanced,
    testStatus,
    testMessage,
    apiModels,
    modelListStatus,
    modelListMessage,
    customProviderId,
    customProtocol,
    isCustomMode,
    selectedModels,
    selectedDefaultUrl,
    effectiveUrl,
    effectiveModelId,
    effectiveProtocol,
    effectiveProviderId,
    selectedProviderRequiresApiKey,
    canFetchModels,
    canTest,
    setSelectedModelId,
    setApiModels,
    setModelListStatus,
    setModelListMessage,
    setTestResult,
    handleProviderSelect,
    handleCustomProviderIdChange,
    handleCustomProtocolChange,
    handleCustomUrlChange,
    handleApiKeyChange,
    handleSelectedModelChange,
    handleCustomModelIdChange,
    toggleAdvanced,
  };
}
