// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { callApi, type ApiResult } from '../../api/client.ts';
import type { CategoryRow, TreeBody } from '../types.ts';
import { CategoriesTabs } from './categories-tabs.tsx';
import { mergeTargets, pathText, problemOf, suggestSlug } from './model.ts';
import { ProposalsTab } from './proposals-tab.tsx';
import type { Proposal, Shelf } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

const row = (
  n: number,
  parent: number | null,
  depth: number,
  name: string,
  status: CategoryRow['status'] = 'active',
): CategoryRow => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug: `c-${n}`,
  status,
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  depth,
  position: 0,
  version: 1,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
});
const tree: TreeBody = {
  treeVersion: 7,
  defaultLocale: 'en',
  supportedLocales: ['en', 'fa'],
  requiredLocales: ['en'],
  complete: true,
  categories: [
    row(1, null, 0, 'Pantry'),
    row(2, 1, 1, 'Rice'),
    row(3, 1, 1, 'Old oils', 'archived'),
  ],
  actions: {},
};

const proposal = (n: number, over: Partial<Proposal> = {}): Proposal => ({
  id: id(100 + n),
  sellerId: id(200 + n),
  platformParentId: id(2),
  texts: [
    { locale: 'en', name: `Saffron ${n}`, description: null },
    { locale: 'fa', name: 'زعفران', description: 'بهترین زعفران' },
  ],
  status: 'pending',
  reasonCode: null,
  sellerCategoryId: null,
  decidedAt: null,
  createdAt: '2026-11-01T01:00:00.000Z',
  version: 3,
  storeName: `Store ${n}`,
  ...over,
});
const shelf = (n: number, over: Partial<Shelf> = {}): Shelf => ({
  id: id(300 + n),
  platformParentId: id(2),
  slug: `fresh-dates-${n}`,
  status: 'active',
  mergedIntoId: null,
  texts: [{ locale: 'en', name: `Fresh dates ${n}`, description: null }],
  version: 2,
  ...over,
});

let queue: Proposal[] = [];
let shelves: Shelf[] = [];
let writes: Array<{ path: string; body: unknown }> = [];
let writeAnswer: (path: string) => ApiResult<unknown> = () =>
  ok({ status: 'approved', version: 4 });

beforeEach(() => {
  queue = [proposal(1), proposal(2)];
  shelves = [shelf(1), shelf(2, { status: 'merged' })];
  writes = [];
  writeAnswer = () => ok({ status: 'approved', version: 4 });
  window.history.replaceState(null, '', '/');
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  call.mockReset();
  call.mockImplementation((method, path, body) => {
    if (method === 'POST') {
      writes.push({ path, body });
      return Promise.resolve(writeAnswer(path) as ApiResult<never>);
    }
    if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree) as ApiResult<never>);
    if (path.startsWith('catalog/admin/category-proposals')) {
      return Promise.resolve(ok({ items: queue, nextAfterId: null }) as ApiResult<never>);
    }
    if (path.includes('/shelves')) return Promise.resolve(ok({ shelves }) as ApiResult<never>);
    return Promise.resolve(fail(404, 'x'));
  });
});
afterEach(cleanup);

const view = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
const tab = (canPromote = true) => view(<ProposalsTab csrfToken="tok" canPromote={canPromote} />);

describe('proposal model', () => {
  it('builds the parent path, merge targets (live only) and a URL name from English letters', () => {
    expect(pathText(tree.categories, id(2), 'en')).toBe('Pantry › Rice');
    expect(mergeTargets(tree.categories, 'en').map((o) => o.label)).toEqual([
      'Pantry',
      'Pantry › Rice',
    ]);
    expect(suggestSlug([{ locale: 'en-AU', name: 'Fresh Dates & Figs!', description: null }])).toBe(
      'fresh-dates-figs',
    );
    expect(suggestSlug([{ locale: 'fa', name: 'زعفران', description: null }])).toBe('');
  });

  it('maps codes to message keys, with the stale ones asking for a reload', () => {
    expect(problemOf({ status: 409, code: 'conflict.stale' })).toEqual({
      key: 'conflict_stale',
      reload: true,
    });
    expect(
      problemOf({ status: 422, code: 'category.depth-exceeded', details: { max: 4 } }),
    ).toEqual({
      key: 'category_depth-exceeded',
      reload: false,
      max: 4,
    });
    expect(problemOf({ status: 418, code: 'weird' }).key).toBe('unknown');
    expect(problemOf({ status: 503, code: 'weird' }).key).toBe('access_unavailable');
  });
});

describe('Category proposals queue', () => {
  it('lists store, parent path, names per locale (Persian right to left) and the time', async () => {
    tab();
    const list = await screen.findByRole('list', { name: 'Waiting category proposals' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('Store 1')).toBeTruthy();
    expect(within(first).getByText(/Under Pantry › Rice/)).toBeTruthy();
    expect(within(first).getByText('Saffron 1')).toBeTruthy();
    const persian = within(first).getByText('زعفران');
    expect(persian.getAttribute('dir')).toBe('rtl');
    expect(persian.getAttribute('lang')).toBe('fa');
    expect(within(first).getByText('Waiting')).toBeTruthy();
    expect(within(first).getByText(/2026/)).toBeTruthy();
  });

  it('shows an empty state and a retry on a failed load', async () => {
    queue = [];
    tab();
    expect(await screen.findByText('No proposals are waiting')).toBeTruthy();
    cleanup();
    call.mockReset();
    call.mockResolvedValue(fail(500, 'x'));
    tab();
    expect(await screen.findByText('The category proposals could not be loaded.')).toBeTruthy();
  });

  it('approves with the version read and shows the outcome in place', async () => {
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the proposal Saffron 1' }));
    await screen.findByText('Approved: shelf created');
    expect(writes).toEqual([
      { path: `catalog/admin/category-proposals/${id(101)}/approve`, body: { version: 3 } },
    ]);
    expect(screen.queryByRole('button', { name: 'Approve the proposal Saffron 1' })).toBeNull();
    // The other row is untouched.
    expect(screen.getByRole('button', { name: 'Approve the proposal Saffron 2' })).toBeTruthy();
  });

  it('rejects only with one of the prepared reasons', async () => {
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject the proposal Saffron 1' }));
    const select = screen.getByLabelText<HTMLSelectElement>('Reason');
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'already-exists',
      'too-narrow',
      'too-broad',
      'misleading',
      'not-sold-here',
      'other',
    ]);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Reject proposal' }).disabled,
    ).toBe(true);
    fireEvent.change(select, { target: { value: 'too-narrow' } });
    writeAnswer = () => ok({ status: 'rejected', version: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }));
    await screen.findByText('Rejected: Too narrow');
    expect(writes).toEqual([
      {
        path: `catalog/admin/category-proposals/${id(101)}/reject`,
        body: { version: 3, reasonCode: 'too-narrow' },
      },
    ]);
  });

  it('shows "Closed: permission removed" for a proposal the seller lost the right to make', async () => {
    queue = [proposal(1, { status: 'cancelled', reasonCode: 'permission-revoked' })];
    tab();
    expect(await screen.findByText('Closed: permission removed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('shows the same words when the approve answer says the proposal was cancelled', async () => {
    writeAnswer = () => ok({ status: 'cancelled', version: 4 });
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the proposal Saffron 1' }));
    expect(await screen.findByText('Closed: permission removed')).toBeTruthy();
  });

  it('says a refused approve and reads the queue again when it was decided elsewhere', async () => {
    writeAnswer = () => fail(409, 'category-proposal.not-pending');
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the proposal Saffron 1' }));
    await waitFor(() =>
      expect(
        screen.getAllByText('Someone else changed the queue. The list has been refreshed.').length,
      ).toBeGreaterThan(0),
    );
  });

  it('says why a seller without the permission cannot be approved', async () => {
    writeAnswer = () => fail(403, 'category-proposal.not-allowed');
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the proposal Saffron 1' }));
    expect(
      await screen.findByText(
        "This seller may not propose categories any more, so the proposal can't be approved.",
      ),
    ).toBeTruthy();
  });
});

describe('Seller shelves: promote and merge', () => {
  async function openShelves() {
    tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Show the shelves of Store 1' }));
    return screen.findByRole('list', { name: 'Shelves of Store 1' });
  }

  it('lists the shelves, with Promote and Merge on active ones only', async () => {
    const list = await openShelves();
    const items = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.closest('ul') === list);
    expect(
      within(items[0]!).getByRole('button', { name: 'Promote the shelf Fresh dates 1' }),
    ).toBeTruthy();
    expect(within(items[1]!).queryByRole('button', { name: /^Promote/ })).toBeNull();
    expect(within(items[1]!).getByText('Merged')).toBeTruthy();
  });

  it('hides Promote and Merge without the promote-merge key', async () => {
    tab(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the shelves of Store 1' }));
    await screen.findByRole('list', { name: 'Shelves of Store 1' });
    expect(screen.queryByRole('button', { name: /^Promote the shelf/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Merge the shelf/ })).toBeNull();
  });

  it('promotes with the tree version, says the new category is hidden, and reports the Offers', async () => {
    await openShelves();
    fireEvent.click(screen.getByRole('button', { name: 'Promote the shelf Fresh dates 1' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/^Shelves are not platform categories\./)).toBeTruthy();
    expect(within(dialog).getByText(/created hidden/)).toBeTruthy();
    expect(within(dialog).getByText(/loses the shelf/)).toBeTruthy();
    const slug = within(dialog).getByLabelText<HTMLInputElement>('URL name');
    expect(slug.value).toBe('fresh-dates-1');
    fireEvent.change(slug, { target: { value: 'Bad Slug' } });
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Promote shelf' }).disabled,
    ).toBe(true);
    fireEvent.change(slug, { target: { value: 'bad--slug' } });
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Promote shelf' }).disabled,
    ).toBe(true);
    fireEvent.change(slug, { target: { value: 'fresh-dates' } });
    writeAnswer = () =>
      ok({
        categoryId: id(301),
        slug: 'fresh-dates',
        status: 'hidden',
        treeVersion: 8,
        offersCleared: 5,
      });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote shelf' }));
    expect(
      await screen.findByText('Promoted as a hidden platform category. 5 Offers lost the shelf.'),
    ).toBeTruthy();
    expect(writes).toEqual([
      {
        path: `catalog/admin/shelves/${id(301)}/promote`,
        body: { version: 2, slug: 'fresh-dates', treeVersion: 7 },
      },
    ]);
  });

  it('keeps a refused promote open with its reason and a Reload button for a stale tree', async () => {
    await openShelves();
    fireEvent.click(screen.getByRole('button', { name: 'Promote the shelf Fresh dates 1' }));
    writeAnswer = () => fail(409, 'conflict.stale');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote shelf' }));
    expect(
      await within(dialog).findByText('The tree or the shelf changed since you opened it. Reload.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('merges into a live platform category with the copy of FP8', async () => {
    await openShelves();
    fireEvent.click(screen.getByRole('button', { name: 'Merge the shelf Fresh dates 1' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        "Shelves are not platform categories. The seller's offers keep no shelf. You can add this category to the products through a revision.",
      ),
    ).toBeTruthy();
    const target = within(dialog).getByLabelText<HTMLSelectElement>('Merge into');
    expect([...target.options].map((o) => o.textContent)).toEqual([
      'Choose a platform category',
      'Pantry',
      'Pantry › Rice',
    ]);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Merge shelf' }).disabled,
    ).toBe(true);
    fireEvent.change(target, { target: { value: id(2) } });
    writeAnswer = () => ok({ status: 'merged', mergedIntoId: id(2), offersCleared: 1 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge shelf' }));
    expect(await screen.findByText('Merged. 1 Offer lost the shelf.')).toBeTruthy();
    expect(writes).toEqual([
      {
        path: `catalog/admin/shelves/${id(301)}/merge`,
        body: { version: 2, categoryId: id(2) },
      },
    ]);
  });
});

describe('Categories page tabs', () => {
  it('shows the tab only to an admin who may decide, and opens a seller from the address', async () => {
    const props = { canEdit: false, csrfToken: 'tok', canPromote: true };
    view(<CategoriesTabs {...props} canDecide={false} />);
    expect(screen.queryByRole('button', { name: 'Category proposals' })).toBeNull();
    cleanup();
    window.history.replaceState(null, '', `/catalog/categories?tab=proposals&seller=${id(201)}`);
    view(<CategoriesTabs {...props} canDecide />);
    expect(await screen.findByRole('heading', { name: 'Shelves of this seller' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Category proposals' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Category tree' }));
    expect(window.location.search).toBe('');
  });
});
