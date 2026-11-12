// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import type { PageSummary } from './page-types.ts';
import { PagesList } from './pages-list.tsx';

const call = vi.mocked(callApi);

const page = (patch: Partial<PageSummary>): PageSummary => ({
  id: null,
  kind: 'system',
  systemKey: 'home',
  slug: null,
  path: '/',
  templateKey: 'system.home',
  title: 'Home',
  editLevel: 'full',
  status: 'default',
  hasDraft: false,
  publishedVersionNo: null,
  publishedAt: null,
  updatedAt: null,
  ...patch,
});

const pages: PageSummary[] = [
  page({}),
  page({ systemKey: 'checkout', path: '/checkout', title: 'Checkout', editLevel: 'locked' }),
  page({
    id: 'p1',
    kind: 'dynamic',
    systemKey: null,
    slug: 'ramadan',
    path: '/l/ramadan',
    templateKey: 'campaign-landing',
    title: 'Ramadan specials',
    status: 'published',
    hasDraft: true,
    publishedVersionNo: 2,
    publishedAt: '2026-11-01T01:00:00Z',
  }),
  page({
    id: 'p2',
    kind: 'dynamic',
    systemKey: null,
    slug: 'eid',
    path: '/l/eid',
    templateKey: 'info-page',
    title: 'Eid hours',
    status: 'draft',
    hasDraft: true,
  }),
  page({ systemKey: 'navigation', title: 'Navigation', editLevel: 'navigation' }),
];

function mount(canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PagesList canEdit={canEdit} zone="Australia/Brisbane" />
    </NextIntlClientProvider>,
  );
}

const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('cell', { name: /./ }).textContent);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({ ok: true, status: 200, body: { pages } });
});
afterEach(cleanup);

describe('pages list', () => {
  it('reads the pages once and lists them without the navigation', async () => {
    mount();
    expect(screen.getByRole('status')).toBeTruthy();
    await screen.findByText('Ramadan specials');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('GET', 'storefront/admin/pages');
    expect(screen.queryByText('Navigation')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(5);
  });

  it('links a saved page by id and an unchanged system page by key', async () => {
    mount();
    expect(
      (await screen.findByRole('link', { name: 'Ramadan specials' })).getAttribute('href'),
    ).toBe('/content/pages/p1');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe(
      '/content/pages/home',
    );
  });

  it('shows the status, unpublished changes and the last publish in the Market zone', async () => {
    mount();
    const row = (await screen.findByText('Ramadan specials')).closest('tr')!;
    expect(within(row).getByText('Published')).toBeTruthy();
    expect(within(row).getByText('Unpublished changes')).toBeTruthy();
    expect(within(row).getByText('/l/ramadan')).toBeTruthy();
    expect(within(row).getByText(/1 Nov/)).toBeTruthy();
    const draft = screen.getByText('Eid hours').closest('tr')!;
    expect(within(draft).getByText('Draft')).toBeTruthy();
    expect(within(draft).queryByText('Unpublished changes')).toBeNull();
    expect(within(draft).getByText('Never published')).toBeTruthy();
    const system = screen.getByText('Home').closest('tr')!;
    expect(within(system).getByText('Template default')).toBeTruthy();
  });

  it('filters by type, status and title in the browser', async () => {
    mount();
    await screen.findByText('Ramadan specials');
    fireEvent.click(screen.getByRole('button', { name: 'Landing pages' }));
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.getByText('Eid hours')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    expect(screen.queryByText('Ramadan specials')).toBeNull();
    expect(screen.getByText('Eid hours')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search by title or address'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No page matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('Ramadan specials')).toBeTruthy());
    expect(call).toHaveBeenCalledTimes(1);
    void names;
  });

  it('says it is read-only without the edit key', async () => {
    mount(false);
    await screen.findByText('Ramadan specials');
    expect(screen.getByText(/view pages but not change them/)).toBeTruthy();
    cleanup();
    mount(true);
    await screen.findByText('Ramadan specials');
    expect(screen.queryByText(/view pages but not change them/)).toBeNull();
  });

  it('shows a load error with a retry', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 500, code: 'x' } });
    mount();
    await screen.findByText(/could not be loaded/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Ramadan specials');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('has an empty state without a second New page button (the header has the one)', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { pages: [] } });
    mount(true);
    await screen.findByText('No pages yet');
    expect(screen.queryByRole('link', { name: 'New page' })).toBeNull();
  });
});
