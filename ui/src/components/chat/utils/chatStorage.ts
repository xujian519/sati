import type { PilotDeckSettings } from '../types/types';
import { authenticatedFetch } from '../../../utils/api.js';

export const PILOTDECK_SETTINGS_KEY = 'pilotdeck-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

// PilotDeck defaults to bypassing per-tool permission prompts: this is a
// local dev tool the user already trusts (it ships with file/shell
// access to their own machine), and per-prompt approval was the #1
// friction complaint. Users can still flip the toggle off in Settings
// → Permissions; the saved value is preserved on subsequent loads.
const DEFAULT_SKIP_PERMISSIONS = true;

export function getPilotDeckSettings(): PilotDeckSettings {
  const raw = safeLocalStorage.getItem(PILOTDECK_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: DEFAULT_SKIP_PERMISSIONS,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      // Honor the user's explicit boolean choice if one was ever
      // persisted. Treat a *missing* field as the platform default
      // (true) so users who set other permission options before the
      // default flipped don't get stuck with the old behavior.
      skipPermissions:
        typeof parsed.skipPermissions === 'boolean'
          ? parsed.skipPermissions
          : DEFAULT_SKIP_PERMISSIONS,
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: DEFAULT_SKIP_PERMISSIONS,
      projectSortOrder: 'name',
    };
  }
}

export async function fetchPilotDeckPermissionSettings(): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions');
  if (!response.ok) {
    throw new Error(`Failed to fetch permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  return mergePermissionSettings(data.permissions);
}

export async function savePilotDeckPermissionSettings(
  updates: Partial<PilotDeckSettings>,
): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error(`Failed to save permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  const next = mergePermissionSettings(data.permissions);
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify({
    ...getPilotDeckSettings(),
    ...next,
  }));
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  return next;
}

function mergePermissionSettings(value: unknown): PilotDeckSettings {
  const current = getPilotDeckSettings();
  const parsed = value && typeof value === 'object' ? value as Partial<PilotDeckSettings> : {};
  return {
    ...current,
    ...parsed,
    allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
    disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
    skipPermissions: Boolean(parsed.skipPermissions),
    projectSortOrder: current.projectSortOrder || 'name',
  };
}
