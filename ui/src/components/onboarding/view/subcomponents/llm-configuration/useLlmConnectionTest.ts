import { useCallback } from "react";
import type { TFunction } from "i18next";
import type { CatalogProvider, CatalogProviderProtocol } from "../../../../../shared/catalogProviders";
import { authenticatedFetch } from "../../../../../utils/api";
import type { TestStatus } from "./types";

type UseLlmConnectionTestParams = {
  canTest: boolean;
  selectedProvider: CatalogProvider | null;
  effectiveProtocol: CatalogProviderProtocol;
  effectiveProviderId: string;
  effectiveUrl: string;
  apiKey: string;
  effectiveModelId: string;
  t: TFunction<"settings">;
  setTestResult: (status: TestStatus, message: string) => void;
};

/** The "test connection" action. It only reports diagnostics; save stays independent. */
export function useLlmConnectionTest({
  canTest,
  selectedProvider,
  effectiveProtocol,
  effectiveProviderId,
  effectiveUrl,
  apiKey,
  effectiveModelId,
  t,
  setTestResult,
}: UseLlmConnectionTestParams) {
  return useCallback(async () => {
    if (!canTest || !selectedProvider) return;
    setTestResult("testing", "");
    try {
      const res = await authenticatedFetch("/api/config/test-connection", {
        method: "POST",
        body: JSON.stringify({
          providerType: effectiveProtocol,
          providerId: effectiveProviderId,
          baseUrl: effectiveUrl,
          apiKey: apiKey.trim(),
          model: effectiveModelId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult("success", data.message || t("llmSetup.connectedSuccessfully"));
      } else {
        setTestResult("error", data.error || t("llmSetup.connectionFailed"));
      }
    } catch (err) {
      setTestResult("error", err instanceof Error ? err.message : t("llmSetup.connectionFailed"));
    }
  }, [
    canTest,
    selectedProvider,
    effectiveUrl,
    apiKey,
    effectiveModelId,
    effectiveProtocol,
    effectiveProviderId,
    t,
    setTestResult,
  ]);
}
