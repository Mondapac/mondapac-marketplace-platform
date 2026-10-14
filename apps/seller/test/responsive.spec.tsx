// @vitest-environment jsdom
// The responsive standard of the panels (docs: frontend-next handoff): the phone drawer and
// bottom bar of the shell, and a source check that no table can widen the page.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '@mondapac/ui';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const labels = { menu: 'Open menu', close: 'Close menu', more: 'More', main: 'Main' };
const tabs = [
  { id: 'a', href: '/', label: 'Home', active: true },
  { id: 'b', href: '/products', label: 'Products', active: false },
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
});
