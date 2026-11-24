// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  // These tests count the form's own calls; the writer's status read is tested in writer-in-form.
  DescriptionWriter: () => null,
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import { categoryIssuesOf, isCategoryIssue } from './category-issues.ts';
import { editProblemOf } from './edit-errors.ts';
import { EditForm } from './edit-form.tsx';
import type { ProductView } from './types.ts';

// The "Categories" field of the product form (categories C5b): the picker, Make primary, the limit
// of three and the refusals of a submit told next to the category they are about.

const call = vi.mocked(callApi);
const PICKER = 'catalog/seller/products/category-picker';
const hint = "Choose a category or subcategory. Products can't go on a department or group.";
const levelError = "Choose a more specific category. Products can't go on a department or group.";
const choice = (id: string, path: string[], general = false) => ({
  id,
  level: path.length,
  name: path[path.length - 1],
  path,
  general,
  status: 'active',
});
const CHOICES = [
  choice('basmati', ['Pantry', 'Rice', 'Basmati']),
  choice('rice', ['Pantry', 'Rice'], true),
  choice('oils', ['Pantry', 'Oils']),
  choice('tea', ['Drinks', 'Tea']),
];
const picker = (body: unknown = { locale: 'en-AU', choices: CHOICES }) =>
  ({ ok: true, status: 200, body }) as const;
const saved = { ok: true, status: 200, body: { variantIds: ['v1'], refusedFields: [] } } as const;

const product = (categoryIds: string[] = []): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  variants: [{ variantId: 'v1', state: 'active', variantCode: 'P-000001-0v1' }],
  maxVariants: 5,
  sensitiveFields: [],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: {
    taxCategories: [{ code: 'standard', labelKey: 'catalog.tax.standard' }],
    units: [],
    fields: [],
    categories: [
      { categoryId: 'oils', parentId: 'pantry', names: { 'en-AU': 'Oils' } },
      { categoryId: 'pantry', parentId: null, names: { 'en-AU': 'Pantry' } },
    ],
  },
  workingCopy: {
    content: {
      texts: { 'en-AU': { name: 'Olive oil' } },
      taxCategoryCode: 'standard',
      categoryIds,
    },
    lastSavedAt: '2026-10-01T00:00:00Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
});
const mount = (p: ProductView = product()) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={p}
        photos={[]}
        locales={['en-AU']}
        defaultLocale="en-AU"
        marketName="Australia"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
const add = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
  fireEvent.click(await screen.findByRole('option', { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { assign: vi.fn(), href: 'http://seller.localhost/products/p1/edit' },
    writable: true,
  });
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

describe('the category field of the seller product form', () => {
  it('shows the hint and names a saved category by its path without reading the picker', () => {
    mount(product(['oils']));
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText('Oils')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('reads the picker once, when the Add control opens, and offers "General"', async () => {
    call.mockResolvedValue(picker());
    mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByRole('option', { name: /^Pantry › Rice › General/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Pantry › Rice › Basmati/ })).toBeTruthy();
    expect(call.mock.calls.filter(([, path]) => path === PICKER)).toHaveLength(1);
  });

  it('shows a failure to read the picker and reads it again on retry', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    call.mockResolvedValueOnce(picker());
    mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByText("We couldn't load the categories.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /^Drinks › Tea/ })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('adds up to three in one department, makes one primary, and saves them in that order', async () => {
    call.mockImplementation((method) => Promise.resolve(method === 'GET' ? picker() : saved));
    mount();
    await add(/^Pantry › Oils/);
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByRole('option', { name: /^Pantry › Rice › General/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^Drinks › Tea/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /^Pantry › Rice › General/ }));
    await add(/^Pantry › Rice › Basmati/);
    expect(
      screen.getByText('A product can be in up to 3 categories. Remove one to add another.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Other categories must be in the same department as the primary one.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make primary: Pantry › Rice › General' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      content: { categoryIds: ['rice', 'oils', 'basmati'] },
    });
  });

  it('removes a category', () => {
    mount(product(['oils', 'pantry']));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pantry › Oils' }));
    const list = screen.getByRole('list');
    expect(within(list).queryByText('Pantry › Oils')).toBeNull();
    expect(within(list).getByText('Primary')).toBeTruthy();
  });

  it('tells a refused submit next to the category, and clears it when the list changes', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 422,
        code: 'revision.not-ready',
        details: {
          issues: [
            { path: 'categoryIds.0', code: 'category.level-not-allowed' },
            { path: 'categoryIds.1', code: 'category.not-available' },
            { path: 'attributes.size', code: 'required' },
          ],
        },
      },
    });
    mount(product(['pantry', 'oils']));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(levelError, { selector: '[role="alert"]' })).toBeTruthy();
    expect(
      screen.getByText("This category isn't available any more. Remove it and choose another."),
    ).toBeTruthy();
    // Other refusals stay as lines; the category ones are not repeated as raw codes.
    expect(screen.getByText('attributes.size: required')).toBeTruthy();
    expect(screen.queryByText(/categoryIds/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pantry' }));
    expect(
      screen.queryByText("This category isn't available any more. Remove it and choose another."),
    ).toBeNull();
  });
});

describe('category issues of a refused submit', () => {
  it('maps every code to one place', () => {
    const found = categoryIssuesOf([
      { path: 'categoryIds', code: 'required' },
      { path: 'categoryIds.0', code: 'duplicate' },
      { path: 'categoryIds.1', code: 'unknown' },
      { path: 'categoryIds.2', code: 'category.not-available' },
      { path: 'categoryIds.3', code: 'category.level-not-allowed' },
      { path: 'categoryIds.4', code: 'category.not-same-branch' },
      { path: 'topicIds.0', code: 'unknown' },
    ]);
    expect(found).toEqual({
      list: 'required',
      items: {
        0: 'duplicate',
        1: 'unknown',
        2: 'not-available',
        3: 'level-not-allowed',
        4: 'not-same-branch',
      },
    });
    expect(categoryIssuesOf([{ path: 'categoryIds', code: 'too-many' }]).list).toBe('too-many');
  });

  it('ignores another field and a code the list does not carry', () => {
    expect(isCategoryIssue({ path: 'topicIds.0', code: 'unknown' })).toBe(false);
    expect(isCategoryIssue({ path: 'categoryIds', code: 'duplicate' })).toBe(false);
    expect(isCategoryIssue({ path: 'categoryIds.1', code: 'too-many' })).toBe(false);
    expect(isCategoryIssue({ path: 'categoryIds.1', code: 'unknown' })).toBe(true);
  });

  it('keeps them out of the raw lines of the problem', () => {
    const problem = editProblemOf({
      status: 422,
      code: 'revision.not-ready',
      details: { issues: [{ path: 'categoryIds', code: 'too-many' }] },
    });
    expect(problem.details).toEqual([]);
    expect(problem.categoryIssues?.list).toBe('too-many');
  });

  it('has a sentence for every code', () => {
    const errors = (
      messages as unknown as {
        catalog: { edit: { 'categories-error': Record<string, string> } };
      }
    ).catalog.edit['categories-error'];
    expect(Object.keys(errors).sort()).toEqual(
      [
        'duplicate',
        'level-not-allowed',
        'not-available',
        'not-in-activity',
        'not-same-branch',
        'required',
        'too-many',
        'unknown',
      ].sort(),
    );
  });

  it('works for the synthetic ZZ market: its locale, a depth-3 path and the exact hint', async () => {
    const base = product(['zz-leaf']);
    const zzProduct: ProductView = {
      ...base,
      form: {
        ...base.form,
        categories: [
          { categoryId: 'zz-leaf', parentId: 'zz-mid', names: { 'zz-ZZ': 'Quuxen' } },
          { categoryId: 'zz-mid', parentId: 'zz-top', names: { 'zz-ZZ': 'Plinkus' } },
          { categoryId: 'zz-top', parentId: null, names: { 'zz-ZZ': 'Zorbia' } },
        ],
      },
    };
    call.mockResolvedValue(
      picker({
        locale: 'zz-ZZ',
        choices: [
          choice('zz-leaf', ['Zorbia', 'Plinkus', 'Quuxen']),
          choice('zz-other', ['Zorbia', 'Vex']),
        ],
      }),
    );
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <EditForm
          product={zzProduct}
          photos={[]}
          locales={['zz-ZZ']}
          defaultLocale="zz-ZZ"
          marketName="Zorbia"
          csrfToken="csrf"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(hint)).toBeTruthy();
    const saved = screen
      .getAllByRole('list')
      .map((l) => l.textContent)
      .join(' ');
    expect(saved).toContain('Quuxen');
    expect(saved).toContain('Plinkus');
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByRole('option', { name: /^Zorbia › Vex/ })).toBeTruthy();
  });
});

describe("the seller's business activity scope (owner decision 2026-10-31)", () => {
  const noActivity = 'Ask the team to set your business activity before choosing categories.';

  it('says to ask the team when the picker answers no-activity, and offers nothing', async () => {
    call.mockResolvedValue(picker({ locale: 'en-AU', choices: [], notice: 'no-activity' }));
    mount();
    expect(screen.queryByText(noActivity)).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByText(noActivity)).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Pantry/ })).toBeNull();
  });

  it('shows no such notice when the picker offers choices', async () => {
    call.mockResolvedValue(picker());
    mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(await screen.findByRole('option', { name: /^Pantry › Oils/ })).toBeTruthy();
    expect(screen.queryByText(noActivity)).toBeNull();
  });

  it('tells a category outside the activity next to it', () => {
    expect(categoryIssuesOf([{ path: 'categoryIds.1', code: 'category.not-in-activity' }])).toEqual(
      { items: { 1: 'not-in-activity' } },
    );
    expect(isCategoryIssue({ path: 'categoryIds.0', code: 'category.not-in-activity' })).toBe(true);
  });
});
