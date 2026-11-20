// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import ReviewModerationRoute from './page.tsx';

// The permission gate of the review moderation list: nothing is read without
// reviews.moderation.queue; the page passes on the actions the admin may take, the Market's List
// paging setting and a seller id from a link (only a real id).

const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const mocks = vi.hoisted(() => ({ session: vi.fn(), get: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/reviews/moderation-list/moderation-list.tsx', () => ({
  ModerationList: (props: {
    canModerate: boolean;
    canRemove: boolean;
    paging: string;
    sellerId: string | null;
    marketId: string;
  }) => (
    <p
      data-moderate={String(props.canModerate)}
      data-remove={String(props.canRemove)}
      data-paging={props.paging}
      data-seller={props.sellerId ?? 'none'}
      data-market={props.marketId}
    >
      the list
    </p>
  ),
}));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('review moderation page', () => {
  it('shows the list to someone with the view permission, with the actions they hold', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['reviews.moderation.queue', 'reviews.moderation.moderate']),
    });
    render(await ReviewModerationRoute(search({ sellerId: SELLER.toUpperCase() })));
    const list = screen.getByText('the list');
    expect(list.getAttribute('data-moderate')).toBe('true');
    expect(list.getAttribute('data-remove')).toBe('false');
    expect(list.getAttribute('data-paging')).toBe('pages');
    expect(list.getAttribute('data-seller')).toBe(SELLER);
    expect(list.getAttribute('data-market')).toBe('AU');
  });

  it('uses Previous and next when the paging setting cannot be read, and ignores a bad seller id', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['reviews.moderation.queue']) });
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await ReviewModerationRoute(search({ sellerId: 'not-an-id' })));
    const list = screen.getByText('the list');
    expect(list.getAttribute('data-paging')).toBe('prev-next');
    expect(list.getAttribute('data-seller')).toBe('none');
  });

  it('shows no list and reads nothing without the view permission', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await ReviewModerationRoute(search()));
    expect(screen.queryByText('the list')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText('You do not have access to the buyer review queue.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Reviews' })).toBeTruthy();
  });

  it('keeps its heading when there is no session', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await ReviewModerationRoute(search()));
    expect(screen.getByRole('heading', { name: 'Reviews' })).toBeTruthy();
  });
});
