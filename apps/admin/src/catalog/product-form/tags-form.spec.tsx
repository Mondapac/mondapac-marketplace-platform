// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import messages from '../../../messages/en.json';

import type { callApi } from '../../api/client.ts';

// The form also reads the photo library of the product; that call goes to its own mock, so
// `call` sees only the product read, the tag search and the save.
const mocks = vi.hoisted(() => ({
  call: vi.fn<typeof callApi>(),
  images: vi.fn<typeof callApi>(),
}));
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  // These tests count the form's own calls; the writer's status read is tested in writer-in-form.
  DescriptionWriter: () => null,
}));
vi.mock('../../api/client.ts', () => ({
  callApi: ((...args: Parameters<typeof callApi>) =>
    args[0] === 'GET' && args[1].endsWith('/images')
      ? mocks.images(...args)
      : mocks.call(...args)) as typeof callApi,
}));

import { ProductEdit } from './edit-form.tsx';
import type { ProductView, TopicRef } from './types.ts';

const call = mocks.call;
const ID = '0190a000-0000-7000-8000-0000000000c1';
const VARIANT = '0190a000-0000-7000-8000-0000000000e1';
const id = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const saved = ok({ variantIds: [VARIANT], refusedFields: [] });
const bodyOf = (index: number) =>
  call.mock.calls[index]?.[2] as { content: Record<string, unknown> };

describe.each([
  { code: 'AU', locale: 'en', names: (n: string) => ({ en: n, ar: `ar ${n}` }) },
  { code: 'ZZ', locale: 'ms', names: (n: string) => ({ de: `de ${n}`, ms: n }) },
])('the Tags field of the platform product form in market $code', ({ locale, names }) => {
  const ref = (n: number, name: string, status: TopicRef['status'] = 'active'): TopicRef => ({
    id: id(n),
    slug: `tag-${n}`,
    status,
    name,
    names: names(name),
  });
  const view = (): ProductView => ({
    productId: ID,
    productCode: 'P00000001',
    typeCode: 'simple',
    familyCode: 'default',
    variantModel: 'single',
    status: 'draft',
    pausedAt: null,
    offers: { sellerCount: 0, offerCount: 0 },
    variants: [{ variantId: VARIANT, state: 'proposed' }],
    maxVariants: 100,
    lastChangedAt: '2026-11-05T01:00:00.000Z',
    createdAt: '2026-11-05T01:00:00.000Z',
    form: { taxCategoryCodes: ['gst-free'], fields: [], categories: [] },
    locales: { default: locale, supported: [locale] },
    workingCopy: {
      content: {
        texts: { [locale]: { name: 'Dates' } },
        taxCategoryCode: 'gst-free',
        topicIds: [id(1), id(2)],
      },
      lastSavedAt: '2026-11-05T01:00:00.000Z',
      baseRevisionId: null,
    },
    published: null,
    topicRefs: [ref(1, 'Eid'), ref(2, 'Ramadan', 'archived')],
  });
  const mount = (canReadTags = true) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <ProductEdit
          productId={ID}
          csrfToken="csrf-1"
          marketName="Market"
          timeZone="UTC"
          canPause={false}
          canReadTags={canReadTags}
        />
      </NextIntlClientProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    call.mockReset();
    call.mockResolvedValueOnce(ok(view()));
    mocks.images.mockReset();
    mocks.images.mockResolvedValue(ok({ images: [] }));
    Object.defineProperty(window, 'location', {
      value: { assign: vi.fn(), href: 'http://admin.localhost/catalog/products/x/edit' },
      writable: true,
    });
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(cleanup);

  it('sits last in the "Category and tags" card, after the tax category', async () => {
    mount();
    await screen.findByLabelText('Title');
    const card = screen.getByRole('heading', { name: 'Category and tags' }).closest('section');
    const tax = card?.querySelector('[name="taxCategoryCode"]');
    const tags = screen.getByRole('combobox', { name: /Tags/ });
    expect(tax).not.toBeNull();
    expect(card?.contains(tags)).toBe(true);
    expect(
      (tax as Node).compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Ramadan (archived)' })).toBeTruthy();
  });

  it('sends the tags back unchanged when only the title changed', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Dates 2' } });
    call.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(bodyOf(1).content['topicIds']).toEqual([id(1), id(2)]);
  });

  it('saves the tags left after a removal, and drops the key when none are left', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ramadan (archived)' }));
    call.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(bodyOf(1).content).toMatchObject({ topicIds: [id(1)] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eid' }));
    call.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(bodyOf(2).content).not.toHaveProperty('topicIds');
  });

  it('without the tag read key shows the tags as text and still sends them back unchanged', async () => {
    mount(false);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Dates 2' } });
    expect(screen.queryByRole('combobox', { name: /Tags/ })).toBeNull();
    expect(screen.getByText('Ramadan (archived)')).toBeTruthy();
    expect(screen.getByText(/Your role can't change tags\./)).toBeTruthy();
    call.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(bodyOf(1).content['topicIds']).toEqual([id(1), id(2)]);
    expect(call.mock.calls.some((entry) => String(entry[1]).includes('topics'))).toBe(false);
  });

  it('tells a refused save in words, in the banner and by the field, until the tags change', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Dates 2' } });
    call.mockResolvedValueOnce({
      ok: false as const,
      failure: {
        status: 422,
        code: 'revision.not-ready',
        details: {
          issues: [
            { path: 'topicIds.1', code: 'archived' },
            { path: 'attributes.size', code: 'required' },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const sentence = 'Ramadan is archived. Remove it.';
    expect((await screen.findAllByText(sentence)).length).toBe(2);
    expect(screen.getByText('attributes.size: required')).toBeTruthy();
    expect(screen.queryByText(/topicIds/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ramadan (archived)' }));
    expect(screen.queryByText(sentence)).toBeNull();
  });
});
