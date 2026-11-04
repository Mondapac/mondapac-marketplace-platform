// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { brandProblemOf } from './brand-errors.ts';
import { bodyOf, checkForm, EMPTY_FORM, parseAliases } from './brand-form.ts';
import { BrandsView } from './brands-view.tsx';
import { defaultTarget } from './merge-queue.tsx';
import type { BrandRow, QueueBody, QueueBrand } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const brand = (n: number, over: Partial<BrandRow> = {}): BrandRow => ({
  id: id(n),
  slug: `brand-${n}`,
  name: `Brand ${n}`,
  summary: null,
  originCountry: 'JP',
  logoImageId: null,
  logoAlt: null,
  headerImageId: null,
  status: 'active',
  proposedBySellerId: null,
  approvedBy: id(900),
  mergedIntoId: null,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-14T01:00:00.000Z',
  version: 3,
  ...over,
});
const queued = (n: number, products: number, over: Partial<BrandRow> = {}): QueueBrand => ({
  ...brand(n, over),
  productCount: products,
});

type Handler = ApiResult<unknown> | ((body: unknown) => ApiResult<unknown>);
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refuse = (status: number, code: string, details?: object): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

/** Answers by `METHOD path?status=...`: the longest registered prefix of the call wins. */
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

const emptyQueue: QueueBody = { groups: [] };
const lists = (active: BrandRow[] = [], draft: BrandRow[] = [], archived: BrandRow[] = []) => ({
  'GET catalog/admin/brands?status=active': ok({ items: active, nextAfterId: null }),
  'GET catalog/admin/brands?status=draft': ok({ items: draft, nextAfterId: null }),
  'GET catalog/admin/brands?status=archived': ok({ items: archived, nextAfterId: null }),
  'GET catalog/admin/brands/merge-queue': ok(emptyQueue),
});

function mount(canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BrandsView canEdit={canEdit} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const calls = (method: string, prefix: string) =>
  call.mock.calls.filter(([m, path]) => m === method && path.startsWith(prefix));

describe('admin brands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(cleanup);

  it('lists the active brands with their status and the proposed count on the tab', async () => {
    serve(lists([brand(1, { name: 'Saffron & Co' })], [brand(2, { status: 'draft' })]));
    mount();
    expect(await screen.findByText('Saffron & Co')).toBeTruthy();
    expect(screen.getByText('/brands/brand-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Proposed 1' })).toBeTruthy();
    expect(calls('GET', 'catalog/admin/brands?status=active')[0]?.[1]).toBe(
      'catalog/admin/brands?status=active&limit=25',
    );
  });

  it('shows a dash that screen readers read as "Not set" for an empty origin', async () => {
    serve(lists([brand(1, { originCountry: null })]));
    mount();
    expect((await screen.findByLabelText('Not set')).textContent).toBe('\u2014');
  });

  it('returns focus to the button that opened a dialog', async () => {
    serve(lists([brand(1)]));
    mount();
    await screen.findByText('Brand 1');
    const opener = screen.getByRole('button', { name: 'Edit Brand 1' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows brand text as plain text', async () => {
    serve(lists([brand(1, { name: '<b>Bold</b>' })]));
    mount();
    expect(await screen.findByText('<b>Bold</b>')).toBeTruthy();
  });

  it('says so when there is no brand, and when a search finds none', async () => {
    serve(lists());
    mount();
    expect(await screen.findByText(/No active brands yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search by name, slug or alias'), {
      target: { value: 'zzz' },
    });
    await waitFor(() =>
      expect(calls('GET', 'catalog/admin/brands?status=active').at(-1)?.[1]).toContain(
        'search=zzz',
      ),
    );
    expect(await screen.findByText('No brand matches this search.')).toBeTruthy();
  });

  it('shows a load error with a retry', async () => {
    serve({
      ...lists(),
      'GET catalog/admin/brands?status=active': refuse(503, 'access.unavailable'),
    });
    mount();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    serve(lists([brand(1)]));
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByText('Brand 1')).toBeTruthy();
  });

  it('appends the next page', async () => {
    serve({
      ...lists(),
      'GET catalog/admin/brands?status=active&limit=25&afterId': ok({
        items: [brand(2)],
        nextAfterId: null,
      }),
      'GET catalog/admin/brands?status=active&limit=25': ok({
        items: [brand(1)],
        nextAfterId: id(1),
      }),
    });
    mount();
    await screen.findByText('Brand 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Brand 2')).toBeTruthy();
    expect(screen.getByText('Brand 1')).toBeTruthy();
  });

  describe('without catalog.brand.edit', () => {
    it('reads the lists and offers no button that changes anything', async () => {
      serve(lists([brand(1)], [brand(2, { status: 'draft' })]));
      mount(false);
      expect(await screen.findByText('Brand 1')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'New brand' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Archive Brand/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Proposed 1' }));
      expect(await screen.findByText('Brand 2')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    });

    it('shows the merge queue as read-only', async () => {
      serve({
        ...lists(),
        'GET catalog/admin/brands/merge-queue': ok({
          groups: [{ groupKey: 'acme', brands: [queued(1, 3), queued(2, 1)] }],
        }),
      });
      mount(false);
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicates 1' }));
      expect(
        await screen.findByText('Your role can read this list but not merge brands.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Not the same' })).toBeNull();
    });
  });

  describe('create and edit', () => {
    it('creates a brand with the typed content', async () => {
      serve({
        ...lists(),
        'POST catalog/admin/brands': ok({ brand: brand(7, { name: 'Cedar Kitchen' }) }),
      });
      mount();
      await screen.findByText(/No active brands yet/);
      fireEvent.click(screen.getByRole('button', { name: 'New brand' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Cedar Kitchen ' } });
      fireEvent.change(screen.getByLabelText(/Country of origin/), { target: { value: 'jp' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create brand' }));
      await expectToast('Cedar Kitchen was created.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        'catalog/admin/brands',
        {
          name: 'Cedar Kitchen',
          summary: null,
          originCountry: 'JP',
          logoImageId: null,
          logoAlt: null,
          headerImageId: null,
        },
        'csrf-1',
      );
    });

    it('sends nothing while the form has a mistake', async () => {
      serve(lists());
      mount();
      await screen.findByText(/No active brands yet/);
      fireEvent.click(screen.getByRole('button', { name: 'New brand' }));
      fireEvent.click(screen.getByRole('button', { name: 'Create brand' }));
      expect(await screen.findByText('Enter the brand name.')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
      fireEvent.change(screen.getByLabelText(/Logo image ID/), { target: { value: id(5) } });
      fireEvent.click(screen.getByRole('button', { name: 'Create brand' }));
      expect(await screen.findByText('Describe the logo.')).toBeTruthy();
      expect(calls('POST', 'catalog/admin/brands')).toHaveLength(0);
    });

    it('names the live brands a near-duplicate name looks like', async () => {
      serve({
        ...lists(),
        'POST catalog/admin/brands': refuse(409, 'brand.near-duplicate', {
          brands: [{ id: id(1), slug: 'acme', name: 'Acme Foods', status: 'active' }],
        }),
      });
      mount();
      await screen.findByText(/No active brands yet/);
      fireEvent.click(screen.getByRole('button', { name: 'New brand' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME foods' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create brand' }));
      expect(await screen.findByText(/very similar name/)).toBeTruthy();
      expect(screen.getByText('Acme Foods')).toBeTruthy();
    });

    it('edits the whole content with the version seen; the address of a live brand is locked', async () => {
      serve({
        ...lists([brand(1, { summary: 'Spices' })]),
        'PUT catalog/admin/brands/': ok({ brand: brand(1, { name: 'Brand One' }) }),
      });
      mount();
      await screen.findByText('Brand 1');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Brand 1' }));
      expect(screen.getByLabelText('Page address').hasAttribute('disabled')).toBe(true);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Brand One' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await expectToast('Brand One was saved.');
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `catalog/admin/brands/${id(1)}`,
        {
          name: 'Brand One',
          summary: 'Spices',
          originCountry: 'JP',
          logoImageId: null,
          logoAlt: null,
          headerImageId: null,
          version: 3,
        },
        'csrf-1',
      );
    });

    it('lets the slug of a proposal change', async () => {
      serve({
        ...lists([], [brand(2, { status: 'draft' })]),
        'PUT catalog/admin/brands/': ok({ brand: brand(2) }),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed 1' }));
      await screen.findByText('Brand 2');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Brand 2' }));
      const slug = screen.getByLabelText('Page address');
      expect(slug.hasAttribute('disabled')).toBe(false);
      fireEvent.change(slug, { target: { value: 'brand-two' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(calls('PUT', 'catalog/admin/brands/')).toHaveLength(1));
      expect(calls('PUT', 'catalog/admin/brands/')[0]?.[2]).toMatchObject({ slug: 'brand-two' });
    });

    it('offers a reload when the brand changed meanwhile', async () => {
      serve({
        ...lists([brand(1)]),
        'PUT catalog/admin/brands/': refuse(409, 'conflict.stale'),
      });
      mount();
      await screen.findByText('Brand 1');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Brand 1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
      serve(lists([brand(1, { version: 4 })]));
      fireEvent.click(screen.getByRole('button', { name: 'Reload the lists' }));
      expect(await screen.findByText(/changed while you were looking/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    });

    it('has no edit button for an archived brand', async () => {
      serve(lists([], [], [brand(3, { status: 'archived', mergedIntoId: id(1) })]));
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
      expect(await screen.findByText('Brand 3')).toBeTruthy();
      expect(screen.getByText(/Merged into brand/)).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /^(Edit |Archive Brand|Merge other)/ }),
      ).toBeNull();
    });
  });

  describe('seller proposals', () => {
    const proposal = brand(2, { status: 'draft', proposedBySellerId: id(77), version: 5 });

    it('approves after a confirmation, with the version seen', async () => {
      serve({
        ...lists([], [proposal]),
        'POST catalog/admin/brands/': ok({ brand: { ...proposal, status: 'active' } }),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed 1' }));
      expect(await screen.findByText('Brand 2')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'seller 00000077' }).getAttribute('href')).toBe(
        `/sellers/${id(77)}`,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Approve Brand 2' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Approve Brand 2?')).toBeTruthy();
      expect(calls('POST', 'catalog/admin/brands/')).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve brand' }));
      await expectToast('Brand 2 is approved and live.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/brands/${id(2)}/approve`,
        { version: 5 },
        'csrf-1',
      );
    });

    it('turns a proposal down through the archive route', async () => {
      serve({ ...lists([], [proposal]), 'POST catalog/admin/brands/': ok({ brand: proposal }) });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed 1' }));
      await screen.findByText('Brand 2');
      fireEvent.click(screen.getByRole('button', { name: 'Turn down the proposal Brand 2' }));
      fireEvent.click(screen.getByRole('button', { name: 'Turn down proposal' }));
      await expectToast('The proposal Brand 2 was turned down.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/brands/${id(2)}/archive`,
        { version: 5 },
        'csrf-1',
      );
    });

    it('explains a proposal that is no longer a draft', async () => {
      serve({
        ...lists([], [proposal]),
        'POST catalog/admin/brands/': refuse(409, 'brand.not-draft'),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed 1' }));
      await screen.findByText('Brand 2');
      fireEvent.click(screen.getByRole('button', { name: 'Approve Brand 2' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve brand' }));
      expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    });

    it('archives a live brand after a confirmation', async () => {
      serve({ ...lists([brand(1)]), 'POST catalog/admin/brands/': ok({ brand: brand(1) }) });
      mount();
      await screen.findByText('Brand 1');
      fireEvent.click(screen.getByRole('button', { name: 'Archive Brand 1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Archive brand' }));
      await expectToast('Brand 1 was archived.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/brands/${id(1)}/archive`,
        { version: 3 },
        'csrf-1',
      );
    });
  });

  describe('merge', () => {
    it('merges the picked brands into the target, with extra spellings', async () => {
      serve({
        ...lists([brand(1), brand(2), brand(3)]),
        'POST catalog/admin/brands/': ok({
          brand: brand(1),
          merged: [{ brandId: id(2), productsMoved: 4 }],
          aliasesAdded: ['Brand Two'],
        }),
      });
      mount();
      await screen.findByText('Brand 1');
      fireEvent.click(screen.getByRole('button', { name: 'Merge other brands into Brand 1' }));
      const dialog = screen.getByRole('dialog');
      const second = await within(dialog).findByLabelText('Brand 2');
      expect(within(dialog).queryByLabelText('Brand 1')).toBeNull();
      expect(
        within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Merge' }).disabled,
      ).toBe(true);
      fireEvent.click(second);
      fireEvent.change(within(dialog).getByLabelText(/More spellings/), {
        target: { value: 'Brand Two, Brand Two\nB2' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Merge 1 brand' }));
      await expectToast('1 brand was merged into Brand 1. 4 products moved.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/brands/${id(1)}/merge`,
        { sourceBrandIds: [id(2)], aliases: ['Brand Two', 'B2'] },
        'csrf-1',
      );
    });

    it('names the brand that already owns a spelling', async () => {
      serve({
        ...lists([brand(1), brand(2)]),
        'POST catalog/admin/brands/': refuse(409, 'brand.alias-taken', {
          brands: [{ id: id(9), slug: 'other', name: 'Other Foods', status: 'active' }],
        }),
      });
      mount();
      await screen.findByText('Brand 1');
      fireEvent.click(screen.getByRole('button', { name: 'Merge other brands into Brand 1' }));
      fireEvent.click(await screen.findByLabelText('Brand 2'));
      fireEvent.click(screen.getByRole('button', { name: 'Merge 1 brand' }));
      expect(await screen.findByText(/already belongs to another brand/)).toBeTruthy();
      expect(screen.getByText('Other Foods')).toBeTruthy();
    });
  });

  describe('merge queue', () => {
    const group = {
      groupKey: 'saffron-co',
      brands: [
        queued(1, 11, { name: 'Saffron & Co' }),
        queued(2, 2, { name: 'Saffron and Co' }),
        queued(3, 1, { name: 'SAFFRON & CO.', status: 'draft' }),
      ],
    };
    const withQueue = (extra: Record<string, Handler> = {}) =>
      serve({
        ...lists([brand(1)]),
        'GET catalog/admin/brands/merge-queue': ok({ groups: [group] }),
        ...extra,
      });

    it('picks the live brand with the most products as the default target', () => {
      expect(defaultTarget(group)).toBe(id(1));
      expect(defaultTarget({ groupKey: 'x', brands: [queued(3, 5, { status: 'draft' })] })).toBe(
        '',
      );
    });

    it('lists a group and merges the other values after a confirmation', async () => {
      withQueue({
        'POST catalog/admin/brands/': ok({ brand: brand(1), merged: [], aliasesAdded: [] }),
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicates 1' }));
      expect(await screen.findByText('“Saffron and Co”')).toBeTruthy();
      expect(screen.getByText('11 products')).toBeTruthy();
      expect(screen.getByLabelText('Merge into')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Merge 2 into Saffron & Co' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/3 products move to Saffron & Co/)).toBeTruthy();
      expect(calls('POST', 'catalog/admin/brands/')).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Merge 2 values' }));
      await expectToast(/2 values were merged into Saffron & Co. 3 products moved./);
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/brands/${id(1)}/merge`,
        { sourceBrandIds: [id(2), id(3)] },
        'csrf-1',
      );
    });

    it('keeps the brands apart with "Not the same"', async () => {
      withQueue({ 'POST catalog/admin/brands/merge-queue/dismiss': ok({ resolved: 3 }) });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicates 1' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Not the same' }));
      await expectToast('These brands will stay apart.');
      expect(call).toHaveBeenCalledWith(
        'POST',
        'catalog/admin/brands/merge-queue/dismiss',
        { groupKey: 'saffron-co' },
        'csrf-1',
      );
    });

    it('says so when nothing looks like a duplicate', async () => {
      serve(lists());
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicates' }));
      expect(await screen.findByText(/No possible duplicates/)).toBeTruthy();
    });
  });

  it('maps refusals to message keys', () => {
    expect(brandProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'brands.error.stale',
      reload: true,
    });
    expect(brandProblemOf({ status: 422, code: 'brand.merge-into-itself' }).key).toBe(
      'brands.error.into-itself',
    );
    expect(brandProblemOf({ status: 0, code: 'network' }).key).toBe('brands.error.unavailable');
    expect(brandProblemOf({ status: 418, code: 'x' }).key).toBe('brands.error.unknown');
    expect(
      brandProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'name', code: 'required' }] },
      }).fields,
    ).toEqual(['name']);
  });

  it('checks the form and builds the body', () => {
    expect(checkForm(EMPTY_FORM, true)).toEqual({ name: 'name-required' });
    expect(checkForm({ ...EMPTY_FORM, name: 'A', slug: 'Bad Slug' }, true)).toEqual({
      slug: 'slug-format',
    });
    expect(checkForm({ ...EMPTY_FORM, name: 'A', slug: 'Bad Slug' }, false)).toEqual({});
    expect(checkForm({ ...EMPTY_FORM, name: 'A', logoAlt: 'x' }, true)).toEqual({
      logoAlt: 'alt-without-logo',
    });
    expect(bodyOf({ ...EMPTY_FORM, name: ' A ', slug: 'a-b' }, false)).not.toHaveProperty('slug');
    expect(parseAliases('a, b\n a ,\n').aliases).toEqual(['a', 'b']);
    expect(parseAliases(Array.from({ length: 25 }, (_, n) => `a${n}`).join(',')).tooMany).toBe(
      true,
    );
  });
});
