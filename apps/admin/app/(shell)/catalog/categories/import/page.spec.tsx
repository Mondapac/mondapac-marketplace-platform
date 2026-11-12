// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import CategoryImportPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(
      createTranslator({
        locale: 'en-AU',
        messages,
        ...(namespace === undefined ? {} : { namespace }),
      } as never),
    ),
}));
vi.mock('../../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <div data-active={activeId}>{children}</div>,
}));
vi.mock('../../../../../src/categories/import/category-import.tsx', () => ({
  CategoryImport: ({ csrfToken }: { readonly csrfToken: string }) => (
    <p data-testid="import" data-csrf={csrfToken}>
      import
    </p>
  ),
}));

const session = (keys: readonly string[]): { kind: 'ok'; session: AdminSession } =>
  ({ kind: 'ok', session: { permissionKeys: keys, csrfToken: 'tok' } }) as never;

beforeEach(() => mocks.session.mockReset());
afterEach(cleanup);

describe('Import categories page', () => {
  it('shows the import to a holder of the import key', async () => {
    mocks.session.mockResolvedValue(session(['catalog.category-tree.import']));
    render(await CategoryImportPage());
    expect(screen.getByRole('heading', { name: 'Import categories' })).toBeTruthy();
    expect(screen.getByTestId('import').getAttribute('data-csrf')).toBe('tok');
  });

  it('says the role cannot import without the key, with a way back', async () => {
    mocks.session.mockResolvedValue(session(['catalog.category-tree.view']));
    render(await CategoryImportPage());
    expect(screen.queryByTestId('import')).toBeNull();
    expect(screen.getByText('Your role cannot import categories.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Categories' }).getAttribute('href')).toBe(
      '/catalog/categories',
    );
  });

  it('shows a retry when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await CategoryImportPage());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
