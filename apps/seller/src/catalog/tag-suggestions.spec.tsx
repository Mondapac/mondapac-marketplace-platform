// @vitest-environment jsdom
import { visibleNavItems } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { SuggestTagForm, tagSuggestionError } from './suggest-tag-form.tsx';
import { TagSuggestionsTable } from './tag-suggestions-table.tsx';
import type { OwnTopicSuggestion } from './types.ts';

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
  getLocale: () => Promise.resolve('en-AU'),
  getTimeZone: () => Promise.resolve('UTC'),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';

const call = vi.mocked(callApi);
const PRODUCT = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000a2';
const id = (n: number) => `0190a000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;

// Two Market shapes: the default language is not always the first name of a tag.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', names: (n: string) => ({ 'en-AU': n, ar: `ar ${n}` }) },
  { code: 'ZZ', locale: 'ms-MY', names: (n: string) => ({ en: `en ${n}`, 'ms-MY': n }) },
] as const;

const suggestion = (over: Partial<OwnTopicSuggestion>): OwnTopicSuggestion => ({
  id: id(0xb1),
  status: 'open',
  label: 'Eid gifts',
  createdAt: '2026-11-05T01:00:00.000Z',
  decidedAt: null,
  rejectReason: null,
  topic: null,
  product: { id: PRODUCT, productCode: 'P00000001', name: 'Olive oil 1L' },
  ...over,
});

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(() => cleanup());

describe.each(MARKETS)('tag suggestions table in market $code', ({ locale, names }) => {
  const topic = (name: string, status: 'active' | 'archived' = 'active') => ({
    id: id(0xc1),
    slug: 'eid-gifts',
    status,
    names: names(name),
  });

  it('shows each outcome in words and says approving does not add the tag', async () => {
    render(
      await TagSuggestionsTable({
        defaultLocale: locale,
        items: [
          suggestion({ id: id(1) }),
          suggestion({ id: id(2), status: 'approved', topic: topic('Eid gifts') }),
          suggestion({ id: id(3), status: 'mapped', topic: topic('Gifts') }),
          suggestion({ id: id(4), status: 'rejected', rejectReason: 'Too vague.' }),
          suggestion({ id: id(5), status: 'rejected' }),
        ],
      }),
    );
    const row = (n: number) => within(screen.getByTestId(`suggestion-${id(n)}`));
    expect(row(1).getByText('Open')).toBeTruthy();
    expect(row(1).getByText('Waiting for review')).toBeTruthy();
    expect(row(1).getByRole('link', { name: 'Olive oil 1L' }).getAttribute('href')).toBe(
      `/products/${PRODUCT}`,
    );
    expect(row(2).getByText('Approved')).toBeTruthy();
    expect(row(2).getByText('New tag “Eid gifts” created')).toBeTruthy();
    expect(row(2).getByText(/Approving does not add it for you/)).toBeTruthy();
    expect(row(2).getByRole('link', { name: 'Open product' }).getAttribute('href')).toBe(
      `/products/${PRODUCT}`,
    );
    expect(row(3).getByText('Mapped')).toBeTruthy();
    expect(row(3).getByText('Matched to the existing tag “Gifts”')).toBeTruthy();
    expect(row(3).getByText(/Approving does not add it for you/)).toBeTruthy();
    expect(row(4).getByText('Rejected: Too vague.')).toBeTruthy();
    expect(row(4).queryByText(/Approving does not/)).toBeNull();
    expect(row(5).getAllByText('Rejected')).toHaveLength(2);
  });

  it('says a retired tag can no longer be added, with no product link', async () => {
    render(
      await TagSuggestionsTable({
        defaultLocale: locale,
        items: [suggestion({ status: 'approved', topic: topic('Eid gifts', 'archived') })],
      }),
    );
    expect(
      screen.getByText('This tag has since been retired and can no longer be added.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Approving does not add/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open product' })).toBeNull();
  });
});

describe('tag suggestions table, other states', () => {
  it('renders what a seller or reviewer typed as text, not markup', async () => {
    const { container } = render(
      await TagSuggestionsTable({
        defaultLocale: 'en-AU',
        items: [
          suggestion({
            label: '<b>Huge</b>',
            status: 'rejected',
            rejectReason: '<img src=x onerror=alert(1)>',
          }),
        ],
      }),
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<b>Huge</b>')).toBeTruthy();
  });

  it('names a product that is gone instead of linking to it, and an unknown status in words', async () => {
    render(
      await TagSuggestionsTable({
        defaultLocale: 'en-AU',
        items: [
          suggestion({
            id: id(1),
            product: { id: PRODUCT, productCode: null, name: null },
          }),
          suggestion({ id: id(2), status: 'weird' as never }),
        ],
      }),
    );
    expect(screen.getByText('Product no longer available')).toBeTruthy();
    expect(within(screen.getByTestId(`suggestion-${id(2)}`)).getByText('Unknown')).toBeTruthy();
  });

  it('shows the empty states, with the action only when none was ever sent', async () => {
    const { unmount } = render(
      await TagSuggestionsTable({
        defaultLocale: 'en-AU',
        items: [],
        emptyAction: <a href="/tag-suggestions/new">Suggest a tag</a>,
      }),
    );
    expect(screen.getByText('No tag suggestions yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Suggest a tag' })).toBeTruthy();
    unmount();
    render(await TagSuggestionsTable({ defaultLocale: 'en-AU', items: [], filtered: true }));
    expect(screen.getByText('Nothing in this status')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never says topic in the messages the pages show', () => {
    const text = JSON.stringify(messages.catalog.tagSuggestions) + JSON.stringify(messages.nav);
    expect(text.toLowerCase()).not.toContain('topic');
  });
});

describe('suggest a tag form', () => {
  const PRODUCTS = [
    { id: PRODUCT, label: 'Olive oil 1L (P00000001)' },
    { id: OTHER, label: 'Dates (P00000002)' },
  ];
  const mount = (props: Partial<Parameters<typeof SuggestTagForm>[0]> = {}) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <SuggestTagForm
          products={PRODUCTS}
          language="Australian English"
          openCount={2}
          maxOpen={10}
          csrfToken="csrf-1"
          {...props}
        />
      </NextIntlClientProvider>,
    );
  const field = () => screen.getByLabelText<HTMLInputElement>(/^Tag/);
  const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send suggestion' });
  const fill = (product: string, text: string) => {
    fireEvent.change(screen.getByLabelText(/^Product/), { target: { value: product } });
    fireEvent.change(field(), { target: { value: text } });
  };

  it('shows the help, the counter and the usage line', () => {
    mount();
    expect(screen.getByText(/2 to 40 characters, in Australian English/)).toBeTruthy();
    expect(screen.getByTestId('tag-counter').textContent).toBe('0 / 40');
    expect(screen.getByText('You have used 2 of 10 open suggestions.')).toBeTruthy();
    fireEvent.change(field(), { target: { value: 'Eid' } });
    expect(screen.getByTestId('tag-counter').textContent).toBe('3 / 40');
  });

  it('keeps Send off until a product and a tag are given, and preselects the only product', () => {
    mount();
    expect(send().disabled).toBe(true);
    fill(PRODUCT, 'Eid gifts');
    expect(send().disabled).toBe(false);
    cleanup();
    mount({ products: [PRODUCTS[1]!] });
    expect(screen.getByLabelText<HTMLSelectElement>(/^Product/).value).toBe(OTHER);
  });

  it('starts on the product and the text it was linked with', () => {
    mount({ initialProduct: OTHER, initialLabel: 'Eid gifts' });
    expect(screen.getByLabelText<HTMLSelectElement>(/^Product/).value).toBe(OTHER);
    expect(field().value).toBe('Eid gifts');
    cleanup();
    mount({ initialProduct: id(0xee) });
    expect(screen.getByLabelText<HTMLSelectElement>(/^Product/).value).toBe('');
  });

  it('posts the trimmed tag to the chosen product with the CSRF token, then goes to the list', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: {} });
    mount();
    fill(OTHER, '  Eid gifts  ');
    fireEvent.click(send());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/tag-suggestions?sent=1'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/seller/products/${OTHER}/topic-suggestions`,
      { label: 'Eid gifts' },
      'csrf-1',
    );
  });

  it('refuses one character before any request', () => {
    mount();
    fill(PRODUCT, ' a ');
    fireEvent.click(send());
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Use 2 to 40 characters.')).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field());
  });

  it('blocks a second send while one is in flight', async () => {
    let finish: (value: never) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount();
    fill(PRODUCT, 'Eid gifts');
    fireEvent.click(send());
    fireEvent.submit(field().closest('form')!);
    expect(call).toHaveBeenCalledTimes(1);
    finish({ ok: false, failure: { status: 500, code: 'x' } } as never);
    await screen.findByRole('alert');
  });

  it('turns a 401 into the session-ended page', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount();
    fill(PRODUCT, 'Eid gifts');
    fireEvent.click(send());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('disables Send and sends nothing when the limit is already reached', () => {
    mount({ openCount: 10 });
    fill(PRODUCT, 'Eid gifts');
    expect(send().disabled).toBe(true);
  });

  const FAILURES: readonly [string, number, Record<string, unknown>, string, 'field' | 'banner'][] =
    [
      [
        'suggestion.topic-exists',
        409,
        {},
        'A tag like this already exists. Search for it in the Tags field of your product.',
        'field',
      ],
      [
        'suggestion.already-open',
        409,
        {},
        'You already suggested this tag and it is waiting for review.',
        'banner',
      ],
      [
        'suggestion.limit-reached',
        422,
        { max: 7 },
        'You can have up to 7 open suggestions. Wait for a decision, then try again.',
        'banner',
      ],
      ['suggestion.label-invalid', 422, {}, 'Use 2 to 40 characters of plain text.', 'field'],
      ['validation.failed', 400, {}, 'Use 2 to 40 characters of plain text.', 'field'],
      [
        'topic.claim-word',
        422,
        {},
        'A tag cannot claim a certification such as halal or organic. Certifications are added from your certificates.',
        'field',
      ],
      [
        'topic.locale-uncheckable',
        422,
        {},
        'This text could not be checked. Try different words.',
        'field',
      ],
      ['product.not-found', 404, {}, 'That product was not found. Choose another.', 'banner'],
      [
        'product.not-editable',
        409,
        {},
        'That product cannot be changed right now. Choose another.',
        'banner',
      ],
      ['seller.not-eligible', 403, {}, 'Your seller account cannot suggest tags yet.', 'banner'],
      [
        'access.seller-not-approved',
        403,
        {},
        'Your seller account cannot suggest tags yet.',
        'banner',
      ],
      ['access.denied', 403, {}, 'You do not have permission to suggest tags.', 'banner'],
      ['request.csrf', 403, {}, 'Your session expired. Reload the page.', 'banner'],
      ['request.throttled', 429, {}, 'Too many requests. Wait a moment and try again.', 'banner'],
      ['access.unavailable', 503, {}, 'Could not reach the server. Try again.', 'banner'],
      ['network', 0, {}, 'Could not reach the server. Try again.', 'banner'],
      ['something.else', 418, {}, 'Something went wrong. Try again.', 'banner'],
    ];
  it.each(FAILURES)(
    'tells %s in words, keeping the typed tag',
    async (code, status, details, copy, place) => {
      call.mockResolvedValue({ ok: false, failure: { status, code, details } });
      mount();
      fill(PRODUCT, 'Eid gifts');
      fireEvent.click(send());
      const text = await screen.findByText(copy);
      expect(field().value).toBe('Eid gifts');
      expect(send().disabled).toBe(false);
      if (place === 'banner') {
        expect(within(text.closest('[role="alert"]') as HTMLElement).getByText(copy)).toBeTruthy();
      } else {
        expect(field().getAttribute('aria-invalid')).toBe('true');
        expect(field().getAttribute('aria-describedby')).toContain(text.id);
      }
    },
  );

  it('offers the product and the list where the refusal calls for them', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'suggestion.topic-exists' },
    });
    mount();
    fill(OTHER, 'Eid');
    fireEvent.click(send());
    const back = await screen.findByRole('link', { name: 'Back to my product' });
    expect(back.getAttribute('href')).toBe(`/products/${OTHER}`);
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'suggestion.already-open' },
    });
    fireEvent.click(send());
    const list = await screen.findByRole('link', { name: 'View my suggestions' });
    expect(list.getAttribute('href')).toBe('/tag-suggestions');
    expect(document.activeElement).toBe(list.closest('div'));
  });

  it('maps a limit refusal without details to the page maximum', () => {
    expect(tagSuggestionError({ status: 422, code: 'suggestion.limit-reached' })).toMatchObject({
      key: 'limit',
    });
  });
});

describe('seller nav', () => {
  it('lists Tag suggestions under Catalogue for a seller who may view products', () => {
    const item = visibleNavItems(sellerNav, new Set(['catalog.own-product.view'])).find(
      (entry) => entry.id === 's_tag_suggestions',
    );
    expect(item).toMatchObject({ href: '/tag-suggestions', group: 'catalogue' });
    expect(
      visibleNavItems(sellerNav, new Set<string>()).some(
        (entry) => entry.id === 's_tag_suggestions',
      ),
    ).toBe(false);
  });
});
