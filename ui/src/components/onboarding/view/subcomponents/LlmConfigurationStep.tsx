import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

type CatalogProvider = {
  id: string;
  displayName: string;
  protocol: 'anthropic' | 'openai';
  defaultUrl: string;
  models: { id: string; displayName: string }[];
};

const CATALOG_PROVIDERS: CatalogProvider[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic',
    defaultUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' },
      { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' },
      { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-3-5-20241022', displayName: 'Claude 3.5 Haiku' },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    defaultUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4.1', displayName: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini' },
      { id: 'gpt-4o', displayName: 'GPT-4o' },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
      { id: 'o3', displayName: 'o3' },
      { id: 'o3-mini', displayName: 'o3 Mini' },
    ],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    defaultUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)' },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'google',
    displayName: 'Google AI',
    protocol: 'openai',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
    ],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    defaultUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6' },
      { id: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6' },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    defaultUrl: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
    ],
  },
  {
    id: 'yeysai',
    displayName: 'Yeysai',
    protocol: 'openai',
    defaultUrl: 'https://yeysai.com/v1',
    models: [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
      { id: 'kimi-k2.6', displayName: 'Kimi K2.6' },
    ],
  },
];

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

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

  useEffect(() => {
    (async () => {
      try {
        const res = await authenticatedFetch('/api/config/provider');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.exists || !data.provider) return;

        const p = data.provider;
        if (p.apiKey) setApiKey(p.apiKey);
        if (p.baseUrl) {
          const match = CATALOG_PROVIDERS.find(
            (cp) => cp.defaultUrl === p.baseUrl,
          );
          if (match) {
            setSelectedProvider(match);
            if (p.model) setSelectedModelId(p.model);
          }
        }
      } catch { /* no existing config */ }
    })();
  }, []);

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
          providerType: selectedProvider.protocol === 'anthropic' ? 'anthropic' : 'openai-chat',
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

  const handleSave = useCallback(async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      const { stringify: stringifyYaml, parse: parseYaml } = await import('yaml');

      let existingConfig: Record<string, unknown> = {};
      try {
        const res = await authenticatedFetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (data.raw) existingConfig = parseYaml(data.raw) || {};
        }
      } catch { /* start fresh */ }

      const providerId = selectedProvider.id;
      const modelId = effectiveModelId;

      if (!existingConfig.schemaVersion) {
        (existingConfig as Record<string, unknown>).schemaVersion = 1;
      }
      if (!existingConfig.model || typeof existingConfig.model !== 'object') {
        (existingConfig as Record<string, unknown>).model = { providers: {} };
      }
      const modelSection = existingConfig.model as Record<string, unknown>;
      if (!modelSection.providers || typeof modelSection.providers !== 'object') {
        modelSection.providers = {};
      }

      const yamlProviders = modelSection.providers as Record<string, Record<string, unknown>>;
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

      if (!existingConfig.agent || typeof existingConfig.agent !== 'object') {
        (existingConfig as Record<string, unknown>).agent = {};
      }
      (existingConfig.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;

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

      await onSaved();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, effectiveUrl, effectiveModelId, apiKey, onSaved]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">LLM Provider Setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select your provider and enter your API key. Model capabilities are auto-configured.
        </p>
      </div>

      <div className="border-t border-border" />

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
    </div>
  );
}
