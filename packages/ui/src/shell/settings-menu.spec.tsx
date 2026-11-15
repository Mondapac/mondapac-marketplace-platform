// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSettingsMenuGroups, filterSettingsMenu, type SettingsMenu } from './settings-menu.ts';
import { Sidebar } from './sidebar.tsx';

const text: Record<string, string> = {
  'g.ops': 'Delivery',
  'g.money': 'Money',
  'l.rules': 'Delivery rules',
  'l.wallet': 'Customer wallet',
  's.cutoff': 'Order cut-off time',
  's.cutoff-words': 'deadline, hours',
};
const label = (key: string) => text[key] ?? key;

const visible = [
  {
    group: { id: 'ops', labelKey: 'g.ops', icon: 'package' as const },
    links: [{ link: { id: 'rules', labelKey: 'l.rules', href: '/settings/delivery' } }],
  },
  {
    group: { id: 'money', labelKey: 'g.money', icon: 'wallet' as const },
    links: [{ link: { id: 'wallet', labelKey: 'l.wallet', href: '/settings/wallet' } }],
  },
];
const groups = buildSettingsMenuGroups(
  visible,
  [{ id: 'cutoff', pageId: 'rules', labelKey: 's.cutoff', keywordsKey: 's.cutoff-words' }],
  label,
);

const menu = (activeId?: string, list = groups): SettingsMenu => ({
  groups: list,
  ...(activeId === undefined ? {} : { activeId }),
  backHref: '/',
  backLabel: 'Back to Dashboard',
  searchLabel: 'Search settings',
  emptyLabel: 'No settings match',
  navLabel: 'Settings menu',
});

function show(settings: SettingsMenu) {
  render(
    <Sidebar
      panelName="Admin"
      items={[{ id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' }]}
      activeId="settings"
      label={label}
      settings={settings}
    />,
  );
}
afterEach(cleanup);

describe('settings menu data', () => {
  it('adds the labels and words of a page’s settings as search words', () => {
    expect(groups[0]?.links[0]?.words).toEqual(['Order cut-off time', 'deadline', 'hours']);
  });

  it('filters by link label, setting word or group name, and drops empty groups', () => {
    expect(filterSettingsMenu(groups, 'wallet').map((g) => g.id)).toEqual(['money']);
    expect(filterSettingsMenu(groups, 'DEADLINE').map((g) => g.id)).toEqual(['ops']);
    expect(filterSettingsMenu(groups, 'money')[0]?.links).toHaveLength(1);
    expect(filterSettingsMenu(groups, 'zzz')).toEqual([]);
    expect(filterSettingsMenu(groups, '  ')).toEqual(groups);
  });
});

describe('Sidebar in settings mode', () => {
  it('replaces the normal menu: Back to Dashboard first, then search, then the groups', () => {
    show(menu('rules'));
    const nav = screen.getByRole('navigation', { name: 'Settings menu' });
    const back = within(nav).getByRole('link', { name: 'Back to Dashboard' });
    expect(back.getAttribute('href')).toBe('/');
    expect(back.compareDocumentPosition(screen.getByRole('searchbox'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByRole('link', { name: 'nav.home' })).toBeNull();
    expect(within(nav).getByText('Delivery')).toBeTruthy();
  });

  it('marks only the current settings page', () => {
    show(menu('wallet'));
    const current = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Customer wallet']);
  });

  it('marks nothing on the hub', () => {
    show(menu());
    expect(document.querySelector('[aria-current]')).toBeNull();
  });

  it('filters the links as the user types and says when nothing matches', () => {
    show(menu());
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'deadline' } });
    expect(screen.queryByRole('link', { name: 'Customer wallet' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Delivery rules' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No settings match')).toBeTruthy();
  });

  it('shows no page the caller may not view (the app passes only visible groups)', () => {
    show(menu('rules', groups.slice(0, 1)));
    expect(screen.queryByRole('link', { name: 'Customer wallet' })).toBeNull();
  });
});
