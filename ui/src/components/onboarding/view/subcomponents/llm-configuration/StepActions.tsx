import type { TFunction } from "i18next";
import { Loader2 } from "lucide-react";
import type { TestStatus } from "./types";

type StepActionsProps = {
  testStatus: TestStatus;
  canTest: boolean;
  canSave: boolean;
  saving: boolean;
  onTest: () => void;
  onSave: () => void;
  t: TFunction<"settings">;
};

export default function StepActions({ testStatus, canTest, canSave, saving, onTest, onSave, t }: StepActionsProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-6">
      {testStatus === "idle" && canTest && (
        <span className="mr-auto text-xs text-muted-foreground">{t("llmSetup.testOptional")}</span>
      )}
      <button
        type="button"
        onClick={onTest}
        disabled={!canTest || testStatus === "testing"}
        className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        {testStatus === "testing" ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("llmSetup.testing")}
          </span>
        ) : (
          t("llmSetup.testConnection")
        )}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {saving ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("llmSetup.saving")}
          </span>
        ) : (
          t("llmSetup.save")
        )}
      </button>
    </div>
  );
}
