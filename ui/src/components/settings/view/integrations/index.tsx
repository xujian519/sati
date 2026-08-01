import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSatiConfig } from "../../../../hooks/useSatiConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { SatiConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import GatewayConfigSection from "./components/GatewayConfigSection";
import ImChannelsSection from "./im";

type IntegrationsSectionsProps = {
  title: string;
};

export default function IntegrationsSections({ title }: IntegrationsSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = useSatiConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: SatiConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise integrations config patch", caught);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      {loading ? (
        <div className="py-6 text-xs text-muted-foreground">{t("satiConfig.loading")}</div>
      ) : parsedConfig ? (
        <GatewayConfigSection config={parsedConfig} onChange={onFormChange} />
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.integrations")}
        </div>
      )}
      <ImChannelsSection />
    </div>
  );
}
