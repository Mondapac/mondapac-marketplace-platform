// @vitest-environment jsdom
// The grouped sidebar of both panels: independent open and close, the cookie, the active group,
// keyboard movement and the icon rail.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar, visibleNavItems, type NavConfig } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sellerNav, sellerNavItems } from '../src/nav.ts';

const config: NavConfig = {
  groups: [
    { id: 'a', labelKey: 'nav.group.a', icon: 'inbox' },
    { id: 'b', labelKey: 'nav.group.b', icon: 'wallet' },
  ],
  items: [
    { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
    { id: 'a1', labelKey: 'nav.a1', icon: 'inbox', href: '/a1', group: 'a' },
    { id: 'a2', labelKey: 'nav.a2', icon: 'inbox', href: '/a2', group: 'a' },
    { id: 'b1', labelKey: 'nav.b1', icon: 'wallet', href: '/b1', group: 'b' },
    { id: 'b2', labelKey: 'nav.b2', icon: 'wallet', href: '/b2', group: 'b' },
  ],
};

function clearCookie() {
  document.cookie = 'mp-nav-open=; max-age=0; path=/';
}

function sidebar(props: { activeId?: string; openGroups?: readonly string[] } = {}) {
  return (
    <div className="group/rail" data-rail="false">
      <Sidebar
        panelName="Panel"
        items={visibleNavItems(config, new Set())}
        groups={config.groups}
        activeId={props.activeId ?? 'home'}
        label={(key) => key}
        openGroups={props.openGroups}
        expandAll="Expand all"
        collapseAll="Collapse all"
      />
    </div>
  );
}

const header = (name: string) => screen.getByRole('button', { name });
const expanded = (name: string) => header(name).getAttribute('aria-expanded');

beforeEach(clearCookie);
afterEach(cleanup);

describe('grouped sidebar', () => {
  it('starts with every group closed on a first visit, Dashboard active', () => {
    render(sidebar());
    expect(expanded('nav.group.a')).toBe('false');
    expect(expanded('nav.group.b')).toBe('false');
    expect(screen.queryByRole('link', { name: 'nav.a1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'nav.home' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('opens and closes groups independently, so several can be open at once', () => {
    render(sidebar());
    fireEvent.click(header('nav.group.a'));
    fireEvent.click(header('nav.group.b'));
    expect(expanded('nav.group.a')).toBe('true');
    expect(expanded('nav.group.b')).toBe('true');
    expect(screen.getByRole('link', { name: 'nav.a1' })).toBeTruthy();
    fireEvent.click(header('nav.group.a'));
    expect(expanded('nav.group.a')).toBe('false');
    expect(expanded('nav.group.b')).toBe('true');
  });

  it('wires aria-controls to the list the header folds', () => {
    const { container } = render(sidebar({ openGroups: ['a'] }));
    const id = header('nav.group.a').getAttribute('aria-controls') as string;
    const list = container.querySelector(`[id="${id}"]`) as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(list.querySelectorAll('a')).toHaveLength(2);
  });

  it('takes the open groups from the cookie value the server read', () => {
    render(sidebar({ openGroups: ['b'] }));
    expect(expanded('nav.group.a')).toBe('false');
    expect(expanded('nav.group.b')).toBe('true');
  });

  it('opens the group of the active page even when the cookie says closed', () => {
    render(sidebar({ activeId: 'b2', openGroups: [] }));
    expect(expanded('nav.group.b')).toBe('true');
    expect(screen.getByRole('link', { name: 'nav.b2' }).getAttribute('aria-current')).toBe('page');
  });

  it('writes the choice to the cookie', () => {
    render(sidebar());
    fireEvent.click(header('nav.group.b'));
    fireEvent.click(header('nav.group.a'));
    expect(decodeURIComponent(document.cookie)).toContain('mp-nav-open=a,b');
  });

  it('opens or closes every group from one button', () => {
    render(sidebar());
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(expanded('nav.group.a')).toBe('true');
    expect(expanded('nav.group.b')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(expanded('nav.group.a')).toBe('false');
    expect(expanded('nav.group.b')).toBe('false');
  });

  it('moves focus with the arrow keys, Home and End across headers and open links', () => {
    render(sidebar({ openGroups: ['a'] }));
    const order = ['Collapse all', 'nav.home', 'nav.group.a', 'nav.a1', 'nav.a2', 'nav.group.b'];
    const el = (name: string) =>
      screen.getAllByRole(
        name.startsWith('nav.group') || name.endsWith('all') ? 'button' : 'link',
        {
          name,
        },
      )[0] as HTMLElement;
    // The button for an all-open state is "Expand all" here: not every group is open.
    order[0] = 'Expand all';
    el('nav.home').focus();
    fireEvent.keyDown(el('nav.home'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(el('nav.group.a'));
    fireEvent.keyDown(el('nav.group.a'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(el('nav.a1'));
    fireEvent.keyDown(el('nav.a1'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(el('nav.group.a'));
    fireEvent.keyDown(el('nav.group.a'), { key: 'End' });
    expect(document.activeElement).toBe(el('nav.group.b'));
    fireEvent.keyDown(el('nav.group.b'), { key: 'Home' });
    expect(document.activeElement).toBe(el('Expand all'));
  });

  it('skips the links of a closed group when moving', () => {
    render(sidebar());
    const a = header('nav.group.a');
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(header('nav.group.b'));
  });

  it('opens with ArrowRight and closes with ArrowLeft on a header, mirrored in RTL', () => {
    const { container } = render(sidebar());
    const a = header('nav.group.a');
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(expanded('nav.group.a')).toBe('true');
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(expanded('nav.group.a')).toBe('false');
    container.querySelector('nav')?.setAttribute('dir', 'rtl');
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(expanded('nav.group.a')).toBe('true');
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(expanded('nav.group.a')).toBe('false');
  });

  it('opens a group when its icon is pressed on the rail, even if it was open', () => {
    const { container } = render(sidebar({ openGroups: ['a'] }));
    const panel = container.querySelector('[data-rail]') as HTMLElement;
    panel.dataset.rail = 'true';
    fireEvent.pointerDown(header('nav.group.a'));
    fireEvent.click(header('nav.group.a'));
    expect(expanded('nav.group.a')).toBe('true');
    fireEvent.pointerDown(header('nav.group.b'));
    fireEvent.click(header('nav.group.b'));
    expect(expanded('nav.group.b')).toBe('true');
  });

  it('shows on the rail the group icon and hides the links of the group', () => {
    render(sidebar({ openGroups: ['a'] }));
    const list = document.getElementById(
      header('nav.group.a').getAttribute('aria-controls') as string,
    );
    expect(list?.className).toContain('group-data-[rail=true]/rail:hidden');
    expect(header('nav.group.a').querySelector('span')?.className).toContain(
      'group-data-[rail=true]/rail:sr-only',
    );
  });

  it('gives a header the control height and no motion with reduced motion', () => {
    render(sidebar());
    expect(header('nav.group.a').className).toContain('min-h-(--mp-size-control)');
    expect(header('nav.group.a').innerHTML).toContain('motion-reduce:transition-none');
  });
});

describe('seller menu structure', () => {
  const ALL = sellerNav.items.flatMap((item) => item.anyOf ?? []);

  it('shows the grouped tree of an approved seller and only setup before approval', () => {
    const ids = (state: 'approved' | 'pending') =>
      sellerNavItems(state, ALL).map((item) => item.id);
    expect(ids('approved')).toEqual([
      's_home',
      's_orders',
      's_products',
      's_offers',
      's_stock',
      's_store_profile',
      's_earnings',
      's_payout',
      's_team',
      's_settings',
    ]);
    expect(ids('pending')).toEqual(['s_setup']);
  });

  it('shows Stock locations and Payout account only with their view permission', () => {
    const ids = (keys: string[]) => sellerNavItems('approved', keys).map((item) => item.id);
    expect(ids([])).not.toContain('s_stock');
    expect(ids([])).not.toContain('s_payout');
    expect(ids(['inventory.stock.view'])).toContain('s_stock');
    expect(ids(['payments.payout-account.view'])).toContain('s_payout');
  });

  it('puts Store profile in My store, behind its own permission; sellers have no delivery page', () => {
    const ids = (keys: string[]) => sellerNavItems('approved', keys).map((item) => item.id);
    const groups = sellerNav.groups?.map((group) => group.id);
    expect(groups?.indexOf('store')).toBe((groups?.indexOf('catalogue') ?? -2) + 1);
    expect(groups?.indexOf('money')).toBe((groups?.indexOf('store') ?? -2) + 1);
    expect(ids([])).not.toContain('s_store_profile');
    expect(ids(['sellers.store-profile.view'])).toContain('s_store_profile');
    expect(ids(['sellers.store-settings.edit'])).not.toContain('s_delivery');
  });
});
