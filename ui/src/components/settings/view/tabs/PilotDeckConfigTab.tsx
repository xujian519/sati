import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Code2,
  FileCog,
  FolderOpen,
  Gauge,
  Image as ImageIcon,
  Info,
  LayoutList,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { usePilotDeckConfig, type ConfigReload } from '../../../../hooks/usePilotDeckConfig';
import {
  getAlwaysOnProjectRoot,
  isAlwaysOnProjectEnabled,
  setAlwaysOnProjectEnabled,
} from '../../../../utils/alwaysOnConfigPatch';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { cn } from '../../../../lib/utils';
import {
  CATALOG_PROVIDERS,
  findCatalogProviderById,
  type CatalogProvider,
  type CatalogModel,
} from '../../../../shared/catalogProviders';
import type { SettingsProject } from '../../types/types';

// ── V2 schema types ────────────────────────────────────────────────────
// Schema mirrors ~/.pilotdeck/pilotdeck.yaml exactly. No more
// pre-/post-translation in the backend — disk shape === UI shape.

type V2Provider = {
  protocol?: 'openai' | 'anthropic';
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  models?: Record<string, Record<string, unknown> | null>;
};

type PilotDeckConfig = {
  schemaVersion?: number;
  agent?: {
    model?: string;
    params?: Record<string, unknown>;
    subagents?: { default?: string; params?: Record<string, unknown> };
  };
  model?: {
    providers?: Record<string, V2Provider>;
  };
  memory?: {
    enabled?: boolean;
    model?: string;
    apiType?: string;
    reasoningMode?: string;
    autoIndexIntervalMinutes?: number;
    autoDreamIntervalMinutes?: number;
    captureStrategy?: string;
    includeAssistant?: boolean;
    maxMessageChars?: number;
    heartbeatBatchSize?: number;
  };
  webui?: {
    runtime?: {
      host?: string;
      serverPort?: number;
      vitePort?: number;
      proxyPort?: number;
      contextWindow?: number;
      apiTimeoutMs?: number;
      httpsProxy?: string;
      databasePath?: string;
      workspacesRoot?: string;
    };
  };
  alwaysOn?: {
    enabled?: boolean;
    trigger?: {
      enabled?: boolean;
      tickIntervalMinutes?: number;
      cooldownMinutes?: number;
      dailyBudget?: number;
      heartbeatStaleSeconds?: number;
      recentUserMsgMinutes?: number;
      preferChannel?: string;
    };
    dormancy?: {
      enabled?: boolean;
      debounceMs?: number;
      ignoreGlobs?: string[];
    };
    workspace?: {
      gitWorktreeBaseDir?: string;
      snapshotBaseDir?: string;
      snapshotMaxBytes?: number;
      gitLfs?: boolean;
    };
    execution?: {
      maxTurns?: number;
      maxToolCalls?: number;
      timeoutMinutes?: number;
    };
    projects?: Record<string, { enabled?: boolean }>;
  };
  customEnv?: Record<string, string>;
  router?: {
    enabled?: boolean;
    scenarios?: Record<string, string>;
    fallback?: Record<string, string[]>;
    zeroUsageRetry?: {
      enabled?: boolean;
      maxAttempts?: number;
    };
    tokenSaver?: {
      enabled?: boolean;
      judge?: string;
      defaultTier?: string;
      judgeTimeoutMs?: number;
      tiers?: Record<string, { model?: string; description?: string }>;
      rules?: string[];
      subagent?: { policy?: string };
    };
    autoOrchestrate?: {
      enabled?: boolean;
      triggerTiers?: string[];
      slimSystemPrompt?: boolean;
    };
    stats?: {
      enabled?: boolean;
      modelPricing?: Record<string, { input?: number; output?: number; cacheRead?: number }>;
    };
  } & Record<string, unknown>;
  gateway?: { enabled?: boolean; home?: string } & Record<string, unknown>;
  tools?: {
    webSearch?: {
      apiKey?: string;
      endpoint?: string;
    };
  };
};

type SectionId = 'models' | 'agents' | 'memory' | 'tools' | 'router' | 'gateway' | 'customEnv' | 'alwaysOn' | 'advanced';

const SECTIONS: Array<{ id: SectionId; labelKey: string; descriptionKey: string }> = [
  { id: 'models',    labelKey: 'models',    descriptionKey: 'models' },
  { id: 'agents',    labelKey: 'agents',    descriptionKey: 'agents' },
  { id: 'memory',    labelKey: 'memory',    descriptionKey: 'memory' },
  { id: 'tools',     labelKey: 'tools',     descriptionKey: 'tools' },
  { id: 'router',    labelKey: 'router',    descriptionKey: 'router' },
  { id: 'gateway',   labelKey: 'gateway',   descriptionKey: 'gateway' },
  { id: 'customEnv', labelKey: 'customEnv', descriptionKey: 'customEnv' },
  { id: 'alwaysOn',  labelKey: 'alwaysOn',  descriptionKey: 'alwaysOn' },
  { id: 'advanced',  labelKey: 'runtime',   descriptionKey: 'runtime' },
];

// ── Reload-status presentation (kept identical to legacy raw view) ──────

type SubsystemKey = 'processEnv' | 'memory' | 'router' | 'gateway' | 'proxy';
const SUBSYSTEM_LABELS: Record<SubsystemKey, string> = {
  processEnv: 'Process Env',
  memory: 'Memory',
  router: 'PilotDeck Router',
  gateway: 'Gateway',
  proxy: 'Proxy',
};

type SubsystemResult = {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
};

function classifySubsystem(result: SubsystemResult | undefined): 'ok' | 'skipped' | 'error' | 'unknown' {
  if (!result) return 'unknown';
  if (result.error) return 'error';
  if (result.reloaded) return 'ok';
  if (result.skipped) return 'skipped';
  return 'unknown';
}

function subsystemBadgeClasses(state: 'ok' | 'skipped' | 'error' | 'unknown'): string {
  if (state === 'ok') return 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300';
  if (state === 'skipped') return 'border-border bg-muted text-muted-foreground';
  if (state === 'error') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function SubsystemIcon({ state }: { state: 'ok' | 'skipped' | 'error' | 'unknown' }) {
  if (state === 'ok') return <CheckCircle2 className="h-4 w-4" />;
  if (state === 'error') return <XCircle className="h-4 w-4" />;
  if (state === 'skipped') return <Info className="h-4 w-4" />;
  return <Info className="h-4 w-4 opacity-50" />;
}

function ReloadSummary({ reload }: { reload: ConfigReload | null }) {
  if (!reload) {
    return <div className="text-sm text-muted-foreground">No reload has run yet.</div>;
  }
  const keys: SubsystemKey[] = ['processEnv', 'memory', 'router', 'gateway', 'proxy'];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {keys.map((key) => {
        const result = reload[key] as SubsystemResult | undefined;
        const state = classifySubsystem(result);
        const detail = result?.error || result?.reason || result?.note || (state === 'ok' ? 'Reloaded' : state === 'unknown' ? 'No data' : '');
        return (
          <div key={key} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs ${subsystemBadgeClasses(state)}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <SubsystemIcon state={state} />
              <span>{SUBSYSTEM_LABELS[key]}</span>
            </div>
            {detail && <div className="text-[11px] opacity-80">{detail}</div>}
          </div>
        );
      })}
    </div>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'ui-save':   return 'UI save';
    case 'ui-reload': return 'UI reload';
    case 'watcher':   return 'External file edit';
    case 'refresh':   return 'Manual refresh';
    default:          return source;
  }
}

// ── Form-mode helpers ──────────────────────────────────────────────────

function safeParseYaml(text: string): PilotDeckConfig | null {
  try {
    const value = parseYaml(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as PilotDeckConfig;
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a new YAML string with the patched config — everything else (top-
 * level shape, formatting defaults) flows through `yaml`'s round-trip.
 *
 * Note: comments and key ordering are not preserved across this trip. Users
 * who care about hand-formatted YAML should use the Raw YAML tab — that mode
 * just edits the textarea and never reserializes.
 */
function configToYamlString(config: PilotDeckConfig): string {
  return stringifyYaml(config, { indent: 2, lineWidth: 0 });
}

type Path = readonly (string | number)[];

function patch<T extends PilotDeckConfig>(config: T, path: Path, value: unknown): T {
  // Immutable deep set. Each key cloned along the way so React picks up the
  // change. Numeric segments materialise arrays; everything else materialises
  // objects.
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === 'number';
  const current: any = config ?? (isArrayKey ? [] : {});
  const next: any = isArrayKey ? [...(current as unknown[])] : { ...(current as object) };
  next[head as string | number] = rest.length === 0 ? value : patch(current?.[head as string | number] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
  return next as T;
}

function replaceRouterModelRefs(config: PilotDeckConfig, oldRef: string, newRef: string): PilotDeckConfig {
  if (!oldRef || !newRef || oldRef === newRef || !config.router) return config;

  let next = config;
  const oldSlash = oldRef.indexOf('/');
  const newSlash = newRef.indexOf('/');
  const oldProviderId = oldSlash > 0 ? oldRef.slice(0, oldSlash) : '';
  const oldModelId = oldSlash > 0 ? oldRef.slice(oldSlash + 1) : '';
  const newModelId = newSlash > 0 ? newRef.slice(newSlash + 1) : '';
  const scenarios = config.router.scenarios;
  if (scenarios && Object.values(scenarios).some((ref) => ref === oldRef)) {
    next = patch(next, ['router', 'scenarios'], Object.fromEntries(
      Object.entries(scenarios).map(([key, ref]) => [key, ref === oldRef ? newRef : ref]),
    ));
  }

  const fallback = next.router?.fallback;
  if (fallback && Object.values(fallback).some((refs) => refs.some((ref) => ref === oldRef))) {
    next = patch(next, ['router', 'fallback'], Object.fromEntries(
      Object.entries(fallback).map(([key, refs]) => [key, refs.map((ref) => ref === oldRef ? newRef : ref)]),
    ));
  }

  if (next.router?.tokenSaver?.judge === oldRef) {
    next = patch(next, ['router', 'tokenSaver', 'judge'], newRef);
  }

  const tiers = next.router?.tokenSaver?.tiers;
  if (tiers && Object.values(tiers).some((tier) => tier.model === oldRef)) {
    next = patch(next, ['router', 'tokenSaver', 'tiers'], Object.fromEntries(
      Object.entries(tiers).map(([key, tier]) => [
        key,
        tier.model === oldRef ? { ...tier, model: newRef } : tier,
      ]),
    ));
  }

  const memoryLlm = (next.memory as Record<string, unknown> | undefined)?.llm;
  if (memoryLlm && typeof memoryLlm === 'object' && !Array.isArray(memoryLlm)) {
    const llm = memoryLlm as Record<string, unknown>;
    if (llm.provider === oldProviderId && llm.model === oldModelId) {
      next = patch(next, ['memory', 'llm', 'model'], newModelId);
    }
  }

  return next;
}

const MASK = '********';

// ── Reusable inputs ────────────────────────────────────────────────────

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
  monospace,
}: {
  value: string | number | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
  className?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type={type}
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={cn(
        'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none',
        'focus:ring-1 focus:ring-ring',
        monospace && 'font-mono text-xs',
        className,
      )}
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      type="number"
      value={value}
      placeholder={placeholder}
      onChange={(s) => {
        if (s === '') return onChange(undefined);
        const n = Number(s);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

let _datalistCounter = 0;

function ModelRefInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  const [id] = useState(() => `model-ref-dl-${++_datalistCounter}`);
  return (
    <>
      <input
        type="text"
        list={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'provider/model-name'}
        spellCheck={false}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
      />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </datalist>
    </>
  );
}

function FormRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-4 py-3 sm:grid-cols-[200px_1fr] sm:gap-4 sm:py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Section components ─────────────────────────────────────────────────

function AdvancedSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const r = config.webui?.runtime ?? {};
  const set = (key: string, value: unknown) =>
    onChange(patch(config, ['webui', 'runtime', key], value));
  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.runtime.title')}
      description={t('edgeClawConfig.panels.runtime.description')}
    >
      <SettingsCard divided>
        <FormRow label="Host" description="Bind interface for the HTTP/WebSocket server.">
          <TextInput value={r.host} placeholder="0.0.0.0" onChange={(v) => set('host', v)} />
        </FormRow>
        <FormRow label="Server port" description="Express + WebSocket port.">
          <NumberInput value={r.serverPort} placeholder="3001" onChange={(v) => set('serverPort', v)} />
        </FormRow>
        <FormRow label="Vite port" description="Frontend dev server (only used when running `npm run dev`).">
          <NumberInput value={r.vitePort} placeholder="5173" onChange={(v) => set('vitePort', v)} />
        </FormRow>
        <FormRow label="Proxy port" description="Local LLM proxy (PilotDeck agent target).">
          <NumberInput value={r.proxyPort} placeholder="18080" onChange={(v) => set('proxyPort', v)} />
        </FormRow>
        <FormRow label="Context window" description="Default token budget for new sessions.">
          <NumberInput value={r.contextWindow} placeholder="160000" onChange={(v) => set('contextWindow', v)} />
        </FormRow>
        <FormRow label="API timeout (ms)" description="Per-request upstream timeout.">
          <NumberInput value={r.apiTimeoutMs} placeholder="120000" onChange={(v) => set('apiTimeoutMs', v)} />
        </FormRow>
        <FormRow label="Database path" description="SQLite auth/projects database (~ expands to home).">
          <TextInput value={r.databasePath} placeholder="~/.pilotdeck/auth.db" monospace onChange={(v) => set('databasePath', v)} />
        </FormRow>
        <FormRow label="Workspaces root" description="Directory under which projects are scanned.">
          <TextInput value={r.workspacesRoot} placeholder="~" monospace onChange={(v) => set('workspacesRoot', v)} />
        </FormRow>
        <FormRow label="HTTPS proxy" description="Outbound HTTPS proxy URL (HTTPS_PROXY / https_proxy).">
          <TextInput value={r.httpsProxy} placeholder="http://127.0.0.1:7890" monospace onChange={(v) => set('httpsProxy', v)} />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function ProviderCard({
  providerId,
  provider,
  onChange,
  onRemove,
  onRename,
  catalogEntry,
  activeModelRef,
  onSetActive,
}: {
  providerId: string;
  provider: V2Provider;
  onChange: (next: V2Provider) => void;
  onRemove: () => void;
  onRename: (newId: string) => void;
  catalogEntry?: CatalogProvider;
  activeModelRef: string;
  onSetActive: (modelRef: string) => void;
}) {
  const isMaskedKey = provider.apiKey === MASK;
  const protocol = provider.protocol ?? catalogEntry?.protocol ?? 'openai';
  const effectiveUrl = provider.url || catalogEntry?.defaultUrl || '';
  const enabledModels = Object.keys(provider.models ?? {});
  const [newModelId, setNewModelId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (patch: Partial<V2Provider>) => onChange({ ...provider, ...patch });

  // Read `models.<modelId>.capabilities.maxOutputTokens` if set as a positive
  // number. Anything else (missing, null, non-numeric) reads as undefined so
  // the input shows blank and the model falls back to catalog/protocol default.
  const getModelMaxOutputTokens = (modelId: string): number | undefined => {
    const def = provider.models?.[modelId];
    if (!def || typeof def !== 'object') return undefined;
    const caps = (def as Record<string, unknown>).capabilities;
    if (!caps || typeof caps !== 'object') return undefined;
    const v = (caps as Record<string, unknown>).maxOutputTokens;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };

  // Patch `models.<modelId>.capabilities.maxOutputTokens` immutably. Passing
  // undefined removes the key (and removes the empty `capabilities` block) so
  // the YAML stays minimal — matches the round-trip behaviour the rest of
  // this form already uses.
  const setModelMaxOutputTokens = (modelId: string, value: number | undefined) => {
    const models = { ...(provider.models ?? {}) };
    const existing = models[modelId];
    const def: Record<string, unknown> = existing && typeof existing === 'object'
      ? { ...(existing as Record<string, unknown>) }
      : {};
    const capabilities: Record<string, unknown> = def.capabilities && typeof def.capabilities === 'object'
      ? { ...(def.capabilities as Record<string, unknown>) }
      : {};
    if (value === undefined) {
      delete capabilities.maxOutputTokens;
    } else {
      capabilities.maxOutputTokens = value;
    }
    if (Object.keys(capabilities).length > 0) {
      def.capabilities = capabilities;
    } else {
      delete def.capabilities;
    }
    models[modelId] = def as Record<string, unknown>;
    update({ models });
  };

  const addModel = (mid: string) => {
    const id = mid.trim();
    if (!id) return;
    if (provider.models && id in provider.models) return;
    update({ models: { ...(provider.models ?? {}), [id]: {} } });
    setNewModelId('');
  };
  const removeModel = (mid: string) => {
    const next = { ...(provider.models ?? {}) };
    delete next[mid];
    update({ models: next });
    // If the removed model was the main agent, clear agent.model so
    // validation flags it explicitly instead of silently breaking.
    if (`${providerId}/${mid}` === activeModelRef) onSetActive('');
  };
  const toggleCatalogModel = (mid: string) => {
    if (provider.models && mid in provider.models) {
      removeModel(mid);
    } else {
      addModel(mid);
    }
  };

  const containsActive = activeModelRef.startsWith(`${providerId}/`) &&
    enabledModels.includes(activeModelRef.slice(providerId.length + 1));

  return (
    <div className={cn(
      'space-y-3 rounded-lg border bg-background/50 p-4 transition-colors',
      containsActive ? 'border-foreground/40 ring-1 ring-foreground/10' : 'border-border',
    )}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {catalogEntry && (
              <div className="text-sm font-semibold text-foreground">{catalogEntry.displayName}</div>
            )}
            {containsActive && (
              <span className="inline-flex items-center gap-1 rounded-full border border-foreground/30 bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                <Star className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
                Main agent
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">id</span>
            <input
              value={providerId}
              onChange={(e) => onRename(e.target.value.trim())}
              className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* API key — the only required field */}
      <label className="block text-xs text-muted-foreground">
        <span className="mb-1 block">API key</span>
        <TextInput
          type="password"
          value={provider.apiKey}
          placeholder={isMaskedKey ? 'Existing key kept — type to replace' : 'sk-...'}
          onChange={(v) => update({ apiKey: v })}
        />
        {isMaskedKey && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" />
            Key hidden; leave as-is to keep, retype to replace.
          </span>
        )}
      </label>

      {/* Models — chip-style toggles for catalog models + a free-form input.
          Each enabled chip has a star icon: filled when this is the main
          agent model, outlined (hover-revealed) otherwise. Click the chip
          body to enable/disable; click the star to set as main. */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>Enabled models</span>
          <span className="text-[10px] text-muted-foreground/60">
            click <Star className="inline h-2.5 w-2.5" /> to set main agent
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            · <ImageIcon className="inline h-2.5 w-2.5" /> supports image input
          </span>
        </div>
        {catalogEntry && catalogEntry.models.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {catalogEntry.models.map((m) => {
              const on = provider.models && m.id in provider.models;
              const ref = `${providerId}/${m.id}`;
              const isActive = on && ref === activeModelRef;
              return (
                <div
                  key={m.id}
                  className={cn(
                    'group inline-flex items-center rounded-md border text-[11px] transition-colors',
                    on
                      ? isActive
                        ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/30'
                        : 'border-foreground/30 bg-muted/60 text-foreground'
                      : 'border-border bg-muted text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleCatalogModel(m.id)}
                    className="inline-flex items-center gap-1 px-2 py-1"
                    title={on ? 'Click to disable' : 'Click to enable'}
                  >
                    {isActive && <Check className="h-3 w-3 text-primary" strokeWidth={2.5} />}
                    {m.displayName}
                    {m.supportsImage && (
                      <ImageIcon
                        className="h-3 w-3 text-muted-foreground/70"
                        strokeWidth={2}
                      />
                    )}
                  </button>
                  {on && (
                    <button
                      type="button"
                      onClick={() => onSetActive(ref)}
                      title={isActive ? 'Currently the main agent model' : 'Set as main agent model'}
                      className={cn(
                        'border-l px-1.5 py-1 transition-opacity',
                        isActive ? 'border-primary/30 text-primary opacity-100' : 'border-current/20 opacity-30 hover:opacity-100',
                      )}
                    >
                      <Star className={cn('h-3 w-3', isActive && 'fill-current')} strokeWidth={isActive ? 0 : 2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Custom (off-catalog) models currently enabled */}
        {enabledModels.filter((mid) => !catalogEntry || !catalogEntry.models.some((m) => m.id === mid)).map((mid) => {
          const ref = `${providerId}/${mid}`;
          const isActive = ref === activeModelRef;
          return (
            <div key={mid} className={cn(
              'mb-1 flex items-center gap-2 rounded-md border px-2 py-1 text-[11px]',
              isActive ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/30' : 'border-border bg-muted/40',
            )}>
              <code className="flex-1 truncate font-mono">{mid}</code>
              <button
                type="button"
                onClick={() => onSetActive(ref)}
                title={isActive ? 'Currently the main agent model' : 'Set as main agent model'}
                className={cn(
                  'transition-opacity',
                  isActive ? 'text-primary opacity-100' : 'text-muted-foreground opacity-40 hover:opacity-100',
                )}
              >
                <Star className={cn('h-3 w-3', isActive && 'fill-current')} strokeWidth={isActive ? 0 : 2} />
              </button>
              <button
                type="button"
                onClick={() => removeModel(mid)}
                className="text-muted-foreground hover:text-destructive"
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {/* Add custom model */}
        <div className="flex items-center gap-2">
          <input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder="Custom model ID"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') addModel(newModelId); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => addModel(newModelId)} disabled={!newModelId.trim()}>
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
      </div>

      {/* Per-model overrides — currently just maxOutputTokens. Always shown
          so users discover that every enabled model has this knob, not just
          the ones that already happen to have an override on disk. Maps
          directly to `models.<modelId>.capabilities.maxOutputTokens` in the
          yaml. */}
      {enabledModels.length > 0 && (
        <div className="border-t border-border/60 pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Settings2 className="h-3 w-3" />
            Per-model max output tokens
          </div>
          <div className="space-y-1.5">
            {enabledModels.map((mid) => {
              const ref = `${providerId}/${mid}`;
              const isActive = ref === activeModelRef;
              const current = getModelMaxOutputTokens(mid);
              const catalogModel = catalogEntry?.models.find((m) => m.id === mid);
              const label = catalogModel?.displayName || mid;
              return (
                <div key={mid} className={cn(
                  'grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-md border px-2 py-1.5',
                  current !== undefined
                    ? 'border-foreground/30 bg-foreground/5'
                    : 'border-border bg-background/40',
                )}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-foreground">{label}</span>
                      {isActive && (
                        <Star className="h-2.5 w-2.5 fill-current text-foreground" strokeWidth={0} />
                      )}
                    </div>
                    {label !== mid && (
                      <code className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{mid}</code>
                    )}
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={current ?? ''}
                    placeholder="32768"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return setModelMaxOutputTokens(mid, undefined);
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) setModelMaxOutputTokens(mid, Math.floor(n));
                    }}
                    className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setModelMaxOutputTokens(mid, undefined)}
                    disabled={current === undefined}
                    className={cn(
                      'rounded p-1 text-muted-foreground transition-colors',
                      current === undefined
                        ? 'opacity-30'
                        : 'hover:bg-muted hover:text-foreground',
                    )}
                    title={current === undefined ? 'Already using default' : 'Reset to catalog/protocol default'}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Cap on tokens each model may generate per turn (sent as <code className="font-mono">max_tokens</code>). Leave blank to fall back to the protocol default (~8k for openai, ~4k for anthropic). 32k is a safe modern recommendation; raise it for long-form / thinking models — too small a value cuts the response off mid-stream.
          </p>
        </div>
      )}

      {/* Advanced — protocol + URL (filled from catalog by default) */}
      <div className="border-t border-border/60 pt-2">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced (protocol &amp; URL)
        </button>
        {showAdvanced && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr]">
            <label className="text-[11px] text-muted-foreground">
              <span className="mb-1 block">Protocol</span>
              <Select
                value={protocol}
                onChange={(v) => update({ protocol: v as 'openai' | 'anthropic' })}
                options={[
                  { value: 'openai',    label: 'openai (chat-completions)' },
                  { value: 'anthropic', label: 'anthropic (messages API)' },
                ]}
              />
            </label>
            <label className="text-[11px] text-muted-foreground">
              <span className="mb-1 block">Base URL</span>
              <TextInput
                value={provider.url}
                placeholder={catalogEntry?.defaultUrl || 'https://api.example.com/v1'}
                monospace
                onChange={(v) => update({ url: v })}
              />
              {!provider.url && catalogEntry && (
                <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                  Defaults to <code className="font-mono">{catalogEntry.defaultUrl}</code> from catalog.
                </span>
              )}
            </label>
            {effectiveUrl && (
              <div className="col-span-full text-[10px] text-muted-foreground">
                Effective: <code className="font-mono">{effectiveUrl}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogPicker({
  existingIds,
  onPick,
  onCustom,
}: {
  existingIds: Set<string>;
  onPick: (catalog: CatalogProvider) => void;
  onCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const available = CATALOG_PROVIDERS.filter((p) => !existingIds.has(p.id));
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add provider
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">Add a provider</div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {available.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { onPick(p); setOpen(false); }}
            className="rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
          >
            <div className="font-medium text-foreground">{p.displayName}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{p.models.length} models</div>
          </button>
        ))}
        <button
          type="button"
          onClick={() => { onCustom(); setOpen(false); }}
          className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
        >
          <div className="font-medium text-foreground">+ Custom</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">Manual setup</div>
        </button>
      </div>
    </div>
  );
}

function ModelsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const providers = config.model?.providers ?? {};
  const ids = Object.keys(providers);
  const activeModelRef = config.agent?.model ?? '';

  const setProvider = (id: string, prov: V2Provider) =>
    onChange(patch(config, ['model', 'providers', id], prov));
  const removeProvider = (id: string) => {
    const next = { ...providers };
    delete next[id];
    let nextConfig = patch(config, ['model', 'providers'], next);
    // Clear agent.model if its provider was just removed.
    if (activeModelRef.startsWith(`${id}/`)) {
      nextConfig = patch(nextConfig, ['agent', 'model'], '');
    }
    onChange(nextConfig);
  };
  const renameProvider = (oldId: string, newId: string) => {
    if (!newId || newId === oldId || providers[newId]) return;
    const next: Record<string, V2Provider> = {};
    for (const [k, v] of Object.entries(providers)) next[k === oldId ? newId : k] = v;
    let nextConfig = patch(config, ['model', 'providers'], next);
    // Update agent.model if it referenced the renamed provider.
    if (activeModelRef.startsWith(`${oldId}/`)) {
      const modelPart = activeModelRef.slice(oldId.length + 1);
      nextConfig = patch(nextConfig, ['agent', 'model'], `${newId}/${modelPart}`);
    }
    onChange(nextConfig);
  };
  const setActive = (ref: string) => {
    const previousRef = config.agent?.model ?? '';
    const nextConfig = patch(config, ['agent', 'model'], ref);
    onChange(replaceRouterModelRefs(nextConfig, previousRef, ref));
  };

  const handleCatalogPick = (cp: CatalogProvider) => {
    if (providers[cp.id]) return;
    setProvider(cp.id, {
      apiKey: '',
      // protocol and url are stored explicitly so the saved yaml carries
      // them — backend catalog auto-fill kicks in only when the disk
      // value is missing, which is what we want for user-edited configs.
      protocol: cp.protocol,
      url: cp.defaultUrl,
      models: {},
    });
  };

  const handleCustom = () => {
    let i = 1;
    while (providers[`provider${i}`]) i++;
    setProvider(`provider${i}`, {
      protocol: 'openai',
      url: '',
      apiKey: '',
      models: {},
    });
  };

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.models.title')}
      description={t('edgeClawConfig.panels.models.description')}
    >
      <div className="space-y-3">
        {ids.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No providers configured yet. Click "Add provider" to get started.
          </div>
        )}
        {ids.map((id) => (
          <ProviderCard
            key={id}
            providerId={id}
            provider={providers[id] ?? {}}
            catalogEntry={findCatalogProviderById(id)}
            activeModelRef={activeModelRef}
            onSetActive={setActive}
            onChange={(next) => setProvider(id, next)}
            onRemove={() => removeProvider(id)}
            onRename={(newId) => renameProvider(id, newId)}
          />
        ))}
        <CatalogPicker
          existingIds={new Set(ids)}
          onPick={handleCatalogPick}
          onCustom={handleCustom}
        />
      </div>
    </SettingsSection>
  );
}

// Build the "provider/model" options for agent / memory model dropdowns
// from the currently-enabled providers and their enabled model ids.
function buildModelRefOptions(config: PilotDeckConfig): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const providers = config.model?.providers ?? {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (!prov?.models) continue;
    const catalog = findCatalogProviderById(pid);
    for (const mid of Object.keys(prov.models)) {
      const catalogModel = catalog?.models.find((m) => m.id === mid);
      out.push({
        value: `${pid}/${mid}`,
        label: catalog && catalogModel
          ? `${catalog.displayName}: ${catalogModel.displayName}`
          : `${pid}/${mid}`,
      });
    }
  }
  return out;
}

function activeModelCapabilities(config: PilotDeckConfig): {
  ref: string;
  providerId: string;
  modelId: string;
  catalogModel?: CatalogModel;
  catalogProvider?: CatalogProvider;
  multimodalInput: string[] | null;
  maxOutputTokensOverride: number | undefined;
} | null {
  const ref = config.agent?.model ?? '';
  if (!ref) return null;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = config.model?.providers?.[providerId];
  if (!provider) return null;
  const userDef = provider.models?.[modelId];
  const userMultimodal = userDef && typeof userDef === 'object'
    ? (userDef as Record<string, unknown>).multimodal
    : null;
  let multimodalInput: string[] | null = null;
  if (userMultimodal && typeof userMultimodal === 'object') {
    const input = (userMultimodal as Record<string, unknown>).input;
    if (Array.isArray(input)) multimodalInput = input.filter((s): s is string => typeof s === 'string');
  }
  const userCapabilities = userDef && typeof userDef === 'object'
    ? (userDef as Record<string, unknown>).capabilities
    : null;
  let maxOutputTokensOverride: number | undefined;
  if (userCapabilities && typeof userCapabilities === 'object') {
    const v = (userCapabilities as Record<string, unknown>).maxOutputTokens;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) maxOutputTokensOverride = v;
  }
  const catalogProvider = findCatalogProviderById(providerId);
  const catalogModel = catalogProvider?.models.find((m) => m.id === modelId);
  return { ref, providerId, modelId, catalogModel, catalogProvider, multimodalInput, maxOutputTokensOverride };
}

function AgentsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const refOptions = buildModelRefOptions(config);
  const mainRef = config.agent?.model ?? '';
  const subDefault = config.agent?.subagents?.default ?? 'inherit';
  const [showSubagents, setShowSubagents] = useState(subDefault !== 'inherit');

  const mainOptions = [
    { value: '', label: '— pick a model —' },
    ...refOptions,
  ];
  const subOptions = [
    { value: 'inherit', label: 'inherit (use main agent\'s model)' },
    ...refOptions,
  ];

  const caps = activeModelCapabilities(config);
  // True when the *effective* config (catalog ∪ user override) supports image.
  const supportsImageEffective = caps
    ? caps.multimodalInput
      ? caps.multimodalInput.includes('image')
      : Boolean(caps.catalogModel?.supportsImage)
    : false;
  // True only when the user explicitly wrote a multimodal.input override.
  const userOverrideActive = caps?.multimodalInput != null;

  const setImageOverride = (enable: boolean) => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    const def: Record<string, unknown> = existingDef && typeof existingDef === 'object'
      ? { ...(existingDef as Record<string, unknown>) }
      : {};

    if (enable === Boolean(caps.catalogModel?.supportsImage) && !userOverrideActive) {
      // Already matches catalog default — no override needed.
      return;
    }

    if (enable) {
      def.multimodal = { input: ['text', 'image'] };
    } else {
      def.multimodal = { input: ['text'] };
    }
    models[modelId] = def as Record<string, unknown>;
    onChange(patch(config, ['model', 'providers', providerId, 'models'], models));
  };

  const clearOverride = () => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    if (existingDef && typeof existingDef === 'object') {
      const next = { ...(existingDef as Record<string, unknown>) };
      delete next.multimodal;
      models[modelId] = next as Record<string, unknown>;
    }
    onChange(patch(config, ['model', 'providers', providerId, 'models'], models));
  };

  const setMaxOutputTokens = (value: number | undefined) => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    const def: Record<string, unknown> = existingDef && typeof existingDef === 'object'
      ? { ...(existingDef as Record<string, unknown>) }
      : {};
    const capabilities: Record<string, unknown> = def.capabilities && typeof def.capabilities === 'object'
      ? { ...(def.capabilities as Record<string, unknown>) }
      : {};
    if (value === undefined) {
      delete capabilities.maxOutputTokens;
    } else {
      capabilities.maxOutputTokens = value;
    }
    if (Object.keys(capabilities).length > 0) {
      def.capabilities = capabilities;
    } else {
      delete def.capabilities;
    }
    models[modelId] = def as Record<string, unknown>;
    onChange(patch(config, ['model', 'providers', providerId, 'models'], models));
  };

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.agents.title')}
      description={t('edgeClawConfig.panels.agents.description')}
    >
      <SettingsCard divided>
        <FormRow label="Main agent model" description="Used by the primary chat agent. Reference an enabled provider/model from the Models section.">
          <Select
            value={mainRef}
            options={mainOptions}
            onChange={(v) => onChange(patch(config, ['agent', 'model'], v))}
          />
        </FormRow>

        {caps && (
          <div className="px-4 py-3">
            <div className="rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-foreground">
                Active model capabilities
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5" />
                  Image input
                </span>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={supportsImageEffective}
                    onChange={(e) => setImageOverride(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border"
                  />
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    supportsImageEffective
                      ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : 'border border-border bg-muted text-muted-foreground',
                  )}>
                    {supportsImageEffective ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
                {userOverrideActive && (
                  <button
                    type="button"
                    onClick={clearOverride}
                    className="text-[10px] text-muted-foreground underline hover:text-foreground"
                  >
                    reset to catalog default
                  </button>
                )}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {userOverrideActive
                  ? 'Override active — your yaml explicitly defines this model\'s multimodal.input.'
                  : caps.catalogModel
                    ? `Default from catalog: ${caps.catalogModel.supportsImage ? 'supports image input.' : 'text only.'}`
                    : 'No catalog entry — defaulting to text only. Toggle to override.'}
                {' '}If the upstream model server doesn\'t actually accept images, enabling this will produce upstream errors at request time.
              </p>

              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" />
                    Max output tokens
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={caps.maxOutputTokensOverride ?? ''}
                    placeholder="8192"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return setMaxOutputTokens(undefined);
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) setMaxOutputTokens(Math.floor(n));
                    }}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    caps.maxOutputTokensOverride !== undefined
                      ? 'border border-foreground/30 bg-foreground/10 text-foreground'
                      : 'border border-border bg-muted text-muted-foreground',
                  )}>
                    {caps.maxOutputTokensOverride !== undefined ? 'Override' : 'Default'}
                  </span>
                  {caps.maxOutputTokensOverride !== undefined && (
                    <button
                      type="button"
                      onClick={() => setMaxOutputTokens(undefined)}
                      className="text-[10px] text-muted-foreground underline hover:text-foreground"
                    >
                      reset to default
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  Cap on tokens the model may generate per turn (sent as <code className="font-mono">max_tokens</code> to upstream). Leave empty to fall back to the catalog or protocol default (typically 8192 for openai). Increase this for long-form creative tasks or thinking models that burn output budget while reasoning — too small a value cuts the response off mid-stream and the UI then appears stuck.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="px-4 py-2">
          <button
            type="button"
            onClick={() => setShowSubagents(!showSubagents)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showSubagents ? 'Hide' : 'Show'} subagent settings
          </button>
        </div>
        {showSubagents && (
          <FormRow label="Subagents default" description="Used by tool-spawned subagents (e.g. tasks).">
            <Select
              value={subDefault}
              options={subOptions}
              onChange={(v) => onChange(patch(config, ['agent', 'subagents', 'default'], v))}
            />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

const WELL_KNOWN_ENV_KEYS = [
  { key: 'TAVILY_API_KEY', hint: 'Tavily web search API key' },
  { key: 'FIRECRAWL_API_KEY', hint: 'Firecrawl web scraping API key' },
  { key: 'SERPER_API_KEY', hint: 'Serper search API key' },
  { key: 'BROWSERBASE_API_KEY', hint: 'Browserbase API key' },
];

function CustomEnvSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const envMap = config.customEnv ?? {};
  const entries = Object.entries(envMap);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const setEnv = (key: string, value: string) => {
    onChange(patch(config, ['customEnv', key], value));
  };
  const removeEnv = (key: string) => {
    const next = { ...envMap };
    delete next[key];
    onChange(patch(config, ['customEnv'], next));
  };
  const addEntry = () => {
    const key = newKey.trim();
    if (!key) return;
    onChange(patch(config, ['customEnv', key], newValue));
    setNewKey('');
    setNewValue('');
  };
  const addWellKnown = (key: string) => {
    if (envMap[key] !== undefined) return;
    onChange(patch(config, ['customEnv', key], ''));
  };

  const unusedWellKnown = WELL_KNOWN_ENV_KEYS.filter((wk) => envMap[wk.key] === undefined);

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.customEnv.title')}
      description={t('edgeClawConfig.panels.customEnv.description')}
    >
      <SettingsCard className="space-y-3 p-4">
        {entries.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No custom environment variables configured.
          </div>
        )}
        {entries.map(([key, value]) => {
          const isMasked = value === MASK;
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  value={key}
                  readOnly
                  className="w-[200px] shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none"
                />
                <span className="text-muted-foreground">=</span>
                <TextInput
                  type="password"
                  value={value}
                  placeholder={isMasked ? 'Existing value kept — type to replace' : 'value'}
                  monospace
                  className="min-w-0 flex-1"
                  onChange={(v) => setEnv(key, v)}
                />
                <button
                  type="button"
                  onClick={() => removeEnv(key)}
                  className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {isMasked && (
                <div className="ml-[216px] flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  Value hidden; leave as-is to keep, retype to replace.
                </div>
              )}
            </div>
          );
        })}

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-xs font-medium text-foreground">Add variable</div>
          <div className="flex items-center gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="KEY_NAME"
              className="w-[200px] shrink-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-muted-foreground">=</span>
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              type="password"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === 'Enter') addEntry(); }}
            />
            <Button variant="outline" size="sm" className="shrink-0" onClick={addEntry} disabled={!newKey.trim()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        </div>

        {unusedWellKnown.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-xs text-muted-foreground">Quick add common keys:</div>
            <div className="flex flex-wrap gap-1.5">
              {unusedWellKnown.map((wk) => (
                <button
                  key={wk.key}
                  type="button"
                  onClick={() => addWellKnown(wk.key)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
                  title={wk.hint}
                >
                  <Plus className="h-3 w-3" />
                  {wk.key}
                </button>
              ))}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function AlwaysOnSection({
  config,
  projects,
  onChange,
}: {
  config: PilotDeckConfig;
  projects: SettingsProject[];
  onChange: (next: PilotDeckConfig) => void;
}) {
  const { t } = useTranslation('settings');
  const ao = config.alwaysOn ?? {};
  const trigger = ao.trigger ?? {};
  const dormancy = ao.dormancy ?? {};
  const workspace = ao.workspace ?? {};
  const execution = ao.execution ?? {};
  const enabled = ao.enabled === true;

  const projectRows = projects
    .map(project => ({ project, root: getAlwaysOnProjectRoot(project) }))
    .filter(item => item.root.length > 0);

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.alwaysOn.title')}
      description={t('edgeClawConfig.panels.alwaysOn.description')}
    >
      <div className="space-y-4">
        {/* General */}
        <SettingsCard>
          <SettingsRow
            label="Enabled"
            description="Master switch for Always-On background agent."
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel="Toggle Always-On"
              onChange={(value) => onChange(patch(config, ['alwaysOn', 'enabled'], value))}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            {/* Trigger */}
            <SettingsSection
              title={t('edgeClawConfig.panels.alwaysOn.trigger.title')}
              description={t('edgeClawConfig.panels.alwaysOn.trigger.description')}
            >
              <SettingsCard divided>
                <SettingsRow
                  label="Auto discovery"
                  description="When enabled, Always-On periodically inspects opted-in workspaces and proposes follow-up plans."
                >
                  <SettingsToggle
                    checked={trigger.enabled === true}
                    ariaLabel="Toggle automatic discovery"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label="Tick interval (minutes)" description="How often the daemon checks opted-in workspaces.">
                  <NumberInput
                    value={trigger.tickIntervalMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'tickIntervalMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Cooldown (minutes)" description="Minimum time between discovery runs per workspace.">
                  <NumberInput
                    value={trigger.cooldownMinutes}
                    placeholder="60"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'cooldownMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Daily budget" description="Maximum automatic discovery runs per workspace per day.">
                  <NumberInput
                    value={trigger.dailyBudget}
                    placeholder="4"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'dailyBudget'], value))}
                  />
                </FormRow>
                <FormRow label="Heartbeat stale (seconds)" description="Heartbeats older than this are considered stale.">
                  <NumberInput
                    value={trigger.heartbeatStaleSeconds}
                    placeholder="90"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'heartbeatStaleSeconds'], value))}
                  />
                </FormRow>
                <FormRow label="Recent user msg (minutes)" description="Only fire if the user sent a message within this window.">
                  <NumberInput
                    value={trigger.recentUserMsgMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'recentUserMsgMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Preferred channel" description="Channel the discovery agent prefers to interact through.">
                  <Select
                    value={trigger.preferChannel}
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'preferChannel'], value))}
                    options={[
                      { value: 'web', label: 'Web UI' },
                      { value: 'tui', label: 'TUI' },
                    ]}
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Dormancy */}
            <SettingsSection
              title={t('edgeClawConfig.panels.alwaysOn.dormancy.title')}
              description={t('edgeClawConfig.panels.alwaysOn.dormancy.description')}
            >
              <SettingsCard divided>
                <SettingsRow
                  label="Enabled"
                  description="Suppress discovery fires while the workspace has recent file changes."
                >
                  <SettingsToggle
                    checked={dormancy.enabled !== false}
                    ariaLabel="Toggle dormancy"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label="Debounce (ms)" description="Wait this long after the last file change before resuming.">
                  <NumberInput
                    value={dormancy.debounceMs}
                    placeholder="2000"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'debounceMs'], value))}
                  />
                </FormRow>
                <FormRow label="Ignore globs" description="File patterns excluded from dormancy detection, one per line.">
                  <textarea
                    value={(dormancy.ignoreGlobs ?? []).join('\n')}
                    placeholder={"**/.git/**\n**/node_modules/**\n**/.pilotdeck/**\n**/dist/**\n**/.DS_Store"}
                    onChange={(e) => {
                      const globs = e.target.value.split('\n').filter((s) => s.trim().length > 0);
                      onChange(patch(config, ['alwaysOn', 'dormancy', 'ignoreGlobs'], globs));
                    }}
                    spellCheck={false}
                    className="min-h-[100px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Workspace */}
            <SettingsSection
              title={t('edgeClawConfig.panels.alwaysOn.workspace.title')}
              description={t('edgeClawConfig.panels.alwaysOn.workspace.description')}
            >
              <SettingsCard divided>
                <FormRow label="Git worktree base dir" description="Root directory for git worktree-based isolation.">
                  <TextInput
                    value={workspace.gitWorktreeBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitWorktreeBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label="Snapshot base dir" description="Root directory for snapshot-based isolation.">
                  <TextInput
                    value={workspace.snapshotBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label="Snapshot max bytes" description="Maximum size of a workspace snapshot.">
                  <NumberInput
                    value={workspace.snapshotMaxBytes}
                    placeholder="1073741824"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotMaxBytes'], value))}
                  />
                </FormRow>
                <SettingsRow
                  label="Git LFS"
                  description="Include Git LFS objects in workspace snapshots."
                >
                  <SettingsToggle
                    checked={workspace.gitLfs === true}
                    ariaLabel="Toggle Git LFS"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitLfs'], value))}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            {/* Execution */}
            <SettingsSection
              title={t('edgeClawConfig.panels.alwaysOn.execution.title')}
              description={t('edgeClawConfig.panels.alwaysOn.execution.description')}
            >
              <SettingsCard divided>
                <FormRow label="Max turns" description="Maximum number of agent turns per run.">
                  <NumberInput
                    value={execution.maxTurns}
                    placeholder="30"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxTurns'], value))}
                  />
                </FormRow>
                <FormRow label="Max tool calls" description="Maximum total tool calls per run.">
                  <NumberInput
                    value={execution.maxToolCalls}
                    placeholder="200"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxToolCalls'], value))}
                  />
                </FormRow>
                <FormRow label="Timeout (minutes)" description="Hard timeout for each run.">
                  <NumberInput
                    value={execution.timeoutMinutes}
                    placeholder="20"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'timeoutMinutes'], value))}
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Workspace opt-in */}
            <SettingsSection
              title={t('edgeClawConfig.panels.alwaysOn.workspaceOptIn.title')}
              description={t('edgeClawConfig.panels.alwaysOn.workspaceOptIn.description')}
            >
              <SettingsCard divided>
                {projectRows.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    No recognized projects yet. Add or open a workspace first.
                  </div>
                ) : (
                  projectRows.map(({ project, root }) => (
                    <SettingsRow
                      key={root}
                      label={project.displayName || project.name}
                      description={root}
                    >
                      <SettingsToggle
                        checked={isAlwaysOnProjectEnabled(config, project)}
                        ariaLabel={`Toggle Always-On for ${project.displayName || project.name}`}
                        onChange={(en) => onChange(setAlwaysOnProjectEnabled(config, project, en))}
                      />
                    </SettingsRow>
                  ))
                )}
              </SettingsCard>
            </SettingsSection>
          </>
        )}
      </div>
    </SettingsSection>
  );
}

function MemorySection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const m = config.memory ?? {};
  // Memory uses a "provider/model" reference, or "inherit" to fall back
  // to agent.model. The backend treats `undefined` and `"inherit"` the
  // same way, so we map both to the inherit option in the UI.
  const refOptions = buildModelRefOptions(config);
  const options = [
    { value: 'inherit', label: t('edgeClawConfig.panels.memory.model.inherit') },
    ...refOptions,
  ];
  const selected = m.model && m.model.trim() ? m.model : 'inherit';
  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.memory.title')}
      description={t('edgeClawConfig.panels.memory.description')}
    >
      <SettingsCard>
        <SettingsRow
          label={t('edgeClawConfig.panels.memory.enabled.label')}
          description={t('edgeClawConfig.panels.memory.enabled.description')}
        >
          <SettingsToggle
            checked={Boolean(m.enabled)}
            ariaLabel={t('edgeClawConfig.panels.memory.enabled.label')}
            onChange={(v) => onChange(patch(config, ['memory', 'enabled'], v))}
          />
        </SettingsRow>
        {m.enabled && (
          <FormRow
            label={t('edgeClawConfig.panels.memory.model.label')}
            description={t('edgeClawConfig.panels.memory.model.description')}
          >
            <Select
              value={selected}
              options={options}
              onChange={(v) => onChange(patch(config, ['memory', 'model'], v === 'inherit' ? '' : v))}
            />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function ToolsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const ws = config.tools?.webSearch ?? {};
  const apiKey = typeof ws.apiKey === 'string' ? ws.apiKey : '';
  const endpoint = typeof ws.endpoint === 'string' ? ws.endpoint : '';

  // Test-connection state — modeled after onboarding's LlmConfigurationStep
  // so behaviour and accessibility match across the app. Reset whenever the
  // user edits the key or endpoint so a stale ✓ never lies about new input.
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const setField = (field: 'apiKey' | 'endpoint', value: string) => {
    const trimmed = value;
    const nextWs: NonNullable<PilotDeckConfig['tools']>['webSearch'] = { ...ws };
    if (trimmed === '') {
      delete nextWs[field];
    } else {
      nextWs[field] = trimmed;
    }
    const nextTools = Object.keys(nextWs).length > 0 ? { webSearch: nextWs } : undefined;
    onChange(patch(config, ['tools'], nextTools));
    setTestStatus('idle');
    setTestMessage('');
  };

  const handleTest = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setTestStatus('error');
      setTestMessage(t('edgeClawConfig.panels.tools.test.needsKey'));
      return;
    }
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-web-search', {
        method: 'POST',
        body: JSON.stringify({ apiKey: trimmedKey, endpoint: endpoint.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage(
          t('edgeClawConfig.panels.tools.test.success', {
            count: data.organicCount ?? 0,
            latency: data.latencyMs ?? 0,
          }),
        );
      } else {
        setTestStatus('error');
        setTestMessage(
          t('edgeClawConfig.panels.tools.test.failedPrefix', { error: data.error || 'unknown' }),
        );
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(
        t('edgeClawConfig.panels.tools.test.failedPrefix', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.tools.title')}
      description={t('edgeClawConfig.panels.tools.description')}
    >
      <SettingsCard divided>
        <FormRow
          label={t('edgeClawConfig.panels.tools.apiKey.label')}
          description={t('edgeClawConfig.panels.tools.apiKey.description')}
        >
          <TextInput
            type="password"
            value={apiKey}
            placeholder={t('edgeClawConfig.panels.tools.apiKey.placeholder')}
            monospace
            onChange={(v) => setField('apiKey', v)}
          />
        </FormRow>
        <FormRow
          label={t('edgeClawConfig.panels.tools.endpoint.label')}
          description={t('edgeClawConfig.panels.tools.endpoint.description')}
        >
          <TextInput
            value={endpoint}
            placeholder={t('edgeClawConfig.panels.tools.endpoint.placeholder')}
            monospace
            onChange={(v) => setField('endpoint', v)}
          />
        </FormRow>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testStatus === 'testing' || !apiKey.trim()}
            >
              {testStatus === 'testing' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {testStatus === 'testing'
                ? t('edgeClawConfig.panels.tools.test.testing')
                : t('edgeClawConfig.panels.tools.test.button')}
            </Button>
            {testStatus === 'success' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function ModelPricingEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const pricing = config.router?.stats?.modelPricing ?? {};
  const keys = Object.keys(pricing);
  const [newKey, setNewKey] = useState('');

  const setPricing = (key: string, field: 'input' | 'output' | 'cacheRead', value: number | undefined) => {
    const entry = pricing[key] ?? {};
    onChange(patch(config, ['router', 'stats', 'modelPricing', key], { ...entry, [field]: value }));
  };
  const removePricing = (key: string) => {
    const next = { ...pricing };
    delete next[key];
    onChange(patch(config, ['router', 'stats', 'modelPricing'], next));
  };
  const addPricing = () => {
    const key = newKey.trim();
    if (!key || pricing[key]) return;
    onChange(patch(config, ['router', 'stats', 'modelPricing', key], { input: 0, output: 0 }));
    setNewKey('');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">Model Pricing</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Custom pricing per model ($/million tokens). Used when the API doesn't report cost.
          Key format: <code className="rounded bg-muted px-1 text-[11px]">provider/model</code> or partial model name.
        </div>
      </div>

      {keys.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No custom pricing configured. Built-in defaults cover common models (DeepSeek, Claude, GPT, Gemini, GLM, Qwen, Llama, etc).
        </div>
      )}

      {keys.map((key) => {
        const entry = pricing[key] ?? {};
        return (
          <div key={key} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">{key}</code>
              <button
                type="button"
                onClick={() => removePricing(key)}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Input $/M</span>
                <NumberInput value={entry.input} placeholder="0.50" onChange={(v) => setPricing(key, 'input', v)} />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Output $/M</span>
                <NumberInput value={entry.output} placeholder="1.50" onChange={(v) => setPricing(key, 'output', v)} />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Cache $/M</span>
                <NumberInput value={entry.cacheRead} placeholder="0" onChange={(v) => setPricing(key, 'cacheRead', v)} />
              </label>
            </div>
          </div>
        );
      })}

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-foreground">Add model pricing</div>
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="provider/model-name"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') addPricing(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addPricing} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function RouterScenarioEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const scenarios = config.router?.scenarios ?? {};
  const entries = Object.entries(scenarios);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState('');

  const setScenario = (key: string, value: string) =>
    onChange(patch(config, ['router', 'scenarios', key], value));
  const removeScenario = (key: string) => {
    const next = { ...scenarios };
    delete next[key];
    onChange(patch(config, ['router', 'scenarios'], next));
  };
  const addScenario = () => {
    const key = newKey.trim();
    if (!key || scenarios[key]) return;
    onChange(patch(config, ['router', 'scenarios', key], modelOpts[0]?.value ?? ''));
    setNewKey('');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">Scenarios</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Map scenario names to models. <code className="rounded bg-muted px-1 text-[11px]">default</code> is the primary route.
        </div>
      </div>
      {entries.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No scenarios configured.
        </div>
      )}
      {entries.map(([key, model]) => (
        <div key={key} className="flex items-center gap-2">
          <code className="w-28 shrink-0 truncate rounded bg-muted px-2 py-1.5 text-xs text-foreground">{key}</code>
          <div className="min-w-0 flex-1">
            <ModelRefInput value={model} options={modelOpts} onChange={(v) => setScenario(key, v)} />
          </div>
          <button
            type="button"
            onClick={() => removeScenario(key)}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="scenario name"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') addScenario(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addScenario} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function RouterFallbackEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const fallback = config.router?.fallback ?? {};
  const entries = Object.entries(fallback);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState('');

  const setChain = (scenario: string, chain: string[]) =>
    onChange(patch(config, ['router', 'fallback', scenario], chain));
  const removeChain = (scenario: string) => {
    const next = { ...fallback };
    delete next[scenario];
    onChange(patch(config, ['router', 'fallback'], next));
  };
  const addChain = () => {
    const key = newKey.trim();
    if (!key || fallback[key]) return;
    onChange(patch(config, ['router', 'fallback', key], [modelOpts[0]?.value ?? '']));
    setNewKey('');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">Fallback Chains</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Ordered fallback models per scenario. If the primary fails, the router tries the next.
        </div>
      </div>
      {entries.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No fallback chains configured.
        </div>
      )}
      {entries.map(([scenario, chain]) => (
        <div key={scenario} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">{scenario}</code>
            <button
              type="button"
              onClick={() => removeChain(scenario)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {(chain ?? []).map((model, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-[10px] font-semibold text-muted-foreground">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <ModelRefInput
                    value={model}
                    options={modelOpts}
                    onChange={(v) => {
                      const next = [...chain];
                      next[idx] = v;
                      setChain(scenario, next);
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setChain(scenario, chain.filter((_, i) => i !== idx))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Remove model"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setChain(scenario, [...(chain ?? []), modelOpts[0]?.value ?? ''])}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Add fallback model
            </button>
          </div>
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="scenario name (e.g. default)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') addChain(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addChain} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

const DEFAULT_TIERS: Record<string, { description: string }> = {
  simple: { description: 'Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules' },
  medium: { description: 'Single tool call, short text generation, 1-2 file read/write, code generation' },
  complex: { description: 'Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents' },
  reasoning: { description: 'Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources' },
};

const DEFAULT_RULES: string[] = [
  'complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work',
  'Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning',
  'Simple file creation (1-2 files) or single code generation is medium',
  'Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple',
];

function TokenSaverTierEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const tiers = config.router?.tokenSaver?.tiers ?? {};
  const entries = Object.entries(tiers);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState('');

  const setTier = (key: string, field: 'model' | 'description', value: string) =>
    onChange(patch(config, ['router', 'tokenSaver', 'tiers', key, field], value));
  const removeTier = (key: string) => {
    const next = { ...tiers };
    delete next[key];
    onChange(patch(config, ['router', 'tokenSaver', 'tiers'], next));
  };
  const addTier = () => {
    const key = newKey.trim();
    if (!key || tiers[key]) return;
    const preset = DEFAULT_TIERS[key];
    onChange(patch(config, ['router', 'tokenSaver', 'tiers', key], {
      model: modelOpts[0]?.value ?? '',
      description: preset?.description ?? '',
    }));
    setNewKey('');
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold text-foreground">Tiers</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Complexity tiers the judge can route to. Pick a model for each — descriptions are pre-filled.
        </div>
      </div>
      {entries.map(([key, tier]) => (
        <div key={key} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-2 py-1 text-xs font-semibold text-foreground">{key}</code>
            <div className="min-w-0 flex-1">
              <ModelRefInput value={tier.model ?? ''} options={modelOpts} onChange={(v) => setTier(key, 'model', v)} />
            </div>
            <button
              type="button"
              onClick={() => removeTier(key)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <textarea
            value={tier.description ?? ''}
            onChange={(e) => setTier(key, 'description', e.target.value)}
            placeholder="Describe when the judge should pick this tier…"
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="tier name (e.g. simple, medium, complex)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') addTier(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addTier} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function TokenSaverRulesEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const rules = config.router?.tokenSaver?.rules ?? [];
  const [newRule, setNewRule] = useState('');

  const setRule = (idx: number, value: string) => {
    const next = [...rules];
    next[idx] = value;
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], next));
  };
  const removeRule = (idx: number) =>
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], rules.filter((_, i) => i !== idx)));
  const addRule = () => {
    const r = newRule.trim();
    if (!r) return;
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], [...rules, r]));
    setNewRule('');
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-foreground">Judge Rules</div>
      {rules.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No custom rules. The judge uses tier descriptions only.
        </div>
      )}
      {rules.map((rule, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <textarea
            value={rule}
            onChange={(e) => setRule(idx, e.target.value)}
            rows={2}
            className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => removeRule(idx)}
            className="mt-1 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          placeholder="Add a rule for the judge…"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
        />
        <Button variant="outline" size="sm" className="shrink-0" onClick={addRule} disabled={!newRule.trim()}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

function RouterSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const r = config.router ?? {};
  const enabled = Boolean(r.enabled);
  const statsEnabled = r.stats?.enabled !== false;
  const modelOpts = buildModelRefOptions(config);

  const ts = r.tokenSaver ?? {};
  const ao = r.autoOrchestrate ?? {};
  const zr = r.zeroUsageRetry ?? {};

  const TIER_PRESETS = ['simple', 'medium', 'complex', 'reasoning'] as const;
  const availableTierNames = Object.keys(ts.tiers ?? {});

  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.router.title')}
      description={t('edgeClawConfig.panels.router.description')}
    >
      <div className="space-y-4">
        {/* ── Master toggle ─────────────────────────────────────────── */}
        <SettingsCard divided>
          <SettingsRow
            label="Enabled"
            description="When on, agents use the router instead of the configured provider directly."
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel="Toggle router"
              onChange={(v) => {
                let next = patch(config, ['router', 'enabled'], v);
                // Seed `scenarios.default` on enable if missing so the
                // gateway-side parser never sees a `router: { enabled: true }`
                // without a default routing target. Mirrors the same
                // auto-seed we already do for `tokenSaver.tiers` below.
                if (v && !next.router?.scenarios?.default) {
                  const defaultRef =
                    typeof next.agent?.model === 'string' && next.agent.model.trim()
                      ? next.agent.model.trim()
                      : modelOpts[0]?.value ?? '';
                  if (defaultRef) {
                    next = patch(next, ['router', 'scenarios', 'default'], defaultRef);
                  }
                }
                onChange(next);
              }}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            {/* ── Scenarios ──────────────────────────────────────────── */}
            <RouterScenarioEditor config={config} onChange={onChange} />

            {/* ── Fallback chains ────────────────────────────────────── */}
            <RouterFallbackEditor config={config} onChange={onChange} />

            {/* ── Zero-usage retry ───────────────────────────────────── */}
            <SettingsCard divided>
              <SettingsRow
                label="Zero-usage retry"
                description="Automatically retry when the upstream returns a response with zero tokens used."
              >
                <SettingsToggle
                  checked={Boolean(zr.enabled)}
                  ariaLabel="Toggle zero-usage retry"
                  onChange={(v) => onChange(patch(config, ['router', 'zeroUsageRetry', 'enabled'], v))}
                />
              </SettingsRow>
              {zr.enabled && (
                <FormRow label="Max attempts" description="Maximum retry attempts before giving up.">
                  <NumberInput
                    value={zr.maxAttempts}
                    placeholder="5"
                    onChange={(v) => onChange(patch(config, ['router', 'zeroUsageRetry', 'maxAttempts'], v))}
                  />
                </FormRow>
              )}
            </SettingsCard>

            {/* ── TokenSaver ─────────────────────────────────────────── */}
            <SettingsCard className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Token Saver</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    A lightweight judge classifies each turn into a tier and routes it to a cost-appropriate model.
                  </div>
                </div>
                <SettingsToggle
                  checked={Boolean(ts.enabled)}
                  ariaLabel="Toggle token saver"
                  onChange={(v) => {
                    let next = patch(config, ['router', 'tokenSaver', 'enabled'], v);
                    if (v && Object.keys(next.router?.tokenSaver?.tiers ?? {}).length === 0) {
                      const defaultModel = modelOpts[0]?.value ?? '';
                      const seeded: Record<string, { model: string; description: string }> = {};
                      for (const [k, def] of Object.entries(DEFAULT_TIERS)) {
                        seeded[k] = { model: defaultModel, description: def.description };
                      }
                      next = patch(next, ['router', 'tokenSaver', 'tiers'], seeded);
                      if ((next.router?.tokenSaver?.rules ?? []).length === 0) {
                        next = patch(next, ['router', 'tokenSaver', 'rules'], [...DEFAULT_RULES]);
                      }
                      if (!next.router?.tokenSaver?.defaultTier) {
                        next = patch(next, ['router', 'tokenSaver', 'defaultTier'], 'medium');
                      }
                      if (!next.router?.tokenSaver?.judgeTimeoutMs) {
                        next = patch(next, ['router', 'tokenSaver', 'judgeTimeoutMs'], 15000);
                      }
                    }
                    onChange(next);
                  }}
                />
              </div>

              {ts.enabled && (
                <div className="space-y-4 border-t border-border pt-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-foreground">Judge model</label>
                      <ModelRefInput
                        value={ts.judge ?? ''}
                        options={modelOpts}
                        onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'judge'], v))}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-foreground">Default tier</label>
                      <Select
                        value={ts.defaultTier ?? 'medium'}
                        options={
                          availableTierNames.length > 0
                            ? availableTierNames.map((t) => ({ value: t, label: t }))
                            : TIER_PRESETS.map((t) => ({ value: t, label: t }))
                        }
                        onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'defaultTier'], v))}
                      />
                    </div>
                  </div>
                  <FormRow label="Judge timeout (ms)" description="Maximum time to wait for the judge decision.">
                    <NumberInput
                      value={ts.judgeTimeoutMs}
                      placeholder="15000"
                      onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'judgeTimeoutMs'], v))}
                    />
                  </FormRow>
                  <FormRow label="Sub-agent policy" description="How sub-agents are routed: 'judge' re-evaluates each sub-agent turn, 'inherit' reuses the parent tier.">
                    <Select
                      value={ts.subagent?.policy ?? 'judge'}
                      options={[
                        { value: 'judge', label: 'judge' },
                        { value: 'inherit', label: 'inherit' },
                      ]}
                      onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'subagent', 'policy'], v))}
                    />
                  </FormRow>

                  <TokenSaverTierEditor config={config} onChange={onChange} />
                  <TokenSaverRulesEditor config={config} onChange={onChange} />
                </div>
              )}
            </SettingsCard>

            {/* ── Auto-orchestrate ───────────────────────────────────── */}
            <SettingsCard className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Auto Orchestrate</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Automatically fan out complex turns into parallel sub-agents when the judge assigns certain tiers.
                  </div>
                </div>
                <SettingsToggle
                  checked={Boolean(ao.enabled)}
                  ariaLabel="Toggle auto orchestrate"
                  onChange={(v) => onChange(patch(config, ['router', 'autoOrchestrate', 'enabled'], v))}
                />
              </div>

              {ao.enabled && (
                <div className="space-y-3 border-t border-border pt-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-foreground">Trigger tiers</label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {(availableTierNames.length > 0 ? availableTierNames : [...TIER_PRESETS]).map((tier) => {
                        const active = (ao.triggerTiers ?? []).includes(tier);
                        return (
                          <button
                            key={tier}
                            type="button"
                            className={cn(
                              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                              active
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted',
                            )}
                            onClick={() => {
                              const prev = ao.triggerTiers ?? [];
                              const next = active ? prev.filter((t) => t !== tier) : [...prev, tier];
                              onChange(patch(config, ['router', 'autoOrchestrate', 'triggerTiers'], next));
                            }}
                          >
                            {tier}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <SettingsRow
                    label="Slim system prompt"
                    description="Use a shorter system prompt for orchestrated sub-agents to save tokens."
                  >
                    <SettingsToggle
                      checked={Boolean(ao.slimSystemPrompt)}
                      ariaLabel="Toggle slim system prompt"
                      onChange={(v) => onChange(patch(config, ['router', 'autoOrchestrate', 'slimSystemPrompt'], v))}
                    />
                  </SettingsRow>
                </div>
              )}
            </SettingsCard>

            {/* ── Stats ──────────────────────────────────────────────── */}
            <SettingsCard divided>
              <SettingsRow
                label="Stats collection"
                description="Track token usage and cost per session. Powers the Dashboard tab."
              >
                <SettingsToggle
                  checked={statsEnabled}
                  ariaLabel="Toggle stats"
                  onChange={(v) => onChange(patch(config, ['router', 'stats', 'enabled'], v))}
                />
              </SettingsRow>
            </SettingsCard>

            {statsEnabled && <ModelPricingEditor config={config} onChange={onChange} />}
          </>
        )}
      </div>
    </SettingsSection>
  );
}

function GatewaySection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const g = config.gateway ?? {};
  return (
    <SettingsSection
      title={t('edgeClawConfig.panels.gateway.title')}
      description={t('edgeClawConfig.panels.gateway.description')}
    >
      <SettingsCard divided>
        <SettingsRow label="Enabled" description="When on, the gateway home is generated and channels with credentials come online.">
          <SettingsToggle
            checked={Boolean(g.enabled)}
            ariaLabel="Toggle gateway"
            onChange={(v) => onChange(patch(config, ['gateway', 'enabled'], v))}
          />
        </SettingsRow>
        {g.enabled && (
          <FormRow label="Gateway home" description="Working directory for gateway state and per-channel configs.">
            <TextInput value={g.home} placeholder="~/.pilotdeck/gateway" monospace onChange={(v) => onChange(patch(config, ['gateway', 'home'], v))} />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// ── Raw YAML view (kept very close to the original textarea panel) ──────

function RawYamlView({
  raw, setRaw, validation, error, message, isDirty, externalChangeNotice, dismissExternalNotice,
}: {
  raw: string;
  setRaw: (value: string) => void;
  validation: { valid: boolean; errors: string[]; warnings: string[] } | null;
  error: string | null;
  message: string | null;
  isDirty: boolean;
  externalChangeNotice: string | null;
  dismissExternalNotice: () => void;
}) {
  return (
    <div className="space-y-4">
      {externalChangeNotice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex-1">{externalChangeNotice}</div>
          <button
            type="button"
            onClick={dismissExternalNotice}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
          >
            Dismiss
          </button>
        </div>
      )}
      <SettingsCard className="overflow-hidden">
        <textarea
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          spellCheck={false}
          className="min-h-[480px] w-full resize-y border-0 bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none"
        />
      </SettingsCard>

      <div className="flex items-center gap-2">
        {validation?.valid ? (
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Config is valid {isDirty && <span className="text-muted-foreground">(unsaved)</span>}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            Config has validation errors
          </div>
        )}
      </div>

      {validation && validation.errors.length > 0 && (
        <div className="text-destructive">
          <div className="mb-1 text-xs font-semibold">Errors</div>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {validation.errors.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      {validation && validation.warnings.length > 0 && (
        <div className="text-amber-600 dark:text-amber-400">
          <div className="mb-1 text-xs font-semibold">Warnings</div>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {validation.warnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">{message}</div>}
    </div>
  );
}

// ── Main tab ───────────────────────────────────────────────────────────

type ViewMode = 'form' | 'raw';

export default function PilotDeckConfigTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const {
    path,
    raw,
    setRaw,
    exists,
    validation,
    reload,
    lastReloadInfo,
    isDirty,
    externalChangeNotice,
    dismissExternalNotice,
    loading,
    saving,
    opening,
    error,
    message,
    refresh,
    save,
    reloadConfig,
    openFile,
  } = usePilotDeckConfig();

  // View mode persists across mounts so power users who prefer the textarea
  // don't get bumped back to form-mode every time they re-open Settings.
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof localStorage === 'undefined') return 'form';
    return (localStorage.getItem('pilotdeck:configView') as ViewMode) || 'form';
  });
  useEffect(() => {
    try { localStorage.setItem('pilotdeck:configView', view); } catch { /* swallow */ }
  }, [view]);

  // Active form section. Keeping it local — sections aren't deep-linkable
  // since the surrounding modal already owns its own URL.
  const [activeSection, setActiveSection] = useState<SectionId>('models');

  // Parse `raw` into a typed config for the form. Memoised so we don't
  // reparse on every keystroke unrelated to YAML, but raw IS the source of
  // truth — every form patch reserialises back into raw, which keeps the
  // existing save/watcher pipeline (and hot-reload) functional unchanged.
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const parseError = !parsedConfig && raw.trim().length > 0;

  // Form patches: take the next config, stringify back into YAML, push into
  // the existing `setRaw`. This is what keeps the save+reload pipeline a
  // single code path: server-side validation, watcher debouncing, and
  // subsystem hot-reload all work whether the edit came from the form, the
  // textarea, or an external editor.
  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
    } catch (caught) {
      // Should be unreachable — every patch produces a serializable shape.
      // Fall through silently; the existing error banner will surface any
      // server-side problem on save.
      console.error('Failed to serialise config patch', caught);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('edgeClawConfig.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header card: file path, view-mode toggle, reveal/refresh actions. */}
      <SettingsCard className="space-y-3 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FileCog className="h-4 w-4" />
              {exists ? t('edgeClawConfig.header.configFile') : t('edgeClawConfig.header.configPreview')}
              {isDirty && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  {t('edgeClawConfig.header.unsaved')}
                </span>
              )}
            </div>
            <code className="mt-1 block truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
              {path}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Mode pill — Form / Raw YAML. Same visual idiom Cursor uses
                for its "Edit in JSON" affordance. */}
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              <button
                type="button"
                onClick={() => setView('form')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs',
                  view === 'form' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutList className="h-3.5 w-3.5" />
                {t('edgeClawConfig.viewMode.form')}
              </button>
              <button
                type="button"
                onClick={() => setView('raw')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs',
                  view === 'raw' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                {t('edgeClawConfig.viewMode.rawYaml')}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={openFile} disabled={opening}>
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {opening ? t('edgeClawConfig.actions.opening') : t('edgeClawConfig.actions.revealFile')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('edgeClawConfig.actions.refresh')}
            </Button>
          </div>
        </div>

        {/* External-change banner — relevant in both views. */}
        {externalChangeNotice && view === 'form' && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <div className="flex-1">{externalChangeNotice}</div>
            <button
              type="button"
              onClick={dismissExternalNotice}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
            >
              Dismiss
            </button>
          </div>
        )}
        {parseError && view === 'form' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            YAML on disk failed to parse — switch to Raw YAML to fix it.
          </div>
        )}
      </SettingsCard>

      {view === 'form' ? (
        // Form-mode body: split nav (left) + sections (right). On narrow
        // viewports nav becomes a horizontal scroller above the body so we
        // never hide it behind a hamburger.
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr]">
          <aside className="md:sticky md:top-0 md:self-start">
            <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    'whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors md:whitespace-normal',
                    activeSection === s.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {t(`edgeClawConfig.sections.${s.labelKey}.label`)}
                </button>
              ))}
            </nav>
          </aside>
          <main className="min-w-0 space-y-6">
            {parsedConfig ? (
              <>
                {activeSection === 'models'   && <ModelsSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'agents'   && <AgentsSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'memory'   && <MemorySection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'tools'    && <ToolsSection   config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'router'   && <RouterSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'gateway'  && <GatewaySection config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'customEnv' && <CustomEnvSection config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'alwaysOn' && <AlwaysOnSection config={parsedConfig} projects={projects} onChange={onFormChange} />}
                {activeSection === 'advanced' && <AdvancedSection config={parsedConfig} onChange={onFormChange} />}
              </>
            ) : (
              <SettingsCard className="p-6 text-sm text-muted-foreground">
                Could not parse the YAML on disk. Switch to <strong className="font-medium text-foreground">Raw YAML</strong> to inspect and fix it.
              </SettingsCard>
            )}

            {/* Validation summary lives below the form so users see it after
                tweaking values. Errors/warnings are server-validated — not a
                client mirror — so this stays accurate for cross-section
                rules (e.g. agents.main.model must reference a known entry). */}
            <div className="space-y-2">
              {validation?.valid ? (
                <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Config is valid {isDirty && <span className="text-muted-foreground">(unsaved)</span>}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Config has validation errors — see below
                </div>
              )}
              {validation && validation.errors.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-destructive">
                  {validation.errors.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {validation && validation.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-amber-600 dark:text-amber-400">
                  {validation.warnings.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              {message && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">{message}</div>}
            </div>
          </main>
        </div>
      ) : (
        <RawYamlView
          raw={raw}
          setRaw={setRaw}
          validation={validation}
          error={error}
          message={message}
          isDirty={isDirty}
          externalChangeNotice={externalChangeNotice}
          dismissExternalNotice={dismissExternalNotice}
        />
      )}

      {/* Subsystem reload card — same in both modes, stays at the bottom so
          users always see the impact of their last save. */}
      <SettingsSection
        title={t('edgeClawConfig.panels.subsystemReload.title')}
        description={lastReloadInfo
          ? t('edgeClawConfig.panels.subsystemReload.lastReload', {
              source: sourceLabel(lastReloadInfo.source),
              time: new Date(lastReloadInfo.at).toLocaleTimeString(),
            })
          : t('edgeClawConfig.panels.subsystemReload.fallbackDescription')}
      >
        <SettingsCard className="p-4">
          <ReloadSummary reload={reload} />
        </SettingsCard>
      </SettingsSection>

      {/* Sticky save bar. Save & Reload routes through the same PUT endpoint
          regardless of which view edited `raw` — that's how form edits and
          textarea edits both pick up the unified hot-reload. */}
      <div className="pointer-events-none sticky bottom-0 flex items-center justify-end gap-2 rounded-xl border border-border bg-card/90 p-3 backdrop-blur">
        <Button className="pointer-events-auto" variant="outline" size="sm" onClick={reloadConfig} disabled={saving}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Reload current
        </Button>
        <Button className="pointer-events-auto" size="sm" onClick={save} disabled={saving || !isDirty}>
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {saving ? 'Saving...' : 'Save & reload'}
        </Button>
      </div>
    </div>
  );
}
