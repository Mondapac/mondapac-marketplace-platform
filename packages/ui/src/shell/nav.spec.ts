import { describe, expect, it } from 'vitest';
import { sidebarCollapsed, visibleNavItems, type NavConfig } from './nav.ts';

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
