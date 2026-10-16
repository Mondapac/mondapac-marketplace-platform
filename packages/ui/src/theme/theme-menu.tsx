'use client';

import { useState } from 'react';
import type { IconName } from '../icon/icon.tsx';
import { Menu } from '../overlay/menu.tsx';
import { THEME_COOKIE, type ThemeChoice } from './theme.ts';

const ICONS: Record<ThemeChoice, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export interface ThemeMenuProps {
  /** The choice saved in the cookie when the page was rendered. */
  readonly choice: ThemeChoice;
  /** Texts from the app's catalogue: the trigger's name and one label per choice. */
  readonly labels: { readonly menu: string } & Record<ThemeChoice, string>;
}

/** The topbar's theme control: System, Light or Dark, applied at once and kept for later visits. */
export function ThemeMenu({ choice: saved, labels }: ThemeMenuProps) {
  const [choice, setChoice] = useState(saved);

  function choose(next: ThemeChoice) {
    setChoice(next);
    const root = document.documentElement;
    root.setAttribute('data-theme-choice', next);
    if (next === 'system') {
      document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    } else {
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      root.setAttribute('data-theme', next);
    }
  }

  return (
    <Menu
      label={labels.menu}
      icon={ICONS[choice]}
      items={ORDER.map((item) => ({
        id: item,
        label: labels[item],
        icon: ICONS[item],
        checked: item === choice,
        onSelect: () => choose(item),
      }))}
    />
  );
}
