// @vitest-environment jsdom
import { PanelTools, SettingsHubHeader, panelToolsLabels } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { adminGoShortcuts, adminPaletteEntries } from '../palette.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;
const KEYS = ['ordering.order.view'];

beforeEach(() => {
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('SettingsHubHeader', () => {
  function mount() {
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
        <SettingsHubHeader title="Settings" description={text('settings.hub.description')} />
      </PanelTools>,
    );
  }

  it('has a Search button in the title row that opens the search dialog and gives focus back on close', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Search' });
    button.focus();
    fireEvent.click(button);
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    expect(dialog?.getAttribute('aria-label')).toBe('Search');
    expect(within(dialog!).getByRole('combobox')).toBeTruthy();
    fireEvent.click(within(dialog!).getByRole('button', { name: 'Close search' }));
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
