// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { callApi, type ApiResult } from '../api/client.ts';
import { CategoriesView } from './categories-view.tsx';
import type { CategoryRow, DetailBody, TreeBody } from './types.ts';

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
const tree = (): TreeBody => ({
  treeVersion: 7,
  defaultLocale: 'en',
  supportedLocales: ['en', 'fa'],
  requiredLocales: ['en'],
  complete: true,
  categories: [
    row(1, null, 0, 'Pantry'),
    row(2, 1, 1, 'Rice', {
      names: [
        { locale: 'en', name: 'Rice' },
        { locale: 'fa', name: 'برنج' },
      ],
    }),
    row(3, 1, 1, 'Oils', { status: 'hidden' }),
    row(4, null, 0, 'Drinks'),
  ],
  actions: {},
});
const detail = (r: CategoryRow): DetailBody => ({
  category: r,
  path: [{ id: r.id, slug: r.slug, name: r.names[0]?.name ?? null }],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [],
  complete: true,
  actions: {},
  details: {
    texts: r.names.map((entry) => ({
      locale: entry.locale,
      name: entry.name,
      shortDescription: null,
      keywords: [],
    })),
    seo: { title: null, description: null, noindex: false },
    showInMenu: true,
    imageId: null,
    hiddenById: null,
  },
  treeVersion: 7,
});
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const written = {
  category: { id: id(2), slug: 'c-2', status: 'active', version: 4, revisionNo: 2, treeVersion: 8 },
};

/** Serves the tree and the detail of any category; writes answer `writeAnswer`. */
function serve(writeAnswer: ApiResult<unknown> = ok(written)) {
  call.mockImplementation((method: string, path: string) => {
    if (method !== 'GET') return Promise.resolve(writeAnswer);
    if (path === 'catalog/admin/categories') return Promise.resolve(ok(tree()));
    const found = tree().categories.find((c) => path === `catalog/admin/categories/${c.id}`);
    return Promise.resolve(found === undefined ? ok(null) : ok(detail(found)));
  });
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

const view = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

async function pick(name: string) {
  const items = await screen.findAllByRole('treeitem');
  fireEvent.click(items.find((el) => el.textContent?.includes(name))!);
  await screen.findByRole('heading', { name });
}

beforeEach(() => {
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

describe('category editor (C3b)', () => {
  it('adds a department hidden: suggests the URL name and sends the tree version it read', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await screen.findAllByRole('treeitem');
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/starts hidden/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name (English)'), {
      target: { value: 'Dried Fruit' },
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('URL name').value).toBe('dried-fruit');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      'catalog/admin/categories',
      {
        parentId: null,
        slug: 'dried-fruit',
        texts: { en: { name: 'Dried Fruit', shortDescription: null, keywords: [] } },
        seo: { title: null, description: null, noindex: false },
        showInMenu: true,
        treeVersion: 7,
      },
      'tok',
    ]);
  });

  it('refuses an empty required name before any request', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await screen.findAllByRole('treeitem');
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add category' }));
    expect(await within(dialog).findAllByText('This is required.')).not.toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('edits details with the category version; Persian fields read right to left and are marked Missing when empty', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = screen.getByRole('dialog');
    const language = within(dialog).getByLabelText<HTMLSelectElement>('Language');
    expect(within(language).getByRole('option', { name: 'Persian · Missing' })).toBeTruthy();
    fireEvent.change(language, { target: { value: 'fa' } });
    const persian = within(dialog).getByLabelText('Name (Persian)');
    expect(persian.getAttribute('dir')).toBe('rtl');
    fireEvent.change(persian, { target: { value: 'خشکبار' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [method, path, body] = writes()[0]!;
    expect(method).toBe('PATCH');
    expect(path).toBe(`catalog/admin/categories/${id(1)}`);
    expect(body).toMatchObject({
      version: 3,
      texts: {
        en: { name: 'Pantry' },
        fa: { name: 'خشکبار', shortDescription: null, keywords: [] },
      },
    });
  });

  it('shows the search preview from the typed words', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search engines' }));
    fireEvent.change(within(dialog).getByLabelText(/Search title/), {
      target: { value: 'Pantry staples' },
    });
    expect(within(dialog).getByTestId('preview-title').textContent).toBe('Pantry staples');
    expect(within(dialog).getByTestId('preview-url').textContent).toBe('www.example.com/c/c-1');
  });

  it('asks before Hide, then sends the tree version', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 categories below it/)).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/categories/${id(1)}/hide`,
      { treeVersion: 7 },
      'tok',
    ]);
  });

  it('offers Show and Discard on a hidden category with no products and no children, never on an active one', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Oils');
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
    cleanup();
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });

  it('disables Move up on the first sibling and Move down on the last, and sends the direction', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Rice');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move up' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `catalog/admin/categories/${id(2)}/reorder`,
      { direction: 'down', treeVersion: 7 },
      'tok',
    ]);
  });

  it('warns about search engines when the URL name changes', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Rice');
    fireEvent.click(screen.getByRole('button', { name: 'Change URL name' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/search engines need time/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('URL name'), {
      target: { value: 'basmati-rice' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change URL name' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({ slug: 'basmati-rice', treeVersion: 7 });
  });

  it('on a stale write says so and offers to read again; field problems show at the field', async () => {
    serve({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Hide' }));
    expect(await screen.findByText(/Someone changed the categories/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read again' })).toBeTruthy();
    cleanup();

    serve({
      ok: false,
      failure: {
        status: 422,
        code: 'category.claim-word',
        details: { fields: [{ path: 'texts.en.name', code: 'claim-word' }] },
      },
    });
    view(<CategoriesView canEdit csrfToken="tok" />);
    await pick('Pantry');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findAllByText(/names a certification or a similar claim/),
    ).not.toHaveLength(0);
  });

  it('filters by a missing language and counts what is missing in each', async () => {
    serve();
    view(<CategoriesView canEdit csrfToken="tok" />);
    await screen.findAllByRole('treeitem');
    const select = screen.getByLabelText<HTMLSelectElement>('Missing a name');
    // Pantry, Oils and Drinks have no Persian name; Rice has one.
    expect(within(select).getByRole('option', { name: 'Missing: Persian (3)' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: 'Missing: English (0)' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'fa' } });
    await waitFor(() =>
      expect(screen.getAllByRole('treeitem').map((el) => el.textContent)).toEqual([
        expect.stringContaining('Pantry'),
        expect.stringContaining('Oils'),
        expect.stringContaining('Drinks'),
      ]),
    );
  });

  it('shows no change buttons to a reader', async () => {
    serve();
    view(<CategoriesView canEdit={false} />);
    await pick('Pantry');
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add category' })).toBeNull();
  });
});
