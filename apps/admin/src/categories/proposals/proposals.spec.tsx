// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi, type ApiResult } from '../../api/client.ts';
import { expectToast } from '../../../test/toast-spy.ts';
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
  featureSetId: null,
  featureSetCode: null,
  featureSetFromCategoryId: null,
  inherited: false,
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
      return Promise.resolve(
        ok({
          items: queue.map((item) => ({ ...item, actions: ['approve', 'reject'] })),
          nextAfterId: null,
          total: queue.length,
          page: 1,
          pageSize: 25,
          paging: 'pages',
          hasNext: false,
        }) as ApiResult<never>,
      );
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
const where = { paging: 'pages', accountId: id(99), marketId: 'AU' } as const;
const tab = (canPromote = true) =>
  view(<ProposalsTab csrfToken="tok" canPromote={canPromote} {...where} />);
/** Opens the row's Actions menu and picks an item: no row action is a button in the row. */
async function act(name: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

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

describe('Category proposals list', () => {
  it('lists store, parent path, names per locale (Persian right to left) and the time', async () => {
    tab();
    const list = await screen.findByRole('list', { name: 'Names of the proposal Saffron 1' });
    expect(within(list).getByText('Saffron 1')).toBeTruthy();
    const persian = within(list).getAllByText('زعفران')[0]!;
    expect(persian.getAttribute('dir')).toBe('rtl');
    expect(persian.getAttribute('lang')).toBe('fa');
    expect(screen.getAllByText('Store 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pantry › Rice').length).toBeGreaterThan(0);
    const first = new URLSearchParams(
      call.mock.calls
        .find(([, path]) => path.startsWith('catalog/admin/category-proposals'))?.[1]
        .split('?')[1],
    );
    expect(first.get('page')).toBe('1');
    expect(first.get('sort')).toBe('created');
    expect(first.get('direction')).toBe('asc');
  });

  it('shows an empty state and a failed load', async () => {
    queue = [];
    tab();
    expect(await screen.findByText('No proposals are waiting')).toBeTruthy();
    cleanup();
    call.mockReset();
    call.mockResolvedValue(fail(500, 'x'));
    tab();
    expect(await screen.findByText('The category proposals could not be loaded.')).toBeTruthy();
  });

  it('has no button in a row: every decision and the shelves are in the Actions menu', async () => {
    tab();
    await screen.findByText('Store 1');
    expect(screen.queryByRole('button', { name: /^(Approve|Reject|Show)/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Saffron 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Approve…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reject…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Seller’s shelves…' })).toBeTruthy();
  });

  it('approves after a confirmation, with the version read', async () => {
    tab();
    await act('Saffron 1', 'Approve…');
    const dialog = await screen.findByRole('dialog', { name: 'Approve “Saffron 1”?' });
    expect(writes).toHaveLength(0);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve proposal' }));
    await expectToast('Approved. The seller now has the shelf.');
    expect(writes).toEqual([
      { path: `catalog/admin/category-proposals/${id(101)}/approve`, body: { version: 3 } },
    ]);
  });

  it('rejects only with one of the prepared reasons', async () => {
    tab();
    await act('Saffron 1', 'Reject…');
    const dialog = await screen.findByRole('dialog', { name: 'Reject “Saffron 1”?' });
    const select = within(dialog).getByLabelText<HTMLSelectElement>('Reason');
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'already-exists',
      'too-narrow',
      'too-broad',
      'misleading',
      'not-sold-here',
      'other',
    ]);
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject proposal',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'too-narrow' } });
    writeAnswer = () => ok({ status: 'rejected', version: 4 });
    fireEvent.click(confirm);
    await expectToast('Proposal rejected.');
    expect(writes).toEqual([
      {
        path: `catalog/admin/category-proposals/${id(101)}/reject`,
        body: { version: 3, reasonCode: 'too-narrow' },
      },
    ]);
  });

  it('tells the seller lost the right when the approve answer says the proposal was cancelled', async () => {
    writeAnswer = () => ok({ status: 'cancelled', version: 4 });
    tab();
    await act('Saffron 1', 'Approve…');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve proposal' }));
    await expectToast('The seller can no longer propose categories, so the proposal was closed.');
  });

  it('closes the dialog and says so when the proposal was decided elsewhere', async () => {
    writeAnswer = () => fail(409, 'category-proposal.not-pending');
    tab();
    await act('Saffron 1', 'Approve…');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve proposal' }));
    await expectToast(
      'Someone else already decided this proposal. The list has been refreshed.',
      'error',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says why a seller without the permission cannot be approved, and keeps the dialog', async () => {
    writeAnswer = () => fail(403, 'category-proposal.not-allowed');
    tab();
    await act('Saffron 1', 'Approve…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve proposal' }));
    expect(
      await within(dialog).findByText(
        "This seller may not propose categories any more, so the proposal can't be approved.",
      ),
    ).toBeTruthy();
  });

  it('approves the ticked rows together, names how many, and reports the skipped ones', async () => {
    writeAnswer = (path) =>
      path.endsWith('bulk-decide')
        ? ok({
            action: 'approve',
            counts: { done: 1, skipped: 1, failed: 0 },
            results: [],
          })
        : ok({ status: 'approved', version: 4 });
    tab();
    await screen.findByText('Store 1');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bulk action' }).disabled).toBe(
      true,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Saffron 1' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Saffron 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 2 proposals?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 2 proposals' }));
    expect(await within(dialog).findByText('1 row decided, 1 skipped.')).toBeTruthy();
    expect(writes).toEqual([
      {
        path: 'catalog/admin/category-proposals/bulk-decide',
        body: {
          action: 'approve',
          items: [
            { id: id(101), version: 3 },
            { id: id(102), version: 3 },
          ],
        },
      },
    ]);
  });

  it('rejects the ticked rows with one prepared reason code', async () => {
    writeAnswer = () =>
      ok({ action: 'reject', counts: { done: 1, skipped: 0, failed: 0 }, results: [] });
    tab();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Saffron 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reject ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 1 proposal?' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject 1 proposal',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'too-broad' } });
    fireEvent.click(confirm);
    await within(dialog).findByText('1 row decided, 0 skipped.');
    expect(writes[0]?.body).toEqual({
      action: 'reject',
      items: [{ id: id(101), version: 3 }],
      reasonCode: 'too-broad',
    });
  });
});

describe('Seller shelves: promote and merge', () => {
  async function openShelves() {
    tab();
    await act('Saffron 1', 'Seller’s shelves…');
    return screen.findByRole('list', { name: 'Shelves of Store 1' });
  }

  it('lists the shelves, with Promote and Merge on active ones only', async () => {
    const list = await openShelves();
    const items = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.closest('ul') === list);
    fireEvent.click(
      within(items[0]!).getByRole('button', { name: 'Actions for the shelf Fresh dates 1' }),
    );
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Promote…',
      'Merge…',
    ]);
    expect(within(items[1]!).queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(within(items[1]!).getByText('Merged')).toBeTruthy();
  });

  it('hides Promote and Merge without the promote-merge key', async () => {
    tab(false);
    await act('Saffron 1', 'Seller’s shelves…');
    await screen.findByRole('list', { name: 'Shelves of Store 1' });
    expect(screen.queryByRole('button', { name: /^Actions for the shelf/ })).toBeNull();
  });

  it('promotes with the tree version, says the new category is hidden, and reports the Offers', async () => {
    await openShelves();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for the shelf Fresh dates 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Promote…' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Actions for the shelf Fresh dates 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Promote…' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Actions for the shelf Fresh dates 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Merge…' }));
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
    // Merging cannot be undone: the button stays off until the shelf's name is typed.
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Merge shelf' }).disabled,
    ).toBe(true);
    const typed = within(dialog).getByLabelText('Type the shelf name to confirm');
    fireEvent.change(typed, { target: { value: 'Fresh dates' } });
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Merge shelf' }).disabled,
    ).toBe(true);
    fireEvent.change(typed, { target: { value: 'Fresh dates 1' } });
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
    const props = { canEdit: false, csrfToken: 'tok', canPromote: true, ...where };
    view(<CategoriesTabs {...props} canDecide={false} />);
    expect(screen.queryByRole('button', { name: 'Category proposals' })).toBeNull();
    cleanup();
    window.history.replaceState(null, '', `/catalog/categories?tab=proposals&seller=${id(201)}`);
    view(<CategoriesTabs {...props} canDecide />);
    expect(await screen.findByRole('heading', { name: 'Shelves of this seller' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Category tree' }));
    expect(window.location.search).toBe('');
  });
});
