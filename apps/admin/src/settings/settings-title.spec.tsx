// @vitest-environment jsdom
import { PanelTools, SettingsPage, SettingsTitle, panelToolsLabels } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { adminGoShortcuts, adminPaletteEntries } from '../palette.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;
const KEYS = ['shipping.delivery-settings.view', 'shipping.delivery-settings.manage'];

function mount(children: React.ReactNode) {
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
      {children}
    </PanelTools>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/settings/delivery');
});
afterEach(cleanup);

describe('the pin star on a settings page', () => {
  it('sits beside the page title, in the same row as the h1', () => {
    mount(<SettingsTitle>Delivery rules</SettingsTitle>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Delivery rules' });
    const row = heading.parentElement!;
    const star = within(row).getByRole('button', { name: 'Pin Delivery rules' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    // The heading comes first, so the star follows the title on the start-to-end reading order.
    expect(row.firstElementChild).toBe(heading);
  });

  it('pins and unpins the page from there', () => {
    mount(<SettingsTitle>Delivery rules</SettingsTitle>);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Delivery rules' }));
    expect(
      screen.getByRole('button', { name: 'Pin Delivery rules' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Pin Delivery rules' }));
    expect(
      screen.getByRole('button', { name: 'Pin Delivery rules' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('is in the header of the settings template, which no longer takes it as an action', () => {
    mount(
      <SettingsPage title="Delivery rules" description="How delivery works.">
        <p>Sections</p>
      </SettingsPage>,
    );
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'Pin Delivery rules' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Pin Delivery rules' })).toHaveLength(1);
  });

  it('is left out where the panel tools are not around', () => {
    render(<SettingsTitle>Delivery rules</SettingsTitle>);
    expect(screen.getByRole('heading', { level: 1, name: 'Delivery rules' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
