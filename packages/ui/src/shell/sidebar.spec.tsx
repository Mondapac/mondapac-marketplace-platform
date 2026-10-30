import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { splitNavPlacement, type NavItem } from './nav.ts';
import { Sidebar } from './sidebar.tsx';

const items: readonly NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
  { id: 'orders', labelKey: 'nav.orders', icon: 'receipt', href: '/orders' },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    icon: 'sliders',
    href: '/settings',
    placement: 'footer',
  },
];
const label = (key: string) => key.replace('nav.', '');

describe('splitNavPlacement', () => {
  it('separates footer items from the menu and keeps config order', () => {
    const split = splitNavPlacement(items);
    expect(split.menu.map((item) => item.id)).toEqual(['home', 'orders']);
    expect(split.footer.map((item) => item.id)).toEqual(['settings']);
  });
});

describe('Sidebar footer', () => {
  const render = (activeId: string, list = items) =>
    renderToStaticMarkup(
      <Sidebar panelName="Admin" items={list} activeId={activeId} label={label} />,
    );

  it('pins a footer item after the menu, in its own block below a rule', () => {
    const out = render('home');
    expect(out.indexOf('href="/orders"')).toBeLessThan(out.indexOf('href="/settings"'));
    expect(out).toMatch(/border-t border-line[^"]*"[^>]*><a href="\/settings"/);
  });

  it('marks the footer item as the current page when it is active', () => {
    expect(render('settings')).toMatch(/<a href="\/settings"[^>]*aria-current="page"/);
    expect(render('home')).not.toMatch(/<a href="\/settings"[^>]*aria-current/);
  });

  it('does not draw a footer block without a footer item', () => {
    expect(render('home', items.slice(0, 2))).not.toContain('border-t border-line');
  });

  it('keeps a footer item out of the menu groups', () => {
    const grouped = items.map((item) => (item.id === 'settings' ? { ...item, group: 'g' } : item));
    const out = renderToStaticMarkup(
      <Sidebar
        panelName="Admin"
        items={[...grouped, { id: 'x', labelKey: 'nav.x', icon: 'home', href: '/x', group: 'g' }]}
        groups={[{ id: 'g', labelKey: 'nav.group.g', icon: 'inbox' }]}
        activeId="home"
        label={label}
      />,
    );
    expect(out).not.toContain('aria-expanded');
  });
});
