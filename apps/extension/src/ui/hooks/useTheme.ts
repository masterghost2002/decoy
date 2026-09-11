import { useCallback, useEffect, useState } from 'react';

import { getThemeRoot } from '@/ui/lib/roots';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/**
 * Deliberately not part of `MocksmithConfig`. The config is the rule set: it is
 * validated, broadcast to every tab and re-injected into every page on change.
 * Flipping the theme must not rewrite the rules or wake every content script,
 * so it gets its own key.
 */
const THEME_KEY = 'mocksmith.theme.v1';

function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/**
 * `system` leaves the attribute off entirely, so the `prefers-color-scheme`
 * media query in the stylesheet stays in charge. The explicit choices stamp
 * `data-theme` on the root, which both theme blocks are written to beat.
 *
 * Which root that is depends on the surface: the document on the popup and the
 * tab, the shadow host in the floating panel -- where stamping the document
 * would flip the colours of the site being mocked.
 */
function applyTheme(choice: ThemeChoice): void {
  const root = getThemeRoot();
  if (choice === 'system') {
    delete root.dataset.theme;
    root.style.colorScheme = '';
    return;
  }
  root.dataset.theme = choice;
  root.style.colorScheme = choice;
}

export interface ThemeState {
  theme: ThemeChoice;
  setTheme: (next: ThemeChoice) => void;
}

export function useTheme(): ThemeState {
  const [theme, setThemeState] = useState<ThemeChoice>('system');

  useEffect(() => {
    let cancelled = false;

    void chrome.storage.local.get(THEME_KEY).then((stored) => {
      if (cancelled) return;
      const raw: unknown = stored[THEME_KEY];
      if (!isThemeChoice(raw)) return;
      setThemeState(raw);
      applyTheme(raw);
    });

    // The popup and the full tab can be open at once, and a theme flip in one
    // should not leave the other disagreeing.
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[THEME_KEY];
      if (change === undefined) return;
      const next: unknown = change.newValue;
      const resolved: ThemeChoice = isThemeChoice(next) ? next : 'system';
      setThemeState(resolved);
      applyTheme(resolved);
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    applyTheme(next);
    void chrome.storage.local.set({ [THEME_KEY]: next });
  }, []);

  return { theme, setTheme };
}
