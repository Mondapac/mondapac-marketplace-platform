// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { activityProblemOf } from './activity-errors.ts';
import {
  bodyOf,
  categoryOptions,
  checkForm,
  emptyForm,
  fieldsOf,
  formOf,
  suggestCode,
} from './activity-form.ts';
import { BusinessActivitiesView } from './business-activities-view.tsx';
import type { ActivityRow, Locales } from './types.ts';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LOCALES: Locales = { default: 'en', supported: ['en', 'ar', 'fa'] };
const activity = (n: number, over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: id(n),
  code: `activity-${n}`,
  status: 'active',
  names: { en: `Activity ${n}` },
  description: null,
  categoryIds: [],
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-14T01:00:00.000Z',
  version: 3,
  ...over,
});
const TREE = {
  categories: [
    { id: id(101), name: 'Fresh', depth: 0 },
    { id: id(102), name: 'Meat', depth: 1 },
    { id: id(103), name: 'Beef', depth: 2 },
    { id: id(104), name: 'Pantry', depth: 0 },
  ],
};

type Handler = ApiResult<unknown> | ((body: unknown) => ApiResult<unknown>);
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refuse = (status: number, code: string, details?: object): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
/** What the API names for a row (the reader gets none), by status. */
let granted = true;
const actionsOf = (row: ActivityRow): string[] =>
  !granted ? [] : row.status === 'active' ? ['edit', 'deactivate'] : ['edit'];
const page =
  (items: ActivityRow[], total: number = items.length, hasNext = false) =>
  () =>
    ok({
      items: items.map((row) => ({ ...row, actions: actionsOf(row) })),
      total,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext,
      locales: LOCALES,
    });

/** Answers by `METHOD path`: the longest registered prefix of the call wins. */
function serve(routes: Record<string, Handler>) {
  call.mockImplementation((method, path, body) => {
    const key = `${method} ${path}`;
    const hit = Object.keys(routes)
      .filter((route) => key.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    const handler = hit === undefined ? undefined : routes[hit];
    // No saved filters unless a test serves some, and only for this list's own key: a read of
    // any other key is an unexpected call, so a wrong key fails the test.
    if (
      handler === undefined &&
      key === 'GET lists/admin/saved-filters?listKey=admin.catalog.business-activities'
    ) {
      return Promise.resolve(ok({ items: [], canShare: false }) as never);
    }
    if (handler === undefined) throw new Error(`unexpected call ${key}`);
    return Promise.resolve((typeof handler === 'function' ? handler(body) : handler) as never);
  });
}
const base = (items: ActivityRow[] = []) => ({
  'GET catalog/admin/business-activities': page(items),
  'GET catalog/categories': ok(TREE),
});

function mount(canEdit = true) {
  granted = canEdit;
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BusinessActivitiesView
        canEdit={canEdit}
        csrfToken="csrf-1"
        paging="pages"
        accountId={id(99)}
        marketId="AU"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}

/** Opens the row's Actions menu and picks an item: no row action is a button in the row. */
async function act(name: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}
const calls = (method: string, prefix: string) =>
  call.mock.calls.filter(([m, path]) => m === method && path.startsWith(prefix));

describe('admin business activities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(cleanup);

  it('lists name, code, description, branch count and status', async () => {
    serve(
      base([
        activity(1, {
          names: { en: 'Grocery', ar: 'بقالة' },
          code: 'grocery',
          description: 'Dry goods',
          categoryIds: [id(101), id(104)],
        }),
        activity(2, { status: 'inactive' }),
      ]),
    );
    mount();
    expect(await screen.findByText('Grocery')).toBeTruthy();
    expect(screen.getByText('grocery')).toBeTruthy();
    expect(screen.getByText('Dry goods')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Inactive', { selector: 'span' })).toBeTruthy();
    const first = new URLSearchParams(
      calls('GET', 'catalog/admin/business-activities')[0]?.[1].split('?')[1],
    );
    expect(first.get('page')).toBe('1');
    expect(first.get('paging')).toBe('pages');
    expect(first.get('sort')).toBe('code');
    expect(first.get('direction')).toBe('asc');
    expect(first.get('status')).toBeNull();
  });

  it('has Active and Inactive as views and searches on the server', async () => {
    serve(base([activity(1)]));
    mount();
    await screen.findByText('Activity 1');
    fireEvent.click(screen.getByRole('button', { name: 'Inactive' }));
    await waitFor(() =>
      expect(
        calls('GET', 'catalog/admin/business-activities').at(-1)?.[1].includes('status=inactive'),
      ).toBe(true),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search activities' }), {
      target: { value: 'gro' },
    });
    await waitFor(() => {
      const last = calls('GET', 'catalog/admin/business-activities').at(-1)?.[1] ?? '';
      expect(last).toContain('q=gro');
      expect(last).toContain('sort=code');
      expect(last).toContain('status=inactive');
    });
  });

  it('filters by when it was created, as instants on the Brisbane day, and takes it off again', async () => {
    serve(base([activity(1)]));
    mount();
    await screen.findByText('Activity 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'created' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const asked = () =>
      calls('GET', 'catalog/admin/business-activities?').map(
        ([, path]) => new URLSearchParams(path.split('?')[1]),
      );
    await waitFor(() => expect(asked().some((p) => p.has('createdFrom'))).toBe(true));
    const range = asked().find((p) => p.has('createdFrom')) as URLSearchParams;
    // Midnight on the Brisbane clock (UTC+10, no daylight saving) is 14:00 UTC, and Today is one
    // day long: never the UTC day.
    expect(range.get('createdFrom')).toMatch(/T14:00:00(\.000)?Z$/);
    expect(range.get('createdTo')).toMatch(/T14:00:00(\.000)?Z$/);
    expect(
      Date.parse(range.get('createdTo') ?? '') - Date.parse(range.get('createdFrom') ?? ''),
    ).toBe(24 * 3600 * 1000);
    expect(range.has('created')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: /Remove filter Created is/ }));
    await waitFor(() => expect(asked().at(-1)?.has('createdFrom')).toBe(false));
  });

  it('opens a saved filter as a tab with its view, search and sort', async () => {
    serve({
      ...base([activity(1)]),
      'GET lists/admin/saved-filters?listKey=admin.catalog.business-activities': ok({
        items: [
          {
            id: '0190a000-0000-7000-8000-000000000064',
            listKey: 'admin.catalog.business-activities',
            name: 'Retired groceries',
            visibility: 'everyone',
            payload: {
              v: 1,
              q: 'gro',
              filters: { status: 'inactive' },
              sort: 'code',
              direction: 'asc',
            },
            ownedByMe: false,
            canManage: false,
          },
        ],
        canShare: false,
      }),
    });
    mount();
    await screen.findByText('Activity 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Retired groceries' }));
    await waitFor(() => {
      const last = calls('GET', 'catalog/admin/business-activities').at(-1)?.[1] ?? '';
      expect(last).toContain('status=inactive');
      expect(last).toContain('q=gro');
      expect(last).toContain('sort=code');
      expect(last).toContain('direction=asc');
    });
  });

  it('says so when nothing matches, and shows a load error with a retry', async () => {
    serve(base());
    mount();
    expect(await screen.findByText('No business activities yet')).toBeTruthy();
    cleanup();
    serve({ 'GET catalog/admin/business-activities': refuse(500, 'internal') });
    mount();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('moves to the next page with the page buttons', async () => {
    serve({ ...base(), 'GET catalog/admin/business-activities': page([activity(1)], 40, true) });
    mount();
    await screen.findByText('Activity 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        calls('GET', 'catalog/admin/business-activities').some(([, path]) =>
          path.includes('page=2'),
        ),
      ).toBe(true),
    );
  });

  it('shows activity text as plain text', async () => {
    serve(base([activity(1, { names: { en: '<b>Bold</b>' } })]));
    mount();
    expect(await screen.findByText('<b>Bold</b>')).toBeTruthy();
  });

  it('gives a reader the list and no button that changes anything', async () => {
    serve(base([activity(1)]));
    mount(false);
    expect(await screen.findByText('Activity 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('keeps Edit and Deactivate in the Actions menu, and Deactivate only for an active one', async () => {
    serve(base([activity(1), activity(2, { status: 'inactive' })]));
    mount();
    await screen.findByText('Activity 1');
    expect(screen.queryByRole('button', { name: /^(Edit|Deactivate)/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Activity 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Deactivate…' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Activity 2' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Deactivate…' })).toBeNull();
  });

  it('deactivates after a confirmation, sending the row content back with the version', async () => {
    serve({
      ...base([activity(1, { description: 'Dry goods', categoryIds: [id(102)] })]),
      'PUT catalog/admin/business-activities/': ok({
        activity: activity(1, { status: 'inactive' }),
      }),
    });
    mount();
    await act('Activity 1', 'Deactivate…');
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Activity 1?' });
    expect(calls('PUT', 'catalog/admin/business-activities/')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate activity' }));
    await expectToast('Activity 1 was deactivated.');
    expect(calls('PUT', 'catalog/admin/business-activities/')[0]?.[2]).toEqual({
      names: { en: 'Activity 1' },
      description: 'Dry goods',
      categoryIds: [id(102)],
      status: 'inactive',
      version: 3,
    });
  });

  describe('the form', () => {
    it('creates an activity with a second language and categories at level 1 and 2', async () => {
      serve({
        ...base(),
        'POST catalog/admin/business-activities': ok({ activity: activity(9) }),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'New activity' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('English (required)'), {
        target: { value: 'Butcher' },
      });
      // The code is suggested from the name and sent only when typed.
      expect(within(dialog).getByLabelText('Code').getAttribute('placeholder')).toBe('butcher');
      // Add a language from the searchable list.
      fireEvent.click(within(dialog).getByRole('combobox', { name: 'Add language' }));
      fireEvent.click(await screen.findByRole('option', { name: /Arabic/ }));
      fireEvent.change(within(dialog).getByLabelText('Arabic'), { target: { value: 'جزار' } });
      // The categories: the closed field has no "Search" placeholder; the deep level is not offered.
      const field = within(dialog).getByRole('combobox', { name: 'Categories' });
      expect(field.textContent).not.toContain('Search');
      await waitFor(() => expect(calls('GET', 'catalog/categories')).toHaveLength(1));
      fireEvent.click(field);
      expect(screen.queryByRole('option', { name: /Beef/ })).toBeNull();
      fireEvent.click(await screen.findByRole('option', { name: /Meat/ }));
      expect(screen.getByText('Fresh > Meat')).toBeTruthy();
      fireEvent.keyDown(screen.getAllByRole('combobox').at(-1)!, { key: 'Escape' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create activity' }));
      await expectToast('Activity 9 was created.');
      expect(calls('POST', 'catalog/admin/business-activities')[0]).toEqual([
        'POST',
        'catalog/admin/business-activities',
        {
          names: { en: 'Butcher', ar: 'جزار' },
          description: null,
          categoryIds: [id(102)],
        },
        'csrf-1',
      ]);
    });

    it('needs the default language name before it sends anything', async () => {
      serve(base());
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'New activity' }));
      fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
      expect(await screen.findByText('Enter a name.')).toBeTruthy();
      expect(calls('POST', 'catalog/admin/business-activities')).toHaveLength(0);
    });

    it('edits with the version seen, shows the code read-only and the saved languages', async () => {
      serve({
        ...base([
          activity(1, {
            code: 'grocery',
            names: { en: 'Grocery', ar: 'بقالة' },
            categoryIds: [id(102)],
          }),
        ]),
        'PUT catalog/admin/business-activities/': ok({ activity: activity(1) }),
      });
      mount();
      await act('Grocery', 'Edit…');
      const dialog = await screen.findByRole('dialog');
      const code = within(dialog).getByLabelText<HTMLInputElement>('Code');
      expect(code.readOnly).toBe(true);
      expect(code.value).toBe('grocery');
      expect(within(dialog).getByText('Names in: English, Arabic')).toBeTruthy();
      expect(await within(dialog).findByText('Meat')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await expectToast('Activity 1 was saved.');
      const put = calls('PUT', 'catalog/admin/business-activities/')[0];
      expect(put?.[2]).toMatchObject({ version: 3, status: 'active', categoryIds: [id(102)] });
      expect(put?.[2]).not.toHaveProperty('code');
    });

    it('shows the refusal of a certification claim at the name it came from', async () => {
      serve({
        ...base(),
        'POST catalog/admin/business-activities': refuse(422, 'business-activity.claim-word', {
          fields: [{ path: 'names.en', code: 'claim-word' }],
        }),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'New activity' }));
      fireEvent.change(screen.getByLabelText('English (required)'), { target: { value: 'X' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
      expect(
        await screen.findByText('Names cannot claim a certification such as halal.'),
      ).toBeTruthy();
      expect(screen.getByText(/Names cannot claim a certification\. Remove/)).toBeTruthy();
    });

    it('reloads the list on a stale version and says so', async () => {
      serve({
        ...base([activity(1, { names: { en: 'Grocery' } })]),
        'PUT catalog/admin/business-activities/': refuse(409, 'conflict.stale'),
      });
      mount();
      await act('Grocery', 'Edit…');
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Reload the list' }));
      expect(await screen.findByText(/That activity changed while you were looking/)).toBeTruthy();
      expect(calls('GET', 'catalog/admin/business-activities').length).toBeGreaterThan(1);
    });
  });

  it('maps refusals to message keys and fields', () => {
    expect(activityProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'business-activities.error.stale',
      reload: true,
    });
    expect(activityProblemOf({ status: 409, code: 'business-activity.code-taken' })).toMatchObject({
      key: 'business-activities.error.code-taken',
      fields: [{ path: 'code', code: 'taken' }],
    });
    expect(activityProblemOf({ status: 0, code: 'network' }).key).toBe(
      'business-activities.error.unavailable',
    );
    expect(activityProblemOf({ status: 418, code: 'x' }).key).toBe(
      'business-activities.error.unknown',
    );
    expect(
      fieldsOf([
        { path: 'names.ar', code: 'claim-word' },
        { path: 'description', code: 'too-long' },
        { path: 'categoryIds', code: 'level' },
        { path: 'code', code: 'taken' },
        { path: 'zzz', code: 'x' },
      ]),
    ).toEqual({
      names: { ar: 'claim-word' },
      description: 'refused',
      categoryIds: 'categories-refused',
      code: 'code-taken',
    });
  });

  it('checks the form and builds the body', () => {
    const empty = emptyForm('en');
    expect(checkForm(empty, 'en', true)).toEqual({ names: { en: 'name-required' } });
    const filled = {
      ...empty,
      names: [
        { locale: 'en', name: ' Grocery ' },
        { locale: 'ar', name: ' ' },
      ],
    };
    expect(checkForm(filled, 'en', true)).toEqual({});
    expect(checkForm({ ...filled, code: 'Bad Code' }, 'en', true)).toEqual({ code: 'code-format' });
    expect(checkForm({ ...filled, code: 'Bad Code' }, 'en', false)).toEqual({});
    expect(checkForm({ ...filled, description: 'x'.repeat(301) }, 'en', true)).toEqual({
      description: 'description-long',
    });
    // Create: no status (the API refuses unknown keys); edit: status is sent.
    expect(bodyOf({ ...filled, active: false }, true)).toEqual({
      names: { en: 'Grocery' },
      description: null,
      categoryIds: [],
    });
    expect(bodyOf({ ...filled, active: false }, false)).toEqual({
      names: { en: 'Grocery' },
      description: null,
      categoryIds: [],
      status: 'inactive',
    });
    expect(bodyOf({ ...filled, code: 'g-1' }, true)).toHaveProperty('code', 'g-1');
    expect(bodyOf({ ...filled, code: 'g-1' }, false)).not.toHaveProperty('code');
    expect(
      formOf(activity(1, { names: { ar: 'ب', en: 'A' } }), 'en').names.map((r) => r.locale),
    ).toEqual(['en', 'ar']);
    expect(suggestCode('Café & Bakery!')).toBe('cafe-bakery');
    expect(suggestCode('بقالة')).toBe('activity');
  });

  it('offers only levels 1 and 2 of the tree, with the full path of a child', () => {
    expect(categoryOptions(TREE)).toEqual([
      { value: id(101), label: 'Fresh' },
      { value: id(102), label: 'Meat', description: 'Fresh > Meat' },
      { value: id(104), label: 'Pantry' },
    ]);
  });
});
