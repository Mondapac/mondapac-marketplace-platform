// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { expectToast } from '../../../test/toast-spy.ts';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { PageSettings } from './page-settings.tsx';
import type { PageDetail } from './page-types.ts';
import { ID, page } from './test-data.ts';

const call = vi.mocked(callApi);
const CAT = '0190a000-0000-7000-8000-0000000000c1';
const ZONE = 'Australia/Brisbane';

const catalogue = {
  templates: [
    { key: 'campaign-landing', scope: 'dynamic', linkable: ['category', 'seller', 'product'] },
    { key: 'info-page', scope: 'dynamic', linkable: [] },
  ],
};
const tree = {
  defaultLocale: 'en-AU',
  categories: [
    { id: CAT, status: 'active', depth: 0, names: [{ locale: 'en-AU', name: 'Meat' }] },
    { id: 'c2', status: 'archived', depth: 0, names: [{ locale: 'en-AU', name: 'Old' }] },
  ],
};
const refused = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  ok: false as const,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});

/** Reads answer the catalogue and the categories; a PUT answers `put`. */
function route(put: unknown = { ok: true, status: 200, body: page() }, treeOk = true) {
  call.mockImplementation((method, path) => {
    if (path === 'storefront/admin/catalogue') {
      return Promise.resolve({ ok: true, status: 200, body: catalogue });
    }
    if (path === 'catalog/admin/categories') {
      return Promise.resolve(
        treeOk ? { ok: true, status: 200, body: tree } : refused('access.denied', 403),
      );
    }
    return Promise.resolve(put as never);
  });
}
const puts = () => call.mock.calls.filter(([method]) => method === 'PUT');

function mount(detail: PageDetail = page(), canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PageSettings page={detail} canEdit={canEdit} csrfToken="csrf-1" zone={ZONE} />
    </NextIntlClientProvider>,
  );
}
const field = (label: string) => screen.getByLabelText(new RegExp(`^${label}`));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));

beforeEach(() => {
  vi.clearAllMocks();
  route();
});
afterEach(cleanup);

describe('the Settings tab of a landing page', () => {
  it('shows the settings and, beside them, what buyers see now', async () => {
    mount();
    expect((field('Page title') as HTMLInputElement).value).toBe('Ramadan specials');
    expect((field('Address') as HTMLInputElement).value).toBe('ramadan');
    expect((field('Search and share title') as HTMLInputElement).value).toBe('Ramadan');
    const now = screen.getByRole('complementary', { name: 'What buyers see now' });
    expect(within(now).getByText('Ramadan specials')).toBeTruthy();
    expect(within(now).getByText('/l/ramadan')).toBeTruthy();
    expect(within(now).getByText(/Published 1 Nov/)).toBeTruthy();
    await screen.findByLabelText('Linked category');
  });

  it('has nothing to save until something changes, and discards back to the start', () => {
    mount();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save to draft' });
    expect(button.matches(':disabled')).toBe(true);
    fireEvent.change(field('Page title'), { target: { value: 'Eid' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((field('Page title') as HTMLInputElement).value).toBe('Ramadan specials');
    expect(button.matches(':disabled')).toBe(true);
  });

  it('saves all the settings to the draft, with the window as instants of the Market zone', async () => {
    const saved = page({
      draft: {
        ...page().draft,
        settings: {
          title: 'Eid specials',
          slug: 'eid',
          seo: { title: 'Ramadan' },
          linked: { type: 'category', id: CAT },
          startsAt: '2026-11-30T23:00:00.000Z',
          endsAt: null,
        },
      },
    });
    route({ ok: true, status: 200, body: saved });
    mount();
    fireEvent.change(field('Page title'), { target: { value: 'Eid specials' } });
    fireEvent.change(field('Address'), { target: { value: 'eid' } });
    fireEvent.change(await screen.findByLabelText('Linked category'), { target: { value: CAT } });
    fireEvent.change(field('Live from'), { target: { value: '2026-12-01T09:00' } });
    fireEvent.change(field('Search and share description'), { target: { value: '  ' } });
    save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([
      'PUT',
      `storefront/admin/pages/${ID}`,
      {
        title: 'Eid specials',
        slug: 'eid',
        seo: { title: 'Ramadan' },
        linked: { type: 'category', id: CAT },
        startsAt: '2026-11-30T23:00:00.000Z',
        endsAt: null,
      },
      'csrf-1',
    ]);
    await expectToast('Settings saved to the draft.', 'success');
    // The form now shows the saved draft as its clean state, and says it waits for publishing.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save to draft' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/wait for publishing/)).toBeTruthy();
  });

  it('warns that the old address keeps working when a published page gets a new one', () => {
    mount();
    expect(screen.getByText(/Lower-case letters, digits and hyphens/)).toBeTruthy();
    fireEvent.change(field('Address'), { target: { value: 'eid' } });
    expect(screen.getByText(/Buyers who use the old address/)).toBeTruthy();
    cleanup();
    mount(page({ status: 'draft', publishedVersionNo: null, publishedAt: null }));
    fireEvent.change(field('Address'), { target: { value: 'eid' } });
    expect(screen.queryByText(/Buyers who use the old address/)).toBeNull();
  });

  it('marks fields that fail the checks and sends nothing', () => {
    mount();
    fireEvent.change(field('Page title'), { target: { value: '' } });
    fireEvent.change(field('Address'), { target: { value: 'home' } });
    fireEvent.change(field('Live from'), { target: { value: '2026-12-02T09:00' } });
    fireEvent.change(field('Live until'), { target: { value: '2026-12-01T09:00' } });
    fireEvent.change(field('Search and share title'), { target: { value: 'x'.repeat(71) } });
    save();
    expect(screen.getByText('Enter a title.')).toBeTruthy();
    expect(screen.getByText('This address is reserved. Choose another.')).toBeTruthy();
    expect(screen.getByText('The end must be after the start.')).toBeTruthy();
    expect(screen.getByText('Use at most 70 characters.')).toBeTruthy();
    expect(screen.getByText('Check the marked fields and try again.')).toBeTruthy();
    expect(field('Page title').getAttribute('aria-invalid')).toBe('true');
    expect(puts()).toHaveLength(0);
  });

  it('wants a description with a share image', () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^Picture$/), { target: { value: 'egg' } });
    save();
    expect(screen.getByText('Describe the image.')).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('names an address another page already uses, and stops sending it again unchanged', async () => {
    route(refused('storefront.slug-taken'));
    mount();
    fireEvent.change(field('Address'), { target: { value: 'eid' } });
    save();
    await screen.findByText('Another page already uses this address.');
    expect(field('Address').getAttribute('aria-invalid')).toBe('true');
    save();
    expect(puts()).toHaveLength(1);
    fireEvent.change(field('Address'), { target: { value: 'eid-2' } });
    save();
    await waitFor(() => expect(puts()).toHaveLength(2));
  });

  it('marks the fields the API refused', async () => {
    route(
      refused('validation.failed', 400, [
        { path: 'seo.description', code: 'length' },
        { path: 'linked.id', code: 'format' },
      ]),
    );
    mount();
    fireEvent.change(field('Page title'), { target: { value: 'Eid' } });
    save();
    await screen.findByText('Use at most 160 characters.');
    expect(screen.getByText('Check the marked fields and try again.')).toBeTruthy();
  });

  it.each([
    ['storefront.page-locked', 409, /locked in the app/],
    ['storefront.page-archived', 409, /archived page cannot be changed/],
    ['access.denied', 403, /permission to change pages/],
    ['network', 0, /No connection/],
  ])('words the refusal %s above the form', async (code, status, words) => {
    route(refused(code, status));
    mount();
    fireEvent.change(field('Page title'), { target: { value: 'Eid' } });
    save();
    await screen.findByText(words);
    expect((field('Page title') as HTMLInputElement).value).toBe('Eid');
  });

  it('goes to the sign-in page when the session ended', async () => {
    route(refused('session.required', 401));
    mount();
    fireEvent.change(field('Page title'), { target: { value: 'Eid' } });
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('keeps a link to a product that this editor cannot change, and says so', async () => {
    route({ ok: true, status: 200, body: page() });
    mount(page({ linked: { type: 'product', id: 'p1' } }));
    expect(await screen.findByText(/Linked product: set elsewhere/)).toBeTruthy();
    fireEvent.change(field('Page title'), { target: { value: 'Eid' } });
    save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0]?.[2] as { linked: unknown }).linked).toEqual({ type: 'product', id: 'p1' });
  });

  it('offers no linked category for a template that links none, or without the category lookup', async () => {
    mount(page({ templateKey: 'info-page' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'storefront/admin/catalogue'));
    expect(screen.queryByLabelText('Linked category')).toBeNull();
    cleanup();
    route(undefined, false);
    mount();
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'catalog/admin/categories'));
    expect(screen.queryByLabelText('Linked category')).toBeNull();
  });

  it('is read-only without the edit key, on an archived page and on a locked page', () => {
    mount(page(), false);
    expect(screen.getByText(/view this page but not change it/)).toBeTruthy();
    expect(field('Page title').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    cleanup();
    mount(page({ status: 'archived' }));
    expect(field('Page title').matches(':disabled')).toBe(true);
    cleanup();
    mount(page({ editLevel: 'locked' }));
    expect(field('Page title').matches(':disabled')).toBe(true);
  });
});

describe('the Settings tab of a system page', () => {
  const system = () =>
    page({
      kind: 'system',
      id: null,
      systemKey: 'home',
      slug: null,
      path: '/',
      templateKey: 'system.home',
      title: 'Home',
      status: 'default',
      publishedVersionNo: null,
      publishedAt: null,
      linked: null,
    });

  it('has a title and SEO only, and saves by the system key', async () => {
    mount(system());
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByLabelText('Live from')).toBeNull();
    expect(screen.queryByLabelText('Linked category')).toBeNull();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(field('Page title'), { target: { value: 'Welcome' } });
    save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([
      'PUT',
      'storefront/admin/pages/home',
      { title: 'Welcome', seo: { title: 'Ramadan', description: 'Offers for Ramadan' } },
      'csrf-1',
    ]);
  });
});
