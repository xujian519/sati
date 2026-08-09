import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSatiConfig } from "../../../../hooks/useSatiConfig";
import { ConfigSaveError, PageSectionHeader, SettingsCard, SettingsRow, SettingsToggle } from "../../shared/view";
import { FormRow, Select } from "../../shared/components/Inputs";
import { patch } from "../modelPool/utils/patch";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { SatiConfig } from "../modelPool/types";
import { ensureModelRefConfigured } from "../agentModel/utils/modelRefs";
import { useDynamicModelOptions } from "../../../../shared/useDynamicModelOptions";
import type { SettingsProject } from "../../shared/types";
import MemoryDataSection from "./MemoryDataSection";
import KnowledgeCapabilitiesSection from "./KnowledgeCapabilitiesSection";
import EmbeddingConfigSection from "./EmbeddingConfigSection";
import {
  DEFAULT_DREAM_MINUTES,
  DEFAULT_INDEX_MINUTES,
  resolveEnabledMemoryIntervals,
  toDisplayUnit,
  toMinutes,
  type IntervalUnit,
} from "./memoryIntervals";

type AgentMemorySectionsProps = {
  title: string;
  projects: SettingsProject[];
};

function MemorySection({ config, onChange }: { config: SatiConfig; onChange: (next: SatiConfig) => void }) {
  const { t } = useTranslation("settings");
  const m = config.memory ?? {};
  const dynamicOptions = useDynamicModelOptions(config);
  const options = [{ value: "inherit", label: t("satiConfig.panels.memory.model.inherit") }, ...dynamicOptions];
  const selected = m.model && m.model.trim() ? m.model : "inherit";

  const initialIndex = toDisplayUnit(m.autoIndexIntervalMinutes, DEFAULT_INDEX_MINUTES);
  const initialDream = toDisplayUnit(m.autoDreamIntervalMinutes, DEFAULT_DREAM_MINUTES);
  const [indexUnit, setIndexUnit] = useState<IntervalUnit>(initialIndex.unit);
  const [dreamUnit, setDreamUnit] = useState<IntervalUnit>(initialDream.unit);
  const [indexEditing, setIndexEditing] = useState(false);
  const [indexDraftValue, setIndexDraftValue] = useState(String(initialIndex.value));
  const [indexDraftUnit, setIndexDraftUnit] = useState<IntervalUnit>(initialIndex.unit);
  const [dreamEditing, setDreamEditing] = useState(false);
  const [dreamDraftValue, setDreamDraftValue] = useState(String(initialDream.value));
  const [dreamDraftUnit, setDreamDraftUnit] = useState<IntervalUnit>(initialDream.unit);

  const applyIndex = (value: number | undefined, unit: IntervalUnit) => {
    onChange(patch(config, ["memory", "autoIndexIntervalMinutes"], toMinutes(value, unit)));
  };

  const applyDream = (value: number | undefined, unit: IntervalUnit) => {
    onChange(patch(config, ["memory", "autoDreamIntervalMinutes"], toMinutes(value, unit)));
  };

  const handleMemoryEnabled = (enabled: boolean) => {
    let next = patch(config, ["memory", "enabled"], enabled);
    if (enabled) {
      const intervals = resolveEnabledMemoryIntervals(config.memory);
      next = patch(next, ["memory", "autoIndexIntervalMinutes"], intervals.autoIndexIntervalMinutes);
      next = patch(next, ["memory", "autoDreamIntervalMinutes"], intervals.autoDreamIntervalMinutes);
    }
    onChange(next);
  };

  const indexValueDisplay =
    indexUnit === "hours"
      ? Math.max(0, Math.floor((m.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES) / 60))
      : (m.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES);

  const dreamValueDisplay =
    dreamUnit === "hours"
      ? Math.max(0, Math.floor((m.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES) / 60))
      : (m.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES);

  const commitIndex = () => {
    const parsed = Number(indexDraftValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setIndexUnit(indexDraftUnit);
    applyIndex(parsed, indexDraftUnit);
    setIndexEditing(false);
  };

  const cancelIndex = () => {
    setIndexDraftValue(String(indexValueDisplay));
    setIndexDraftUnit(indexUnit);
    setIndexEditing(false);
  };

  const commitDream = () => {
    const parsed = Number(dreamDraftValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setDreamUnit(dreamDraftUnit);
    applyDream(parsed, dreamDraftUnit);
    setDreamEditing(false);
  };

  const cancelDream = () => {
    setDreamDraftValue(String(dreamValueDisplay));
    setDreamDraftUnit(dreamUnit);
    setDreamEditing(false);
  };

  return (
    <div className="space-y-3 pb-6">
      <PageSectionHeader description={t("satiConfig.panels.memory.description")} />
      <SettingsCard>
        <SettingsRow
          label={t("satiConfig.panels.memory.enabled.label")}
          description={t("satiConfig.panels.memory.enabled.description")}
        >
          <SettingsToggle
            checked={Boolean(m.enabled)}
            ariaLabel={t("satiConfig.panels.memory.enabled.label")}
            onChange={handleMemoryEnabled}
          />
        </SettingsRow>
        {m.enabled && (
          <>
            <FormRow
              label={t("satiConfig.panels.memory.model.label")}
              description={t("satiConfig.panels.memory.model.description")}
            >
              <Select
                value={selected}
                options={options}
                onChange={v => {
                  const nextValue = v === "inherit" ? "" : v;
                  onChange(patch(ensureModelRefConfigured(config, nextValue), ["memory", "model"], nextValue));
                }}
              />
            </FormRow>

            <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[minmax(360px,1fr)_420px] sm:gap-4">
              <div className="min-w-0">
                <div className="text-[13px] leading-5 font-medium text-foreground">
                  {t("satiConfig.panels.memory.autoIndexInterval.label")}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t("satiConfig.panels.memory.autoIndexInterval.description")}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2.5">
                <div className="w-32">
                  <input
                    type="number"
                    min={0}
                    value={indexEditing ? indexDraftValue : String(indexValueDisplay)}
                    readOnly={!indexEditing}
                    onChange={event => setIndexDraftValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelIndex();
                      }
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
                        event.preventDefault();
                        commitIndex();
                      }
                    }}
                    className={
                      indexEditing
                        ? "w-full rounded-md border border-primary/40 bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground ring-1 ring-ring/40 outline-hidden focus:ring-1 focus:ring-ring"
                        : "w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[13px] leading-5 text-muted-foreground outline-hidden"
                    }
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={indexEditing ? indexDraftUnit : indexUnit}
                    disabled={!indexEditing}
                    options={[
                      { value: "minutes", label: t("satiConfig.panels.memory.intervalUnits.minutes") },
                      { value: "hours", label: t("satiConfig.panels.memory.intervalUnits.hours") },
                    ]}
                    onChange={v => {
                      const unit = v === "hours" ? "hours" : "minutes";
                      if (!indexEditing) return;
                      setIndexDraftUnit(unit);
                    }}
                  />
                </div>
                {indexEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={cancelIndex}
                      className="rounded border border-border bg-background px-2 py-1 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {t("settingsPage.actions.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={commitIndex}
                      disabled={!Number.isFinite(Number(indexDraftValue)) || Number(indexDraftValue) < 0}
                      className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] whitespace-nowrap text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("settingsPage.actions.save")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setIndexDraftValue(String(indexValueDisplay));
                      setIndexDraftUnit(indexUnit);
                      setIndexEditing(true);
                    }}
                    className="rounded border border-border bg-background px-2 py-1 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("settingsPage.actions.edit")}
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[minmax(360px,1fr)_420px] sm:gap-4">
              <div className="min-w-0">
                <div className="text-[13px] leading-5 font-medium text-foreground">
                  {t("satiConfig.panels.memory.autoDreamInterval.label")}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t("satiConfig.panels.memory.autoDreamInterval.description")}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2.5">
                <div className="w-32">
                  <input
                    type="number"
                    min={0}
                    value={dreamEditing ? dreamDraftValue : String(dreamValueDisplay)}
                    readOnly={!dreamEditing}
                    onChange={event => setDreamDraftValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelDream();
                      }
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
                        event.preventDefault();
                        commitDream();
                      }
                    }}
                    className={
                      dreamEditing
                        ? "w-full rounded-md border border-primary/40 bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground ring-1 ring-ring/40 outline-hidden focus:ring-1 focus:ring-ring"
                        : "w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[13px] leading-5 text-muted-foreground outline-hidden"
                    }
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={dreamEditing ? dreamDraftUnit : dreamUnit}
                    disabled={!dreamEditing}
                    options={[
                      { value: "minutes", label: t("satiConfig.panels.memory.intervalUnits.minutes") },
                      { value: "hours", label: t("satiConfig.panels.memory.intervalUnits.hours") },
                    ]}
                    onChange={v => {
                      const unit = v === "hours" ? "hours" : "minutes";
                      if (!dreamEditing) return;
                      setDreamDraftUnit(unit);
                    }}
                  />
                </div>
                {dreamEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={cancelDream}
                      className="rounded border border-border bg-background px-2 py-1 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {t("settingsPage.actions.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={commitDream}
                      disabled={!Number.isFinite(Number(dreamDraftValue)) || Number(dreamDraftValue) < 0}
                      className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] whitespace-nowrap text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("settingsPage.actions.save")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDreamDraftValue(String(dreamValueDisplay));
                      setDreamDraftUnit(dreamUnit);
                      setDreamEditing(true);
                    }}
                    className="rounded border border-border bg-background px-2 py-1 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("settingsPage.actions.edit")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </SettingsCard>
    </div>
  );
}

export default function AgentMemorySections({ title, projects }: AgentMemorySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = useSatiConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: SatiConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise agent memory config patch", caught);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">{t("satiConfig.loading")}</div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentMemory")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      <MemorySection config={parsedConfig} onChange={onFormChange} />
      <EmbeddingConfigSection config={parsedConfig} onChange={onFormChange} />
      <MemoryDataSection projects={projects} />
      <KnowledgeCapabilitiesSection projects={projects} />
    </div>
  );
}
