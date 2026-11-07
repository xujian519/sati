import type { TFunction } from "i18next";
import { ChevronDown } from "lucide-react";
import type { CatalogProviderProtocol } from "../../../../../shared/catalogProviders";

type CustomProviderFieldsProps = {
  customProviderId: string;
  customProtocol: CatalogProviderProtocol;
  customUrl: string;
  onProviderIdChange: (value: string) => void;
  onProtocolChange: (value: CatalogProviderProtocol) => void;
  onUrlChange: (value: string) => void;
  t: TFunction<"settings">;
};

export default function CustomProviderFields({
  customProviderId,
  customProtocol,
  customUrl,
  onProviderIdChange,
  onProtocolChange,
  onUrlChange,
  t,
}: CustomProviderFieldsProps) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
      <div>
        <label htmlFor="custom-provider-id" className="mb-1 block text-sm font-medium text-foreground">
          {t("llmSetup.customProviderId")}
        </label>
        <input
          id="custom-provider-id"
          type="text"
          value={customProviderId}
          onChange={e => onProviderIdChange(e.target.value)}
          placeholder={t("llmSetup.customProviderIdPlaceholder")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-hidden"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">{t("llmSetup.customProviderIdHint")}</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <label htmlFor="custom-protocol" className="mb-1 block text-sm font-medium text-foreground">
            {t("llmSetup.protocol")}
          </label>
          <div className="relative">
            <select
              id="custom-protocol"
              value={customProtocol}
              onChange={e => onProtocolChange(e.target.value as CatalogProviderProtocol)}
              className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:border-foreground/40 focus:outline-hidden"
            >
              <option value="openai">openai</option>
              <option value="openai-responses">openai-responses</option>
              <option value="anthropic">anthropic</option>
              <option value="google">google</option>
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        <div className="col-span-2">
          <label htmlFor="custom-base-url" className="mb-1 block text-sm font-medium text-foreground">
            {t("llmSetup.baseUrl")}
          </label>
          <input
            id="custom-base-url"
            type="text"
            value={customUrl}
            onChange={e => onUrlChange(e.target.value)}
            placeholder={t("llmSetup.baseUrlPlaceholder")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-hidden"
            autoComplete="off"
            spellCheck={false}
          />
          {customProtocol === "openai" && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("llmSetup.baseUrlOpenaiHintBefore")}
              <span className="font-mono">{t("llmSetup.baseUrlOpenaiHintSuffix")}</span>
              {t("llmSetup.baseUrlOpenaiHintAfter")}
            </p>
          )}
          {customProtocol === "openai-responses" && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("llmSetup.baseUrlOpenaiResponsesHintBefore")}
              <span className="font-mono">{t("llmSetup.baseUrlOpenaiResponsesHintSuffix")}</span>
              {t("llmSetup.baseUrlOpenaiResponsesHintAfter")}
            </p>
          )}
          {customProtocol === "google" && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("llmSetup.baseUrlGoogleHintBefore")}
              <span className="font-mono">{t("llmSetup.baseUrlGoogleHintSuffix")}</span>
              {t("llmSetup.baseUrlGoogleHintAfter")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
