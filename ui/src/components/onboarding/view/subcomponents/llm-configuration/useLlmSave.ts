import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import type { CatalogProvider, CatalogProviderProtocol } from "../../../../../shared/catalogProviders";
import type { ApiModelListItem } from "../../../../../shared/modelListApi";
import { authenticatedFetch } from "../../../../../utils/api";
import { buildLlmConfig } from "../llmConfigBuilder";
import type { TestStatus } from "./types";

type UseLlmSaveParams = {
  selectedProvider: CatalogProvider | null;
  effectiveUrl: string;
  effectiveModelId: string;
  apiKey: string;
  effectiveProtocol: CatalogProviderProtocol;
  effectiveProviderId: string;
  apiModels: ApiModelListItem[] | null;
  onSaved: () => void | Promise<void>;
  t: TFunction<"settings">;
  setTestResult: (status: TestStatus, message: string) => void;
};

/** Reads the existing YAML config, merges the chosen provider and PUTs it back. */
export function useLlmSave({
  selectedProvider,
  effectiveUrl,
  effectiveModelId,
  apiKey,
  effectiveProtocol,
  effectiveProviderId,
  apiModels,
  onSaved,
  t,
  setTestResult,
}: UseLlmSaveParams) {
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      const { stringify: stringifyYaml, parse: parseYaml } = await import("yaml");

      let existingConfig: unknown = {};
      try {
        const res = await authenticatedFetch("/api/config");
        if (res.ok) {
          const data = await res.json();
          if (data.raw) existingConfig = parseYaml(data.raw) || {};
        }
      } catch {
        /* start fresh */
      }

      const providerId = effectiveProviderId;
      const modelId = effectiveModelId;
      if (!providerId) throw new Error(t("llmSetup.missingProviderId"));

      const config = buildLlmConfig(existingConfig, {
        providerId,
        modelId,
        protocol: effectiveProtocol,
        url: effectiveUrl,
        apiKey: apiKey.trim(),
        apiModels,
      });

      const saveRes = await authenticatedFetch("/api/config", {
        method: "PUT",
        body: JSON.stringify({ raw: stringifyYaml(config, { indent: 2, lineWidth: 0 }) }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        throw new Error(err.error || t("llmSetup.saveFailed"));
      }

      await onSaved();
    } catch (err) {
      setTestResult("error", err instanceof Error ? err.message : t("llmSetup.failedToSave"));
    } finally {
      setSaving(false);
    }
  }, [
    selectedProvider,
    effectiveUrl,
    effectiveModelId,
    apiKey,
    effectiveProtocol,
    effectiveProviderId,
    apiModels,
    onSaved,
    t,
    setTestResult,
  ]);

  return { saving, handleSave };
}
