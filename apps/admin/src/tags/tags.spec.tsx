// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi, type ApiResult } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { tagProblemOf } from './tag-errors.ts';
import { bodyOf, checkForm, emptyForm, fieldsOf, formOf, suggestSlug } from './tag-form.ts';
import { TagsView } from './tags-view.tsx';
import type { Locales, TopicRow } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// The two Market fixtures' locale shapes: AU (one language) and ZZ (a second language).
const MARKETS: readonly { readonly market: string; readonly locales: Locales }[] = [
  { market: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { market: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'en-US'] } },
];
let LOCALES: Locales = MARKETS[0]!.locales;
const main = () => LOCALES.default;

const topic = (n: number, over: Partial<TopicRow> = {}): TopicRow => ({
  id: id(n),
  slug: `tag-${n}`,
  group: 'occasion',
  status: 'active',
  names: { [main()]: `Tag ${n}` },
  synonyms: {},
  intro: null,
  createdAt: '2026-11-01T01:00:00.000Z',
  updatedAt: '2026-11-07T01:00:00.000Z',
  version: 2,
  ...over,
});

type Handler = ApiResult<unknown> | ((body: unknown) => ApiResult<unknown>);
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refuse = (status: number, code: string, details?: object): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
/** What the API names for a row: the reader gets none. */
let granted = true;
const page =
  (items: TopicRow[], total: number = items.length, hasNext = false) =>
  () =>
    ok({
      items: items.map((row) => ({ ...row, actions: granted ? ['edit'] : [] })),
      nextAfterId: null,
      total,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext,
      locales: LOCALES,
      groups: ['occasion', 'cuisine', 'use'],
      maxSynonyms: 10,
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
      key === 'GET lists/admin/saved-filters?listKey=admin.catalog.tags'
    ) {
      return Promise.resolve(ok({ items: [], canShare: false }) as never);
    }
    if (handler === undefined) throw new Error(`unexpected call ${key}`);
    return Promise.resolve((typeof handler === 'function' ? handler(body) : handler) as never);
  });
}
const base = (items: TopicRow[] = []) => ({ 'GET catalog/admin/topics': page(items) });

function mount(canManage = true) {
  granted = canManage;
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <TagsView
        canManage={canManage}
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
const languageOf = (locale: string) =>
  new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;

beforeEach(() => {
  vi.clearAllMocks();
  LOCALES = MARKETS[0]!.locales;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('admin tags list', () => {
  it('lists name, slug, group, the first synonyms with +N and the status', async () => {
    serve(
      base([
        topic(1, {
          slug: 'bbq',
          group: 'use',
          names: { [main()]: 'BBQ' },
          synonyms: { [main()]: ['Barbecue', 'Grill', 'Smoker', 'Braai'] },
        }),
        topic(2, { status: 'archived' }),
      ]),
    );
    mount();
    expect(await screen.findByText('BBQ')).toBeTruthy();
    expect(screen.getByText('bbq')).toBeTruthy();
    expect(screen.getAllByText('Use').length).toBeGreaterThan(0);
    expect(screen.getByText(/Barbecue, Grill/)).toBeTruthy();
    expect(screen.getByText('+2').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('and 2 more').className).toContain('sr-only');
    expect(screen.getByText('Archived', { selector: 'span' })).toBeTruthy();
    const first = new URLSearchParams(calls('GET', 'catalog/admin/topics')[0]?.[1].split('?')[1]);
    expect(first.get('page')).toBe('1');
    expect(first.get('paging')).toBe('pages');
    expect(first.get('sort')).toBe('slug');
    expect(first.get('direction')).toBe('asc');
    expect(first.get('status')).toBeNull();
  });

  it('has Active and Archived as views and searches on the server', async () => {
    serve(base([topic(1)]));
    mount();
    await screen.findByText('Tag 1');
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() =>
      expect(calls('GET', 'catalog/admin/topics').at(-1)?.[1].includes('status=archived')).toBe(
        true,
      ),
    );
    // A view on its own is not a filter: no Clear all and no Save filter….
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save filter/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tags' }), {
      target: { value: 'bbq' },
    });
    await waitFor(() => {
      const last = calls('GET', 'catalog/admin/topics').at(-1)?.[1] ?? '';
      expect(last).toContain('q=bbq');
      expect(last).toContain('status=archived');
    });
  });

  it('filters by when it was created, as instants on the Brisbane day, and takes it off again', async () => {
    serve(base([topic(1)]));
    mount();
    await screen.findByText('Tag 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'created' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const asked = () =>
      calls('GET', 'catalog/admin/topics?').map(
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

  it('opens a saved filter as a tab with its view, group, search and sort', async () => {
    serve({
      ...base([topic(1)]),
      'GET lists/admin/saved-filters?listKey=admin.catalog.tags': ok({
        items: [
          {
            id: id(90),
            listKey: 'admin.catalog.tags',
            name: 'Old occasions',
            visibility: 'everyone',
            payload: {
              v: 1,
              q: 'eid',
              filters: { status: 'archived', group: 'occasion' },
              sort: 'slug',
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
    await screen.findByText('Tag 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Old occasions' }));
    await waitFor(() => {
      const last = calls('GET', 'catalog/admin/topics').at(-1)?.[1] ?? '';
      expect(last).toContain('status=archived');
      expect(last).toContain('group=occasion');
      expect(last).toContain('q=eid');
      expect(last).toContain('sort=slug');
      expect(last).toContain('direction=asc');
    });
  });

  it('says so when nothing matches, and shows a load error', async () => {
    serve(base());
    mount();
    expect(await screen.findByText('No tags yet')).toBeTruthy();
    cleanup();
    serve({ 'GET catalog/admin/topics': refuse(500, 'internal') });
    mount();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('moves to the next page with the page buttons', async () => {
    serve({ ...base(), 'GET catalog/admin/topics': page([topic(1)], 40, true) });
    mount();
    await screen.findByText('Tag 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(calls('GET', 'catalog/admin/topics').some(([, path]) => path.includes('page=2'))).toBe(
        true,
      ),
    );
  });

  it('keeps Edit in the Actions menu and not in the row', async () => {
    serve(base([topic(1)]));
    mount();
    await screen.findByText('Tag 1');
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Tag 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeTruthy();
  });

  it('gives a reader the list and no button that changes anything, and shows text as text', async () => {
    serve(base([topic(1, { names: { [main()]: '<b>Bold</b>' } })]));
    mount(false);
    expect(await screen.findByText('<b>Bold</b>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New tag' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });
});

describe.each(MARKETS)('the tag form in market $market', ({ locales }) => {
  beforeEach(() => {
    LOCALES = locales;
  });
  const required = () => `${languageOf(locales.default)} (required)`;

  it('creates a tag with synonym rows, Enter adding a row, and no status', async () => {
    serve({
      ...base(),
      'POST catalog/admin/topics': ok({ topic: topic(9) }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    // A new tag is always active: no status box on create.
    expect(within(dialog).queryByRole('checkbox', { name: 'Active' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(required()), {
      target: { value: 'Persian Food' },
    });
    expect(within(dialog).getByLabelText('Address').getAttribute('placeholder')).toBe(
      'persian-food',
    );
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'cuisine' } });
    const lang = languageOf(locales.default);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add synonym' }));
    const first = within(dialog).getByLabelText(`Synonym 1 (${lang})`);
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.change(first, { target: { value: 'Iranian food' } });
    // Enter adds the next row and does not send the form.
    fireEvent.keyDown(first, { key: 'Enter' });
    const second = await within(dialog).findByLabelText(`Synonym 2 (${lang})`);
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(calls('POST', 'catalog/admin/topics')).toHaveLength(0);
    expect(within(dialog).getByText('2 / 10')).toBeTruthy();
    // An empty row is not sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    await expectToast('Tag 9 was created.');
    expect(calls('POST', 'catalog/admin/topics')[0]).toEqual([
      'POST',
      'catalog/admin/topics',
      {
        group: 'cuisine',
        names: { [locales.default]: 'Persian Food' },
        synonyms: { [locales.default]: ['Iranian food'] },
        intro: null,
      },
      'csrf-1',
    ]);
  });

  it('moves focus to the previous row, or to Add synonym, after a Remove', async () => {
    serve(base());
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add synonym' });
    fireEvent.click(add);
    fireEvent.click(add);
    const lang = languageOf(locales.default);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove synonym 2' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText(`Synonym 1 (${lang})`)),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove synonym 1' }));
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('checks the name, the group and repeated synonyms before it sends anything', async () => {
    serve(base());
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeTruthy();
    expect(within(dialog).getByText('Choose a group.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(required()), { target: { value: 'BBQ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add synonym' }));
    const lang = languageOf(locales.default);
    fireEvent.change(within(dialog).getByLabelText(`Synonym 1 (${lang})`), {
      target: { value: ' bbq ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByText('This word is already in the list.')).toBeTruthy();
    expect(calls('POST', 'catalog/admin/topics')).toHaveLength(0);
  });

  it('puts the refusals of the API on the rows they name', async () => {
    serve({
      ...base(),
      'POST catalog/admin/topics': refuse(409, 'topic.term-taken', {
        fields: [{ path: `synonyms.${locales.default}.1`, code: 'taken' }],
      }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    const lang = languageOf(locales.default);
    fireEvent.change(within(dialog).getByLabelText(required()), { target: { value: 'BBQ' } });
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'use' } });
    const add = within(dialog).getByRole('button', { name: 'Add synonym' });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);
    // Row 2 stays empty, so the second synonym sent is row 3.
    fireEvent.change(within(dialog).getByLabelText(`Synonym 1 (${lang})`), {
      target: { value: 'Barbecue' },
    });
    fireEvent.change(within(dialog).getByLabelText(`Synonym 3 (${lang})`), {
      target: { value: 'Grill' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(
      await within(dialog).findByText('Another tag already uses one of these words.'),
    ).toBeTruthy();
    const row3 = within(dialog).getByLabelText(`Synonym 3 (${lang})`);
    expect(row3.getAttribute('aria-invalid')).toBe('true');
    expect(
      within(dialog).getByLabelText(`Synonym 1 (${lang})`).getAttribute('aria-invalid'),
    ).not.toBe('true');
  });

  it('edits with the version seen, the address read-only and the status', async () => {
    serve({
      ...base([
        topic(1, {
          slug: 'ramadan',
          names: { [main()]: 'Ramadan' },
          synonyms: { [main()]: ['Ramazan'] },
          intro: 'The month of fasting.',
        }),
      ]),
      'PUT catalog/admin/topics/': ok({ topic: topic(1) }),
    });
    mount();
    await act('Ramadan', 'Edit…');
    const dialog = screen.getByRole('dialog');
    const slug = within(dialog).getByLabelText<HTMLInputElement>('Address');
    expect(slug.readOnly).toBe(true);
    expect(slug.value).toBe('ramadan');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Active/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expectToast('Tag 1 was saved.');
    const put = calls('PUT', 'catalog/admin/topics/')[0];
    expect(put?.[1]).toBe(`catalog/admin/topics/${id(1)}`);
    expect(put?.[2]).toEqual({
      version: 2,
      group: 'occasion',
      names: { [locales.default]: 'Ramadan' },
      synonyms: { [locales.default]: ['Ramazan'] },
      intro: 'The month of fasting.',
      status: 'archived',
    });
  });

  it('shows a certification word at the name and reloads on a stale version', async () => {
    serve({
      ...base([topic(1, { names: { [main()]: 'Eid' } })]),
      'PUT catalog/admin/topics/': refuse(422, 'topic.claim-word', {
        fields: [{ path: `names.${locales.default}`, code: 'claim-word' }],
      }),
    });
    mount();
    await act('Eid', 'Edit…');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findAllByText(
        'Certification words such as halal or organic cannot be used in a tag.',
      ),
    ).toHaveLength(2);
    serve({
      ...base([topic(1, { names: { [main()]: 'Eid' } })]),
      'PUT catalog/admin/topics/': refuse(409, 'conflict.stale'),
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload the list' }));
    expect(await screen.findByText(/Someone else changed that tag/)).toBeTruthy();
  });
});

describe('the tag form with a second language (market ZZ)', () => {
  beforeEach(() => {
    LOCALES = MARKETS[1]!.locales;
  });

  it('gives each language its synonyms, labels the buttons by language, and drops them with it', async () => {
    serve({ ...base(), 'POST catalog/admin/topics': ok({ topic: topic(9) }) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Add language' }));
    fireEvent.click(await screen.findByRole('option', { name: /English/ }));
    const ja = languageOf('ja-JP');
    const en = languageOf('en-US');
    fireEvent.change(within(dialog).getByLabelText(`${ja} (required)`), {
      target: { value: 'ラマダン' },
    });
    fireEvent.change(within(dialog).getByLabelText(en), { target: { value: 'Ramadan' } });
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'occasion' } });
    fireEvent.click(within(dialog).getByRole('button', { name: `Add synonym in ${en}` }));
    fireEvent.change(within(dialog).getByLabelText(`Synonym 1 (${en})`), {
      target: { value: 'Ramazan' },
    });
    expect(within(dialog).getByRole('button', { name: `Remove synonym 1 (${en})` })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    await expectToast('Tag 9 was created.');
    expect(calls('POST', 'catalog/admin/topics')[0]?.[2]).toEqual({
      group: 'occasion',
      names: { 'ja-JP': 'ラマダン', 'en-US': 'Ramadan' },
      synonyms: { 'en-US': ['Ramazan'] },
      intro: null,
    });
  });

  it('shows a language that cannot be checked at its name', async () => {
    serve({
      ...base(),
      'POST catalog/admin/topics': refuse(422, 'topic.locale-uncheckable', {
        fields: [{ path: 'names.ja-JP', code: 'locale-uncheckable' }],
      }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(`${languageOf('ja-JP')} (required)`), {
      target: { value: 'ラマダン' },
    });
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'occasion' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(
      await within(dialog).findByText(
        'This language cannot be checked for certification words yet.',
      ),
    ).toBeTruthy();
  });
});

describe('tag form rules', () => {
  it('maps refusals to message keys and fields', () => {
    expect(tagProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'tags.error.stale',
      reload: true,
    });
    expect(tagProblemOf({ status: 409, code: 'topic.slug-taken' })).toMatchObject({
      key: 'tags.error.slug-taken',
      fields: [{ path: 'slug', code: 'slug-taken' }],
    });
    expect(tagProblemOf({ status: 503, code: 'access.unavailable' }).key).toBe(
      'tags.error.unavailable',
    );
    expect(tagProblemOf({ status: 418, code: 'x' }).key).toBe('tags.error.unknown');
    const form = {
      ...emptyForm('en'),
      languages: [
        {
          locale: 'en',
          name: 'BBQ',
          synonyms: [
            { key: 101, text: '' },
            { key: 102, text: 'Grill' },
          ],
        },
      ],
    };
    expect(
      fieldsOf(
        [
          { path: 'names.en', code: 'taken' },
          { path: 'synonyms.en.0', code: 'claim-word' },
          { path: 'synonyms.ar', code: 'name-missing' },
          { path: 'intro', code: 'link' },
          { path: 'slug', code: 'slug-taken' },
          { path: 'group', code: 'unknown' },
          { path: 'zzz', code: 'x' },
        ],
        form,
      ),
    ).toEqual({
      names: { en: 'name-taken' },
      synonyms: { 102: 'claim-word' },
      synonymLists: { ar: 'name-missing' },
      intro: 'link',
      slug: 'slug-taken',
      group: 'group-required',
    });
  });

  it('checks the form and builds the body', () => {
    const empty = emptyForm('en');
    expect(checkForm(empty, 'en', true)).toEqual({
      names: { en: 'name-required' },
      group: 'group-required',
    });
    const filled = {
      ...empty,
      group: 'use' as const,
      languages: [
        { locale: 'en', name: ' BBQ ', synonyms: [{ key: 1, text: ' Barbecue ' }] },
        { locale: 'ar', name: ' ', synonyms: [] },
      ],
    };
    expect(checkForm(filled, 'en', true)).toEqual({});
    expect(checkForm({ ...filled, slug: 'Bad Slug' }, 'en', true)).toEqual({
      slug: 'slug-format',
    });
    expect(checkForm({ ...filled, slug: 'Bad Slug' }, 'en', false)).toEqual({});
    expect(checkForm({ ...filled, intro: 'x'.repeat(1001) }, 'en', true)).toEqual({
      intro: 'intro-long',
    });
    const many = Array.from({ length: 11 }, (_, i) => ({ key: 200 + i, text: `Grill ${i}` }));
    expect(
      checkForm(
        {
          ...filled,
          languages: [
            { locale: 'en', name: 'BBQ', synonyms: many },
            { locale: 'ar', name: '', synonyms: [{ key: 300, text: 'شواء' }] },
          ],
        },
        'en',
        true,
      ),
    ).toEqual({ synonymLists: { en: 'too-many', ar: 'name-missing' } });
    expect(bodyOf({ ...filled, active: false }, true)).toEqual({
      group: 'use',
      names: { en: 'BBQ' },
      synonyms: { en: ['Barbecue'] },
      intro: null,
      status: 'archived',
    });
    expect(bodyOf({ ...filled, slug: 'bbq' }, false)).toHaveProperty('slug', 'bbq');
    expect(bodyOf({ ...filled, slug: 'bbq' }, true)).not.toHaveProperty('slug');
    expect(bodyOf(filled, false)).not.toHaveProperty('status');
    expect(
      formOf(
        topic(1, { names: { ar: 'ب', en: 'A' }, synonyms: { fa: ['x'] } }),
        'en',
      ).languages.map((r) => r.locale),
    ).toEqual(['en', 'ar', 'fa']);
    expect(fieldsOf([{ path: 'slug', code: 'format' }], emptyForm('en'))).toEqual({
      slug: 'slug-format',
    });
    expect(suggestSlug('Café & Brunch')).toBe('cafe-and-brunch');
    expect(suggestSlug('نوروز')).toBe('topic');
  });
});
