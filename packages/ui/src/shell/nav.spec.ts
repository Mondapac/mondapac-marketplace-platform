import { describe, expect, it } from 'vitest';
import { visibleNavItems, type NavConfig } from './nav.ts';

const config: NavConfig = {
  items: [
    { id: 'home', labelKey: 'nav.home', href: '/' },
    { id: 'team', labelKey: 'nav.team', href: '/team', anyOf: ['a.view', 'b.view'] },
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
