import type { TFunction } from "i18next";

type ApiKeyFieldProps = {
  apiKey: string;
  requiresApiKey: boolean;
  onChange: (value: string) => void;
  t: TFunction<"settings">;
};

export default function ApiKeyField({ apiKey, requiresApiKey, onChange, t }: ApiKeyFieldProps) {
  return (
    <div>
      <label htmlFor="llm-api-key" className="mb-1 block text-sm font-medium text-foreground">
        {t("llmSetup.apiKeyLabel")}
        {requiresApiKey ? "" : t("llmSetup.apiKeyOptional")}
      </label>
      <input
        id="llm-api-key"
        type="password"
        value={apiKey}
        onChange={e => onChange(e.target.value)}
        placeholder={requiresApiKey ? t("llmSetup.apiKeyPlaceholder") : t("llmSetup.apiKeyNotRequired")}
        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-hidden"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}
