import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';

type ConfigValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

type SubsystemResult = {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
  configPath?: string;
};

export type ConfigReload = {
  processEnv?: SubsystemResult;
  memory?: SubsystemResult;
  router?: SubsystemResult;
  gateway?: SubsystemResult;
  proxy?: SubsystemResult;
} & Record<string, unknown>;

type ConfigResponse = {
  exists: boolean;
  path: string;
  raw: string;
  validation: ConfigValidation;
  reload?: ConfigReload;
};

type ReloadSource = 'ui-save' | 'ui-reload' | 'watcher' | 'refresh';

type ReloadInfo = {
  source: ReloadSource;
  at: number;
};

export function useEdgeClawConfig() {
  const [path, setPath] = useState('');
  const [raw, setRaw] = useState('');
  const [exists, setExists] = useState(false);
  const [validation, setValidation] = useState<ConfigValidation | null>(null);
  const [reload, setReload] = useState<ConfigReload | null>(null);
  const [lastReloadInfo, setLastReloadInfo] = useState<ReloadInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [externalChangeNotice, setExternalChangeNotice] = useState<string | null>(null);

  // Users may be typing in the <textarea> when an external edit arrives.
  // Track local edits so we don't clobber unsaved input.
  const savedRawRef = useRef<string>('');
  const [isDirty, setIsDirty] = useState(false);

  const { latestMessage } = useWebSocket();

  const applyResponse = useCallback((data: ConfigResponse, source: ReloadSource = 'refresh') => {
    setPath(data.path);
    setRaw(data.raw);
    savedRawRef.current = data.raw;
    setIsDirty(false);
    setExists(data.exists);
    setValidation(data.validation);
    setReload((data.reload as ConfigReload | undefined) ?? null);
    setLastReloadInfo({ source, at: Date.now() });
  }, []);

  const updateRaw = useCallback((value: string) => {
    setRaw(value);
    setIsDirty(value !== savedRawRef.current);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/config');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load config');
      applyResponse(data, 'refresh');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!latestMessage || latestMessage.type !== 'config:reloaded') return;
    const payload = latestMessage as ConfigResponse & {
      source?: ReloadSource;
      timestamp?: string;
    };
    const source: ReloadSource = payload.source ?? 'watcher';

    // If the user has unsaved changes, preserve them and just surface a notice.
    if (isDirty && source === 'watcher') {
      setExternalChangeNotice(
        'Config was changed on disk by an external edit. Your unsaved draft is kept — click Refresh to discard and load the new version.',
      );
      // Still update validation/reload summary (non-destructive fields)
      setValidation(payload.validation);
      setReload((payload.reload as ConfigReload | undefined) ?? null);
      setPath(payload.path);
      setExists(true);
      setLastReloadInfo({ source, at: Date.now() });
      return;
    }

    applyResponse(
      {
        exists: true,
        path: payload.path,
        raw: payload.raw ?? '',
        validation: payload.validation,
        reload: payload.reload as ConfigReload | undefined,
      },
      source,
    );
    if (source === 'watcher') {
      setExternalChangeNotice('Config was updated on disk — the new version is now loaded.');
    } else {
      setExternalChangeNotice(null);
    }
  }, [latestMessage, isDirty, applyResponse]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.validation?.errors?.join(', ') || 'Failed to save config');
      applyResponse(data, 'ui-save');
      setMessage('Saved and reloaded');
      setExternalChangeNotice(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  }, [applyResponse, raw]);

  const reloadConfig = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/config/reload', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to reload config');
      applyResponse(data, 'ui-reload');
      setMessage('Reloaded current config');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to reload config');
    } finally {
      setSaving(false);
    }
  }, [applyResponse]);

  const openFile = useCallback(async () => {
    setOpening(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/config/open', { method: 'POST' });
      const data = await response.json();
      if (!data.success && data.error) throw new Error(data.error);
      setMessage(`Config file: ${data.path}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to open config file');
    } finally {
      setOpening(false);
    }
  }, []);

  const dismissExternalNotice = useCallback(() => setExternalChangeNotice(null), []);

  return {
    path,
    raw,
    setRaw: updateRaw,
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
  };
}
