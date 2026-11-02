// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import AttributesPage from './page.tsx';

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
vi.mock('../../../../src/attributes/attributes-view.tsx', () => ({
  AttributesView: (props: {
    readonly canEdit: boolean;
    readonly canSeeBrands: boolean;
    readonly initialTab: string;
    readonly initialId: string | null;
  }) => (
    <p
      data-testid="view"
      data-can-edit={String(props.canEdit)}
      data-brands={String(props.canSeeBrands)}
      data-tab={props.initialTab}
      data-id={String(props.initialId)}
    >
      view
    </p>
  ),
}));

const ID = '0190a000-0000-7000-8000-000000000001';
const session = (permissionKeys: string[]): AdminSession =>
  ({ permissionKeys, csrfToken: 'csrf-9' }) as unknown as AdminSession;
const open = async (query: Record<string, string | string[]> = {}) =>
  render(await AttributesPage({ searchParams: Promise.resolve(query) }));
const view = () => screen.getByTestId('view');

describe('admin attributes page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the screen view-only to a holder of catalog.attribute.view', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.view']) });
    const { container } = await open();
    expect(screen.getByRole('heading', { name: 'Attributes' })).toBeTruthy();
    expect(view().getAttribute('data-can-edit')).toBe('false');
    expect(view().getAttribute('data-brands')).toBe('false');
    expect(view().getAttribute('data-tab')).toBe('attributes');
    expect(view().getAttribute('data-id')).toBe('null');
    expect(container.querySelector('[data-active="attributes"]')).not.toBeNull();
  });

  it('tells an editor apart and shows Brands to a holder of catalog.brand.read', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.attribute.view', 'catalog.attribute.edit', 'catalog.brand.read']),
    });
    await open();
    expect(view().getAttribute('data-can-edit')).toBe('true');
    expect(view().getAttribute('data-brands')).toBe('true');
  });

  it('opens the tab and the row the address names, and ignores anything else', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.view']) });
    await open({ tab: 'feature-sets', id: ID });
    expect(view().getAttribute('data-tab')).toBe('feature-sets');
    expect(view().getAttribute('data-id')).toBe(ID);
    cleanup();
    await open({ tab: 'brands', id: 'not-an-id' });
    expect(view().getAttribute('data-tab')).toBe('attributes');
    expect(view().getAttribute('data-id')).toBe('null');
    cleanup();
    await open({ tab: ['waiting', 'x'], id: [ID] });
    expect(view().getAttribute('data-tab')).toBe('attributes');
    expect(view().getAttribute('data-id')).toBe('null');
  });

  it('shows a no-access message, and no screen, without the view key', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.edit']) });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText(/You do not have access to attributes/)).toBeTruthy();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
