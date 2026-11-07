import type { TFunction } from "i18next";
import type { CatalogProviderProtocol } from "../../../../../shared/catalogProviders";

type AdvancedSettingsProps = {
  showAdvanced: boolean;
  protocol: CatalogProviderProtocol;
  customUrl: string;
  selectedDefaultUrl: string;
  onToggle: () => void;
  onUrlChange: (value: string) => void;
  t: TFunction<"settings">;
};

export default function AdvancedSettings({
  showAdvanced,
  protocol,
  customUrl,
  selectedDefaultUrl,
  onToggle,
  onUrlChange,
  t,
}: AdvancedSettingsProps) {
  return (
    <div>
      <button type="button" onClick={onToggle} className="text-xs text-muted-foreground hover:text-foreground">
        {showAdvanced ? t("llmSetup.hideAdvancedToggle") : t("llmSetup.showAdvancedToggle")}
      </button>
      {showAdvanced && (
        <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
          <div>
            <label htmlFor="llm-url" className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("llmSetup.apiBaseUrl")}
            </label>
            <input
              id="llm-url"
              type="text"
              value={customUrl}
              onChange={e => onUrlChange(e.target.value)}
              placeholder={selectedDefaultUrl}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-hidden"
              autoComplete="off"
              spellCheck={false}
            />
            {protocol === "openai" && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("llmSetup.baseUrlOpenaiHintBefore")}
                <span className="font-mono">{t("llmSetup.baseUrlOpenaiHintSuffix")}</span>
                {t("llmSetup.baseUrlOpenaiHintAfter")}
              </p>
            )}
            {protocol === "openai-responses" && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("llmSetup.baseUrlOpenaiResponsesHintBefore")}
                <span className="font-mono">{t("llmSetup.baseUrlOpenaiResponsesHintSuffix")}</span>
                {t("llmSetup.baseUrlOpenaiResponsesHintAfter")}
              </p>
            )}
            {protocol === "google" && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("llmSetup.advancedGoogleHintBefore")}
                <span className="font-mono">{t("llmSetup.advancedGoogleHintSuffix")}</span>
                {t("llmSetup.advancedGoogleHintAfter")}
              </p>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t("llmSetup.protocolLabel")}
            <span className="font-mono">{protocol}</span> &middot; {t("llmSetup.defaultUrlLabel")}
            <span className="font-mono">{selectedDefaultUrl}</span>
          </div>
        </div>
      )}
    </div>
  );
}
