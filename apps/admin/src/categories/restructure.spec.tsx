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
  featureSetId: null,
  featureSetCode: null,
  featureSetFromCategoryId: null,
  inherited: false,
  ...over,
});
// A test may add rows (a hidden category) after the default ones.
let extraRows: CategoryRow[] = [];
// Pantry > Rice > Basmati; Pantry > Oils; Drinks; Old (merged); Gone (archived)
const rows = (): CategoryRow[] => [
  row(1, null, 0, 'Pantry'),
  row(2, 1, 1, 'Rice'),
  row(5, 2, 2, 'Basmati'),
  row(3, 1, 1, 'Oils'),
  row(4, null, 0, 'Drinks'),
  row(6, null, 0, 'Old', { status: 'merged' }),
  row(7, null, 0, 'Gone', { status: 'archived' }),
  ...extraRows,
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
  extraRows = [];
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('why an action is off, and hidden categories', () => {
  it.each([
    ['access.acting-as-refused', 'Not available while acting as a seller.'],
    ['category.not-active', 'Only live categories can be moved, merged or archived.'],
  ])('%s: gives the reason as a description of the off buttons', async (denial, copy) => {
    serve({
      actions: {
        'platform-category.move': { allowed: false, denial },
        'platform-category.merge': { allowed: false, denial },
        'platform-category.archive': { allowed: false, denial },
      },
    });
    open();
    await pick('Pantry');
    const reason = await screen.findByText(copy);
    for (const name of ['Move…', 'Merge…', 'Archive…']) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBe(reason.id);
    }
  });

  it('gives no reason line for a missing permission or when the actions are on', async () => {
    serve({
      actions: {
        'platform-category.move': { allowed: false, denial: 'access.permission-missing' },
      },
    });
    open();
    await pick('Pantry');
    expect(screen.queryByText(/Not available while acting|Only live categories/)).toBeNull();
    expect(
      screen
        .getByRole<HTMLButtonElement>('button', { name: 'Move…' })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('turns the buttons on for a hidden category from the action map alone', async () => {
    extraRows = [row(8, null, 0, 'Seasonal', { status: 'hidden' })];
    serve();
    open();
    await pick('Seasonal');
    for (const name of ['Move…', 'Merge…', 'Archive…']) {
      await waitFor(() =>
        expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false),
      );
    }
    fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: 'Archive Seasonal' }),
    ).toBeTruthy();
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

  it('marks a hidden category as Hidden in the picker', async () => {
    extraRows = [row(8, null, 0, 'Seasonal', { status: 'hidden' })];
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    const label = within(dialog)
      .getByRole('radio', { name: /Seasonal/ })
      .closest('label')!;
    expect(label.textContent).toBe('SeasonalHidden');
    const plain = within(dialog).getByRole('radio', { name: 'Drinks' }).closest('label')!;
    expect(within(plain).queryByText('Hidden')).toBeNull();
  });

  it('keeps the chosen target in the list while a search would hide it', async () => {
    serve();
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    fireEvent.change(within(dialog).getByLabelText('Find a category'), {
      target: { value: 'oil' },
    });
    const radios = within(dialog).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual(['Oils', 'Drinks']);
    expect(radios[1]!.checked).toBe(true);
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

describe('What will change: races and a rejected session', () => {
  it('shows the answer of the latest target when an earlier one arrives after it', async () => {
    let releaseDrinks: (value: ApiResult<unknown>) => void = () => {};
    const slow = new Promise<ApiResult<unknown>>((resolve) => {
      releaseDrinks = resolve;
    });
    call.mockImplementation((method: string, path: string) => {
      if (method !== 'GET') return Promise.resolve(ok(written));
      if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree()));
      if (path.includes('/impact')) {
        if (path.endsWith(`targetId=${id(4)}`)) return slow;
        return Promise.resolve(
          ok(path.endsWith(`targetId=${id(3)}`) ? impactBody({ products: 99 }) : impactBody()),
        );
      }
      const found = rows().find((c) => path === `catalog/admin/categories/${c.id}`);
      return Promise.resolve(ok(found === undefined ? null : detail(found)));
    });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Oils' }));
    expect(await within(dialog).findByText(/^99 products/)).toBeTruthy();
    releaseDrinks(ok(impactBody({ products: 5, featureSetChanges: 7 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(dialog).getByText(/^99 products/)).toBeTruthy();
    expect(within(dialog).queryByText(/^5 products/)).toBeNull();
    expect(within(dialog).queryByText(/Feature set changes/)).toBeNull();
  });

  it('sends a rejected session on the impact read to sign-in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockImplementation((method: string, path: string) => {
      if (method !== 'GET') return Promise.resolve(ok(written));
      if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree()));
      if (path.includes('/impact')) return Promise.resolve(refused(401, 'auth.required'));
      const found = rows().find((c) => path === `catalog/admin/categories/${c.id}`);
      return Promise.resolve(ok(found === undefined ? null : detail(found)));
    });
    open();
    await startDialog('Rice', 'Archive…');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
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
      const banner = await within(dialog).findByRole('alert');
      expect(within(banner).getByText(copy)).toBeTruthy();
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
    ['conflict.stale', 409, 'The tree changed since you opened it. Reload.'],
    [
      'category.target-not-found',
      404,
      'The category you chose is no longer available. Reload to choose another.',
    ],
    [
      'category.parent-not-found',
      404,
      'The category you chose is no longer available. Reload to choose another.',
    ],
  ])('%s: says what changed and offers a reload', async (code, status, copy) => {
    serve({ write: refused(status, code) });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    const banner = await within(dialog).findByRole('alert');
    expect(within(banner).getByText(copy)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Move' })).toBeNull();
    const treeReads = () =>
      call.mock.calls.filter(([m, p]) => m === 'GET' && p === 'catalog/admin/categories').length;
    const before = treeReads();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(treeReads()).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    [
      'Merge…',
      'Merge',
      'Oils',
      'category.depth-exceeded',
      { max: 4 },
      'Categories can be at most 4 levels deep.',
    ],
    [
      'Merge…',
      'Merge',
      'Oils',
      'category.only-platform-category',
      { total: 1 },
      '1 live product would be left without a category. Choose a replacement.',
    ],
    [
      'Archive…',
      'Archive',
      null,
      'category.has-subcategories',
      undefined,
      'Move or archive its subcategories first.',
    ],
  ] as const)(
    '%s refusal %s: shows its copy in the alert',
    async (button, action, target, code, details, copy) => {
      serve({ write: refused(409, code, details) });
      open();
      const dialog = await startDialog('Rice', button);
      if (target !== null) fireEvent.click(within(dialog).getByRole('radio', { name: target }));
      typeReason(dialog, REASON);
      fireEvent.click(submitButton(dialog, action));
      const banner = await within(dialog).findByRole('alert');
      expect(within(banner).getByText(copy)).toBeTruthy();
    },
  );

  it('clears a shown refusal when another target is picked', async () => {
    serve({ write: refused(422, 'category.cycle') });
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    fireEvent.click(submitButton(dialog, 'Move'));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Oils' }));
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('keeps focus on the button while saving, and ignores a second click', async () => {
    let finish: (value: ApiResult<unknown>) => void = () => {};
    const pendingWrite = new Promise<ApiResult<unknown>>((resolve) => {
      finish = resolve;
    });
    serve();
    const base = call.getMockImplementation()!;
    call.mockImplementation((method: string, path: string, ...rest: unknown[]) =>
      method === 'GET' ? base(method, path, ...(rest as [])) : pendingWrite,
    );
    open();
    const dialog = await startDialog('Rice', 'Move…');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Drinks' }));
    typeReason(dialog, REASON);
    const go = submitButton(dialog, 'Move');
    go.focus();
    fireEvent.click(go);
    await waitFor(() => expect(go.getAttribute('aria-busy')).toBe('true'));
    expect(go.disabled).toBe(false);
    expect(document.activeElement).toBe(go);
    fireEvent.click(go);
    expect(writes()).toHaveLength(1);
    finish(ok(written));
    expect(await screen.findByText('Category moved.')).toBeTruthy();
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
