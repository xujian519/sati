import type { TFunction } from "i18next";
import { ChevronDown, Loader2 } from "lucide-react";
import type { ApiModelListItem } from "../../../../../shared/modelListApi";
import type { ModelListStatus } from "./types";

type ModelPickerProps = {
  selectedModels: ApiModelListItem[];
  selectedModelId: string;
  customModelId: string;
  hasSelectedProvider: boolean;
  modelListStatus: ModelListStatus;
  modelListMessage: string;
  canFetchModels: boolean;
  onModelChange: (value: string) => void;
  onCustomModelChange: (value: string) => void;
  onFetchModels: () => void;
  t: TFunction<"settings">;
};

export default function ModelPicker({
  selectedModels,
  selectedModelId,
  customModelId,
  hasSelectedProvider,
  modelListStatus,
  modelListMessage,
  canFetchModels,
  onModelChange,
  onCustomModelChange,
  onFetchModels,
  t,
}: ModelPickerProps) {
  return (
    <div>
      <label htmlFor="llm-model" className="mb-1 block text-sm font-medium text-foreground">
        {t("llmSetup.modelLabel")}
      </label>
      {selectedModels.length > 0 ? (
        <div className="relative">
          <select
            id="llm-model"
            value={selectedModelId}
            onChange={e => onModelChange(e.target.value)}
            className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:border-foreground/40 focus:outline-hidden"
          >
            {selectedModels.map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName} ({m.id})
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      ) : (
        <input
          id="llm-model"
          type="text"
          value={customModelId}
          onChange={e => onCustomModelChange(e.target.value)}
          placeholder={t("llmSetup.modelPlaceholder")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-hidden"
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {modelListStatus === "loading" && (
        <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("llmSetup.fetchingModels")}
        </p>
      )}
      {hasSelectedProvider && (
        <button
          type="button"
          onClick={onFetchModels}
          disabled={!canFetchModels || modelListStatus === "loading"}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("llmSetup.fetchModels")}
        </button>
      )}
      {modelListStatus === "error" && modelListMessage && (
        <p className="mt-1 text-[11px] text-destructive">{modelListMessage}</p>
      )}
      {modelListStatus === "idle" && modelListMessage && (
        <p className="mt-1 text-[11px] text-muted-foreground">{modelListMessage}</p>
      )}
      {selectedModels.length > 0 && (
        <div className="mt-2">
          <input
            type="text"
            value={customModelId}
            onChange={e => onCustomModelChange(e.target.value)}
            placeholder={t("llmSetup.customModelPlaceholder")}
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-hidden"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}
