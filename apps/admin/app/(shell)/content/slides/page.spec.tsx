// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import SlidesPage from './page.tsx';
import NewSlidePage from './new/page.tsx';
import SlidePage from './[slideId]/page.tsx';
import SlidePlacementPage from './[slideId]/placement/page.tsx';
import SlideVersionsPage from './[slideId]/versions/page.tsx';
import SlideOrderPage from './order/page.tsx';
import ContentPage from '../page.tsx';

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
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
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
vi.mock('../../../../src/content/content-no-access.tsx', () => ({
  ContentNoAccess: () => <h1>No access to content</h1>,
}));
vi.mock('../../../../src/content/slides/slides-list.tsx', () => ({
  SlidesList: ({
    permissionKeys,
    zone,
    csrfToken,
  }: {
    readonly permissionKeys: readonly string[];
    readonly zone: string;
    readonly csrfToken: string;
  }) => (
    <p data-testid="list" data-zone={zone} data-csrf={csrfToken}>
      list {permissionKeys.join(',')}
    </p>
  ),
}));
vi.mock('../../../../src/content/slides/slide-editor.tsx', () => ({
  SlideEditor: ({
    slide,
    canEdit,
    canPause,
    canPublish,
    startReview,
    csrfToken,
  }: {
    readonly slide: { readonly id: string } | null;
    readonly canEdit: boolean;
    readonly canPause?: boolean;
    readonly canPublish?: boolean;
    readonly startReview?: boolean;
    readonly csrfToken: string;
  }) => (
    <p
      data-testid="editor"
      data-edit={String(canEdit)}
      data-pause={String(canPause)}
      data-publish={String(canPublish)}
      data-review={String(startReview)}
      data-csrf={csrfToken}
    >
      editor {slide?.id ?? 'new'}
    </p>
  ),
}));

vi.mock('../../../../src/content/slides/slide-placement-editor.tsx', () => ({
  SlidePlacementEditor: ({
    slide,
    canEdit,
    canPause,
    canPublish,
    zone,
  }: {
    readonly slide: { readonly id: string };
    readonly canEdit: boolean;
    readonly canPause?: boolean;
    readonly canPublish?: boolean;
    readonly zone: string;
  }) => (
    <p
      data-testid="placement"
      data-edit={String(canEdit)}
      data-pause={String(canPause)}
      data-publish={String(canPublish)}
      data-zone={zone}
    >
      placement {slide.id}
    </p>
  ),
}));
vi.mock('../../../../src/content/slides/slide-versions.tsx', () => ({
  SlideVersions: ({
    slide,
    canEdit,
    canPause,
    canPublish,
    csrfToken,
    zone,
  }: {
    readonly slide: { readonly id: string };
    readonly canEdit: boolean;
    readonly canPause?: boolean;
    readonly canPublish?: boolean;
    readonly csrfToken: string;
    readonly zone: string;
  }) => (
    <p
      data-testid="versions"
      data-edit={String(canEdit)}
      data-pause={String(canPause)}
      data-publish={String(canPublish)}
      data-csrf={csrfToken}
      data-zone={zone}
    >
      versions {slide.id}
    </p>
  ),
}));

vi.mock('../../../../src/content/slides/slide-order-view.tsx', () => ({
  SlideOrderView: ({
    place,
    canEdit,
    csrfToken,
    zone,
  }: {
    readonly place: {
      readonly position: string;
      readonly scope: string;
      readonly scopeId: string | null;
    };
    readonly canEdit: boolean;
    readonly csrfToken: string;
    readonly zone: string;
  }) => (
    <p
      data-testid="order"
      data-edit={String(canEdit)}
      data-zone={zone}
      data-csrf={csrfToken}
      data-place={JSON.stringify(place)}
    >
      order
    </p>
  ),
}));

const READ = 'storefront.slide.read';
const EDIT = 'storefront.slide.edit';
const PAUSE = 'storefront.slide.pause';
const PUBLISH = 'storefront.slide.publish';
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
const params = { params: Promise.resolve({ slideId: ID }), searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    kind: 'ok',
    body: { id: ID, updatedAt: '2026-10-24T00:00:00Z', status: 'live', versions: [] },
  });
});
afterEach(cleanup);

describe('content area', () => {
  it('opens on the Slides tab', () => {
    expect(() => ContentPage()).toThrow('redirect:/content/slides');
  });
});

describe('slides list page', () => {
  it('shows the no-access page without the read permission, and reads nothing', async () => {
    signIn([EDIT]);
    render(await SlidesPage());
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(screen.queryByTestId('list')).toBeNull();
    expect(screen.queryByRole('link', { name: 'New slide' })).toBeNull();
  });

  it('shows the list with only the read permission, without New slide', async () => {
    signIn([READ]);
    render(await SlidesPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Storefront content' })).toBeTruthy();
    expect(screen.getByTestId('list').textContent).toBe('list storefront.slide.read');
    expect(screen.getByTestId('list').getAttribute('data-csrf')).toBe('csrf-9');
    expect(screen.queryByRole('link', { name: 'New slide' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Slides' }).getAttribute('aria-current')).toBe('page');
  });

  it('offers the two views, with All slides current', async () => {
    signIn([READ]);
    render(await SlidesPage());
    const nav = screen.getByRole('navigation', { name: 'Slides view' });
    expect(within(nav).getByRole('link', { name: 'All slides' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Order by position' }).getAttribute('href')).toBe(
      '/content/slides/order?position=home.hero',
    );
  });

  it('shows New slide to an editor, linking to the new slide screen', async () => {
    signIn([READ, EDIT]);
    render(await SlidesPage());
    expect(screen.getByRole('link', { name: 'New slide' }).getAttribute('href')).toBe(
      '/content/slides/new',
    );
  });

  it('shows times in the holder zone when there is one, else UTC', async () => {
    signIn([READ], 'Australia/Brisbane');
    render(await SlidesPage());
    expect(screen.getByTestId('list').getAttribute('data-zone')).toBe('Australia/Brisbane');
    cleanup();
    signIn([READ]);
    render(await SlidesPage());
    expect(screen.getByTestId('list').getAttribute('data-zone')).toBe('UTC');
  });

  it('shows a load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await SlidesPage());
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('new slide page', () => {
  it('needs the edit permission as well as read', async () => {
    signIn([READ]);
    render(await NewSlidePage());
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
    cleanup();
    signIn([EDIT]);
    render(await NewSlidePage());
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('shows an empty editor with the session token to an editor', async () => {
    signIn([READ, EDIT]);
    render(await NewSlidePage());
    const editor = screen.getByTestId('editor');
    expect(editor.textContent).toBe('editor new');
    expect(editor.getAttribute('data-edit')).toBe('true');
    expect(editor.getAttribute('data-csrf')).toBe('csrf-9');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('slide page', () => {
  it('shows no-access without the read permission and does not read the slide', async () => {
    signIn([EDIT]);
    render(await SlidePage(params));
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the slide and opens it read-only with only the read permission', async () => {
    signIn([READ]);
    render(await SlidePage(params));
    expect(mocks.get).toHaveBeenCalledWith(`storefront/admin/slides/${ID}`);
    expect(screen.getByTestId('editor').getAttribute('data-edit')).toBe('false');
  });

  it('opens it for editing with the edit permission', async () => {
    signIn([READ, EDIT]);
    render(await SlidePage(params));
    expect(screen.getByTestId('editor').getAttribute('data-edit')).toBe('true');
    expect(screen.getByTestId('editor').textContent).toBe(`editor ${ID}`);
  });

  it('passes each key on its own: pause and publish are separate gates', async () => {
    const gates = async (keys: string[]) => {
      cleanup();
      signIn(keys);
      render(await SlidePage(params));
      const editor = screen.getByTestId('editor');
      return [
        editor.getAttribute('data-edit'),
        editor.getAttribute('data-pause'),
        editor.getAttribute('data-publish'),
      ];
    };
    expect(await gates([READ])).toEqual(['false', 'false', 'false']);
    expect(await gates([READ, EDIT])).toEqual(['true', 'false', 'false']);
    expect(await gates([READ, PAUSE])).toEqual(['false', 'true', 'false']);
    expect(await gates([READ, PUBLISH])).toEqual(['false', 'false', 'true']);
  });

  it('opens the approval dialog at once only for ?review=1', async () => {
    signIn([READ, PUBLISH]);
    render(
      await SlidePage({
        params: Promise.resolve({ slideId: ID }),
        searchParams: Promise.resolve({ review: '1' }),
      }),
    );
    expect(screen.getByTestId('editor').getAttribute('data-review')).toBe('true');
    cleanup();
    render(await SlidePage(params));
    expect(screen.getByTestId('editor').getAttribute('data-review')).toBe('false');
  });

  it('is not found for an unknown slide, signs out a rejected session, and reports an outage', async () => {
    signIn([READ, EDIT]);
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    await expect(SlidePage(params)).rejects.toThrow('not-found');
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(SlidePage(params)).rejects.toThrow('redirect:/session-ended');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await SlidePage(params));
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});

describe('where and when page', () => {
  it('shows no-access without the read permission and does not read the slide', async () => {
    signIn([EDIT]);
    render(await SlidePlacementPage(params));
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(screen.queryByTestId('placement')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the slide and opens read-only with only the read permission', async () => {
    signIn([READ], 'Australia/Brisbane');
    render(await SlidePlacementPage(params));
    expect(mocks.get).toHaveBeenCalledWith(`storefront/admin/slides/${ID}`);
    const tab = screen.getByTestId('placement');
    expect(tab.getAttribute('data-edit')).toBe('false');
    expect(tab.getAttribute('data-zone')).toBe('Australia/Brisbane');
  });

  it('opens for editing with the edit permission', async () => {
    signIn([READ, EDIT]);
    render(await SlidePlacementPage(params));
    expect(screen.getByTestId('placement').getAttribute('data-edit')).toBe('true');
    expect(screen.getByTestId('placement').textContent).toBe(`placement ${ID}`);
  });

  it('is not found, signed out or unavailable like the Content tab', async () => {
    signIn([READ, EDIT]);
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    await expect(SlidePlacementPage(params)).rejects.toThrow('not-found');
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(SlidePlacementPage(params)).rejects.toThrow('redirect:/session-ended');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await SlidePlacementPage(params));
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('placement')).toBeNull();
  });
});

describe('versions page', () => {
  it('shows no-access without the read permission and does not read the slide', async () => {
    signIn([EDIT]);
    render(await SlideVersionsPage(params));
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(screen.queryByTestId('versions')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the slide and lists it read-only with only the read permission', async () => {
    signIn([READ], 'Australia/Brisbane');
    render(await SlideVersionsPage(params));
    expect(mocks.get).toHaveBeenCalledWith(`storefront/admin/slides/${ID}`);
    const tab = screen.getByTestId('versions');
    expect(tab.getAttribute('data-edit')).toBe('false');
    expect(tab.getAttribute('data-pause')).toBe('false');
    expect(tab.getAttribute('data-publish')).toBe('false');
    expect(tab.getAttribute('data-zone')).toBe('Australia/Brisbane');
  });

  it('allows Restore with the edit permission and passes the session token', async () => {
    signIn([READ, EDIT]);
    render(await SlideVersionsPage(params));
    const tab = screen.getByTestId('versions');
    expect(tab.getAttribute('data-edit')).toBe('true');
    expect(tab.getAttribute('data-csrf')).toBe('csrf-9');
    expect(tab.textContent).toBe(`versions ${ID}`);
  });

  it('is not found, signed out or unavailable like the other tabs', async () => {
    signIn([READ, EDIT]);
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    await expect(SlideVersionsPage(params)).rejects.toThrow('not-found');
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(SlideVersionsPage(params)).rejects.toThrow('redirect:/session-ended');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await SlideVersionsPage(params));
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('versions')).toBeNull();
  });
});

describe('order by position page', () => {
  const search = (query: Record<string, string | string[]> = {}) => ({
    searchParams: Promise.resolve(query),
  });
  const placeOf = (): unknown =>
    JSON.parse(screen.getByTestId('order').getAttribute('data-place') ?? '');

  it('shows no-access without the read permission', async () => {
    signIn([EDIT]);
    render(await SlideOrderPage(search()));
    expect(screen.getByRole('heading', { name: 'No access to content' })).toBeTruthy();
    expect(screen.queryByTestId('order')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Slides view' })).toBeNull();
  });

  it('opens read-only with only the read permission, at the first position', async () => {
    signIn([READ], 'Australia/Brisbane');
    render(await SlideOrderPage(search()));
    const view = screen.getByTestId('order');
    expect(view.getAttribute('data-edit')).toBe('false');
    expect(view.getAttribute('data-zone')).toBe('Australia/Brisbane');
    expect(placeOf()).toEqual({ position: 'home.hero', scope: 'all', scopeId: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Storefront content' })).toBeTruthy();
  });

  it('opens for editing with the edit permission, with the session token', async () => {
    signIn([READ, EDIT]);
    render(await SlideOrderPage(search()));
    expect(screen.getByTestId('order').getAttribute('data-edit')).toBe('true');
    expect(screen.getByTestId('order').getAttribute('data-csrf')).toBe('csrf-9');
  });

  it('takes the place from the address, and falls back from what it does not know', async () => {
    signIn([READ, EDIT]);
    const category = '0190a000-0000-7000-8000-0000000000c1';
    render(
      await SlideOrderPage(
        search({ position: 'category.top', scope: 'category', scopeId: category }),
      ),
    );
    expect(placeOf()).toEqual({ position: 'category.top', scope: 'category', scopeId: category });
    cleanup();
    render(await SlideOrderPage(search({ position: ['nope', 'x'], scope: 'all' })));
    expect(placeOf()).toEqual({ position: 'home.hero', scope: 'all', scopeId: null });
  });

  it('marks Order by position as the current view and keeps the place in its link', async () => {
    signIn([READ]);
    render(await SlideOrderPage(search({ position: 'home.mid' })));
    const nav = screen.getByRole('navigation', { name: 'Slides view' });
    const order = within(nav).getByRole('link', { name: 'Order by position' });
    expect(order.getAttribute('aria-current')).toBe('page');
    expect(order.getAttribute('href')).toBe('/content/slides/order?position=home.mid');
    expect(within(nav).getByRole('link', { name: 'All slides' }).getAttribute('href')).toBe(
      '/content/slides',
    );
  });

  it('shows a load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await SlideOrderPage(search()));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('order')).toBeNull();
  });
});
