// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import CategoriesPage from './page.tsx';

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
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <div data-active={activeId}>{children}</div>,
}));
vi.mock('../../../../src/categories/categories-view.tsx', () => ({
  CategoriesView: ({ canEdit }: { readonly canEdit: boolean }) => (
    <p data-testid="view" data-can-edit={String(canEdit)}>
      view
    </p>
  ),
}));

const session = (keys: readonly string[]): { kind: 'ok'; session: AdminSession } =>
  ({ kind: 'ok', session: { permissionKeys: keys, csrfToken: 'tok' } }) as never;

beforeEach(() => mocks.session.mockReset());
afterEach(cleanup);

describe('Categories page', () => {
  it('shows the view to a holder of the view key, read only without the edit key', async () => {
    mocks.session.mockResolvedValue(session(['catalog.category-tree.view']));
    render(await CategoriesPage());
    expect(screen.getByRole('heading', { name: 'Categories' })).toBeTruthy();
    expect(screen.getByTestId('view').getAttribute('data-can-edit')).toBe('false');
  });

  it('passes the edit key on', async () => {
    mocks.session.mockResolvedValue(
      session(['catalog.category-tree.view', 'catalog.category-tree.edit']),
    );
    render(await CategoriesPage());
    expect(screen.getByTestId('view').getAttribute('data-can-edit')).toBe('true');
  });

  it('says the role cannot see categories without the view key', async () => {
    mocks.session.mockResolvedValue(session(['catalog.brand.read']));
    render(await CategoriesPage());
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText('Your role cannot see categories.')).toBeTruthy();
  });

  it('shows a retry when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await CategoriesPage());
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
