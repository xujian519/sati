import type { TFunction } from "i18next";
import { Check, Plus } from "lucide-react";
import { CATALOG_PROVIDERS, type CatalogProvider } from "../../../../../shared/catalogProviders";
import { CUSTOM_PROVIDER } from "./constants";

type ProviderGridProps = {
  selectedProvider: CatalogProvider | null;
  isCustomMode: boolean;
  onSelect: (provider: CatalogProvider) => void;
  t: TFunction<"settings">;
};

export default function ProviderGrid({ selectedProvider, isCustomMode, onSelect, t }: ProviderGridProps) {
  return (
    <div>
      <div className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("llmSetup.providerLabel")}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CATALOG_PROVIDERS.map(provider => (
          <button
            key={provider.id}
            type="button"
            onClick={() => onSelect(provider)}
            className={`relative rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
              selectedProvider?.id === provider.id
                ? "border-foreground bg-muted text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            }`}
          >
            <div className="font-medium">{provider.displayName}</div>
            {selectedProvider?.id === provider.id && (
              <Check className="absolute top-2 right-2 h-4 w-4 text-foreground" strokeWidth={2.5} />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onSelect(CUSTOM_PROVIDER)}
          className={`relative flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-left text-sm transition-colors ${
            isCustomMode
              ? "border-foreground bg-muted text-foreground"
              : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          }`}
        >
          <Plus className="h-4 w-4" />
          <div>
            <div className="font-medium">{t("llmSetup.custom")}</div>
            <div className="mt-0.5 text-[11px] opacity-60">{t("llmSetup.customHint")}</div>
          </div>
          {isCustomMode && <Check className="absolute top-2 right-2 h-4 w-4 text-foreground" strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
}
