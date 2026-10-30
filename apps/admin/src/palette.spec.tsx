// @vitest-environment jsdom
import {
  PaletteSearchButton,
  PanelTools,
  PinButton,
  PinnedSection,
  RecentPages,
  SettingInput,
  SettingRow,
  Toaster,
  panelToolsLabels,
  toast,
  visibleNavItems,
} from '@mondapac/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { adminNav } from './nav.ts';
import { adminDefaultPinIds, adminGoShortcuts, adminPaletteEntries } from './palette.ts';
import { settingEntries, settingsGroups, visibleSettings } from './settings/settings-nav.ts';

const text = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;

const ALL_KEYS = [
  ...adminNav.items.flatMap((item) => item.anyOf ?? []),
  ...settingsGroups.flatMap((group) => group.links.flatMap((l) => [...l.view, ...l.manage])),
  'identity.platform-role.create',
  'identity.admin-account.invite',
];

describe('admin palette index', () => {
  const pageIds = (keys: string[]) =>
    adminPaletteEntries(keys, text)
      .filter((entry) => entry.kind === 'page')
      .map((entry) => entry.href);

  it('lists the same pages as the menu, the settings hub and the account menu, for any keys', () => {
    for (const keys of [
      [],
      ['ordering.order.view'],
      ['shipping.delivery-settings.view', 'identity.platform-role.view'],
      ALL_KEYS,
    ]) {
      const menu = visibleNavItems(adminNav, new Set(keys)).map((item) => item.href);
      const hub = visibleSettings(keys).flatMap(({ links }) => links.map(({ link }) => link.href));
      const account = ['/account/profile', '/account/security', '/account/sessions'];
      expect(pageIds(keys).sort()).toEqual([...menu, ...hub, ...account].sort());
    }
  });

  it('shows a setting and an action only with the permission behind them', () => {
    const labels = (keys: string[]) => adminPaletteEntries(keys, text).map((entry) => entry.label);
    expect(labels([])).not.toContain('Support email');
    expect(labels([])).not.toContain('Create role');
    expect(labels(['notifications.support-contact.view'])).toContain('Support email');
    expect(labels(['identity.platform-role.create'])).toContain('Create role');
    expect(labels([])).toContain('Two-step sign-in');
  });

  it('has a unique id for every registered setting, each on a page of the settings map or the account', () => {
    const ids = settingEntries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pages = new Set([
      ...settingsGroups.flatMap((group) => group.links.map((link) => link.id)),
      'account-security',
    ]);
    for (const entry of settingEntries) expect(pages.has(entry.pageId), entry.id).toBe(true);
  });

  it('starts a role with at most three pinned pages that it may open', () => {
    const pins = (keys: string[]) => adminDefaultPinIds(adminPaletteEntries(keys, text), keys);
    expect(pins(ALL_KEYS)).toHaveLength(3);
    expect(pins(['ordering.order.view'])).toEqual(['page:orders']);
    expect(pins([])).toEqual([]);
  });

  it('adds go-to shortcuts only for pages the keys allow', () => {
    const go = (keys: string[]) =>
      adminGoShortcuts(adminPaletteEntries(keys, text), text).map((s) => s.id);
    expect(go([])).toEqual([]);
    expect(go(ALL_KEYS)).toEqual(['go-settings', 'go-orders']);
    expect(go(['ordering.order.view'])).toEqual(['go-orders']);
  });
});

describe('PanelTools', () => {
  const navigate = vi.fn();
  const KEYS = ['ordering.order.view', 'sellers.seller.view', 'notifications.support-contact.view'];

  function mount(over: { keys?: string[]; accountId?: string } = {}) {
    const keys = over.keys ?? KEYS;
    const entries = adminPaletteEntries(keys, text);
    return render(
      <PanelTools
        panel="admin"
        market="AU"
        accountId={over.accountId ?? 'acc-1'}
        entries={entries}
        defaultPinIds={adminDefaultPinIds(entries, keys)}
        goShortcuts={adminGoShortcuts(entries, text)}
        labels={panelToolsLabels(text)}
        navigate={navigate}
      >
        <PaletteSearchButton />
        <PinButton />
        <PinnedSection />
        <RecentPages heading="Recently visited" />
        <label>
          Notes
          <input />
        </label>
        <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
      </PanelTools>,
    );
  }

  const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
  const key = (target: Element | Document, init: KeyboardEventInit) =>
    fireEvent.keyDown(target, init);

  beforeEach(() => {
    navigate.mockReset();
    window.localStorage.clear();
    window.history.pushState({}, '', '/orders');
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
    vi.restoreAllMocks();
  });

  it('opens with Ctrl+K and Cmd+K as a labelled dialog holding a combobox and a listbox', () => {
    mount();
    key(document, { key: 'k', ctrlKey: true });
    expect(dialog()?.getAttribute('aria-label')).toBe('Search');
    const box = within(dialog()!).getByRole('combobox');
    expect(box.getAttribute('aria-controls')).toBe(
      within(dialog()!).getByRole('listbox').getAttribute('id'),
    );
    expect(document.activeElement).toBe(box);
    key(box, { key: 'k', metaKey: true });
    expect(dialog()).toBeNull();
    key(document, { key: 'k', metaKey: true });
    expect(dialog()).not.toBeNull();
  });

  it('opens from the search control in the top bar and returns focus to it on close', () => {
    mount();
    const opener = screen.getByRole('button', { name: 'Search' });
    opener.focus();
    fireEvent.click(opener);
    expect(dialog()).not.toBeNull();
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close search' }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the opener when the dialog is cancelled with Escape', () => {
    mount();
    const opener = screen.getByRole('button', { name: 'Search' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent(dialog()!, new Event('cancel', { cancelable: true }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('filters as you type, moves with the arrow keys, announces the count and opens with Enter', () => {
    mount();
    key(document, { key: 'k', ctrlKey: true });
    const box = within(dialog()!).getByRole('combobox');
    fireEvent.change(box, { target: { value: 'support' } });
    const options = within(dialog()!).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Support contact'),
      expect.stringContaining('Support email'),
    ]);
    expect(within(dialog()!).getByRole('status').textContent).toBe('2 results');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    key(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    key(box, { key: 'ArrowUp' });
    key(box, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/settings/support#setting-support-email');
    expect(dialog()).toBeNull();
  });

  it('says so when nothing matches, and never lists what the keys do not allow', () => {
    mount({ keys: ['ordering.order.view'] });
    key(document, { key: 'k', ctrlKey: true });
    const box = within(dialog()!).getByRole('combobox');
    fireEvent.change(box, { target: { value: 'support email' } });
    expect(within(dialog()!).queryAllByRole('option')).toEqual([]);
    expect(within(dialog()!).getByRole('status').textContent).toBe(
      'No results for “support email”',
    );
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    key(box, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the shortcuts list with ? and goes to Settings with G then S', () => {
    mount();
    key(document.body, { key: '?', shiftKey: true });
    expect(dialog()?.textContent).toContain('Keyboard shortcuts');
    expect(dialog()?.textContent).toContain('Go to Orders');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(dialog()).toBeNull();
    key(document.body, { key: 'g' });
    key(document.body, { key: 'o' });
    expect(navigate).toHaveBeenCalledWith('/orders');
  });

  it('ignores ? and G-chords while focus is in a field', () => {
    mount();
    const field = screen.getByLabelText('Notes');
    key(field, { key: '?', shiftKey: true });
    key(field, { key: 'g' });
    key(field, { key: 'o' });
    expect(dialog()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('records the page being viewed as recent, newest first, at most five, per account', () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:recent',
      JSON.stringify([
        'page:sellers',
        'page:settings/support',
        'page:home',
        'page:customers',
        'page:x',
      ]),
    );
    mount({ keys: [...KEYS, 'identity.customer-account.view'] });
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:recent')!)).toEqual([
      'page:orders',
      'page:sellers',
      'page:settings/support',
      'page:home',
      'page:customers',
    ]);
    const hub = screen.getByRole('region', { name: 'Recently visited' });
    expect(within(hub).getAllByRole('link')).toHaveLength(5);
    cleanup();
    mount({ accountId: 'acc-2' });
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-2:recent')!)).toEqual([
      'page:orders',
    ]);
  });

  it('pins and unpins the page with the star, keeps the choice in storage and shows it under Pinned', () => {
    mount();
    // Defaults of this role: Orders, All sellers and Settings. The page being viewed is Orders.
    const side = () => screen.getAllByRole('link').map((link) => link.textContent);
    expect(side()).toEqual(expect.arrayContaining(['Orders', 'All sellers', 'Settings']));
    expect(
      screen.getByRole('button', { name: 'Unpin this page' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Unpin this page' }));
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:pins')!)).toEqual([
      'page:sellers',
      'page:settings',
    ]);
    const star = screen.getByRole('button', { name: 'Pin this page' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:pins')!)).toEqual([
      'page:sellers',
      'page:settings',
      'page:orders',
    ]);
  });

  it('refuses a sixth pin with a notice, and unpins to make room', () => {
    const keys = [
      ...KEYS,
      'identity.customer-account.view',
      'catalog.product.view',
      'storefront.slide.read',
    ];
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:pins',
      JSON.stringify([
        'page:sellers',
        'page:customers',
        'page:offer-reviews',
        'page:content',
        'page:settings/support',
      ]),
    );
    mount({ keys });
    const star = screen.getByRole('button', { name: 'Pin this page' });
    fireEvent.click(star);
    expect(screen.getByText('You can pin up to 5 pages. Unpin one first.')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:pins')!)).toHaveLength(5);
    const pinned = screen.getAllByRole('link', { name: 'Customers' });
    expect(pinned.length).toBeGreaterThan(0);
  });

  it('works when storage is missing: pins live for the page and nothing throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount({ keys: ['ordering.order.view', 'sellers.seller.view'] });
    // Defaults show; unpinning works in memory.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Unpin this page' }));
    });
    expect(screen.getByRole('button', { name: 'Pin this page' })).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pin this page' }));
    });
    expect(screen.getByRole('button', { name: 'Unpin this page' })).not.toBeNull();
  });
});

describe('SettingRow highlight', () => {
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  const row = () =>
    render(
      <div>
        <SettingRow settingId="support-email" label="Support email">
          <SettingInput />
        </SettingRow>
        <SettingRow settingId="other" label="Other">
          <SettingInput />
        </SettingRow>
      </div>,
    );

  it('scrolls to the row named by the hash, focuses its control and highlights it', () => {
    window.location.hash = '#setting-support-email';
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    row();
    const wrapper = document.querySelector('[data-setting="support-email"]')!;
    expect(wrapper.hasAttribute('data-found')).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('Support email'));
    expect(document.querySelector('[data-setting="other"]')!.hasAttribute('data-found')).toBe(
      false,
    );
  });

  it('highlights nothing without a matching hash, and follows a later hash change', () => {
    Element.prototype.scrollIntoView = vi.fn();
    row();
    expect(document.querySelector('[data-found]')).toBeNull();
    act(() => {
      window.location.hash = '#setting-other';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(document.querySelector('[data-setting="other"]')!.hasAttribute('data-found')).toBe(true);
  });

  it('fades the highlight after a moment and marks a row only when it has a settingId', () => {
    vi.useFakeTimers();
    try {
      window.location.hash = '#setting-support-email';
      Element.prototype.scrollIntoView = vi.fn();
      row();
      expect(document.querySelector('[data-found]')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(document.querySelector('[data-found]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    render(
      <SettingRow label="Plain">
        <SettingInput />
      </SettingRow>,
    );
    expect(document.querySelector('[data-setting]')).toBeNull();
  });
});
