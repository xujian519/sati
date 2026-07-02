import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { CLAUDE_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { ProjectSession } from '../../../types/app';

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

type ModelOption = {
  value: string;
  label: string;
};

type ThinkingModelContext = {
  providerId?: string;
  providerUrl?: string;
  protocol?: string;
  modelId?: string;
  supportsThinking?: boolean;
};

const DEFAULT_MODEL_OPTIONS: ModelOption[] = CLAUDE_MODELS.OPTIONS.map((option) => ({
  ...option,
}));

const DEFAULT_PERMISSION_MODE_KEY = 'permissionMode-default';
const COMPOSER_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'bypassPermissions',
];

function readStoredPermissionMode(key: string): PermissionMode | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  return COMPOSER_PERMISSION_MODES.includes(stored as PermissionMode)
    ? (stored as PermissionMode)
    : null;
}

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => {
    return readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY) || 'default';
  });
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('pilotdeck-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);
  const [thinkingModelContext, setThinkingModelContext] = useState<ThinkingModelContext | null>(null);

  useEffect(() => {
    const defaultMode = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
    if (!selectedSession?.id) {
      setPermissionModeState(defaultMode || 'default');
      return;
    }

    const savedMode = readStoredPermissionMode(`permissionMode-${selectedSession.id}`);
    setPermissionModeState(savedMode || defaultMode || 'default');
  }, [selectedSession?.id]);

  useEffect(() => {
    setPendingPermissionRequests((previous) => {
      const next = previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id);
      return next;
    });
  }, [selectedSession?.id]);

  useEffect(() => {
    let cancelled = false;

    authenticatedFetch('/api/agents/runtime-config')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) {
          return;
        }

        const availableModels = Array.isArray(data?.claude?.availableModels)
          ? data.claude.availableModels
            .filter((option: unknown): option is ModelOption => (
              typeof option === 'object'
              && option !== null
              && typeof (option as ModelOption).value === 'string'
              && typeof (option as ModelOption).label === 'string'
            ))
            .map((option: ModelOption) => ({
              value: option.value.trim(),
              label: option.label.trim() || option.value.trim(),
            }))
            .filter((option: ModelOption) => option.value.length > 0)
          : [];
        const runtimeOptions = availableModels.length > 0 ? availableModels : DEFAULT_MODEL_OPTIONS;
        const runtimeDefaultModel = typeof data?.claude?.defaultModel === 'string' && data.claude.defaultModel.trim()
          ? data.claude.defaultModel.trim()
          : CLAUDE_MODELS.DEFAULT;
        const storedModel = localStorage.getItem('pilotdeck-model')?.trim() || '';
        const hasStoredModel = runtimeOptions.some((option: ModelOption) => option.value === storedModel);
        const shouldReuseStoredModel = hasStoredModel && storedModel !== CLAUDE_MODELS.DEFAULT;
        const nextModel = shouldReuseStoredModel ? storedModel : runtimeDefaultModel;

        setModelOptions(runtimeOptions);
        setModel(nextModel);
        localStorage.setItem('pilotdeck-model', nextModel);

        const backendMode = data?.permissions?.effectiveMode;
        if (backendMode && COMPOSER_PERMISSION_MODES.includes(backendMode as PermissionMode)) {
          const storedPerm = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
          if (!storedPerm || storedPerm === 'default') {
            setPermissionModeState(backendMode as PermissionMode);
            localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, backendMode);
          }
        }
      })
      .catch((error) => {
        console.error('Error loading runtime config:', error);
      });

    authenticatedFetch('/api/config')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) {
          return;
        }
        const config = data?.config && typeof data.config === 'object' ? data.config as Record<string, unknown> : null;
        const agent = config?.agent && typeof config.agent === 'object' ? config.agent as Record<string, unknown> : null;
        const modelRef = typeof agent?.model === 'string' ? agent.model.trim() : '';
        const slashIndex = modelRef.indexOf('/');
        if (slashIndex <= 0 || slashIndex >= modelRef.length - 1) {
          setThinkingModelContext(null);
          return;
        }
        const providerId = modelRef.slice(0, slashIndex);
        const modelId = modelRef.slice(slashIndex + 1);
        const modelConfig = config?.model && typeof config.model === 'object' ? config.model as Record<string, unknown> : null;
        const providers = modelConfig?.providers && typeof modelConfig.providers === 'object'
          ? modelConfig.providers as Record<string, unknown>
          : null;
        const provider = providers?.[providerId] && typeof providers[providerId] === 'object'
          ? providers[providerId] as Record<string, unknown>
          : null;
        const models = provider?.models && typeof provider.models === 'object'
          ? provider.models as Record<string, unknown>
          : null;
        const modelDefinition = models?.[modelId] && typeof models[modelId] === 'object'
          ? models[modelId] as Record<string, unknown>
          : null;
        const capabilities = modelDefinition?.capabilities && typeof modelDefinition.capabilities === 'object'
          ? modelDefinition.capabilities as Record<string, unknown>
          : null;
        setThinkingModelContext({
          providerId,
          providerUrl: typeof provider?.url === 'string' ? provider.url : undefined,
          protocol: typeof provider?.protocol === 'string' ? provider.protocol : undefined,
          modelId,
          supportsThinking: typeof capabilities?.supportsThinking === 'boolean' ? capabilities.supportsThinking : undefined,
        });
      })
      .catch((error) => {
        console.error('Error loading PilotDeck config:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setPermissionMode = useCallback((nextMode: PermissionMode) => {
    const normalizedMode = COMPOSER_PERMISSION_MODES.includes(nextMode)
      ? nextMode
      : 'default';

    setPermissionModeState(normalizedMode);
    localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, normalizedMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, normalizedMode);
    }
  }, [selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const currentIndex = COMPOSER_PERMISSION_MODES.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % COMPOSER_PERMISSION_MODES.length;
    const nextMode = COMPOSER_PERMISSION_MODES[nextIndex];
    setPermissionMode(nextMode);
  }, [permissionMode, setPermissionMode]);

  return {
    model,
    setModel,
    modelOptions,
    thinkingModelContext,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
