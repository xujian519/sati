import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';
import { CATALOG_PROVIDERS, findCatalogProviderById, type CatalogProvider } from '../../../../shared/catalogProviders';

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';

type ConfiguredProvider = {
  providerId: string;
  displayName: string;
  models: string[];
  activeModel?: string;
};

function summariseProviders(rawYaml: Record<string, unknown>): {
  providers: ConfiguredProvider[];
  agentModel: string;
} {
  const agentModel = typeof (rawYaml.agent as Record<string, unknown> | undefined)?.model === 'string'
    ? ((rawYaml.agent as Record<string, unknown>).model as string)
    : '';
  const modelSection = (rawYaml.model as Record<string, unknown> | undefined) ?? {};
  const providersBlock = (modelSection.providers as Record<string, unknown> | undefined) ?? {};
  const providers: ConfiguredProvider[] = [];
  for (const [providerId, providerRaw] of Object.entries(providersBlock)) {
    if (!providerRaw || typeof providerRaw !== 'object') continue;
    const provider = providerRaw as Record<string, unknown>;
    const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
    // Skip the bootstrap placeholder entry so it doesn't look like the user has
    // already added a provider before they actually have.
    if (!apiKey || apiKey === PLACEHOLDER_API_KEY) continue;
    const modelsRaw = (provider.models as Record<string, unknown> | undefined) ?? {};
    const models = Object.keys(modelsRaw);
    if (models.length === 0) continue;
    const catalog = findCatalogProviderById(providerId);
    const activeProviderId = agentModel.split('/', 1)[0];
    const activeModelId = agentModel.slice(activeProviderId.length + 1);
    providers.push({
      providerId,
      displayName: catalog?.displayName ?? providerId,
      models,
      activeModel: activeProviderId === providerId ? activeModelId : undefined,
    });
  }
  return { providers, agentModel };
}

export default function LlmConfigurationStep({ onSaved }: LlmConfigurationStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Snapshot of providers already written to ~/.pilotdeck/pilotdeck.yaml.
  const [existingProviders, setExistingProviders] = useState<ConfiguredProvider[]>([]);
  const [activeAgentModel, setActiveAgentModel] = useState('');
  const [formMode, setFormMode] = useState<'fresh' | 'adding'>('fresh');

  const refreshExisting = useCallback(async () => {
    try {
      const { parse: parseYaml } = await import('yaml');
      const res = await authenticatedFetch('/api/config');
      if (!res.ok) return;
      const data = await res.json();
      const parsed = data.raw ? parseYaml(data.raw) ?? {} : {};
      const summary = summariseProviders(parsed as Record<string, unknown>);
      setExistingProviders(summary.providers);
      setActiveAgentModel(summary.agentModel);
      if (summary.providers.length > 0) {
        setFormMode('adding');
      }
    } catch { /* no existing config or yaml parse failed */ }
  }, []);

  useEffect(() => {
    void refreshExisting();
  }, [refreshExisting]);

  const effectiveUrl = customUrl.trim() || selectedProvider?.defaultUrl || '';
  const effectiveModelId = customModelId.trim() || selectedModelId;
  const canTest = selectedProvider && apiKey.trim() && effectiveModelId;

  const handleProviderSelect = useCallback((provider: CatalogProvider) => {
    setSelectedProvider(provider);
    setSelectedModelId(provider.models[0]?.id ?? '');
    setCustomModelId('');
    setCustomUrl('');
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const handleTest = useCallback(async () => {
    if (!canTest || !selectedProvider) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          providerType: selectedProvider.protocol,
          baseUrl: effectiveUrl,
          apiKey: apiKey.trim(),
          model: effectiveModelId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage(data.message || 'Connected successfully.');
      } else {
        setTestStatus('error');
        setTestMessage(data.error || 'Connection failed.');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [canTest, selectedProvider, effectiveUrl, apiKey, effectiveModelId]);

  const resetForm = useCallback(() => {
    setSelectedProvider(null);
    setSelectedModelId('');
    setCustomModelId('');
    setApiKey('');
    setCustomUrl('');
    setShowAdvanced(false);
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const persistConfig = useCallback(async (mutate: (config: Record<string, unknown>) => void) => {
    const { stringify: stringifyYaml, parse: parseYaml } = await import('yaml');

    let existingConfig: Record<string, unknown> = {};
    try {
      const res = await authenticatedFetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data.raw) existingConfig = parseYaml(data.raw) || {};
      }
    } catch { /* start fresh */ }

    if (!existingConfig.schemaVersion) {
      existingConfig.schemaVersion = 1;
    }
    if (!existingConfig.model || typeof existingConfig.model !== 'object') {
      existingConfig.model = { providers: {} };
    }
    const modelSection = existingConfig.model as Record<string, unknown>;
    if (!modelSection.providers || typeof modelSection.providers !== 'object') {
      modelSection.providers = {};
    }

    mutate(existingConfig);

    delete (existingConfig as Record<string, unknown>).models;
    delete (existingConfig as Record<string, unknown>).agents;
    delete (existingConfig as Record<string, unknown>).version;

    const saveRes = await authenticatedFetch('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ raw: stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 }) }),
    });

    if (!saveRes.ok) {
      const err = await saveRes.json();
      throw new Error(err.error || 'Failed to save configuration');
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      const providerId = selectedProvider.id;
      const modelId = effectiveModelId;
      await persistConfig((config) => {
        const yamlProviders = (config.model as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
        const existingProvider = (yamlProviders[providerId] || {}) as Record<string, unknown>;
        const existingModels = (
          existingProvider.models && typeof existingProvider.models === 'object'
            ? existingProvider.models
            : {}
        ) as Record<string, unknown>;

        yamlProviders[providerId] = {
          ...existingProvider,
          protocol: selectedProvider.protocol,
          url: effectiveUrl,
          apiKey: apiKey.trim(),
          timeoutMs: typeof existingProvider.timeoutMs === 'number' ? existingProvider.timeoutMs : 120000,
          models: {
            ...existingModels,
            [modelId]: existingModels[modelId] || {},
          },
        };

        // Set this newly-added provider/model as the main agent.
        if (!config.agent || typeof config.agent !== 'object') {
          config.agent = {};
        }
        (config.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;
      });

      resetForm();
      await refreshExisting();
      setFormMode('adding');
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, effectiveUrl, effectiveModelId, apiKey, persistConfig, resetForm, refreshExisting]);

  const handleRemoveProvider = useCallback(async (providerId: string) => {
    try {
      await persistConfig((config) => {
        const yamlProviders = (config.model as Record<string, unknown>).providers as Record<string, unknown>;
        delete yamlProviders[providerId];
        const agent = (config.agent as Record<string, unknown> | undefined) ?? {};
        const currentModel = typeof agent.model === 'string' ? agent.model : '';
        if (currentModel.startsWith(`${providerId}/`)) {
          // Promote any other configured model to main agent, otherwise clear.
          const remaining = Object.entries(yamlProviders).find(
            ([, p]) => p && typeof p === 'object' && Object.keys(((p as Record<string, unknown>).models as Record<string, unknown>) ?? {}).length > 0,
          );
          if (remaining) {
            const [otherId, otherProvider] = remaining;
            const otherModels = ((otherProvider as Record<string, unknown>).models as Record<string, unknown>);
            const firstModel = Object.keys(otherModels)[0];
            (config.agent as Record<string, unknown>) = { ...agent, model: `${otherId}/${firstModel}` };
          } else {
            // Fall back to a placeholder so the gateway can still boot.
            (config.agent as Record<string, unknown>) = {
              ...agent,
              model: 'anthropic/claude-sonnet-4.6',
            };
            // Seed a placeholder anthropic provider so resolveModel doesn't fail.
            yamlProviders.anthropic = {
              protocol: 'anthropic',
              url: 'https://api.anthropic.com',
              apiKey: PLACEHOLDER_API_KEY,
              models: { 'claude-sonnet-4.6': {} },
            };
          }
        }
      });
      await refreshExisting();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to remove provider.');
    }
  }, [persistConfig, refreshExisting]);

  const handleSetActive = useCallback(async (providerId: string, modelId: string) => {
    try {
      await persistConfig((config) => {
        if (!config.agent || typeof config.agent !== 'object') {
          config.agent = {};
        }
        (config.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;
      });
      await refreshExisting();
    } catch { /* noop */ }
  }, [persistConfig, refreshExisting]);

  const handleFinish = useCallback(async () => {
    if (existingProviders.length === 0) return;
    setFinishing(true);
    try {
      await onSaved();
    } finally {
      setFinishing(false);
    }
  }, [existingProviders.length, onSaved]);

  const showAddForm = formMode === 'fresh' || selectedProvider != null;

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">LLM Provider Setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add one or more providers. Each Save persists to <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.pilotdeck/pilotdeck.yaml</code> and the last save becomes your main agent (you can re-pick it below).
        </p>
      </div>

      {existingProviders.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Configured providers
          </div>
          <ul className="space-y-2">
            {existingProviders.map((p) => (
              <li key={p.providerId} className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{p.displayName}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {p.models.map((modelId) => {
                      const isActive = p.activeModel === modelId;
                      return (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => handleSetActive(p.providerId, modelId)}
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                            isActive
                              ? 'border-foreground bg-foreground/10 text-foreground'
                              : 'border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground'
                          }`}
                          title={isActive ? 'Currently the main agent' : 'Set as main agent'}
                        >
                          {isActive ? '★ ' : ''}{modelId}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleRemoveProvider(p.providerId); }}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={`Remove ${p.displayName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {!showAddForm && (
            <button
              type="button"
              onClick={() => { resetForm(); setFormMode('fresh'); }}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another provider
            </button>
          )}
        </div>
      )}

      <div className="border-t border-border" />

      {showAddForm && (<>
      {/* Provider grid */}
      <div>
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Provider
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CATALOG_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => handleProviderSelect(provider)}
              className={`relative rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
                selectedProvider?.id === provider.id
                  ? 'border-foreground bg-muted text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              <div className="font-medium">{provider.displayName}</div>
              <div className="mt-0.5 text-[11px] opacity-60">
                {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
              </div>
              {selectedProvider?.id === provider.id && (
                <Check className="absolute right-2 top-2 h-4 w-4 text-foreground" strokeWidth={2.5} />
              )}
            </button>
          ))}
        </div>
      </div>

      {selectedProvider && (
        <>
          {/* API Key */}
          <div>
            <label htmlFor="llm-api-key" className="mb-1 block text-sm font-medium text-foreground">
              API Key
            </label>
            <input
              id="llm-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
              placeholder="sk-..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Model picker */}
          <div>
            <label htmlFor="llm-model" className="mb-1 block text-sm font-medium text-foreground">
              Model
            </label>
            {selectedProvider.models.length > 0 ? (
              <div className="relative">
                <select
                  id="llm-model"
                  value={selectedModelId}
                  onChange={(e) => { setSelectedModelId(e.target.value); setCustomModelId(''); setTestStatus('idle'); setTestMessage(''); }}
                  className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                >
                  {selectedProvider.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName} ({m.id})</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            ) : (
              <input
                id="llm-model"
                type="text"
                value={customModelId}
                onChange={(e) => { setCustomModelId(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                placeholder="Enter model ID..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {selectedProvider.models.length > 0 && (
              <div className="mt-2">
                <input
                  type="text"
                  value={customModelId}
                  onChange={(e) => { setCustomModelId(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                  placeholder="Or type a custom model ID..."
                  className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced settings
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                <div>
                  <label htmlFor="llm-url" className="mb-1 block text-xs font-medium text-muted-foreground">
                    API Base URL
                  </label>
                  <input
                    id="llm-url"
                    type="text"
                    value={customUrl}
                    onChange={(e) => { setCustomUrl(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                    placeholder={selectedProvider.defaultUrl}
                    className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Protocol: <span className="font-mono">{selectedProvider.protocol}</span> &middot; Default URL: <span className="font-mono">{selectedProvider.defaultUrl}</span>
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-6">
            {testStatus !== 'success' && (
              <span className="mr-auto text-xs text-muted-foreground">Test connection first.</span>
            )}
            <button
              type="button"
              onClick={handleTest}
              disabled={!canTest || testStatus === 'testing'}
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {testStatus === 'testing' ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Testing...
                </span>
              ) : (
                'Test Connection'
              )}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={testStatus !== 'success' || saving}
              className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save'
              )}
            </button>
          </div>

          {testMessage && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${
              testStatus === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800/40 dark:bg-green-900/10 dark:text-green-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'
            }`}>
              {testStatus === 'success' ? '✓ ' : '✗ '}{testMessage}
            </div>
          )}
        </>
      )}
      </>)}

      {existingProviders.length > 0 && (
        <div className="flex items-center justify-end gap-3 border-t border-border pt-6">
          {selectedProvider && (
            <button
              type="button"
              onClick={() => { resetForm(); setFormMode('adding'); }}
              className="mr-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing}
            className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {finishing ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Finishing...
              </span>
            ) : (
              'Finish'
            )}
          </button>
        </div>
      )}
    </div>
  );
}
