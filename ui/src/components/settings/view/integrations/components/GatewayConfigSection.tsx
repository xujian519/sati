import { useTranslation } from "react-i18next";
import { PageSectionHeader, SettingsCard, SettingsRow, SettingsToggle } from "../../../shared/view";
import { FormRow, TextInput } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { SatiConfig } from "../../modelPool/types";

type GatewayConfigSectionProps = {
  config: SatiConfig;
  onChange: (next: SatiConfig) => void;
};

export default function GatewayConfigSection({ config, onChange }: GatewayConfigSectionProps) {
  const { t } = useTranslation("settings");
  const gateway = config.gateway ?? {};

  return (
    <div className="space-y-2.5">
      <PageSectionHeader
        title={t("satiConfig.panels.gateway.title")}
        description={t("satiConfig.panels.gateway.description")}
      />
      <SettingsCard divided>
        <SettingsRow
          label={t("satiConfig.panels.gateway.enabled.label")}
          description={t("satiConfig.panels.gateway.enabled.description")}
        >
          <SettingsToggle
            checked={Boolean(gateway.enabled)}
            ariaLabel={t("satiConfig.panels.gateway.enabled.label")}
            onChange={value => onChange(patch(config, ["gateway", "enabled"], value))}
          />
        </SettingsRow>
        {gateway.enabled && (
          <FormRow
            label={t("satiConfig.panels.gateway.home.label")}
            description={t("satiConfig.panels.gateway.home.description")}
          >
            <TextInput
              value={gateway.home}
              placeholder="~/.sati/gateway"
              monospace
              onChange={value => onChange(patch(config, ["gateway", "home"], value))}
            />
          </FormRow>
        )}
      </SettingsCard>
    </div>
  );
}
