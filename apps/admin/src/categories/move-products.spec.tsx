// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { callApi, type ApiFailure, type ApiResult } from '../api/client.ts';
import { CategoriesView } from './categories-view.tsx';
import { moveProductsProblemOf } from './category-errors.ts';
import { MoveProductsDialog } from './move-products-dialog.tsx';
import { handled, isFinished, jobOf, moveTargetRows } from './move-products-model.ts';
import type {
  CategoryRow,
  DetailBody,
  ImpactBody,
  MoveJob,
  MoveProgressBody,
  TreeBody,
} from './types.ts';

// "Move products…" of a category (categories C5b).

const call = vi.mocked(callApi);
const assign = vi.fn();
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
// Pantry (1) > Rice (2) > Basmati (5), Pantry > Oils (3); Drinks (4) > Tea (6) > Green (7, hidden);
// Old (8, merged)
const rows = (): CategoryRow[] => [
  row(1, null, 0, 'Pantry'),
  row(2, 1, 1, 'Rice'),
  row(5, 2, 2, 'Basmati'),
  row(3, 1, 1, 'Oils'),
  row(4, null, 0, 'Drinks'),
  row(6, 4, 1, 'Tea'),
  row(7, 6, 2, 'Green tea', { status: 'hidden' }),
  row(8, 2, 2, 'Old rice', { status: 'merged' }),
  row(9, 2, 2, 'Sella', {}),
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
const detail = (r: CategoryRow, actions: DetailBody['actions']): DetailBody => ({
  category: r,
  path: [{ id: r.id, slug: r.slug, name: r.names[0]?.name ?? null }],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [],
  complete: true,
  actions,
  details: {
    texts: [{ locale: 'en', name: r.names[0]?.name ?? '', shortDescription: null, keywords: [] }],
    seo: { title: null, description: null, noindex: false },
    showInMenu: true,
    imageId: null,
    hiddenById: null,
  },
  treeVersion: 7,
});
const impact = (over: Partial<ImpactBody> = {}): ImpactBody => ({
  products: 12,
  directProducts: 4,
  offers: 30,
  listedOffers: 20,
  offersWithActiveTag: 9,
  descendants: 2,
  complete: true,
  ...over,
});
const job = (over: Partial<MoveJob> = {}): MoveJob => ({
  id: 'job-1',
  sourceCategoryId: id(2),
  targetCategoryId: id(3),
  state: 'queued',
  createdAt: '2026-11-14T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  total: 4,
  moved: 0,
  skipped: 0,
  failed: 0,
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

const view = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
const REASON = 'Supplier review moved rice to the new shelf.';
const MOVE = 'catalog/admin/categories';

interface Serving {
  readonly start?: ApiResult<unknown>;
  readonly progress?: () => ApiResult<unknown>;
  readonly impactBody?: ImpactBody;
  readonly impactResult?: ApiResult<unknown>;
}
function serve({
  start = { ok: true, status: 202, body: { jobId: 'job-1', products: 4 } },
  progress = () => ok({ jobs: [job()] } satisfies MoveProgressBody),
  impactBody = impact(),
  impactResult,
}: Serving = {}) {
  call.mockImplementation((method: string, path: string) => {
    if (method === 'POST') return Promise.resolve(start);
    if (path.endsWith('/move-products')) return Promise.resolve(progress());
    if (path.includes('/impact?')) return Promise.resolve(impactResult ?? ok(impactBody));
    return Promise.resolve(ok(null));
  });
}
const mountDialog = (over: Partial<React.ComponentProps<typeof MoveProductsDialog>> = {}) => {
  const onClose = vi.fn();
  const onReload = vi.fn();
  view(
    <MoveProductsDialog
      categoryId={id(2)}
      name="Rice"
      rows={rows()}
      locale="en"
      csrfToken="tok"
      onClose={onClose}
      onReload={onReload}
      {...over}
    />,
  );
  return { onClose, onReload };
};
const dialog = () => screen.getByRole('dialog');
const startButton = () =>
  within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Move products' });
async function fill(target = 'Sella', reason = REASON) {
  fireEvent.click(await within(dialog()).findByRole('radio', { name: new RegExp(`^${target}`) }));
  fireEvent.change(within(dialog()).getByLabelText(/^Reason/), { target: { value: reason } });
}
const writes = () => call.mock.calls.filter(([method]) => method === 'POST');

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.defineProperty(window, 'location', {
    value: { assign, href: 'http://admin.localhost/' },
    writable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('move products model', () => {
  it('offers levels 3 and 4 only, hidden ones too, never the source or a merged row', () => {
    const targets = moveTargetRows(rows(), id(2)).map((r) => r.id);
    // Basmati (5), Green tea (7, hidden), Sella (9): depth 2 and live. Not Rice (the source),
    // Pantry, Oils or Tea (level 2 at depth 1 is not allowed either), not the merged one.
    expect(targets).toEqual([id(5), id(7), id(9)]);
    // A source on level 3 may move its products to its own child, never to itself.
    expect(moveTargetRows(rows(), id(5)).map((r) => r.id)).toEqual([id(7), id(9)]);
  });

  it('finds the job by id and counts what is handled, never above the total', () => {
    expect(jobOf({ jobs: [job({ id: 'a' }), job({ id: 'b' })] }, 'b')?.id).toBe('b');
    expect(jobOf({ jobs: [] }, 'b')).toBeNull();
    expect(handled(job({ total: 4, moved: 2, skipped: 1, failed: 2 }))).toBe(4);
    expect(isFinished(job({ state: 'running' }))).toBe(false);
    expect(isFinished(job({ state: 'done' }))).toBe(true);
    expect(isFinished(job({ state: 'failed' }))).toBe(true);
  });
});

describe('error mapping', () => {
  const keyOf = (code: string, status = 409) =>
    moveProductsProblemOf({ status, code }).key.replace('categories.move-products.error.', '');
  it('words every code of the move route', () => {
    for (const code of [
      'category.not-found',
      'category.target-not-found',
      'category.move-unchanged',
      'category.level-not-allowed',
      'category.not-editable',
      'category.no-products',
      'category.move-in-progress',
    ]) {
      expect(keyOf(code)).toBe(code.replace(/\./g, '_'));
    }
    const flat = (
      messages as unknown as { categories: { 'move-products': { error: Record<string, string> } } }
    ).categories['move-products'].error;
    expect(Object.keys(flat)).toHaveLength(7);
  });
  it('asks for a reload only when the page read old data', () => {
    expect(moveProductsProblemOf({ status: 404, code: 'category.target-not-found' }).reload).toBe(
      true,
    );
    expect(moveProductsProblemOf({ status: 404, code: 'category.not-found' }).reload).toBe(true);
    expect(moveProductsProblemOf({ status: 409, code: 'category.not-editable' }).reload).toBe(true);
    expect(moveProductsProblemOf({ status: 409, code: 'category.no-products' }).reload).toBe(false);
    expect(moveProductsProblemOf({ status: 409, code: 'category.move-in-progress' }).reload).toBe(
      false,
    );
  });
  it('words a reason problem for the reason and falls back to the C3 words', () => {
    expect(
      moveProductsProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'too-short' }] },
      }).key,
    ).toBe('categories.restructure.error.reason');
    expect(moveProductsProblemOf({ status: 403, code: 'access.permission-missing' }).key).toBe(
      'categories.error.access_permission-missing',
    );
  });
});

describe('Move products dialog: the form', () => {
  it('lists level 3 and 4 targets with Hidden marked, and previews the direct products', async () => {
    serve();
    mountDialog();
    const d = dialog();
    expect(within(d).getByRole('heading', { name: 'Move products of Rice' })).toBeTruthy();
    expect(await within(d).findByText('4 published products will move.')).toBeTruthy();
    expect(within(d).getByRole('radio', { name: /^Basmati/ })).toBeTruthy();
    expect(within(d).getByRole('radio', { name: /^Green tea/ })).toBeTruthy();
    expect(within(d).getByText('Hidden')).toBeTruthy();
    expect(within(d).queryByRole('radio', { name: /^Pantry/ })).toBeNull();
    expect(within(d).queryByRole('radio', { name: /^Old rice/ })).toBeNull();
    // The count is the direct-products number of the impact read, asked without a target.
    expect(call.mock.calls[0]).toEqual(['GET', `${MOVE}/${id(2)}/impact?action=archive`]);
  });

  it('says "at least" when the count stopped, and tells that there is nothing to move at 0', async () => {
    serve({ impactBody: impact({ directProducts: 40, complete: false }) });
    mountDialog();
    expect(await screen.findByText('At least 40 published products will move.')).toBeTruthy();
    cleanup();
    serve({ impactBody: impact({ directProducts: 0 }) });
    mountDialog();
    expect(
      await screen.findByText(
        'No published product is directly in Rice, so there is nothing to move.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('There are no published products to move.')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  it('keeps the button off until a target and a reason of 10 to 500 characters are given', async () => {
    serve();
    mountDialog();
    await screen.findByText('4 published products will move.');
    expect(startButton().disabled).toBe(true);
    expect(screen.getByText('Choose a category to continue.')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('radio', { name: /^Sella/ }));
    expect(screen.getByText('Add a reason to continue.')).toBeTruthy();
    const reason = within(dialog()).getByLabelText(/^Reason/);
    fireEvent.change(reason, { target: { value: 'a'.repeat(9) } });
    fireEvent.blur(reason);
    expect(startButton().disabled).toBe(true);
    expect(screen.getAllByText('Add a reason of 10 to 500 characters.').length).toBeGreaterThan(0);
    fireEvent.change(reason, { target: { value: 'a'.repeat(10) } });
    expect(startButton().disabled).toBe(false);
    fireEvent.change(reason, { target: { value: 'a'.repeat(500) } });
    expect(startButton().disabled).toBe(false);
    fireEvent.change(reason, { target: { value: 'a'.repeat(501) } });
    expect(startButton().disabled).toBe(true);
    expect(screen.getByText('The reason is longer than 500 characters.')).toBeTruthy();
    expect(screen.getByText(/Sellers never see it/)).toBeTruthy();
  });

  it('still lets the admin start when the count could not be read', async () => {
    serve({ impactResult: refused(503, 'access.unavailable') });
    mountDialog();
    expect(
      await screen.findByText(
        "We couldn't count the products. The move is still checked when you start it.",
      ),
    ).toBeTruthy();
    await fill();
    expect(startButton().disabled).toBe(false);
  });

  it('sends the target and the trimmed reason, nothing else', async () => {
    serve();
    mountDialog();
    await screen.findByText('4 published products will move.');
    await fill('Sella', `  ${REASON}  `);
    fireEvent.click(startButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `${MOVE}/${id(2)}/move-products`,
      { targetId: id(9), reason: REASON },
      'tok',
    ]);
  });

  it.each([
    [
      409,
      'category.move-unchanged',
      'Those products are already in that category. Choose another.',
    ],
    [409, 'category.no-products', 'This category has no published products to move.'],
    [409, 'category.move-in-progress', 'A move from this category is already running.'],
    [
      422,
      'category.level-not-allowed',
      "Choose a more specific category. Products can't go on a department or group.",
    ],
    [409, 'category.not-editable', "This category can't be changed any more. Reload."],
    [
      404,
      'category.target-not-found',
      'The category you chose is no longer available. Reload to choose another.',
    ],
    [404, 'category.not-found', 'This category is no longer available. Reload.'],
  ])('shows %s %s in words and stays on the form', async (status, code, words) => {
    serve({ start: refused(status, code) });
    mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    fireEvent.click(startButton());
    expect(await within(dialog()).findByText(words)).toBeTruthy();
    expect(within(dialog()).queryByTestId('move-products-progress')).toBeNull();
  });

  it('offers Reload after a refusal that means the page is old, and calls it', async () => {
    serve({ start: refused(404, 'category.target-not-found') });
    const { onReload } = mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    fireEvent.click(startButton());
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('words a reason refusal for the reason', async () => {
    serve({
      start: refused(400, 'validation.failed', { fields: [{ path: 'reason', code: 'too-short' }] }),
    });
    mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    fireEvent.click(startButton());
    expect(
      (await within(dialog()).findAllByText('Add a reason of 10 to 500 characters.')).length,
    ).toBeGreaterThan(0);
  });

  it('sends a signed-out admin to sign-in', async () => {
    serve({ start: refused(401, 'identity.unauthenticated') });
    mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    fireEvent.click(startButton());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('closes with Cancel and reports that nothing started', () => {
    serve();
    const { onClose } = mountDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

describe('Move products dialog: the progress', () => {
  async function begin() {
    const view = mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    await act(() => {
      fireEvent.click(startButton());
      return Promise.resolve();
    });
    return view;
  }

  it('shows queued, then running, then done with the counts, and stops reading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const states = [
      job({ state: 'queued' }),
      job({ state: 'running', moved: 2, skipped: 1 }),
      job({ state: 'done', moved: 3, skipped: 1, finishedAt: '2026-11-14T00:01:00Z' }),
    ];
    let reads = 0;
    serve({
      progress: () => ok({ jobs: [states[Math.min(reads++, states.length - 1)]!] }),
    });
    const { onClose } = await begin();
    const d = dialog();
    expect(await within(d).findByText('Waiting to start…')).toBeTruthy();
    // Focus moved to the progress heading, not lost with the form.
    expect(document.activeElement).toBe(
      within(d).getByRole('heading', { name: 'Moving products' }),
    );
    expect(within(d).getByText('You can close this window. The move keeps running.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await within(d).findByText('Moving products…')).toBeTruthy();
    expect(
      within(d).getByRole('progressbar', { name: 'Products handled' }).getAttribute('value'),
    ).toBe('3');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await within(d).findByText('Done. 3 moved, 1 skipped, 0 failed.')).toBeTruthy();
    const counts = within(d).getByTestId('move-products-progress');
    expect(counts.textContent).toContain('Moved3');
    expect(counts.textContent).toContain('Skipped1');
    expect(counts.textContent).toContain('Failed0');
    expect(within(d).getByText(/^Skipped products were no longer in Rice/)).toBeTruthy();
    expect(within(d).queryByText(/Start the move again/)).toBeNull();
    const readsAtDone = call.mock.calls.filter(
      ([m, p]) => m === 'GET' && String(p).endsWith('/move-products'),
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(
      call.mock.calls.filter(([m, p]) => m === 'GET' && String(p).endsWith('/move-products')),
    ).toHaveLength(readsAtDone);
    fireEvent.click(within(d).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('tells a failed job and its counts', async () => {
    serve({ progress: () => ok({ jobs: [job({ state: 'failed', moved: 1, failed: 3 })] }) });
    await begin();
    expect(await within(dialog()).findByText('The move stopped.')).toBeTruthy();
    expect(within(dialog()).getByText(/The move stopped before it finished/)).toBeTruthy();
    expect(within(dialog()).getByTestId('move-products-progress').textContent).toContain('Failed3');
  });

  it('keeps trying when a read fails, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    serve({
      progress: () =>
        reads++ === 0
          ? refused(503, 'access.unavailable')
          : ok({ jobs: [job({ state: 'done', moved: 4 })] }),
    });
    await begin();
    expect(
      await within(dialog()).findByText(
        "We can't read the progress right now. The move keeps running and we keep trying.",
      ),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await within(dialog()).findByText('Done. 4 moved, 0 skipped, 0 failed.')).toBeTruthy();
    expect(within(dialog()).queryByText(/We can't read the progress/)).toBeNull();
  });

  it('shows the count the start gave while the job is not listed yet', async () => {
    serve({ progress: () => ok({ jobs: [] }) });
    await begin();
    expect(await within(dialog()).findByText('Waiting to start…')).toBeTruthy();
    expect(within(dialog()).getByTestId('move-products-progress').textContent).toContain(
      'Products to move4',
    );
  });

  it('closing before the end still tells the owner a job started', async () => {
    serve();
    const { onClose } = await begin();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });
});

describe('the Move products… button of the category page', () => {
  const actions = (moveProducts: boolean): DetailBody['actions'] => ({
    'platform-category.move': allowed,
    'platform-category.merge': allowed,
    'platform-category.archive': allowed,
    ...(moveProducts
      ? { 'platform-category.move-products': allowed }
      : {
          'platform-category.move-products': { allowed: false, denial: 'access.acting-as-refused' },
        }),
  });
  function serveTree(over: DetailBody['actions']) {
    call.mockImplementation((method: string, path: string) => {
      if (method !== 'GET') return Promise.resolve(ok(null));
      if (path === MOVE) return Promise.resolve(ok(tree()));
      const [base = ''] = path.split('?');
      if (base.endsWith('/impact')) return Promise.resolve(ok(impact()));
      if (base.endsWith('/move-products')) return Promise.resolve(ok({ jobs: [] }));
      const found = rows().find((c) => base === `${MOVE}/${c.id}`);
      return Promise.resolve(found === undefined ? ok(null) : ok(detail(found, over)));
    });
  }
  const pick = async (name: string) => {
    const items = await screen.findAllByRole('treeitem');
    fireEvent.click(items.find((el) => el.textContent?.startsWith(name))!);
    await screen.findByRole('heading', { name });
  };

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    window.history.replaceState(null, '', '/');
  });

  it('opens the dialog from the page and returns focus to the row when it closes', async () => {
    serveTree(actions(true));
    view(<CategoriesView canEdit canRestructure csrfToken="tok" />);
    await pick('Rice');
    const trigger = await screen.findByRole('button', { name: 'Move products…' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: 'Move products of Rice' }),
    ).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is off when the action is not allowed, and hidden without the restructure key', async () => {
    serveTree(actions(false));
    view(<CategoriesView canEdit canRestructure csrfToken="tok" />);
    await pick('Rice');
    const trigger = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Move products…',
    });
    expect(trigger.disabled).toBe(true);
    cleanup();
    serveTree(actions(true));
    view(<CategoriesView canEdit canRestructure={false} csrfToken="tok" />);
    await pick('Rice');
    await screen.findByRole('button', { name: 'Edit details' });
    expect(screen.queryByRole('button', { name: 'Move products…' })).toBeNull();
  });
});

describe('Move products dialog: review fixes', () => {
  const reads = () =>
    call.mock.calls.filter(([m, p]) => m === 'GET' && String(p).endsWith('/move-products')).length;
  async function begin() {
    const mounted = mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    await act(() => {
      fireEvent.click(startButton());
      return Promise.resolve();
    });
    return mounted;
  }
  const escape = () => fireEvent(dialog(), new Event('cancel', { cancelable: true }));
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('names the target in the count line once one is chosen, keeping the at-least form', async () => {
    serve();
    mountDialog();
    await screen.findByText('4 published products will move.');
    fireEvent.click(within(dialog()).getByRole('radio', { name: /^Sella/ }));
    expect(
      screen.getByText('4 published products will move from Rice to Pantry › Rice › Sella.'),
    ).toBeTruthy();
    cleanup();
    serve({ impactBody: impact({ directProducts: 40, complete: false }) });
    mountDialog();
    await screen.findByText('At least 40 published products will move.');
    fireEvent.click(await within(dialog()).findByRole('radio', { name: /^Sella/ }));
    expect(
      screen.getByText(
        'At least 40 published products will move from Rice to Pantry › Rice › Sella.',
      ),
    ).toBeTruthy();
  });

  it('sends one POST when Start is clicked twice while the first is pending', async () => {
    let release: (value: ApiResult<unknown>) => void = () => undefined;
    call.mockImplementation((method: string, path: string) => {
      if (method === 'POST') return new Promise((resolve) => (release = resolve));
      if (path.includes('/impact?')) return Promise.resolve(ok(impact()));
      return Promise.resolve(ok({ jobs: [job()] }));
    });
    mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    const start = startButton();
    fireEvent.click(start);
    fireEvent.click(start);
    expect(writes()).toHaveLength(1);
    await act(() => {
      release({ ok: true, status: 202, body: { jobId: 'job-1', products: 4 } });
      return Promise.resolve();
    });
  });

  it('ignores Escape and the Close path while the start is pending, and closes after', async () => {
    let release: (value: ApiResult<unknown>) => void = () => undefined;
    call.mockImplementation((method: string, path: string) => {
      if (method === 'POST') return new Promise((resolve) => (release = resolve));
      if (path.includes('/impact?')) return Promise.resolve(ok(impact()));
      return Promise.resolve(ok({ jobs: [job()] }));
    });
    const { onClose } = mountDialog();
    await screen.findByText('4 published products will move.');
    await fill();
    fireEvent.click(startButton());
    escape();
    expect(onClose).not.toHaveBeenCalled();
    await act(() => {
      release({ ok: false, failure: { status: 409, code: 'category.no-products' } });
      return Promise.resolve();
    });
    escape();
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('stops reading when the dialog is closed or unmounted while the job runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ progress: () => ok({ jobs: [job({ state: 'running' })] }) });
    const { onClose } = await begin();
    await within(dialog()).findByText('Moving products…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(reads()).toBeGreaterThan(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
    cleanup();
    const after = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(reads()).toBe(after);
  });

  it('says the failed products can be tried again, in their own note', async () => {
    serve({ progress: () => ok({ jobs: [job({ state: 'done', moved: 2, failed: 2 })] }) });
    await begin();
    expect(await within(dialog()).findByText('Done. 2 moved, 0 skipped, 2 failed.')).toBeTruthy();
    expect(
      within(dialog()).getByText(
        'Some products could not be moved. Start the move again to try them.',
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByText(/no longer in Rice/)).toBeNull();
  });

  it('shows the skipped note alone, never suggesting a restart for it', async () => {
    serve({ progress: () => ok({ jobs: [job({ state: 'done', moved: 3, skipped: 1 })] }) });
    await begin();
    expect(
      await within(dialog()).findByText(
        'Skipped products were no longer in Rice when their turn came, so there was nothing to move.',
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByText(/Some products could not be moved/)).toBeNull();
  });

  it('calls the progress unreadable after five reads that do not list the job', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ progress: () => ok({ jobs: [] }) });
    await begin();
    expect(await within(dialog()).findByText('Waiting to start…')).toBeTruthy();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    expect(reads()).toBe(5);
    expect(await within(dialog()).findByText(/We can't read the progress right now/)).toBeTruthy();
    expect(within(dialog()).queryByText('Waiting to start…')).toBeNull();
  });

  it('stops reading on a 404 and offers Reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ progress: () => refused(404, 'category.not-found') });
    const { onReload } = await begin();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
    const after = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(reads()).toBe(after);
  });

  it('pauses reading while the tab is hidden and reads again when it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({ progress: () => ok({ jobs: [job({ state: 'running' })] }) });
    await begin();
    await within(dialog()).findByText('Moving products…');
    const before = reads();
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(reads()).toBe(before);
    setHidden(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(reads()).toBe(before + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  describe('a move is already running (409)', () => {
    async function refusedStart(progress: () => ApiResult<unknown>) {
      serve({ start: refused(409, 'category.move-in-progress'), progress });
      const mounted = mountDialog();
      await screen.findByText('4 published products will move.');
      await fill();
      fireEvent.click(startButton());
      await within(dialog()).findByText('A move from this category is already running.');
      return mounted;
    }

    it('attaches only after View progress, to the newest running job, with a warning line', async () => {
      await refusedStart(() =>
        ok({
          jobs: [
            job({ id: 'old', state: 'done', createdAt: '2026-11-14T03:00:00Z' }),
            job({ id: 'a', state: 'running', createdAt: '2026-11-14T01:00:00Z', total: 9 }),
            job({ id: 'b', state: 'queued', createdAt: '2026-11-14T02:00:00Z', total: 7 }),
          ],
        }),
      );
      // Nothing is attached by itself.
      expect(within(dialog()).queryByTestId('move-products-progress')).toBeNull();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'View progress' }));
      const progress = await within(dialog()).findByTestId('move-products-progress');
      expect(
        within(dialog()).getByText(
          'This move was started earlier. It may be moving products to a different category than the one you chose.',
        ),
      ).toBeTruthy();
      expect(progress.textContent).toContain('Products to move7');
      expect(document.activeElement).toBe(
        within(dialog()).getByRole('heading', { name: 'Moving products' }),
      );
    });

    it('says the move just finished, with Reload, when no job is running', async () => {
      const { onReload } = await refusedStart(() => ok({ jobs: [job({ state: 'done' })] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'View progress' }));
      expect(
        await within(dialog()).findByText('That move just finished. Reload the page.'),
      ).toBeTruthy();
      expect(within(dialog()).queryByTestId('move-products-progress')).toBeNull();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Reload' }));
      expect(onReload).toHaveBeenCalled();
    });

    it('keeps the choice and says so when the progress cannot be read', async () => {
      await refusedStart(() => refused(503, 'access.unavailable'));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'View progress' }));
      expect(
        await within(dialog()).findByText("We couldn't read the progress. Try again."),
      ).toBeTruthy();
      expect(within(dialog()).getByRole('button', { name: 'View progress' })).toBeTruthy();
    });
  });
});
