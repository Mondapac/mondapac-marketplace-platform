// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import BrandsPage from './page.tsx';

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
vi.mock('../../../../src/brands/brands-view.tsx', () => ({
  BrandsView: ({
    canEdit,
    csrfToken,
  }: {
    readonly canEdit: boolean;
    readonly csrfToken: string;
  }) => (
    <p data-testid="view" data-can-edit={String(canEdit)} data-csrf={csrfToken}>
      view
    </p>
  ),
}));

const session = (permissionKeys: string[]): AdminSession =>
  ({ permissionKeys, csrfToken: 'csrf-9' }) as unknown as AdminSession;
const open = async () => render(await BrandsPage());

describe('admin brands page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the screen read-only to a holder of catalog.brand.read', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.brand.read']) });
    await open();
    expect(screen.getByRole('heading', { name: 'Brands' })).toBeTruthy();
    expect(screen.getByTestId('view').getAttribute('data-can-edit')).toBe('false');
    expect(screen.getByTestId('view').getAttribute('data-csrf')).toBe('csrf-9');
  });

  it('turns the writes on for catalog.brand.edit', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.brand.read', 'catalog.brand.edit']),
    });
    await open();
    expect(screen.getByTestId('view').getAttribute('data-can-edit')).toBe('true');
  });

  it('shows a no-access message, and no screen, without the read key', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.brand.edit']) });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText('Your role cannot see brands.')).toBeTruthy();
  });

  it('marks the Brands menu item as the active one', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.brand.read']) });
    const { container } = await open();
    expect(container.querySelector('[data-active="brands"]')).not.toBeNull();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
