// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { callApi, type ApiResult } from '../api/client.ts';
import { CategoriesView } from './categories-view.tsx';
import { CategoryPageView } from './category-page-view.tsx';
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
  position: 0,
  version: 1,
  counts: { liveProducts: n, liveProductsDirect: 0, offers: 0 },
  ...over,
});
const tree = (over: Partial<TreeBody> = {}): TreeBody => ({
  treeVersion: 1,
  defaultLocale: 'en',
  supportedLocales: ['en', 'fa'],
  requiredLocales: ['en'],
  complete: true,
  categories: [
    row(1, null, 0, 'Pantry'),
    row(2, 1, 1, 'Rice'),
    row(3, 2, 2, 'Basmati', {
      names: [
        { locale: 'en', name: 'Basmati' },
        { locale: 'fa', name: 'باسماتی' },
      ],
    }),
    row(4, 1, 1, 'Oils', { status: 'archived' }),
    row(5, null, 0, 'Drinks'),
  ],
  actions: {},
  ...over,
});
const detail = (r: CategoryRow, over: Partial<DetailBody> = {}): DetailBody => ({
  category: r,
  path: [
    { id: id(1), slug: 'c-1', name: 'Pantry' },
    { id: r.id, slug: r.slug, name: r.names[0]?.name ?? null },
  ],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [
    {
      revisionNo: 1,
      changeKind: 'create',
      authorKind: 'seed',
      authorAccountId: null,
      parentId: null,
      names: r.names,
      createdAt: '2026-10-01T01:00:00.000Z',
    },
  ],
  complete: true,
  actions: {},
  ...over,
});
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });

function serve(routes: Record<string, ApiResult<unknown>>) {
  call.mockImplementation(((_method: string, path: string) => {
    const hit = Object.keys(routes)
      .filter((key) => path.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    return Promise.resolve(
      hit === undefined ? { ok: false, failure: { status: 500, code: 'x' } } : routes[hit],
    );
  }) as never);
}
const wide = (matches: boolean) =>
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches, addEventListener() {}, removeEventListener() {} }),
  });
const view = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  call.mockReset();
  push.mockReset();
  wide(true);
});
afterEach(cleanup);

describe('CategoriesView', () => {
  it('lists the departments open one level, as a tree with levels and counts', async () => {
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    const items = await screen.findAllByRole('treeitem');
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Pantry'),
      expect.stringContaining('Rice'),
      expect.stringContaining('Oils'),
      expect.stringContaining('Drinks'),
    ]);
    expect(items[0]?.getAttribute('aria-level')).toBe('1');
    expect(items[1]?.getAttribute('aria-level')).toBe('2');
    expect(items[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(within(items[2]!).getByText('Archived')).toBeTruthy();
    expect(screen.queryByText("Your role can't change categories.")).toBeNull();
  });

  it('shows "at least" when the counts are partial, and the view-only note for a reader', async () => {
    serve({ 'catalog/admin/categories': ok(tree({ complete: false })) });
    view(<CategoriesView canEdit={false} />);
    await screen.findAllByRole('treeitem');
    expect(screen.getAllByText(/at least/).length).toBeGreaterThan(0);
    expect(screen.getByText("Your role can't change categories.")).toBeTruthy();
  });

  it('moves with the keyboard: Down, Right to open, Left to close, End', async () => {
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    const first = (await screen.findAllByRole('treeitem'))[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Rice'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('Basmati')).toBeTruthy());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.queryByText('Basmati')).toBeNull());
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Drinks'));
  });

  it('keeps one tab stop', async () => {
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    const items = await screen.findAllByRole('treeitem');
    expect(items.filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  it('shows the details of the picked category beside the tree, with its tabs', async () => {
    const rice = tree().categories[1]!;
    serve({
      'catalog/admin/categories/': ok(detail(rice)),
      'catalog/admin/categories': ok(tree()),
    });
    view(<CategoriesView canEdit />);
    fireEvent.click((await screen.findAllByRole('treeitem'))[1]!);
    expect(await screen.findByRole('heading', { name: 'Rice' })).toBeTruthy();
    expect(screen.getByText('c-2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText(/Revision 1/)).toBeTruthy();
    expect(screen.getByText(/Set up with the platform/)).toBeTruthy();
  });

  it('opens the details as a page on a narrow screen', async () => {
    wide(false);
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    fireEvent.click((await screen.findAllByRole('treeitem'))[1]!);
    expect(push).toHaveBeenCalledWith(`/catalog/categories/${id(2)}`);
  });

  it('a search finds a deep category with its ancestors; no match says so', async () => {
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    await screen.findAllByRole('treeitem');
    fireEvent.change(screen.getByLabelText('Search categories'), { target: { value: 'basm' } });
    await waitFor(() =>
      expect(screen.getAllByRole('treeitem').map((el) => el.textContent)).toEqual([
        expect.stringContaining('Pantry'),
        expect.stringContaining('Rice'),
        expect.stringContaining('Basmati'),
      ]),
    );
    fireEvent.change(screen.getByLabelText('Search categories'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No categories match "zzz".')).toBeTruthy();
  });

  it('filters by status', async () => {
    serve({ 'catalog/admin/categories': ok(tree()) });
    view(<CategoriesView canEdit />);
    await screen.findAllByRole('treeitem');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'archived' } });
    expect(screen.getAllByRole('treeitem').map((el) => el.textContent)).toEqual([
      expect.stringContaining('Pantry'),
      expect.stringContaining('Oils'),
    ]);
  });

  it('says so when there are no categories, and offers a retry on a failed load', async () => {
    serve({ 'catalog/admin/categories': ok(tree({ categories: [] })) });
    view(<CategoriesView canEdit />);
    expect(await screen.findByText('No categories yet.')).toBeTruthy();
    cleanup();
    serve({ 'catalog/admin/categories': { ok: false, failure: { status: 503, code: 'x' } } });
    view(<CategoriesView canEdit />);
    expect(await screen.findByText("We couldn't load categories. Try again.")).toBeTruthy();
    serve({ 'catalog/admin/categories': ok(tree()) });
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect((await screen.findAllByRole('treeitem')).length).toBeGreaterThan(0);
  });
});

describe('CategoryPageView', () => {
  it('shows one category with a way back, and Persian names right to left', async () => {
    const basmati = tree().categories[2]!;
    serve({
      'catalog/admin/categories/': ok(detail(basmati, { requiredLocales: ['en', 'fa'] })),
    });
    view(<CategoryPageView id={basmati.id} canEdit={false} />);
    expect(await screen.findByRole('heading', { name: 'Basmati' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Back to the category tree' }).getAttribute('href'),
    ).toBe('/catalog/categories');
    expect(screen.getByText('باسماتی').getAttribute('dir')).toBe('rtl');
    expect(screen.getByText("Your role can't change categories.")).toBeTruthy();
  });

  it('shows a missing locale and answers not found for an unknown category', async () => {
    const rice = tree().categories[1]!;
    serve({
      'catalog/admin/categories/': ok(
        detail(rice, { requiredLocales: ['en', 'fa'], missingLocales: ['fa'] }),
      ),
    });
    view(<CategoryPageView id={rice.id} canEdit />);
    expect(await screen.findByText(/no name yet: fa/)).toBeTruthy();
    cleanup();
    serve({ 'catalog/admin/categories/': { ok: false, failure: { status: 404, code: 'x' } } });
    view(<CategoryPageView id={id(9)} canEdit />);
    expect(await screen.findByText('This category was not found.')).toBeTruthy();
  });

  it('reads the impact on the Products tab and says "at least" when it is partial', async () => {
    const rice = tree().categories[1]!;
    serve({
      'catalog/admin/categories/': ok(detail(rice)),
      [`catalog/admin/categories/${rice.id}/impact?action=archive`]: ok({
        action: 'archive',
        products: 4,
        directProducts: 1,
        offers: 6,
        listedOffers: 5,
        offersWithActiveTag: 2,
        descendants: 3,
        complete: false,
      }),
    });
    view(<CategoryPageView id={rice.id} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Products' }));
    expect(await screen.findByText('at least 4')).toBeTruthy();
    expect(screen.getByText('Categories under it')).toBeTruthy();
  });
});
