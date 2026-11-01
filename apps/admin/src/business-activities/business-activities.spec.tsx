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
const page = (items: ActivityRow[], nextAfterId: string | null = null) =>
  ok({ items, nextAfterId, locales: LOCALES });

/** Answers by `METHOD path`: the longest registered prefix of the call wins. */
function serve(routes: Record<string, Handler>) {
  call.mockImplementation((method, path, body) => {
    const key = `${method} ${path}`;
    const hit = Object.keys(routes)
      .filter((route) => key.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    const handler = hit === undefined ? undefined : routes[hit];
    if (handler === undefined) throw new Error(`unexpected call ${key}`);
    return Promise.resolve((typeof handler === 'function' ? handler(body) : handler) as never);
  });
}
const base = (items: ActivityRow[] = []) => ({
  'GET catalog/admin/business-activities': page(items),
  'GET catalog/categories': ok(TREE),
});

function mount(canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BusinessActivitiesView canEdit={canEdit} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
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
    expect(calls('GET', 'catalog/admin/business-activities')[0]?.[1]).toBe(
      'catalog/admin/business-activities?limit=25',
    );
  });

  it('filters by status and searches on the server', async () => {
    serve(base([activity(1)]));
    mount();
    await screen.findByText('Activity 1');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    await waitFor(() =>
      expect(calls('GET', 'catalog/admin/business-activities').at(-1)?.[1]).toBe(
        'catalog/admin/business-activities?limit=25&status=inactive',
      ),
    );
    fireEvent.change(screen.getByLabelText('Search by name or code'), {
      target: { value: 'gro' },
    });
    await waitFor(() =>
      expect(calls('GET', 'catalog/admin/business-activities').at(-1)?.[1]).toBe(
        'catalog/admin/business-activities?limit=25&status=inactive&search=gro',
      ),
    );
  });

  it('says so when nothing matches, and shows a load error with a retry', async () => {
    serve(base());
    mount();
    expect(await screen.findByText(/No business activities yet/)).toBeTruthy();
    cleanup();
    serve({ 'GET catalog/admin/business-activities': refuse(500, 'internal') });
    mount();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('appends the next page', async () => {
    serve({
      ...base(),
      'GET catalog/admin/business-activities?limit=25&afterId': page([activity(2)]),
      'GET catalog/admin/business-activities?limit=25': page([activity(1)], id(1)),
    });
    mount();
    await screen.findByText('Activity 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Activity 2')).toBeTruthy();
    expect(screen.getByText('Activity 1')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
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
          status: 'active',
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
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Grocery' }));
      const dialog = screen.getByRole('dialog');
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
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Grocery' }));
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
    expect(bodyOf({ ...filled, active: false }, true)).toEqual({
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
