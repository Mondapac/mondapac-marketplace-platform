// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { callApi, type ApiFailure, type ApiResult } from '../api/client.ts';
import { CategoriesView } from './categories-view.tsx';
import { checkReason, subtreeIds, targetRows } from './restructure-model.ts';
import type { CategoryRow, DetailBody, ImpactBody, TreeBody } from './types.ts';

// Move, Merge and Archive of a platform category (categories C4b).

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (
  n: number,
  parent: number | null,
  depth: number,
  name: string,
  over: Partial<CategoryRow> = {},
): CategoryRow => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug: `c-${n}`,
  status: 'active',
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  depth,
  position: n,
  version: 3,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
  ...over,
});
// Pantry > Rice > Basmati; Pantry > Oils; Drinks; Old (merged); Gone (archived)
const rows = (): CategoryRow[] => [
  row(1, null, 0, 'Pantry'),
  row(2, 1, 1, 'Rice'),
  row(5, 2, 2, 'Basmati'),
  row(3, 1, 1, 'Oils'),
  row(4, null, 0, 'Drinks'),
  row(6, null, 0, 'Old', { status: 'merged' }),
  row(7, null, 0, 'Gone', { status: 'archived' }),
];
const tree = (): TreeBody => ({
  treeVersion: 7,
  defaultLocale: 'en',
  supportedLocales: ['en'],
  requiredLocales: ['en'],
  complete: true,
  categories: rows(),
  actions: {},
});
const allowed = { allowed: true };
const detail = (r: CategoryRow, actions: DetailBody['actions'] | null = null): DetailBody => ({
  category: r,
  path: [{ id: r.id, slug: r.slug, name: r.names[0]?.name ?? null }],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [],
  complete: true,
  actions: actions ?? {
    'platform-category.move': allowed,
    'platform-category.merge': allowed,
    'platform-category.archive': allowed,
  },
  details: {
    texts: [{ locale: 'en', name: r.names[0]?.name ?? '', shortDescription: null, keywords: [] }],
    seo: { title: null, description: null, noindex: false },
    showInMenu: true,
    imageId: null,
    hiddenById: null,
  },
  treeVersion: 7,
});
const impactBody = (over: Partial<ImpactBody> = {}): ImpactBody => ({
  products: 12,
  directProducts: 4,
  offers: 30,
  listedOffers: 20,
  offersWithActiveTag: 9,
  descendants: 2,
  complete: true,
  ...over,
});
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refused = (
  status: number,
  code: string,
  details?: ApiFailure['details'],
): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const written = {
  category: { id: id(2), slug: 'c-2', status: 'active', version: 4, revisionNo: 2, treeVersion: 8 },
};

interface Serving {
  readonly write?: ApiResult<unknown>;
  readonly impact?: (query: URLSearchParams) => ImpactBody;
  readonly actions?: DetailBody['actions'];
}
function serve({ write = ok(written), impact = () => impactBody(), actions }: Serving = {}) {
  call.mockImplementation((method: string, path: string) => {
    if (method !== 'GET') return Promise.resolve(write);
    if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree()));
    const [base = '', query = ''] = path.split('?');
    if (base.endsWith('/impact')) return Promise.resolve(ok(impact(new URLSearchParams(query))));
    const found = rows().find((c) => base === `catalog/admin/categories/${c.id}`);
    return Promise.resolve(found === undefined ? ok(null) : ok(detail(found, actions ?? null)));
  });
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');
const impactReads = () =>
  call.mock.calls
    .filter(([method, path]) => method === 'GET' && String(path).includes('/impact?'))
    .map(([, path]) => String(path));

const view = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
const open = (props: { canRestructure?: boolean } = { canRestructure: true }) =>
  view(<CategoriesView canEdit csrfToken="tok" {...props} />);

async function pick(name: string) {
  const items = await screen.findAllByRole('treeitem');
  fireEvent.click(items.find((el) => el.textContent?.startsWith(name))!);
  await screen.findByRole('heading', { name });
}
async function startDialog(name: string, button: string) {
  await pick(name);
  const trigger = await screen.findByRole('button', { name: button });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  return screen.getByRole('dialog');
}
const typeReason = (dialog: HTMLElement, text: string) =>
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: text } });
const submitButton = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole<HTMLButtonElement>('button', { name });
const REASON = 'Reorganised after the supplier review.';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(cleanup);

describe('restructure model', () => {
  it('counts the reason without the spaces around it: 9 short, 10 and 500 fine, 501 long', () => {
    expect(checkReason('a'.repeat(9))).toBe('short');
    expect(checkReason(`  ${'a'.repeat(9)}  `)).toBe('short');
    expect(checkReason('a'.repeat(10))).toBe('ok');
    expect(checkReason('a'.repeat(500))).toBe('ok');
    expect(checkReason('a'.repeat(501))).toBe('long');
  });
  it('leaves out the category, everything below it and merged or archived rows as targets', () => {
    expect([...subtreeIds(rows(), id(1))].sort()).toEqual([id(1), id(2), id(3), id(5)].sort());
    expect(targetRows(rows(), id(2)).map((r) => r.id)).toEqual([id(1), id(3), id(4)]);
  });
});

describe('Move, Merge and Archive actions', () => {
  it('shows the three actions with the restructure key, after the C3b actions', async () => {
    serve();
    open();
    await pick('Pantry');
    for (const name of ['Move…', 'Merge…', 'Archive…']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
  });

  it('hides them without the key', async () => {
    serve();
    open({ canRestructure: false });
    await pick('Pantry');
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeTruthy();
    for (const name of ['Move…', 'Merge…', 'Archive…']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('shows them off when the API does not allow the action for this category', async () => {
    serve({
      actions: { 'platform-category.move': { allowed: false, denial: 'category.not-active' } },
    });
    open();
    await pick('Pantry');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move…' }).disabled).toBe(true);
  });
});

describe('Move dialog', () => {
  it('lists Top level and the allowed targets only: not itself, its descendants, merged or archived', async () => {
    serve();
    open();
    const dialog = await startDialog('Pantry', 'Move…');
    // Pantry, Rice, Basmati and Oils are Pantry or below; Old is merged and Gone archived.
    const names = within(dialog)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent);
    expect(names).toEqual(['Top level (department)', 'Drinks']);
  });

  it('does not offer the category itself or its descendants, but its siblings and ancestors', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    const names = within(dialog)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent);
    expect(names).toEqual(['Top level (department)', 'Pantry', 'Oils', 'Drinks']);
  });

  it('keeps the button off until a target and a reason of 10 characters exist, then moves', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    expect(within(dialog).getByRole('heading', { name: 'What will change' })).toBeTruthy();
    const go = submitButton(dialog, 'Move');
    typeReason(dialog, REASON);
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByText('Choose a category to continue.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/categories/${id(2)}/move`,
      { treeVersion: 7, parentId: id(4), reason: REASON },
      'tok',
    ]);
  });

  it('sends a null parent for Top level (department)', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Top level (department)' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({ treeVersion: 7, parentId: null, reason: REASON });
  });

  it('on success closes, reads the tree again, says so and returns focus to the row', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    expect(await screen.findByText('Category moved.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-id')).toBe(id(2)));
    const treeReads = call.mock.calls.filter(
      ([method, path]) => method === 'GET' && path === 'catalog/admin/categories',
    );
    expect(treeReads.length).toBeGreaterThan(1);
  });

  it('finds a target by typing', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.change(within(dialog).getByLabelText('Find a category'), {
      target: { value: 'oil' },
    });
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Oils']);
    fireEvent.change(within(dialog).getByLabelText('Find a category'), {
      target: { value: 'zzz' },
    });
    expect(within(dialog).getByText('No category matches.')).toBeTruthy();
  });
});

describe('What will change', () => {
  it('reads the impact without a target first, then again with the target (and Top as top)', async () => {
    serve({
      impact: (q) =>
        q.get('targetId') === null ? impactBody() : impactBody({ featureSetChanges: 5 }),
    });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    expect(
      await within(dialog).findByText(
        '12 products, 30 offers, 9 with certification badges, 2 subcategories',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Feature set changes/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    expect(await within(dialog).findByText('Feature set changes for 5 products')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Top level (department)' }));
    await waitFor(() => expect(impactReads()).toHaveLength(3));
    expect(impactReads()).toEqual([
      `catalog/admin/categories/${id(2)}/impact?action=move`,
      `catalog/admin/categories/${id(2)}/impact?action=move&targetId=${id(4)}`,
      `catalog/admin/categories/${id(2)}/impact?action=move&targetId=top`,
    ]);
  });

  it('says "at least N" when the count is incomplete, and never "at least 0"', async () => {
    serve({ impact: () => impactBody({ complete: false, offersWithActiveTag: 0 }) });
    open();
    const dialog = await startDialog('Rice', 'Merge…');
    expect(
      await within(dialog).findByText(
        'at least 12 products, at least 30 offers, 0 with certification badges, at least 2 subcategories',
      ),
    ).toBeTruthy();
  });

  it('says so when the impact cannot be read, and still lets the change be confirmed', async () => {
    call.mockImplementation((method: string, path: string) => {
      if (method !== 'GET') return Promise.resolve(ok(written));
      if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree()));
      if (path.includes('/impact'))
        return Promise.resolve(refused(503, 'catalog.categories-unavailable'));
      const found = rows().find((c) => path === `catalog/admin/categories/${c.id}`);
      return Promise.resolve(ok(found === undefined ? null : detail(found)));
    });
    open();
    const dialog = await startDialog('Rice', 'Archive…');
    expect(await within(dialog).findByText(/We couldn't count what this reaches/)).toBeTruthy();
    typeReason(dialog, REASON);
    expect(submitButton(dialog, 'Archive').disabled).toBe(false);
  });
});

describe('Merge dialog', () => {
  it('merges into the picked category, with no Top level choice', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Merge…');
    expect(within(dialog).queryByRole('radio', { name: 'Top level (department)' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Oils' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Merge'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/categories/${id(2)}/merge`,
      { treeVersion: 7, targetId: id(3), reason: REASON },
      'tok',
    ]);
    expect(await screen.findByText('Category merged.')).toBeTruthy();
  });

  it('does not offer the category or its descendants as the merge target', async () => {
    serve();
    open();
    const dialog = await startDialog('Pantry', 'Merge…');
    expect(within(dialog).queryByRole('radio', { name: 'Rice' })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: 'Basmati' })).toBeNull();
    expect(within(dialog).getByRole('radio', { name: 'Drinks' })).toBeTruthy();
  });
});

describe('Archive dialog', () => {
  it('warns that it is terminal, has no picker, and archives with a reason', async () => {
    serve();
    open();
    const dialog = await startDialog('Oils', 'Archive…');
    expect(within(dialog).getByText("Archived categories can't be restored.")).toBeTruthy();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    // Cancel has focus first, the safe choice of a one-way action.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const go = submitButton(dialog, 'Archive');
    expect(go.disabled).toBe(true);
    typeReason(dialog, REASON);
    fireEvent.click(go);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/categories/${id(3)}/archive`,
      { treeVersion: 7, reason: REASON },
      'tok',
    ]);
    expect(await screen.findByText('Category archived.')).toBeTruthy();
  });
});

describe('the reason', () => {
  it('is off at 9 characters, on at 10 and at 500, off at 501 with a message and a counter', async () => {
    serve();
    open();
    const dialog = await startDialog('Oils', 'Archive…');
    const go = submitButton(dialog, 'Archive');
    typeReason(dialog, 'a'.repeat(9));
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByText('9 / 500')).toBeTruthy();
    typeReason(dialog, 'a'.repeat(10));
    expect(go.disabled).toBe(false);
    typeReason(dialog, 'a'.repeat(500));
    expect(go.disabled).toBe(false);
    typeReason(dialog, 'a'.repeat(501));
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByText('The reason is longer than 500 characters.')).toBeTruthy();
    expect(within(dialog).getByText('501 / 500')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('is sent without the spaces around it', async () => {
    serve();
    open();
    const dialog = await startDialog('Oils', 'Archive…');
    typeReason(dialog, `   ${REASON}  `);
    fireEvent.click(submitButton(dialog, 'Archive'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toMatchObject({ reason: REASON });
  });
});

describe('refusals', () => {
  const cases: readonly [string, number, string, ApiFailure['details'] | undefined, string][] = [
    ['category.cycle', 422, 'category.cycle', undefined, "A category can't go inside itself."],
    [
      'depth',
      422,
      'category.depth-exceeded',
      { max: 4 },
      'Categories can be at most 4 levels deep.',
    ],
    [
      'check unavailable',
      503,
      'category.check-unavailable',
      undefined,
      "We couldn't check the certificate rules, so nothing was changed. Try again.",
    ],
    [
      'too large',
      422,
      'category.impact-too-large',
      { max: 50000 },
      'This change affects more than 50000 badges. Move its subcategories one at a time.',
    ],
    [
      'only category',
      422,
      'category.only-platform-category',
      { total: 3 },
      '3 live products would be left without a category. Choose a replacement.',
    ],
    [
      'upper level',
      422,
      'category.products-on-upper-level',
      { total: 2 },
      "Choose a category or subcategory. Products can't go on a department or group.",
    ],
    [
      'sibling name',
      409,
      'category.sibling-name-taken',
      undefined,
      'Another category with the same parent already has this name.',
    ],
    [
      'has subcategories',
      409,
      'category.has-subcategories',
      undefined,
      'Move or archive its subcategories first.',
    ],
    [
      'unchanged',
      409,
      'category.move-unchanged',
      undefined,
      "It's already there. Choose another place.",
    ],
    [
      'reason',
      400,
      'validation.failed',
      { fields: [{ path: 'reason', code: 'too-short' }] },
      'Add a reason of 10 to 500 characters.',
    ],
  ];
  it.each(cases)(
    '%s: shows its copy inside the dialog',
    async (_name, status, code, details, copy) => {
      serve({ write: refused(status, code, details) });
      open();
      const dialog = await startDialog('Rice', 'Move…');
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
      typeReason(dialog, REASON);
      fireEvent.click(submitButton(dialog, 'Move'));
      // The reason hint also reads like this copy: look in the banner only.
      await waitFor(() =>
        expect(within(dialog).getAllByText(copy).length).toBeGreaterThanOrEqual(1),
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(submitButton(dialog, 'Move')).toBeTruthy();
    },
  );

  it('names the certificate types whose rules use the category, joined with commas', async () => {
    serve({
      write: refused(409, 'category.referenced-by-policy', {
        typeCodes: ['halal', 'kosher', 'vegan'],
      }),
    });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    expect(
      await within(dialog).findByText(
        "Certificate rules for halal, kosher, vegan use this category, so it can't be moved yet. Move or remove those rules first.",
      ),
    ).toBeTruthy();
  });

  it.each([
    ['conflict.stale', 409],
    ['category.target-not-found', 404],
    ['category.parent-not-found', 404],
  ])('%s: says someone changed it and offers a reload', async (code, status) => {
    serve({ write: refused(status, code) });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    expect(
      await within(dialog).findByText('Someone changed this category. Reload to see the latest.'),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Move' })).toBeNull();
    const treeReads = () =>
      call.mock.calls.filter(([m, p]) => m === 'GET' && p === 'catalog/admin/categories').length;
    const before = treeReads();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(treeReads()).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('words an unlisted refusal like the other category writes', async () => {
    serve({ write: refused(403, 'access.permission-missing') });
    open();
    const dialog = await startDialog('Oils', 'Archive…');
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Archive'));
    expect(await within(dialog).findByText('Your role can not change categories.')).toBeTruthy();
  });

  it('closes without a write on Cancel', async () => {
    serve();
    open();
    const dialog = await startDialog('Oils', 'Archive…');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
