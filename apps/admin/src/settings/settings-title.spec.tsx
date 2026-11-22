// @vitest-environment jsdom
import { PanelTools, SettingsTitle, panelToolsLabels } from '@mondapac/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { adminGoShortcuts, adminPaletteEntries } from '../palette.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;
const KEYS = ['shipping.delivery-settings.view', 'shipping.delivery-settings.manage'];

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/settings/delivery');
});
afterEach(cleanup);

describe('the settings page title', () => {
  it('is a plain h1: the pin star is in the top bar, not beside the title', () => {
    const entries = adminPaletteEntries(KEYS, text);
    render(
      <PanelTools
        panel="admin"
        market="AU"
        accountId="acc-1"
        entries={entries}
        goShortcuts={adminGoShortcuts(entries, text)}
        labels={panelToolsLabels(text)}
      >
        <SettingsTitle>Delivery rules</SettingsTitle>
      </PanelTools>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Delivery rules' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
