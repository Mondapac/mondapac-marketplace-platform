// @vitest-environment jsdom
import {
  PageTitle,
  PaletteSearchButton,
  ShortcutsButton,
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
import { adminGoShortcuts, adminPaletteEntries } from './palette.ts';
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
    expect(labels([])).not.toContain('Support email address');
    expect(labels([])).not.toContain('Create role');
    expect(labels(['notifications.support-contact.view'])).toContain('Support email address');
    expect(labels(['identity.platform-role.create'])).toContain('Create role');
    expect(labels([])).toContain('Two-step sign-in');
  });

  it('puts the path in front of a settings page and a setting, and starts an account page at its group', () => {
    const context = (id: string) =>
      adminPaletteEntries(ALL_KEYS, text).find((entry) => entry.id === id)?.context;
    expect(context('page:settings/delivery')).toBe('Settings / Delivery');
    expect(context('setting:delivery-cutoff')).toBe('Settings / Delivery / Delivery rules');
    expect(context('page:settings/account-profile')).toBe('Account');
  });

  it('lists Invite admin before Create role', () => {
    const actions = adminPaletteEntries(ALL_KEYS, text)
      .filter((entry) => entry.kind === 'action')
      .map((entry) => entry.label);
    expect(actions).toEqual(['Invite admin', 'Create role']);
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
        goShortcuts={adminGoShortcuts(entries, text)}
        labels={panelToolsLabels(text)}
        navigate={navigate}
      >
        <ShortcutsButton />
        <PaletteSearchButton />
        <p data-testid="phone-title">
          <PageTitle fallback="Fallback" />
        </p>
        <PinButton />
        <PinnedSection />
        <RecentPages heading="Recent" />
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
    // Settings first, then pages, each with the path it lives under.
    expect(options.map((o) => o.textContent)).toEqual([
      'Support email addressSettings / Marketplace / Support contact',
      'Support contactSettings / Marketplace',
    ]);
    expect(within(dialog()!).getByRole('status').textContent).toBe('2 results');
    // The count is also on screen, under the field.
    expect(within(dialog()!).getByText('2 results', { selector: 'p[aria-hidden]' })).toBeTruthy();
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    key(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    key(box, { key: 'ArrowUp' });
    key(box, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/settings/support');
    expect(dialog()).toBeNull();
  });

  it('lists Pinned, Recent and Actions before typing, with the path of each page', () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:pins',
      JSON.stringify(['page:orders', 'page:settings/support']),
    );
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:recent',
      JSON.stringify(['page:settings/support', 'page:sellers']),
    );
    mount({ keys: [...KEYS, 'identity.admin-account.invite', 'identity.platform-role.create'] });
    key(document, { key: 'k', ctrlKey: true });
    const groups = within(dialog()!).getAllByRole('group');
    expect(groups.map((g) => g.querySelector('p')?.textContent)).toEqual([
      'Pinned',
      'Recent',
      'Actions',
    ]);
    const rows = (group: HTMLElement) =>
      within(group)
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(rows(groups[0]!)).toEqual([
      'OrdersOrders & customers',
      'Support contactSettings / Marketplace',
    ]);
    // A pinned page is not listed again under Recent.
    expect(rows(groups[1]!)).toEqual(['All sellersSellers']);
    expect(rows(groups[2]!)).toEqual([
      'Invite admin',
      'Create role',
      expect.stringContaining('Keyboard shortcuts'),
    ]);
  });

  it('offers no actions while typing, and ends the footer with "? for shortcuts"', () => {
    mount({ keys: [...KEYS, 'identity.platform-role.create'] });
    key(document, { key: 'k', ctrlKey: true });
    const footer = dialog()!.querySelector('div.border-t')!;
    expect(footer.textContent).toBe('↑ ↓ to moveEnter to openEsc to close? for shortcuts');
    fireEvent.change(within(dialog()!).getByRole('combobox'), { target: { value: 'role' } });
    expect(within(dialog()!).queryAllByRole('option')).toEqual([]);
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

  it('records the page being viewed as recent, newest first, per account, and keeps it out of what is shown', () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:recent',
      JSON.stringify([
        'page:sellers',
        'page:settings/support',
        'page:home',
        'page:customers',
        'page:disputes',
        'page:x',
      ]),
    );
    mount({ keys: [...KEYS, 'identity.customer-account.view', 'commission-payouts.dispute.view'] });
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:recent')!)).toEqual([
      'page:orders',
      'page:sellers',
      'page:settings/support',
      'page:home',
      'page:customers',
      'page:disputes',
    ]);
    // The page being viewed is not offered again, and the slot is filled by the next page.
    const hub = screen.getByRole('region', { name: 'Recent' });
    expect(
      within(hub)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['All sellers', 'Support contact', 'Dashboard', 'Customers', 'Disputes']);
    key(document, { key: 'k', ctrlKey: true });
    const box = within(dialog()!).getByRole('combobox');
    expect(within(dialog()!).getAllByRole('option')[0]!.textContent).toContain('All sellers');
    key(box, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/sellers');
    cleanup();
    mount({ accountId: 'acc-2' });
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-2:recent')!)).toEqual([
      'page:orders',
    ]);
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
  });

  it('pins and unpins the page with a star named after the page, and keeps the choice', () => {
    mount();
    expect(screen.queryByText('Pinned')).toBeNull();
    const star = screen.getByRole('button', { name: 'Pin Orders' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    expect(star.getAttribute('title')).toBe('Pin Orders');
    fireEvent.click(star);
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:pins')!)).toEqual([
      'page:orders',
    ]);
    // The name stays the same; only the pressed state changes.
    const same = screen.getByRole('button', { name: 'Pin Orders' });
    expect(same.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Pinned')).not.toBeNull();
    const pinnedLink = screen.getAllByRole('link', { name: 'Orders' })[0]!;
    expect(pinnedLink.getAttribute('aria-current')).toBeNull();
    fireEvent.click(same);
    expect(JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:pins')!)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Pin Orders' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('names the page in the phone title, and offers no star below a page', () => {
    mount();
    expect(screen.getByTestId('phone-title').textContent).toBe('Orders');
    cleanup();
    window.history.pushState({}, '', '/orders/42');
    mount();
    expect(screen.getByTestId('phone-title').textContent).toBe('Fallback');
    expect(screen.queryByRole('button', { name: /^Pin / })).toBeNull();
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
    const star = screen.getByRole('button', { name: 'Pin Orders' });
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
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pin Orders' }));
    });
    expect(screen.getByRole('button', { name: 'Pin Orders' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pin Orders' }));
    });
    expect(screen.getByRole('button', { name: 'Pin Orders' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('turns the single-key shortcuts off from the shortcuts dialog and remembers it, keeping Ctrl+K', () => {
    mount();
    const opener = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    opener.focus();
    fireEvent.click(opener);
    const box = within(dialog()!).getByRole('checkbox', { name: /Single-key shortcuts/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(dialog()?.textContent).toContain(
      'Turn off if they clash with your assistive technology.',
    );
    expect(dialog()?.textContent).toContain('use the star in the top bar');
    fireEvent.click(box);
    expect(window.localStorage.getItem('mp:admin:AU:acc-1:single-key')).toBe('0');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
    key(document.body, { key: '?', shiftKey: true });
    key(document.body, { key: 'g' });
    key(document.body, { key: 'o' });
    expect(dialog()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    key(document, { key: 'k', ctrlKey: true });
    expect(dialog()).not.toBeNull();
    cleanup();
    // The choice survives a reload, and turning it back on restores the keys.
    mount();
    key(document.body, { key: '?', shiftKey: true });
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    fireEvent.click(within(dialog()!).getByRole('checkbox', { name: /Single-key shortcuts/ }));
    expect(window.localStorage.getItem('mp:admin:AU:acc-1:single-key')).toBe('1');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    key(document.body, { key: 'g' });
    key(document.body, { key: 'o' });
    expect(navigate).toHaveBeenCalledWith('/orders');
  });

  it('opens the shortcuts list from the palette without a shortcut, and returns focus to the opener', () => {
    mount();
    const opener = screen.getByRole('button', { name: 'Search' });
    opener.focus();
    fireEvent.click(opener);
    // Before typing, the action is listed with the other actions.
    const help = within(dialog()!)
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('Keyboard shortcuts'))!;
    fireEvent.click(help);
    expect(navigate).not.toHaveBeenCalled();
    expect(dialog()?.getAttribute('aria-labelledby')).not.toBeNull();
    expect(dialog()?.textContent).toContain('Single-key shortcuts');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to what had it before ? opened the list', () => {
    mount();
    const button = screen.getByRole('button', { name: 'Search' });
    button.focus();
    key(button, { key: '?', shiftKey: true });
    expect(dialog()?.textContent).toContain('Keyboard shortcuts');
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(button);
  });

  it('says what to try when nothing matches, and reports an empty list as collapsed', () => {
    mount();
    key(document, { key: 'k', ctrlKey: true });
    const box = within(dialog()!).getByRole('combobox');
    expect(box.getAttribute('aria-haspopup')).toBe('listbox');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(box, { target: { value: 'zzzz' } });
    expect(box.getAttribute('aria-expanded')).toBe('false');
    expect(box.getAttribute('aria-controls')).toBeNull();
    expect(within(dialog()!).queryByRole('listbox')).toBeNull();
    expect(dialog()?.textContent).toContain('Check the spelling or try a shorter word.');
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
        vi.advanceTimersByTime(4100);
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
