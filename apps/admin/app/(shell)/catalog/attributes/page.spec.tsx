// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import AttributesPage from './page.tsx';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

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
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.localhost' })),
}));
vi.mock('../../../../src/server/server-fetch.ts', () => ({
  serverGet: () => Promise.resolve({ kind: 'ok', body: { listPaging: 'pages' } }),
}));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
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
    readonly canDecide: boolean;
    readonly initialTab: string;
    readonly initialId: string | null;
    readonly paging: string;
    readonly marketId: string;
  }) => (
    <p
      data-testid="view"
      data-can-edit={String(props.canEdit)}
      data-brands={String(props.canSeeBrands)}
      data-decide={String(props.canDecide)}
      data-tab={props.initialTab}
      data-id={String(props.initialId)}
      data-paging={props.paging}
      data-market={props.marketId}
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
    expect(view().getAttribute('data-paging')).toBe('pages');
    expect(view().getAttribute('data-market')).toBe('AU');
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

  it('opens the tab and the feature set the address names, and ignores anything else', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.view']) });
    await open({ tab: 'feature-sets', id: ID });
    expect(view().getAttribute('data-tab')).toBe('feature-sets');
    expect(view().getAttribute('data-id')).toBe(ID);
    cleanup();
    await open({ tab: 'brands', id: 'not-an-id' });
    expect(view().getAttribute('data-tab')).toBe('attributes');
    expect(view().getAttribute('data-id')).toBe('null');
    cleanup();
    await open({ tab: ['waiting', 'x'] });
    expect(view().getAttribute('data-tab')).toBe('attributes');
  });

  it('sends an old ?id= link of the Attributes tab to the attribute page', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.attribute.view']) });
    await expect(open({ id: ID })).rejects.toThrow(`redirect:/catalog/attributes/${ID}`);
    await expect(open({ tab: 'attributes', id: ID })).rejects.toThrow('redirect:');
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
