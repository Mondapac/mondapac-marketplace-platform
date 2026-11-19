// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import BlogPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn(), get: vi.fn() }));

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
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => (
    <div data-testid="shell" data-active={activeId}>
      {children}
    </div>
  ),
}));
vi.mock('../../../../src/content/content-no-access.tsx', () => ({
  ContentNoAccess: () => <h1>No access to content</h1>,
}));
vi.mock('../../../../src/blog/posts-list.tsx', () => ({
  PostsList: (props: {
    readonly initialView: string;
    readonly paging: string;
    readonly marketId: string;
    readonly accountId: string;
    readonly zone: string;
    readonly canEdit: boolean;
  }) => (
    <p
      data-testid="list"
      data-view={props.initialView}
      data-paging={props.paging}
      data-market={props.marketId}
      data-account={props.accountId}
      data-zone={props.zone}
      data-can-edit={String(props.canEdit)}
    />
  ),
}));

const session = (
  permissionKeys: string[],
  timezone: string | null = 'Australia/Sydney',
  marketTimezone = 'Australia/Brisbane',
) => ({ accountId: 'acc-1', permissionKeys, timezone, marketTimezone }) as unknown as AdminSession;
const search = (view?: string) => ({ searchParams: Promise.resolve({ view }) });
const open = async (view?: string) => render(await BlogPage(search(view)));
const list = () => screen.getByTestId('list');

describe('admin blog page', () => {
  beforeEach(() => {
    mocks.session.mockReset();
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
  });
  afterEach(cleanup);

  it('shows the list to a reader, with Blog current in the menu, in the own zone', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['blog.post.read']) });
    await open();
    expect(screen.getByRole('heading', { name: 'Blog' })).toBeTruthy();
    expect(screen.getByTestId('shell').getAttribute('data-active')).toBe('blog');
    expect(list().getAttribute('data-zone')).toBe('Australia/Sydney');
    expect(list().getAttribute('data-account')).toBe('acc-1');
    expect(list().getAttribute('data-market')).toBe('AU');
  });

  it('reads the List paging setting, and uses Previous and next when it cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['blog.post.read']) });
    await open();
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    expect(list().getAttribute('data-paging')).toBe('pages');
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(list().getAttribute('data-paging')).toBe('prev-next');
  });

  it('tells the list whether the role can write posts', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.read', 'blog.post.edit']),
    });
    await open();
    expect(list().getAttribute('data-can-edit')).toBe('true');
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['blog.post.read']) });
    await open();
    expect(list().getAttribute('data-can-edit')).toBe('false');
  });

  it('opens the view of the link, and an unknown one as All', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['blog.post.read']) });
    await open('in_review');
    expect(list().getAttribute('data-view')).toBe('in_review');
    cleanup();
    await open('everything');
    expect(list().getAttribute('data-view')).toBe('all');
  });

  it("falls back to the Market's zone for an unknown own zone, and to UTC for neither", async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.read'], 'Mars/Olympus'),
    });
    await open();
    expect(list().getAttribute('data-zone')).toBe('Australia/Brisbane');
    cleanup();
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.read'], null, 'Mars/Phobos'),
    });
    await open();
    expect(list().getAttribute('data-zone')).toBe('UTC');
  });

  it('shows the no-access page without blog.post.read, also for the other blog keys', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.edit', 'blog.post.publish']),
    });
    await open();
    expect(screen.getByText('No access to content')).toBeTruthy();
    expect(screen.queryByTestId('list')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
