// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock('../../../../src/server/seller-shell.tsx', () => ({
  SellerShell: ({ children, activeId }: { children: ReactNode; activeId: string }) => (
    <div data-testid="shell" data-active={activeId}>
      {children}
    </div>
  ),
}));
vi.mock('../../../../src/catalog/import/seller-import.tsx', () => ({
  SellerImport: ({ csrfToken }: { csrfToken: string }) => <div>import-page {csrfToken}</div>,
}));
const requireSession = vi.fn();
vi.mock('../../../../src/server/session.ts', () => ({
  requireSession: (): unknown => requireSession(),
}));

import ImportPage from './page.tsx';

const session = (over: Record<string, unknown> = {}) => ({
  kind: 'ok',
  session: {
    sellerAccessState: 'approved',
    permissionKeys: ['catalog.own-import.run', 'catalog.own-product.edit'],
    csrfToken: 'csrf-9',
    ...over,
  },
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the import page (server)', () => {
  it('renders the import for a member with both keys', async () => {
    requireSession.mockResolvedValue(session());
    render(await ImportPage());
    expect(screen.getByText('import-page csrf-9')).toBeTruthy();
    expect(screen.getByTestId('shell').dataset.active).toBe('s_import');
  });

  it.each([
    [['catalog.own-import.run']],
    [['catalog.own-product.edit']],
    [['catalog.own-product.view']],
  ])('shows the no-access state for keys %j', async (permissionKeys) => {
    requireSession.mockResolvedValue(session({ permissionKeys }));
    render(await ImportPage());
    expect(screen.queryByText(/import-page/)).toBeNull();
    expect(screen.getByText('catalog.import.no-access')).toBeTruthy();
  });

  it.each(['pending', 'rejected'])('sends a %s seller to the account setup', async (state) => {
    requireSession.mockResolvedValue(session({ sellerAccessState: state }));
    await expect(ImportPage()).rejects.toThrow('redirect:/account-setup');
  });

  it('shows the load error when the session cannot be read', async () => {
    requireSession.mockResolvedValue({ kind: 'unavailable' });
    render(await ImportPage());
    expect(screen.getByText('catalog.error.unavailable')).toBeTruthy();
  });
});
