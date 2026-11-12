// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { EditForm } from './edit-form.tsx';
import type { ProductView, TopicRef } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const saved = { ok: true, status: 200, body: { variantIds: ['v1'], refusedFields: [] } } as const;

describe.each([
  { code: 'AU', locale: 'en-AU', names: (n: string) => ({ 'en-AU': n, ar: `ar ${n}` }) },
  { code: 'ZZ', locale: 'ms-MY', names: (n: string) => ({ en: `en ${n}`, 'ms-MY': n }) },
])('the Tags field of the edit form in market $code', ({ locale, names }) => {
  const ref = (n: number, name: string, status: TopicRef['status'] = 'active'): TopicRef => ({
    id: id(n),
    slug: `tag-${n}`,
    status,
    name,
    names: names(name),
  });
  const product = (over: Partial<ProductView> = {}): ProductView => ({
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
    form: { taxCategoryCodes: ['standard'], units: [], fields: [], categories: [] },
    workingCopy: {
      content: {
        texts: { [locale]: { name: 'Dates' } },
        taxCategoryCode: 'standard',
        topicIds: [id(1), id(2)],
      },
      lastSavedAt: '2026-10-01T00:00:00Z',
      baseRevisionId: null,
    },
    published: null,
    pending: null,
    topicRefs: [ref(1, 'Eid'), ref(2, 'Ramadan', 'archived')],
    ...over,
  });
  const mount = (p: ProductView = product()) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <EditForm
          product={p}
          photos={[]}
          locales={[locale]}
          defaultLocale={locale}
          marketName="Market"
          csrfToken="csrf"
        />
      </NextIntlClientProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      value: { assign: vi.fn(), reload: vi.fn(), href: 'http://seller.localhost/products/p1/edit' },
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

  it('sits last in the "Category and tags" card, after the tax category', () => {
    mount();
    const card = screen.getByRole('heading', { name: 'Category and tags' }).closest('section');
    expect(card).not.toBeNull();
    const tax = card?.querySelector('[name="taxCategoryCode"]');
    const tags = card?.querySelector('[role="combobox"][aria-describedby]');
    expect(tax).not.toBeNull();
    expect(tags).not.toBeNull();
    expect(
      (tax as Node).compareDocumentPosition(tags as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Ramadan (archived)' })).toBeTruthy();
  });

  it('sends the tags back unchanged when only a text changed', async () => {
    call.mockResolvedValue(saved);
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Dates 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const body = call.mock.calls[0]?.[2] as { content: Record<string, unknown> };
    expect(body.content['topicIds']).toEqual([id(1), id(2)]);
  });

  it('saves the tags left after a removal, and drops the key when none are left', async () => {
    call.mockResolvedValue(saved);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ramadan (archived)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect((call.mock.calls[0]?.[2] as { content: Record<string, unknown> }).content).toMatchObject(
      { topicIds: [id(1)] },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(
      (call.mock.calls[1]?.[2] as { content: Record<string, unknown> }).content,
    ).not.toHaveProperty('topicIds');
  });

  it('lists tags in the review notice of a published product', () => {
    mount(
      product({
        published: {} as ProductView['published'],
        sensitiveFields: ['platform-categories', 'topics', 'images'],
      }),
    );
    expect(
      screen.getByText(
        'These changes are checked by us before they go live: categories, tags, images.',
      ),
    ).toBeTruthy();
  });

  it('tells a refused submit in words, in the banner and by the field, until the tags change', async () => {
    call.mockResolvedValueOnce({
      ok: false,
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
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const sentence = 'Ramadan is archived. Remove it.';
    expect((await screen.findAllByText(sentence)).length).toBe(2);
    expect(screen.getByText('attributes.size: required')).toBeTruthy();
    expect(screen.queryByText(/topicIds/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ramadan (archived)' }));
    expect(screen.queryByText(sentence)).toBeNull();
  });
});
