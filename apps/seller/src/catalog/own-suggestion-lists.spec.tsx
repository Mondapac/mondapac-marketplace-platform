// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The address is the list's state: a small store stands in for the router.
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { search: new URLSearchParams() };
  const router = {
    replace: (url: string) => {
      state.search = new URLSearchParams(url.split('?')[1] ?? '');
      for (const listener of listeners) listener();
    },
  };
  return { listeners, state, router };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => nav.router,
    usePathname: () => '/value-suggestions',
    useSearchParams: () =>
      useSyncExternalStore(
        (onChange) => {
          nav.listeners.add(onChange);
          return () => nav.listeners.delete(onChange);
        },
        () => nav.state.search,
      ),
  };
});
const { inner, saved } = vi.hoisted(() => ({
  inner: vi.fn<(method: string, path: string, ...rest: unknown[]) => Promise<unknown>>(),
  saved: { items: [] as unknown[], key: '' },
}));
// Saved filters are served apart from the list's own reads. Only the key a test sets is answered;
// a read of any other list key is not found, so a wrong key is caught.
vi.mock('../api/client.ts', () => ({
  callApi: (method: string, path: string, ...rest: unknown[]) =>
    path.startsWith('lists/seller/saved-filters')
      ? Promise.resolve(
          method === 'GET' && path !== `lists/seller/saved-filters?listKey=${saved.key}`
            ? { ok: false, failure: { status: 404, code: 'not-found' } }
            : { ok: true, status: 200, body: { items: saved.items, canShare: true } },
        )
      : inner(method, path, ...rest),
}));

import { OwnTagSuggestionsList, OwnValueSuggestionsList } from './own-suggestion-lists.tsx';
import type { OwnSuggestion, OwnTopicSuggestion } from './types.ts';

const call = inner;
const PRODUCT = '0190a000-0000-7000-8000-0000000000a1';
const id = (n: number) => `0190a000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;

const value = (over: Partial<OwnSuggestion>): OwnSuggestion => ({
  id: id(0xb1),
  status: 'open',
  label: 'Extra large',
  createdAt: '2026-11-05T01:00:00.000Z',
  decidedAt: null,
  rejectReason: null,
  attribute: { code: 'pack-size', names: { 'en-AU': 'Pack size' } },
  value: null,
  product: { id: PRODUCT, productCode: 'P00000001', name: 'Olive oil 1L' },
  ...over,
});
const tag = (over: Partial<OwnTopicSuggestion>): OwnTopicSuggestion => ({
  id: id(0xb2),
  status: 'open',
  label: 'Eid gifts',
  createdAt: '2026-11-05T01:00:00.000Z',
  decidedAt: null,
  rejectReason: null,
  topic: null,
  product: { id: PRODUCT, productCode: 'P00000001', name: 'Olive oil 1L' },
  ...over,
});

// Two Market shapes: the default language is not always the first name of a tag.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', names: (n: string) => ({ 'en-AU': n, ar: `ar ${n}` }) },
  { code: 'ZZ', locale: 'ms-MY', names: (n: string) => ({ en: `en ${n}`, 'ms-MY': n }) },
] as const;

function answer<Row>(items: Row[], locale: string, over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    status: 200,
    body: {
      items,
      total: items.length,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: false,
      nextAfterId: null,
      openCount: 1,
      maxOpen: 20,
      locales: { default: locale, supported: [locale] },
      ...over,
    },
  };
}
function serve<Row>(items: Row[], locale = 'en-AU', over: Record<string, unknown> = {}) {
  call.mockImplementation(() => Promise.resolve(answer(items, locale, over)));
}

const props = {
  paging: 'pages' as const,
  accountId: 'acct',
  marketId: 'AU',
  csrfToken: 'csrf-1',
  timeZone: 'UTC',
  canSuggest: true,
  sent: false,
};
const mount = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
/** The table row (or phone card) of a label. */
const rowOf = (label: string) => {
  const cell = screen.getByText(label);
  return within(cell.closest('tr') ?? cell.parentElement?.parentElement ?? cell);
};

beforeEach(() => {
  vi.clearAllMocks();
  saved.items = [];
  saved.key = '';
  nav.state.search = new URLSearchParams();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});
afterEach(() => cleanup());

describe('value suggestions list', () => {
  it('opens a saved filter of the store as a tab with its status and search', async () => {
    saved.key = 'seller.catalog.attribute-suggestions';
    saved.items = [
      {
        id: id(0xc1),
        listKey: 'seller.catalog.attribute-suggestions',
        name: 'Turned down',
        visibility: 'everyone',
        payload: {
          v: 1,
          q: 'xl',
          filters: { status: 'rejected' },
          sort: 'created',
          direction: 'desc',
        },
        ownedByMe: false,
        canManage: false,
      },
    ];
    serve([value({ id: id(1), label: 'Open one' })]);
    mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('Open one');
    fireEvent.click(await screen.findByRole('button', { name: 'Turned down' }));
    await waitFor(() => {
      const last = String(call.mock.calls.at(-1)?.[1]);
      expect(last).toContain('catalog/seller/attribute-suggestions?');
      expect(last).toContain('status=rejected');
      expect(last).toContain('q=xl');
      expect(last).toContain('sort=created');
      expect(last).toContain('direction=desc');
    });
  });

  it('shows each outcome in words, with the field and a link to the product', async () => {
    serve([
      value({ id: id(1), label: 'Open one' }),
      value({
        id: id(2),
        label: 'Approved one',
        status: 'approved',
        value: { code: 'xl', labels: { 'en-AU': 'XL' } },
      }),
      value({
        id: id(3),
        label: 'Mapped one',
        status: 'mapped',
        value: { code: 'large', labels: { 'en-AU': 'Large' } },
      }),
      value({ id: id(4), label: 'Rejected one', status: 'rejected', rejectReason: 'Not a size.' }),
    ]);
    mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('Open one');
    expect(rowOf('Open one').getByText(/A reviewer will decide/)).toBeTruthy();
    expect(rowOf('Open one').getByText('Pack size')).toBeTruthy();
    expect(rowOf('Open one').getByRole('link', { name: 'Olive oil 1L' }).getAttribute('href')).toBe(
      `/products/${PRODUCT}`,
    );
    expect(
      rowOf('Approved one').getByText('Added as “XL”. Pick it in the product form.'),
    ).toBeTruthy();
    expect(rowOf('Mapped one').getByText(/Matched to “Large”/)).toBeTruthy();
    expect(rowOf('Rejected one').getByText('Not added: Not a size.')).toBeTruthy();
    expect(call.mock.calls[0]?.[1]).toContain('catalog/seller/attribute-suggestions?');
  });

  it('renders what a seller or reviewer typed as text, not markup', async () => {
    serve([
      value({
        label: '<b>Huge</b>',
        status: 'rejected',
        rejectReason: '<img src=x onerror=alert(1)>',
      }),
    ]);
    const { container } = mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('<b>Huge</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('names a product or field that is gone instead of linking to it', async () => {
    serve([value({ attribute: null, product: { id: PRODUCT, productCode: null, name: null } })]);
    mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('Field no longer available');
    expect(screen.getByText('Product no longer available')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Olive oil 1L' })).toBeNull();
  });

  it('shows the waiting count, and at the limit hides the button and says why', async () => {
    serve([value({})], 'en-AU', { openCount: 20, maxOpen: 20 });
    mount(<OwnValueSuggestionsList {...props} />);
    expect(await screen.findByTestId('open-count')).toBeTruthy();
    expect(screen.getByText('20 of 20 waiting for a decision')).toBeTruthy();
    expect(screen.getByText(/You have reached the limit of 20/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Suggest a value' })).toBeNull();
  });

  it('offers the new suggestion only to a seller who may make one', async () => {
    serve([value({})]);
    const { unmount } = mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('Extra large');
    expect(screen.getByRole('link', { name: 'Suggest a value' }).getAttribute('href')).toBe(
      '/value-suggestions/new',
    );
    unmount();
    mount(<OwnValueSuggestionsList {...props} canSuggest={false} />);
    await screen.findByText('Extra large');
    expect(screen.queryByRole('link', { name: 'Suggest a value' })).toBeNull();
  });

  it('shows the empty state, and asks the status of a chosen tab', async () => {
    serve([], 'en-AU', { openCount: 0 });
    mount(<OwnValueSuggestionsList {...props} />);
    await screen.findByText('No suggestions yet');
    expect(screen.queryByTestId('open-count')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Added' }));
    await waitFor(() =>
      expect(call.mock.calls.some(([, path]) => String(path).includes('status=approved'))).toBe(
        true,
      ),
    );
  });

  it('says the sent suggestion was received', async () => {
    serve([value({})]);
    mount(<OwnValueSuggestionsList {...props} sent />);
    expect(await screen.findByText(/Suggestion sent/)).toBeTruthy();
  });
});

describe.each(MARKETS)('tag suggestions list in market $code', ({ locale, names }) => {
  const topic = (name: string, status: 'active' | 'archived' = 'active') => ({
    id: id(0xc1),
    slug: 'eid-gifts',
    status,
    names: names(name),
  });

  it('shows each outcome in words and says approving does not add the tag', async () => {
    serve(
      [
        tag({ id: id(1), label: 'One' }),
        tag({ id: id(2), label: 'Two', status: 'approved', topic: topic('Eid gifts') }),
        tag({ id: id(3), label: 'Three', status: 'mapped', topic: topic('Gifts') }),
        tag({ id: id(4), label: 'Four', status: 'rejected', rejectReason: 'Too vague.' }),
      ],
      locale,
    );
    mount(<OwnTagSuggestionsList {...props} />);
    await screen.findByText('One');
    expect(rowOf('One').getByText('Waiting for review')).toBeTruthy();
    expect(rowOf('Two').getByText('New tag “Eid gifts” created')).toBeTruthy();
    expect(rowOf('Two').getByText(/Approving does not add it for you/)).toBeTruthy();
    expect(rowOf('Two').getByRole('link', { name: 'Open product' }).getAttribute('href')).toBe(
      `/products/${PRODUCT}`,
    );
    expect(rowOf('Three').getByText('Matched to the existing tag “Gifts”')).toBeTruthy();
    expect(rowOf('Four').getByText('Rejected: Too vague.')).toBeTruthy();
    expect(rowOf('Four').queryByText(/Approving does not/)).toBeNull();
    expect(call.mock.calls[0]?.[1]).toContain('catalog/seller/topic-suggestions?');
  });

  it('says a retired tag can no longer be added, with no product link', async () => {
    serve([tag({ status: 'approved', topic: topic('Eid gifts', 'archived') })], locale);
    mount(<OwnTagSuggestionsList {...props} />);
    expect(
      await screen.findByText('This tag has since been retired and can no longer be added.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open product' })).toBeNull();
  });
});

describe('tag suggestions list, other states', () => {
  it('opens a saved filter of the store as a tab with its status and search', async () => {
    saved.key = 'seller.catalog.topic-suggestions';
    saved.items = [
      {
        id: id(0xc2),
        listKey: 'seller.catalog.topic-suggestions',
        name: 'Turned down',
        visibility: 'everyone',
        payload: {
          v: 1,
          q: 'eid',
          filters: { status: 'rejected' },
          sort: 'created',
          direction: 'desc',
        },
        ownedByMe: false,
        canManage: false,
      },
    ];
    serve([tag({ id: id(1), label: 'Open one' })]);
    mount(<OwnTagSuggestionsList {...props} />);
    await screen.findByText('Open one');
    fireEvent.click(await screen.findByRole('button', { name: 'Turned down' }));
    await waitFor(() => {
      const last = String(call.mock.calls.at(-1)?.[1]);
      expect(last).toContain('catalog/seller/topic-suggestions?');
      expect(last).toContain('status=rejected');
      expect(last).toContain('q=eid');
      expect(last).toContain('sort=created');
      expect(last).toContain('direction=desc');
    });
  });

  it('keeps the button, disabled, when the limit is reached', async () => {
    serve([tag({})], 'en-AU', { openCount: 5, maxOpen: 5 });
    mount(<OwnTagSuggestionsList {...props} />);
    await screen.findByText('Eid gifts');
    expect(screen.getByText(/You have 5 open suggestions/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Suggest a tag' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('never says topic in the messages the pages show', () => {
    const text = JSON.stringify(messages.catalog.tagSuggestions) + JSON.stringify(messages.nav);
    expect(text.toLowerCase()).not.toContain('topic');
  });
});
