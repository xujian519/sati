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

export function usePilotDeckConfig() {
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
  // Mirror `isDirty` into a ref so the WS-message effect can read the
  // current value WITHOUT subscribing to it. Subscribing would re-run
  // the effect every time the user types one character, which would
  // re-apply the last cached `config:reloaded` payload and silently
  // revert their unsaved edits — exactly the "form fields stop
  // accepting input + unsaved badge flickers" bug.
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  const { latestMessage } = useWebSocket();
  // Apply each `config:reloaded` broadcast exactly once. Without this,
  // any unrelated re-render that re-evaluates the deps below would
  // re-run applyResponse against a stale-but-still-current
  // `latestMessage` object reference.
  const lastAppliedMessageRef = useRef<unknown>(null);

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
    // Each new WS frame produces a new object reference; if we've
    // already applied this one, skip — otherwise we'd re-write `raw`
    // every time a sibling state (e.g. isDirty, focus state) caused a
    // re-render and React re-evaluated this effect's body.
    if (lastAppliedMessageRef.current === latestMessage) return;
    lastAppliedMessageRef.current = latestMessage;

    const payload = latestMessage as ConfigResponse & {
      source?: ReloadSource;
      timestamp?: string;
    };
    const source: ReloadSource = payload.source ?? 'watcher';

    // If the user has unsaved changes, preserve them and just surface a notice.
    // Read isDirty via ref so this effect doesn't subscribe to it (see
    // isDirtyRef declaration above for why).
    if (isDirtyRef.current && source === 'watcher') {
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
  }, [latestMessage, applyResponse]);

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
