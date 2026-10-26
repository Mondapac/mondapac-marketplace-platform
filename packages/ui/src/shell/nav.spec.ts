import { describe, expect, it } from 'vitest';
import {
  navOpenGroups,
  navSections,
  navTrail,
  sidebarCollapsed,
  visibleNavItems,
  type NavConfig,
} from './nav.ts';

const config: NavConfig = {
  items: [
    { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
    { id: 'team', labelKey: 'nav.team', icon: 'home', href: '/team', anyOf: ['a.view', 'b.view'] },
  ],
};

describe('visibleNavItems', () => {
  it('shows an item without permission keys to everyone', () => {
    expect(visibleNavItems(config, new Set()).map((i) => i.id)).toEqual(['home']);
  });

  it('shows an item with any one of its keys', () => {
    expect(visibleNavItems(config, new Set(['b.view'])).map((i) => i.id)).toEqual(['home', 'team']);
  });

  it('hides an item when the caller holds none of its keys', () => {
    expect(visibleNavItems(config, new Set(['c.view'])).map((i) => i.id)).toEqual(['home']);
  });
});

describe('visibleNavItems edge cases', () => {
  it('returns nothing for an empty config', () => {
    expect(visibleNavItems({ items: [] }, new Set(['a.view']))).toEqual([]);
  });

  it('hides an item whose anyOf list is empty (no key can show it)', () => {
    const empty: NavConfig = {
      items: [{ id: 'x', labelKey: 'nav.x', icon: 'home', href: '/x', anyOf: [] }],
    };
    expect(visibleNavItems(empty, new Set(['a.view']))).toEqual([]);
  });

  it('keeps config order', () => {
    const ordered: NavConfig = {
      items: [
        { id: 'b', labelKey: 'nav.b', icon: 'home', href: '/b' },
        { id: 'a', labelKey: 'nav.a', icon: 'home', href: '/a' },
      ],
    };
    expect(visibleNavItems(ordered, new Set()).map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('sidebarCollapsed', () => {
  it('is true only for the saved collapsed value', () => {
    expect(sidebarCollapsed('collapsed')).toBe(true);
    expect(sidebarCollapsed('expanded')).toBe(false);
    expect(sidebarCollapsed(undefined)).toBe(false);
    expect(sidebarCollapsed('anything')).toBe(false);
  });
});

describe('navTrail', () => {
  const items = [
    { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
    { id: 'settings', labelKey: 'nav.settings', icon: 'home', href: '/settings' },
  ] as const;
  const label = (key: string) => ({ 'nav.home': 'Home', 'nav.settings': 'Settings' })[key] ?? key;

  it('leads from home through the active item to a tab page', () => {
    expect(navTrail(items, 'settings', 'Security', label)).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Settings', href: '/settings' },
    ]);
  });

  it('drops the active item when it is the page itself', () => {
    expect(navTrail(items, 'settings', 'Settings', label)).toEqual([{ label: 'Home', href: '/' }]);
  });

  it('is empty on the home page', () => {
    expect(navTrail(items, 'home', 'Home', label)).toEqual([]);
  });
});

describe('navSections', () => {
  const grouped: NavConfig = {
    groups: [
      { id: 'a', labelKey: 'nav.group.a', icon: 'inbox' },
      { id: 'b', labelKey: 'nav.group.b', icon: 'wallet' },
      { id: 'c', labelKey: 'nav.group.c', icon: 'users' },
    ],
    items: [
      { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
      { id: 'a1', labelKey: 'nav.a1', icon: 'inbox', href: '/a1', group: 'a', anyOf: ['a1.view'] },
      { id: 'b1', labelKey: 'nav.b1', icon: 'wallet', href: '/b1', group: 'b', anyOf: ['b1.view'] },
      { id: 'a2', labelKey: 'nav.a2', icon: 'inbox', href: '/a2', group: 'a', anyOf: ['a2.view'] },
      { id: 'b2', labelKey: 'nav.b2', icon: 'wallet', href: '/b2', group: 'b', anyOf: ['b2.view'] },
      { id: 'c1', labelKey: 'nav.c1', icon: 'users', href: '/c1', group: 'c', anyOf: ['c1.view'] },
      { id: 'tail', labelKey: 'nav.tail', icon: 'home', href: '/tail' },
    ],
  };
  const shape = (keys: string[]) =>
    navSections(grouped.groups, visibleNavItems(grouped, new Set(keys))).map((section) =>
      section.kind === 'item'
        ? section.item.id
        : `${section.group.id}[${section.items.map((i) => i.id).join(',')}]`,
    );

  it('puts a group where its first visible item is and gathers all its items there', () => {
    expect(shape(['a1.view', 'b1.view', 'a2.view', 'b2.view'])).toEqual([
      'home',
      'a[a1,a2]',
      'b[b1,b2]',
      'tail',
    ]);
  });

  it('keeps ungrouped items in place', () => {
    expect(shape([])).toEqual(['home', 'tail']);
  });

  it('leaves out a group with no visible items', () => {
    expect(shape(['a1.view', 'a2.view'])).toEqual(['home', 'a[a1,a2]', 'tail']);
  });

  it('shows the only visible item of a group flat, without a header', () => {
    expect(shape(['a1.view', 'b1.view', 'b2.view', 'c1.view'])).toEqual([
      'home',
      'a1',
      'b[b1,b2]',
      'c1',
      'tail',
    ]);
  });

  it('follows the position of the first visible item when an earlier one is hidden', () => {
    expect(shape(['b1.view', 'a2.view', 'b2.view', 'a1.view'])).toEqual([
      'home',
      'a[a1,a2]',
      'b[b1,b2]',
      'tail',
    ]);
    expect(shape(['a2.view', 'b1.view', 'b2.view'])).toEqual(['home', 'b[b1,b2]', 'a2', 'tail']);
  });

  it('is a flat list without groups, and treats an unknown group id as ungrouped', () => {
    const items = visibleNavItems(grouped, new Set(['a1.view', 'a2.view']));
    expect(navSections(undefined, items).every((section) => section.kind === 'item')).toBe(true);
    expect(navSections([], items)).toHaveLength(items.length);
  });
});

describe('navOpenGroups', () => {
  it('reads a comma-separated list, and nothing (all closed) without a cookie', () => {
    expect(navOpenGroups(undefined)).toEqual([]);
    expect(navOpenGroups('')).toEqual([]);
    expect(navOpenGroups('orders,money')).toEqual(['orders', 'money']);
    expect(navOpenGroups('orders%2Cmoney')).toEqual(['orders', 'money']);
  });
});

describe('navTrail with groups', () => {
  const groups = [{ id: 'g', labelKey: 'nav.group.g', icon: 'inbox' }] as const;
  const items = [
    { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
    { id: 'x', labelKey: 'nav.x', icon: 'inbox', href: '/x', group: 'g' },
    { id: 'y', labelKey: 'nav.y', icon: 'inbox', href: '/y', group: 'g' },
    { id: 'z', labelKey: 'nav.z', icon: 'inbox', href: '/z', group: 'g' },
  ] as const;
  const label = (key: string) => key;

  it('puts the group label, without a link, between home and the active item', () => {
    expect(navTrail(items, 'y', 'Detail', label, groups)).toEqual([
      { label: 'nav.home', href: '/' },
      { label: 'nav.group.g' },
      { label: 'nav.y', href: '/y' },
    ]);
  });

  it('keeps the group label when the active item is the page itself', () => {
    expect(navTrail(items, 'y', 'nav.y', label, groups)).toEqual([
      { label: 'nav.home', href: '/' },
      { label: 'nav.group.g' },
    ]);
  });

  it('adds no group label for an item shown flat (the only visible one of its group)', () => {
    expect(navTrail(items.slice(0, 2), 'x', 'Detail', label, groups)).toEqual([
      { label: 'nav.home', href: '/' },
      { label: 'nav.x', href: '/x' },
    ]);
  });
});
