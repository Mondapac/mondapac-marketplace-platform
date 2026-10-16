// @vitest-environment jsdom
// The responsive standard of the panels (docs: frontend-next handoff): the phone drawer and
// bottom bar of the shell, and a source check that no table can widen the page.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell, Menu } from '@mondapac/ui';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const labels = { menu: 'Open menu', close: 'Close menu', more: 'More', main: 'Main' };
const tabs = [
  { id: 'a', href: '/', label: 'Home', icon: 'home' as const, active: true },
  { id: 'b', href: '/products', label: 'Products', icon: 'package' as const, active: false },
];

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  window.matchMedia = (() => ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('AppShell on phones', () => {
  it('opens the drawer from the menu button and closes it with the close button', () => {
    const { container } = render(
      <AppShell sidebar={<nav>Side</nav>} topbar={<header>Top</header>} labels={labels}>
        Body
      </AppShell>,
    );
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close menu', hidden: true }));
    expect(dialog.open).toBe(false);
  });

  it('shows the bottom bar only when tabs are given, and More opens the drawer', () => {
    const { container, rerender } = render(
      <AppShell sidebar={<nav>Side</nav>} topbar={<header>Top</header>} labels={labels}>
        Body
      </AppShell>,
    );
    expect(container.querySelector('nav.fixed')).toBeNull();
    rerender(
      <AppShell
        sidebar={<nav>Side</nav>}
        topbar={<header>Top</header>}
        labels={labels}
        bottomTabs={tabs}
      >
        Body
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect((container.querySelector('dialog') as HTMLDialogElement).open).toBe(true);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return path.endsWith('.tsx') && !path.endsWith('.spec.tsx') ? [path] : [];
  });
}

describe('tables', () => {
  it('sit inside a scroll container, so a wide table never widens the page', () => {
    const roots = [join(__dirname, '../src'), join(__dirname, '../app')];
    const offenders = roots.flatMap(sourceFiles).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('<table') && !text.includes('overflow-x-auto');
    });
    expect(offenders).toEqual([]);
  });

  it('start their header text where the cells start, in both panels', () => {
    // Browsers centre <th> by default; the shared stylesheet resets it in the base layer, so a
    // header's own utility (text-end on Actions) still wins over the reset.
    const css = readFileSync(join(__dirname, '../../../packages/ui/src/styles.css'), 'utf8');
    expect(css).toMatch(/@layer base\s*{\s*th\s*{\s*text-align:\s*start;/);
    const panels = ['seller', 'admin'].flatMap((app) =>
      ['src', 'app'].map((dir) => join(__dirname, '../..', app, dir)),
    );
    const centred = panels
      .flatMap(sourceFiles)
      .filter((file) => /<th\b[^>]*\btext-center\b/.test(readFileSync(file, 'utf8')));
    expect(centred).toEqual([]);
  });
});

describe('two-step pages', () => {
  it('use fluid layouts: no fixed widths beyond the QR plate, and wrapping action rows', () => {
    const text = readFileSync(join(__dirname, '../src/security/two-step-panel.tsx'), 'utf8');
    // A fixed pixel width would widen a 375px page; only max-width and the QR plate are set.
    expect(text).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    expect(text).toContain('max-w-(--mp-size-form-max)');
    expect(text).toContain('flex-wrap');
    expect(text).toContain('break-all');
    // The code grid is one column on phones.
    expect(text).toContain('grid-cols-1');
  });
});

describe('payout account pages', () => {
  const files = [
    '../src/payout/payout-account.tsx',
    '../../admin/src/payments/accounts-table.tsx',
    '../../admin/src/payments/accounts-list.tsx',
    '../../admin/src/payments/account-detail.tsx',
  ];

  it('use fluid layouts: no fixed pixel widths, rows that wrap or stack on phones', () => {
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text, file).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    }
    const seller = readFileSync(join(__dirname, files[0] as string), 'utf8');
    // The actions stack on phones; the dialog is the shared one (fits 375px by its own width rule).
    expect(seller).toContain('flex-col gap-2 sm:flex-row');
    expect(seller).toContain('<Dialog');
    expect(seller).toContain('max-w-(--mp-size-form-max)');
  });

  it('keep the admin table in its own scroll box, with the tabs in one scrolling row', () => {
    const table = readFileSync(join(__dirname, files[1] as string), 'utf8');
    expect(table).toContain('overflow-x-auto');
    // Below 1024 px each account is a card (the shared CARD_TABLE classes), no hidden columns.
    expect(table).toContain('CARD_TABLE.row');
    // The tabs are the shared Tabs row: one line that scrolls sideways, 48 px touch targets.
    const list = readFileSync(join(__dirname, files[2] as string), 'utf8');
    expect(list).toContain('<Tabs');
    const tabs = readFileSync(join(__dirname, '../../../packages/ui/src/shell/tabs.tsx'), 'utf8');
    expect(tabs).toContain('overflow-x-auto');
    expect(tabs).toContain('min-h-12');
  });
});

describe('admin customer page', () => {
  it('uses a fluid layout: no fixed pixel widths, a form row and actions that stack on phones', () => {
    const text = readFileSync(
      join(__dirname, '../../admin/src/customers/customer-lookup.tsx'),
      'utf8',
    );
    expect(text).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    expect(text).toContain('max-w-(--mp-size-form-max)');
    expect(text).toContain('flex flex-col gap-3 sm:flex-row');
    expect(text).toContain('flex flex-col gap-2 sm:flex-row');
    // Long addresses wrap inside the value column instead of widening the page.
    expect(text).toContain('wrap-anywhere');
    expect(text).toContain('<Dialog');
  });
});

describe('two-step reset pages', () => {
  it('use fluid layouts and shared components: the admin card and the owner confirm page', () => {
    const files = [
      '../../admin/src/sellers/owner-second-factor-card.tsx',
      '../src/auth/confirm-reset-form.tsx',
    ];
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text, file).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    }
    const card = readFileSync(join(__dirname, files[0] as string), 'utf8');
    expect(card).toContain('flex flex-col gap-2 sm:flex-row');
    expect(card).toContain('<Dialog');
    const confirm = readFileSync(join(__dirname, files[1] as string), 'utf8');
    // The sign-in link is a 48px touch target; the button fills the auth column.
    expect(confirm).toContain('min-h-12');
    expect(confirm).toContain('block');
  });
});

describe('team pages', () => {
  it('give each row action a full control height, 48 px on phones', () => {
    render(
      <Menu
        label="Actions for Ada"
        items={[{ id: 'a', label: 'Change role', onSelect: () => undefined }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    expect(screen.getByRole('menuitem', { name: 'Change role' }).className).toContain(
      'min-h-(--mp-size-control)',
    );
  });

  // Source checks: the screenshots at 375/768/1280 are the layout evidence; these keep the
  // classes that produce it from being dropped.
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

  it('source: keep the table in its own scroll box with fixed columns and no pixel widths', () => {
    const table = read('../src/team/team-table.tsx');
    expect(table).toContain('overflow-x-auto');
    expect(table).toContain('table-fixed');
    expect(table).toContain('<colgroup');
    expect(table).toContain('break-words');
    // Below 1024 px each row is a card (the shared CARD_TABLE classes), so no column is hidden
    // behind a sideways scroll while the sidebar takes part of a tablet's width.
    expect(table).toContain('CARD_TABLE.row');
    expect(table).toContain('data-label=');
    expect(table).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
  });

  it('source: use fluid layouts, touch-sized controls, shared dialogs and stacked actions', () => {
    for (const file of [
      '../src/team/team-table.tsx',
      '../src/team/role-dialog.tsx',
      '../src/team/row-actions.tsx',
      '../src/team/invite-member-button.tsx',
      '../src/auth/accept-invitation-form.tsx',
      '../app/(shell)/team/page.tsx',
    ]) {
      expect(read(file), file).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    }
    const page = read('../app/(shell)/team/page.tsx');
    expect(page).toContain('flex-col gap-2 sm:flex-row');
    expect(page).toContain('min-h-12');
    expect(read('../src/team/role-dialog.tsx')).toContain('<Dialog');
    expect(read('../src/team/row-actions.tsx')).toContain('<Dialog');
    expect(read('../src/team/invite-member-button.tsx')).toContain('w-full sm:w-auto');
    expect(read('../src/auth/accept-invitation-form.tsx')).toContain('min-h-12');
  });
});
