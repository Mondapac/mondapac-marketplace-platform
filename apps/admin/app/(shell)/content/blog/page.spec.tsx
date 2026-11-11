// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import BlogPage from './page.tsx';

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
  }) => (
    <div data-testid="shell" data-active={activeId}>
      {children}
    </div>
  ),
}));
vi.mock('../../../../src/content/content-no-access.tsx', () => ({
  ContentNoAccess: () => <h1>No access to content</h1>,
}));
vi.mock('../../../../src/blog/posts-view.tsx', () => ({
  PostsView: ({ zone }: { readonly zone: string }) => <p data-testid="view" data-zone={zone} />,
}));

const session = (permissionKeys: string[], timezone: string | null = 'Australia/Sydney') =>
  ({ permissionKeys, timezone, csrfToken: 'csrf-1' }) as unknown as AdminSession;
const open = async () => render(await BlogPage());

describe('admin blog page', () => {
  beforeEach(() => mocks.session.mockReset());
  afterEach(cleanup);

  it('shows the list in the Market zone, with Blog current in the menu, to a reader', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['blog.post.read']) });
    await open();
    expect(screen.getByRole('heading', { name: 'Blog' })).toBeTruthy();
    expect(screen.getByTestId('view').getAttribute('data-zone')).toBe('Australia/Sydney');
    expect(screen.getByTestId('shell').getAttribute('data-active')).toBe('blog');
  });

  it('falls back to UTC for an unknown zone', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.read'], 'Mars/Olympus'),
    });
    await open();
    expect(screen.getByTestId('view').getAttribute('data-zone')).toBe('UTC');
  });

  it('shows the no-access page without blog.post.read, also for the other blog keys', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['blog.post.edit', 'blog.post.publish']),
    });
    await open();
    expect(screen.getByText('No access to content')).toBeTruthy();
    expect(screen.queryByTestId('view')).toBeNull();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await open();
    expect(screen.queryByTestId('view')).toBeNull();
  });
});
