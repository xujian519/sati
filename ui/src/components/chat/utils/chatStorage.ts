import type { PilotDeckSettings } from '../types/types';

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
