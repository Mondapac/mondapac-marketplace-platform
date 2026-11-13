// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import NavigationPage from './page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
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
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../src/content/content-no-access.tsx', () => ({
  ContentNoAccess: () => <h1>No access to content</h1>,
}));
vi.mock('../../../../src/content/navigation/navigation-editor.tsx', () => ({
  NavigationEditor: (props: {
    readonly canEdit: boolean;
    readonly canApprove: boolean;
    readonly csrfToken: string;
  }) => (
    <p
      data-testid="editor"
      data-edit={String(props.canEdit)}
      data-approve={String(props.canApprove)}
      data-csrf={props.csrfToken}
    />
  ),
}));

const READ = 'storefront.page.read';
const EDIT = 'storefront.navigation.edit';
const APPROVE = 'storefront.navigation.approve';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'csrf-9',
});
const signIn = (keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    kind: 'ok',
    body: { updatedAt: null, publishedVersionNo: null, draft: { updatedAt: null } },
  });
});
afterEach(cleanup);

describe('the navigation route', () => {
  it('shows the no-access page without the page read key, and reads nothing', async () => {
    signIn([EDIT, APPROVE]);
    render(await NavigationPage());
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the navigation and turns the controls on by the keys held', async () => {
    signIn([READ]);
    render(await NavigationPage());
    expect(mocks.get).toHaveBeenCalledWith('storefront/admin/navigation');
    expect(screen.getByTestId('editor').getAttribute('data-edit')).toBe('false');
    expect(screen.getByTestId('editor').getAttribute('data-approve')).toBe('false');
    expect(screen.getByTestId('editor').getAttribute('data-csrf')).toBe('csrf-9');
    cleanup();
    signIn([READ, EDIT, APPROVE]);
    render(await NavigationPage());
    expect(screen.getByTestId('editor').getAttribute('data-edit')).toBe('true');
    expect(screen.getByTestId('editor').getAttribute('data-approve')).toBe('true');
  });

  it('shows the three tabs, Navigation current', async () => {
    signIn([READ]);
    render(await NavigationPage());
    const current = screen.getByRole('link', { name: 'Navigation' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Pages' }).getAttribute('href')).toBe('/content');
  });

  it('sends a signed-out visitor to the session-ended page', async () => {
    signIn([READ]);
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(NavigationPage()).rejects.toThrow('redirect:/session-ended');
  });

  it('says the navigation is unavailable when the API cannot be reached', async () => {
    signIn([READ]);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await NavigationPage());
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});
