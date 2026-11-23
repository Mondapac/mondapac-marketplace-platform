// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

let path = '/invoices';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

import { AdminHelpButton, AdminHelpPanel, AdminHelpProvider } from './admin-help.tsx';

function mount(zone: string) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AdminHelpProvider zone={zone}>
        <AdminHelpButton />
        <AdminHelpPanel zone={zone} />
      </AdminHelpProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  path = '/invoices';
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Admin Help panel', () => {
  it("names the viewer's own zone, not the Market's", () => {
    mount('Pacific/Auckland');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('Pacific/Auckland');
    expect(panel.textContent).not.toContain('Brisbane');
  });

  it('shows the Related of a tabbed page beside the open tab, from the page entry', () => {
    path = '/catalog/brands';
    mount('UTC');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('link', { name: 'Products' }).getAttribute('href')).toBe(
      '/catalog/products',
    );
  });
});
