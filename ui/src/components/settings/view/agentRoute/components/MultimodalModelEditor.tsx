import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { ensureModelRefsConfigured } from "../../agentModel/utils/modelRefs";
import { useDynamicModelOptions } from "../../../../../shared/useDynamicModelOptions";
import { patch } from "../../modelPool/utils/patch";
import type { SatiConfig } from "../../modelPool/types";
import { SettingsCard } from "../../../shared/view";
import ModelRefInput from "./ModelRefInput";

type MultimodalModelEditorProps = {
  config: SatiConfig;
  onChange: (next: SatiConfig) => void;
};

/**
 * 多模态模型选择：写 router.fallback.media。
 * 与 RouterFallbackEditor 不同，media 键仅用于媒体升级（附图/PDF 请求），
 * 不参与故障降级链——语义独立、成本透明。
 */
export default function MultimodalModelEditor({ config, onChange }: MultimodalModelEditorProps) {
  const { t } = useTranslation("settings");
  const media = config.router?.fallback?.media ?? [];
  const modelOpts = useDynamicModelOptions(config);

  const setMedia = (chain: string[]) => {
    if (chain.length === 0) {
      // 删空时移除 media 键，而非残留 media: []（后端 parse 会忽略空数组，但 yaml 应干净）。
      const fallback = { ...(config.router?.fallback ?? {}) };
      delete fallback.media;
      onChange(patch(config, ["router", "fallback"], fallback));
      return;
    }
    onChange(patch(ensureModelRefsConfigured(config, chain), ["router", "fallback", "media"], chain));
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{t("satiConfig.panels.router.media.title")}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{t("satiConfig.panels.router.media.description")}</div>
      </div>
      {media.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("satiConfig.panels.router.media.empty")}
        </div>
      )}
      <div className="space-y-1.5">
        {media.map((model, idx) => (
          <div key={`${idx}-${model}`} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-[10px] font-semibold text-muted-foreground">{idx + 1}</span>
            <div className="min-w-0 flex-1">
              <ModelRefInput
                value={model}
                options={modelOpts}
                onChange={v => {
                  const next = [...media];
                  next[idx] = v;
                  setMedia(next);
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setMedia(media.filter((_, i) => i !== idx))}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t("satiConfig.actions.removeModel")}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setMedia([...(media ?? []), modelOpts[0]?.value ?? ""])}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {t("satiConfig.panels.router.media.addModel")}
        </button>
      </div>
    </SettingsCard>
  );
}
