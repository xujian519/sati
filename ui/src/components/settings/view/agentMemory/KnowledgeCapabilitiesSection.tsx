import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../../../shared/view/ui";
import { cn } from "../../../../lib/utils";
import { authenticatedFetch } from "../../../../utils/api";
import type { SettingsProject } from "../../shared/types";
import { FormRow, Select } from "../../shared/components/Inputs";
import { SettingsCard, SettingsSection } from "../../shared/view";
import { buildProjectTargets, projectPathFromTarget } from "./projectTargets";

type KnowledgeCapabilityWire = {
  id: string;
  label: string;
  status: "ready" | "missing" | "disabled";
  detail?: string;
};

type KnowledgeRuntimeStatsWire = {
  cacheHits: number;
  cacheMisses: number;
  semanticCalls: number;
  semanticFailures: number;
  rerankCalls: number;
  rerankFailures: number;
  breakers: Array<{ name: string; state: string }>;
  kgFtsMode: string;
  wikiSemanticIndex: string;
};

type KnowledgeCapabilitiesWire = {
  dataDir: string;
  capabilities: KnowledgeCapabilityWire[];
  embeddingConfigured: boolean;
  rerankConfigured: boolean;
  stats?: KnowledgeRuntimeStatsWire;
};

type KnowledgeSectionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: KnowledgeCapabilitiesWire }
  | { kind: "error"; message: string };

type KnowledgeCapabilitiesSectionProps = {
  projects: SettingsProject[];
};

function statusBadgeClass(status: KnowledgeCapabilityWire["status"]): string {
  switch (status) {
    case "ready":
      return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
    case "missing":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function breakerTone(state: string): string {
  return state === "closed"
    ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
    : "border-destructive/30 bg-destructive/10 text-destructive";
}

export default function KnowledgeCapabilitiesSection({ projects }: KnowledgeCapabilitiesSectionProps) {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<KnowledgeSectionState>({ kind: "idle" });

  const projectTargets = useMemo(
    () => buildProjectTargets(projects, t("satiConfig.panels.memory.data.target.projectFallback")),
    [projects, t],
  );

  const [selectedTarget, setSelectedTarget] = useState(() => projectTargets[0]?.value ?? "");
  useEffect(() => {
    if (!projectTargets.some(target => target.value === selectedTarget)) {
      setSelectedTarget(projectTargets[0]?.value ?? "");
    }
  }, [projectTargets, selectedTarget]);

  const targetOptions = useMemo(
    () => projectTargets.map(target => ({ value: target.value, label: target.label })),
    [projectTargets],
  );

  // 知识库状态按项目查询；target 编码了项目绝对路径（路由支持绝对路径参数）。
  const projectRoot = projectPathFromTarget(selectedTarget);

  const load = useCallback(async () => {
    if (!projectRoot) return;
    setState({ kind: "loading" });
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectRoot)}/knowledge-capabilities`,
        { suppressServerErrorToast: true },
      );
      const raw = await response.text();
      if (!response.ok) {
        let message = `${t("satiConfig.panels.memory.knowledge.error")}: ${response.status}`;
        try {
          const body = JSON.parse(raw) as { error?: string };
          if (typeof body?.error === "string" && body.error.trim()) message = body.error;
        } catch {
          // 保留状态码文案
        }
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "ready", data: JSON.parse(raw) as KnowledgeCapabilitiesWire });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [projectRoot, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = state.kind === "loading";
  const stats = state.kind === "ready" ? state.data.stats : undefined;

  return (
    <SettingsSection
      title={t("satiConfig.panels.memory.knowledge.title")}
      description={t("satiConfig.panels.memory.knowledge.description")}
    >
      <SettingsCard divided>
        <FormRow
          label={t("satiConfig.panels.memory.data.target.label")}
          description={t("satiConfig.panels.memory.data.target.description")}
        >
          <Select
            value={selectedTarget}
            options={targetOptions}
            onChange={value => {
              setSelectedTarget(value);
              setState({ kind: "idle" });
            }}
          />
        </FormRow>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-muted-foreground">
              {state.kind === "ready" && (
                <span className="break-all">
                  {t("satiConfig.panels.memory.knowledge.dataDir")}: <code>{state.data.dataDir}</code>
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              disabled={loading || projectTargets.length === 0}
              onClick={() => void load()}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t("satiConfig.panels.memory.knowledge.refresh")}
            </Button>
          </div>

          {projectTargets.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">{t("satiConfig.panels.memory.knowledge.empty")}</p>
          )}

          {state.kind === "error" && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{state.message}</span>
            </div>
          )}

          {state.kind === "ready" && (
            <ul className="mt-3 space-y-1.5">
              {state.data.capabilities.map(cap => (
                <li key={cap.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] leading-4",
                      statusBadgeClass(cap.status),
                    )}
                  >
                    {cap.status === "ready"
                      ? t("satiConfig.panels.memory.knowledge.statusReady")
                      : cap.status === "missing"
                        ? t("satiConfig.panels.memory.knowledge.statusMissing")
                        : t("satiConfig.panels.memory.knowledge.statusDisabled")}
                  </span>
                  <span className="text-foreground">{cap.label}</span>
                  {cap.detail && <span className="text-[11px] text-muted-foreground">{cap.detail}</span>}
                </li>
              ))}
            </ul>
          )}

          {state.kind === "ready" && !stats && (
            <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
              {t("satiConfig.panels.memory.knowledge.stats.noStats")}
            </div>
          )}

          {state.kind === "ready" && stats && (
            <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2.5">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t("satiConfig.panels.memory.knowledge.stats.title")}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-3">
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.cacheHits")}: {stats.cacheHits}
                </span>
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.cacheMisses")}: {stats.cacheMisses}
                </span>
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.semanticCalls")}: {stats.semanticCalls}
                </span>
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.semanticFailures")}: {stats.semanticFailures}
                </span>
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.rerankCalls")}: {stats.rerankCalls}
                </span>
                <span>
                  {t("satiConfig.panels.memory.knowledge.stats.rerankFailures")}: {stats.rerankFailures}
                </span>
              </div>
              {stats.breakers.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t("satiConfig.panels.memory.knowledge.stats.breakers")}:
                  </span>
                  {stats.breakers.map(breaker => (
                    <span
                      key={breaker.name}
                      className={cn(
                        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] leading-4",
                        breakerTone(breaker.state),
                      )}
                    >
                      {breaker.name}={breaker.state}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
