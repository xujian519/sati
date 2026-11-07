import { useTranslation } from "react-i18next";
import AdvancedSettings from "./llm-configuration/AdvancedSettings";
import ApiKeyField from "./llm-configuration/ApiKeyField";
import CustomProviderFields from "./llm-configuration/CustomProviderFields";
import ModelPicker from "./llm-configuration/ModelPicker";
import ProviderGrid from "./llm-configuration/ProviderGrid";
import StepActions from "./llm-configuration/StepActions";
import TestResultBanner from "./llm-configuration/TestResultBanner";
import { useLlmConfigurationState } from "./llm-configuration/useLlmConfigurationState";
import { useLlmConnectionTest } from "./llm-configuration/useLlmConnectionTest";
import { useLlmModelCatalog } from "./llm-configuration/useLlmModelCatalog";
import { useLlmSave } from "./llm-configuration/useLlmSave";

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

export default function LlmConfigurationStep({ onSaved }: LlmConfigurationStepProps) {
  const { t } = useTranslation("settings");
  const state = useLlmConfigurationState();
  const { handleFetchModels } = useLlmModelCatalog({
    selectedProvider: state.selectedProvider,
    effectiveProviderId: state.effectiveProviderId,
    effectiveProtocol: state.effectiveProtocol,
    effectiveUrl: state.effectiveUrl,
    apiKey: state.apiKey,
    isCustomMode: state.isCustomMode,
    selectedProviderRequiresApiKey: state.selectedProviderRequiresApiKey,
    canFetchModels: state.canFetchModels,
    t,
    setApiModels: state.setApiModels,
    setModelListStatus: state.setModelListStatus,
    setModelListMessage: state.setModelListMessage,
    setSelectedModelId: state.setSelectedModelId,
  });
  const handleTest = useLlmConnectionTest({
    canTest: state.canTest,
    selectedProvider: state.selectedProvider,
    effectiveProtocol: state.effectiveProtocol,
    effectiveProviderId: state.effectiveProviderId,
    effectiveUrl: state.effectiveUrl,
    apiKey: state.apiKey,
    effectiveModelId: state.effectiveModelId,
    t,
    setTestResult: state.setTestResult,
  });
  const { saving, handleSave } = useLlmSave({
    selectedProvider: state.selectedProvider,
    effectiveUrl: state.effectiveUrl,
    effectiveModelId: state.effectiveModelId,
    apiKey: state.apiKey,
    effectiveProtocol: state.effectiveProtocol,
    effectiveProviderId: state.effectiveProviderId,
    apiModels: state.apiModels,
    onSaved,
    t,
    setTestResult: state.setTestResult,
  });

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("llmSetup.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("llmSetup.subtitle")}</p>
      </div>

      <div className="border-t border-border" />

      {/* Provider grid */}
      <ProviderGrid
        selectedProvider={state.selectedProvider}
        isCustomMode={state.isCustomMode}
        onSelect={state.handleProviderSelect}
        t={t}
      />

      {state.isCustomMode && (
        <CustomProviderFields
          customProviderId={state.customProviderId}
          customProtocol={state.customProtocol}
          customUrl={state.customUrl}
          onProviderIdChange={state.handleCustomProviderIdChange}
          onProtocolChange={state.handleCustomProtocolChange}
          onUrlChange={state.handleCustomUrlChange}
          t={t}
        />
      )}

      {/* API Key */}
      <ApiKeyField
        apiKey={state.apiKey}
        requiresApiKey={state.selectedProviderRequiresApiKey}
        onChange={state.handleApiKeyChange}
        t={t}
      />

      {/* Model picker */}
      <ModelPicker
        selectedModels={state.selectedModels}
        selectedModelId={state.selectedModelId}
        customModelId={state.customModelId}
        hasSelectedProvider={Boolean(state.selectedProvider)}
        modelListStatus={state.modelListStatus}
        modelListMessage={state.modelListMessage}
        canFetchModels={state.canFetchModels}
        onModelChange={state.handleSelectedModelChange}
        onCustomModelChange={state.handleCustomModelIdChange}
        onFetchModels={handleFetchModels}
        t={t}
      />

      {/* Advanced (catalog providers only — custom already shows URL above) */}
      {!state.isCustomMode && (
        <AdvancedSettings
          showAdvanced={state.showAdvanced}
          protocol={state.selectedProvider?.protocol ?? state.customProtocol}
          customUrl={state.customUrl}
          selectedDefaultUrl={state.selectedDefaultUrl}
          onToggle={state.toggleAdvanced}
          onUrlChange={state.handleCustomUrlChange}
          t={t}
        />
      )}

      {/* Actions */}
      <StepActions
        testStatus={state.testStatus}
        canTest={state.canTest}
        canSave={state.canTest && !saving}
        saving={saving}
        onTest={handleTest}
        onSave={handleSave}
        t={t}
      />

      <TestResultBanner testStatus={state.testStatus} testMessage={state.testMessage} />
    </div>
  );
}
