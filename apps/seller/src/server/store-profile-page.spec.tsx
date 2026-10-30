import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The loader of the Store profile page and the page itself: who is sent where, and what each state
// shows. The session and the API read are doubles; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  serverGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('./session.ts', () => ({ requireSession: mocks.requireSession }));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock('./settings-shell.tsx', () => ({
  SettingsShell: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <main data-title={title}>{children}</main>
  ),
}));
vi.mock('../store-profile/store-profile.tsx', () => ({
  StoreProfile: ({ canEdit }: { canEdit: boolean }) => <section data-can-edit={String(canEdit)} />,
}));

import StoreProfilePage from '../../app/(shell)/settings/store-profile/page.tsx';
import { loadStoreProfilePage } from './store-profile-page.ts';

const VIEW = { version: 1 };
const session = (over: Record<string, unknown> = {}) => ({
  sellerAccessState: 'approved',
  permissionKeys: ['sellers.store-profile.view', 'sellers.store-profile.edit'],
  csrfToken: 'csrf',
  ...over,
});
const signedIn = (over: Record<string, unknown> = {}) =>
  mocks.requireSession.mockResolvedValue({ kind: 'ok', session: session(over) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serverGet.mockResolvedValue({ kind: 'ok', body: VIEW });
});

describe('loadStoreProfilePage', () => {
  it('reads the profile for an approved seller who may view it', async () => {
    signedIn();

    const page = await loadStoreProfilePage();

    expect(page).toMatchObject({ kind: 'ok', view: VIEW });
    expect(mocks.serverGet).toHaveBeenCalledWith('sellers/store-profile');
  });

  it('sends a seller who is not approved to the setup, before any read', async () => {
    signedIn({ sellerAccessState: 'pending' });

    await expect(loadStoreProfilePage()).rejects.toThrow(/^REDIRECT:\/account-setup/);
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });

  it('answers no-access, with no read, when the seller lacks the view permission', async () => {
    signedIn({ permissionKeys: ['sellers.store-settings.view'] });

    expect(await loadStoreProfilePage()).toMatchObject({ kind: 'no-access' });
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });

  it('sends a signed-out answer of the read to /session-ended', async () => {
    signedIn();
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });

    await expect(loadStoreProfilePage()).rejects.toThrow('REDIRECT:/session-ended');
  });

  it.each(['unavailable', 'forbidden', 'not-found'])(
    'is unavailable when the read answers %s',
    async (kind) => {
      signedIn();
      mocks.serverGet.mockResolvedValue({ kind });

      expect(await loadStoreProfilePage()).toEqual({ kind: 'unavailable' });
    },
  );

  it('is unavailable when the session itself is', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'unavailable' });

    expect(await loadStoreProfilePage()).toEqual({ kind: 'unavailable' });
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });
});

describe('the Store profile page', () => {
  const render = async () => renderToStaticMarkup(await StoreProfilePage());

  it('renders the editable profile for an owner', async () => {
    signedIn();

    const html = await render();

    expect(html).toContain('data-can-edit="true"');
    expect(html).toContain('<h1');
  });

  it('renders the profile read-only without the edit permission', async () => {
    signedIn({ permissionKeys: ['sellers.store-profile.view'] });

    expect(await render()).toContain('data-can-edit="false"');
  });

  it('renders the no-access message inside the shell', async () => {
    signedIn({ permissionKeys: [] });

    const html = await render();

    expect(html).not.toContain('catalog.no-access');
    expect(html).toContain('store-profile.no-access.title');
    expect(html).toContain('store-profile.no-access.body');
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('data-can-edit');
  });

  it('renders the unavailable state with Try again', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'unavailable' });

    const html = await render();

    expect(html).toContain('store-profile.error.unavailable');
    expect(html).toContain('load.retry');
  });
});
