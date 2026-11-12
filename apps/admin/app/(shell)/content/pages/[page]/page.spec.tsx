// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import PageEditorPage from './page.tsx';
import PageSettingsPage from './settings/page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
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
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('../../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
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
vi.mock('../../../../../src/content/content-no-access.tsx', () => ({
  ContentNoAccess: () => <h1>No access to content</h1>,
}));
vi.mock('../../../../../src/content/pages/page-content.tsx', () => ({
  PageContent: (props: {
    readonly page: { readonly id: string };
    readonly canEdit: boolean;
    readonly csrfToken: string;
    readonly zone: string;
  }) => (
    <p
      data-testid="content"
      data-edit={String(props.canEdit)}
      data-csrf={props.csrfToken}
      data-zone={props.zone}
    >
      content {props.page.id}
    </p>
  ),
}));
vi.mock('../../../../../src/content/pages/page-settings.tsx', () => ({
  PageSettings: (props: { readonly page: { readonly id: string }; readonly canEdit: boolean }) => (
    <p data-testid="settings" data-edit={String(props.canEdit)}>
      settings {props.page.id}
    </p>
  ),
}));

const READ = 'storefront.page.read';
const EDIT = 'storefront.page.edit';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const session = (permissionKeys: string[], timezone: string | null = null): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'csrf-9',
});
const signIn = (keys: string[], timezone: string | null = null) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys, timezone) });
const params = (page: string) => ({ params: Promise.resolve({ page }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    kind: 'ok',
    body: {
      id: ID,
      updatedAt: '2026-11-02T00:00:00Z',
      publishedVersionNo: 1,
      draft: { updatedAt: null },
    },
  });
});
afterEach(cleanup);

describe('page editor routes', () => {
  it.each([[[]], [[EDIT]], [['storefront.slide.read']]])(
    'show the no-access page without the read permission, and read nothing (%j)',
    async (keys) => {
      signIn(keys);
      render(await PageEditorPage(params(ID)));
      expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
      expect(mocks.get).not.toHaveBeenCalled();
      cleanup();
      render(await PageSettingsPage(params(ID)));
      expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
      expect(mocks.get).not.toHaveBeenCalled();
    },
  );

  it('read the page by its id and show the Content tab with the read key only, not editable', async () => {
    signIn([READ]);
    render(await PageEditorPage(params(ID)));
    expect(mocks.get).toHaveBeenCalledWith(`storefront/admin/pages/${ID}`);
    expect(screen.getByTestId('content').getAttribute('data-edit')).toBe('false');
    expect(screen.getByTestId('content').getAttribute('data-csrf')).toBe('csrf-9');
  });

  it('read a system page by its key and make it editable with the edit key, in the Market zone', async () => {
    signIn([READ, EDIT], 'Australia/Brisbane');
    render(await PageEditorPage(params('home')));
    expect(mocks.get).toHaveBeenCalledWith('storefront/admin/pages/home');
    expect(screen.getByTestId('content').getAttribute('data-edit')).toBe('true');
    expect(screen.getByTestId('content').getAttribute('data-zone')).toBe('Australia/Brisbane');
    expect(screen.getByTestId('content').parentElement?.getAttribute('data-active')).toBe(
      'content',
    );
  });

  it('show the Settings tab on its own route', async () => {
    signIn([READ, EDIT]);
    render(await PageSettingsPage(params(ID)));
    expect(screen.getByTestId('settings').getAttribute('data-edit')).toBe('true');
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('treat an unknown page, and the navigation page, as not found', async () => {
    signIn([READ]);
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    await expect(PageEditorPage(params(ID))).rejects.toThrow('not-found');
    await expect(PageSettingsPage(params(ID))).rejects.toThrow('not-found');
    mocks.get.mockClear();
    await expect(PageEditorPage(params('navigation'))).rejects.toThrow('not-found');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('send a signed-out visitor to the session-ended page', async () => {
    signIn([READ]);
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(PageEditorPage(params(ID))).rejects.toThrow('redirect:/session-ended');
  });

  it('say the page is unavailable when the API cannot be reached', async () => {
    signIn([READ]);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await PageEditorPage(params(ID)));
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('content')).toBeNull();
  });
});
