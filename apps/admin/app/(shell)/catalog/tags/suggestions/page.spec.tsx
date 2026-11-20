// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import TagSuggestionsPage from './page.tsx';

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
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.localhost' })),
}));
vi.mock('../../../../../src/server/server-fetch.ts', () => ({
  serverGet: () => Promise.resolve({ kind: 'ok', body: { listPaging: 'pages' } }),
}));
vi.mock('../../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
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
vi.mock('../../../../../src/tags/suggestions-view.tsx', () => ({
  SuggestionsView: (props: {
    readonly csrfToken: string;
    readonly paging: string;
    readonly marketId: string;
  }) => (
    <p
      data-testid="view"
      data-csrf={props.csrfToken}
      data-paging={props.paging}
      data-market={props.marketId}
    >
      view
    </p>
  ),
}));

const session = (permissionKeys: string[]): AdminSession =>
  ({ permissionKeys, csrfToken: 'csrf-9', accountId: 'acc-1' }) as unknown as AdminSession;
const open = async () => render(await TagSuggestionsPage());

describe('admin tag suggestions page', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the queue to a reviewer with the Market paging and market', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['catalog.topic-suggestion.review']),
    });
    const { container } = await open();
    expect(screen.getByTestId('view').getAttribute('data-csrf')).toBe('csrf-9');
    expect(screen.getByTestId('view').getAttribute('data-paging')).toBe('pages');
    expect(screen.getByTestId('view').getAttribute('data-market')).toBe('AU');
    expect(container.querySelector('[data-active="tags"]')).not.toBeNull();
  });

  it('renders NoAccess, and no queue, without the review key', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.topic.manage']) });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText('You do not have access to tag suggestions')).toBeTruthy();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
