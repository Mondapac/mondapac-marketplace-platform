// @vitest-environment jsdom
// The panel theme (owner decision 2026-10-16): the system setting by default, a saved choice
// from the topbar menu otherwise.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { THEME_SCRIPT, ThemeMenu } from '@mondapac/ui';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../app/theme.js/route.ts';

const labels = { menu: 'Theme', system: 'System', light: 'Light', dark: 'Dark' };
let systemDark = false;
let onSystemChange: (() => void) | undefined;

beforeEach(() => {
  systemDark = false;
  onSystemChange = undefined;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('dark') && systemDark;
    },
    addEventListener: (_: string, listener: () => void) => {
      onSystemChange = listener;
    },
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  root.setAttribute('data-theme-choice', 'system');
  document.cookie = 'mp-theme=; max-age=0; path=/';
});
afterEach(cleanup);

describe('theme head script', () => {
  it('follows the system setting and its changes while the choice is system', () => {
    systemDark = true;
    runInThisContext(THEME_SCRIPT);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    systemDark = false;
    onSystemChange?.();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('leaves a saved choice alone', () => {
    systemDark = true;
    document.documentElement.setAttribute('data-theme-choice', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
    runInThisContext(THEME_SCRIPT);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('theme script route', () => {
  it('serves the head script as JavaScript', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toBe(THEME_SCRIPT);
  });
});

describe('ThemeMenu', () => {
  it('applies and saves a choice, and System clears it', () => {
    render(<ThemeMenu choice="system" labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme: System' }));
    const system = screen.getByRole('menuitemradio', { name: 'System' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(system);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-theme-choice')).toBe('dark');
    expect(document.cookie).toContain('mp-theme=dark');

    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }));
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-theme-choice')).toBe('system');
    expect(document.cookie).not.toContain('mp-theme=dark');
  });
});
