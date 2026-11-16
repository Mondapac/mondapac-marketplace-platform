// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AssistantGate } from '../src/assistant/assistant-gate.tsx';
import { AssistantWidget } from '../src/assistant/assistant-widget.tsx';
import {
  cardOf,
  moneyOf,
  replyOf,
  sendMessage,
  storefrontReadOf,
  validChatUrl,
  validSupportEmail,
  type AssistantBase,
  type AssistantSetup,
} from '../src/assistant/assistant.ts';
import {
  PREVIEW_KEY,
  isPreviewToken,
  storedPreview,
  takePreview,
} from '../src/assistant/preview.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => null,
}));

const TOKEN = 'ap1.1893456000.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const U = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const BASE: AssistantBase = {
  chatUrl: '/api/assistant',
  supportEmail: 'help@example.test',
  csrfToken: null,
};
const ON = {
  enabled: true,
  guestsAllowed: true,
  replyLanguage: 'en',
  welcomeText: null,
  retentionDays: { customer: 365, guest: 30 },
  quickPrompts: [],
  preview: false,
};

const product = (extra: Record<string, unknown> = {}) => ({
  kind: 'product',
  offerId: U(1),
  productId: U(2),
  sellerId: U(3),
  name: 'Lamb shoulder',
  shortText: null,
  sellerName: 'Bright Butchers',
  price: { amount: '2450', currency: 'AUD' },
  regularPrice: null,
  taxInclusive: true,
  priceFrom: false,
  badges: [],
  ...extra,
});
const seller = (extra: Record<string, unknown> = {}) => ({
  kind: 'seller',
  sellerId: U(3),
  slug: 'bright-butchers',
  name: 'Bright Butchers',
  city: 'Brisbane',
  sellingSince: 2021,
  productCount: 14,
  ...extra,
});

describe('cardOf: product fields', () => {
  it('reads seller, price, regular price, tax note, from flag and badges', () => {
    const card = cardOf(
      product({
        price: { amount: '1500', currency: 'NZD' },
        regularPrice: { amount: '2000', currency: 'NZD' },
        priceFrom: true,
        badges: [
          { typeCode: 'HALAL', typeName: 'Halal certified', sellerClaim: false },
          { typeCode: 'ORGANIC', typeName: 'Organic', sellerClaim: true },
        ],
      }),
    );
    expect(card).toMatchObject({
      kind: 'product',
      sellerName: 'Bright Butchers',
      price: { amount: 1500, currency: 'NZD' },
      regularPrice: { amount: 2000, currency: 'NZD' },
      taxInclusive: true,
      priceFrom: true,
    });
    expect((card as unknown as { badges: unknown[] }).badges).toHaveLength(2);
  });

  it('shows no price when the price is null, and drops malformed money', () => {
    expect(cardOf(product({ price: null, regularPrice: null, priceFrom: true }))).toMatchObject({
      price: null,
      regularPrice: null,
      priceFrom: false,
    });
    for (const bad of [
      { amount: '-1', currency: 'AUD' },
      { amount: '12.5', currency: 'AUD' },
      { amount: 12.5, currency: 'AUD' },
      { amount: '1e3', currency: 'AUD' },
      { amount: '99999999999999999999', currency: 'AUD' },
      { amount: '100', currency: 'aud' },
      { amount: '100', currency: 'AUDX' },
      { amount: '100' },
      'AUD 10',
      [],
    ]) {
      expect(moneyOf(bad), JSON.stringify(bad)).toBeNull();
      expect(cardOf(product({ price: bad }))).toMatchObject({ price: null });
    }
    expect(moneyOf({ amount: '0', currency: 'JPY' })).toEqual({ amount: 0, currency: 'JPY' });
  });

  it('keeps a regular price only beside a higher one in the same currency', () => {
    const regular = (amount: string, currency = 'AUD') =>
      cardOf(product({ regularPrice: { amount, currency } })) as { regularPrice: unknown };
    expect(regular('2450').regularPrice).toBeNull();
    expect(regular('1000').regularPrice).toBeNull();
    expect(regular('3000', 'NZD').regularPrice).toBeNull();
    expect(regular('3000').regularPrice).toEqual({ amount: 3000, currency: 'AUD' });
  });

  it('caps and validates badges and strings', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      typeCode: `T${i}`,
      typeName: 'x'.repeat(500),
      sellerClaim: false,
    }));
    const card = cardOf(
      product({
        sellerName: 's'.repeat(500),
        badges: [
          ...many,
          { typeCode: 'bad code!', typeName: 'No', sellerClaim: false },
          { typeCode: 'OK', typeName: 'No', sellerClaim: 'yes' },
        ],
      }),
    ) as unknown as { sellerName: string; badges: { typeName: string }[] };
    expect(card.sellerName).toHaveLength(120);
    expect(card.badges).toHaveLength(6);
    expect(card.badges[0]!.typeName).toHaveLength(60);
    expect(cardOf(product({ badges: 'HALAL' }))).toMatchObject({ badges: [] });
  });
});

describe('cardOf: seller card', () => {
  it('reads a store with city, year and count; unknown count is null', () => {
    expect(cardOf(seller())).toEqual({
      kind: 'seller',
      sellerId: U(3),
      slug: 'bright-butchers',
      name: 'Bright Butchers',
      city: 'Brisbane',
      sellingSince: 2021,
      productCount: 14,
    });
    expect(cardOf(seller({ productCount: null, city: null }))).toMatchObject({
      productCount: null,
      city: null,
    });
    expect(cardOf(seller({ productCount: -1, sellingSince: 'soon' }))).toMatchObject({
      productCount: null,
      sellingSince: null,
    });
  });

  it('drops a card with a bad slug or id, so no link can bend', () => {
    for (const slug of [
      '../account',
      'Bright',
      'a/b',
      'a--b',
      '-a',
      'a_b',
      '',
      'x'.repeat(51),
      7,
    ]) {
      expect(cardOf(seller({ slug })), String(slug)).toBeNull();
    }
    expect(cardOf(seller({ sellerId: '..' }))).toBeNull();
    expect(cardOf(seller({ name: '' }))).toBeNull();
  });

  it('is part of the reply, after the products', () => {
    const body =
      'event: conversation\ndata: {"id":"c"}\n\n' +
      `event: card\ndata: ${JSON.stringify(seller())}\n\n` +
      'event: done\ndata: {}\n\n';
    expect(replyOf(body)?.sellers).toHaveLength(1);
  });
});

describe('setup validation', () => {
  it('accepts a plain support address only', () => {
    expect(validSupportEmail('support@mondapac.com.au')).toBe('support@mondapac.com.au');
    expect(validSupportEmail('a.b+c@x-y.example.org')).toBe('a.b+c@x-y.example.org');
    for (const bad of [
      'a@b@c.com',
      'a@b.com?subject=x',
      'a@b.com&cc=x@y.com',
      'mailto:a@b.com',
      'a b@c.com',
      'a@b.com\n',
      ' a@b.com',
      '<a@b.com>',
      'a@b.com,c@d.com',
      'a@b.com;c@d.com',
      'a@b',
      'a@@b.com',
      '@b.com',
      'a@b..com',
      '%0a@b.com',
      '',
      null,
      undefined,
      42,
      `${'a'.repeat(300)}@b.com`,
    ]) {
      expect(validSupportEmail(bad), String(bad)).toBeNull();
    }
  });

  it('accepts an https URL or a relative path starting with one slash only', () => {
    expect(validChatUrl('/api/assistant')).toBe('/api/assistant');
    expect(validChatUrl('/api/assistant/')).toBe('/api/assistant');
    expect(validChatUrl('https://api.example.test/assistant')).toBe(
      'https://api.example.test/assistant',
    );
    for (const bad of [
      '//evil.test/assistant',
      '/\\evil.test',
      'http://api.example.test/assistant',
      'javascript:alert(1)',
      'api/assistant',
      'https://u:p@api.example.test/assistant',
      'https://api.example.test/assistant?x=1',
      'https://api.example.test/assistant#x',
      '/api/ assistant',
      '/',
      '',
      null,
      7,
    ]) {
      expect(validChatUrl(bad), String(bad)).toBeNull();
    }
  });

  it('reads the storefront answer strictly', () => {
    expect(
      storefrontReadOf({ ...ON, quickPrompts: ['  Halal meat ', '', 7, 'x'.repeat(500)] }),
    ).toEqual(expect.objectContaining({ enabled: true, quickPrompts: ['Halal meat'] }));
    expect(storefrontReadOf({ ...ON, retentionDays: null })?.retentionDays).toBeNull();
    for (const bad of [
      null,
      [],
      { ...ON, enabled: 'yes' },
      { ...ON, preview: undefined },
      { ...ON, retentionDays: { customer: -1, guest: 0 } },
      { ...ON, retentionDays: { customer: 30 } },
      { ...ON, welcomeText: 5 },
    ]) {
      expect(storefrontReadOf(bad)).toBeNull();
    }
  });
});

/** An in-memory Storage. */
function memory(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('preview token', () => {
  const history = () => ({ state: { n: 1 }, replaceState: vi.fn() });

  it('takes the token from the fragment, stores it in session storage and removes it from the URL', () => {
    const store = memory();
    const h = history();
    const token = takePreview(
      { pathname: '/p/x-1', search: '?a=1', hash: `#assistant-preview=${TOKEN}` },
      h,
      store,
    );
    expect(token).toBe(TOKEN);
    expect(store.getItem(PREVIEW_KEY)).toBe(TOKEN);
    expect(h.replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/p/x-1?a=1');
    expect(JSON.stringify(h.replaceState.mock.calls)).not.toContain(TOKEN);
  });

  it('keeps any other fragment part and the query', () => {
    const h = history();
    takePreview(
      { pathname: '/p/x', search: '?q=1', hash: `#reviews&assistant-preview=${TOKEN}&x=2` },
      h,
      memory(),
    );
    expect(h.replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/p/x?q=1#reviews&x=2');
  });

  it('strips a malformed token without storing it', () => {
    const store = memory();
    const h = history();
    const token = takePreview(
      { pathname: '/', search: '', hash: '#assistant-preview=<script>alert(1)</script>' },
      h,
      store,
    );
    expect(token).toBeNull();
    expect(store.getItem(PREVIEW_KEY)).toBeNull();
    expect(h.replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/');
  });

  it('leaves the URL alone with no token in it, and reads the one stored earlier', () => {
    const store = memory();
    store.setItem(PREVIEW_KEY, TOKEN);
    const h = history();
    expect(takePreview({ pathname: '/', search: '', hash: '#top' }, h, store)).toBe(TOKEN);
    expect(h.replaceState).not.toHaveBeenCalled();
    expect(takePreview({ pathname: '/', search: '', hash: '' }, h, null)).toBeNull();
  });

  it('survives blocked storage and a failing replaceState', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const h = {
      state: null,
      replaceState: vi.fn(() => {
        throw new Error('no');
      }),
    };
    expect(
      takePreview({ pathname: '/', search: '', hash: `#assistant-preview=${TOKEN}` }, h, blocked),
    ).toBe(TOKEN);
    expect(storedPreview(blocked)).toBeNull();
  });

  it('checks the shape: bounded length, base64url and dots', () => {
    expect(isPreviewToken(TOKEN)).toBe(true);
    for (const bad of ['', 'short', 'a'.repeat(301), `${TOKEN}=`, 'ap1 a'.repeat(6), 7, null]) {
      expect(isPreviewToken(bad)).toBe(false);
    }
  });

  it('is sent only as the x-assistant-preview header of a message, never in the URL or body', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response('event: conversation\ndata: {"id":"c"}\n\nevent: done\ndata: {}\n\n'),
      ),
    );
    const setup: AssistantSetup = {
      ...BASE,
      guestsAllowed: true,
      welcomeText: null,
      retentionDays: 30,
    };
    await sendMessage(setup, U(9), 'hi', null, new AbortController().signal, fetcher, TOKEN);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/assistant/conversations/${U(9)}/messages`);
    expect((init.headers as Record<string, string>)['x-assistant-preview']).toBe(TOKEN);
    expect(url).not.toContain(TOKEN);
    expect(init.body).not.toContain(TOKEN);
    fetcher.mockClear();
    await sendMessage(setup, U(9), 'hi', null, new AbortController().signal, fetcher);
    expect(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    ).not.toHaveProperty('x-assistant-preview');
  });
});

describe('assistant gate', () => {
  const view = (base: AssistantBase = BASE) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <AssistantGate base={base} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  const launcher = () => screen.queryByRole('button', { name: 'Ask the assistant' });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing until the API answers enabled, then shows the launcher', async () => {
    let answer: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    view();
    expect(launcher()).toBeNull();
    await act(async () => {
      answer(Response.json(ON));
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Ask the assistant' })).toBeTruthy();
  });

  it.each([
    ['disabled', () => Promise.resolve(Response.json({ ...ON, enabled: false }))],
    ['a server error', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['a network failure', () => Promise.reject(new Error('down'))],
    ['a malformed body', () => Promise.resolve(Response.json({ enabled: true }))],
    ['not JSON', () => Promise.resolve(new Response('<html>'))],
  ])('stays off, without console noise, on %s', async (_name, reply) => {
    const noise = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(reply));
    view();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(launcher()).toBeNull();
    expect(document.querySelector('.asw')).toBeNull();
    expect(noise).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    noise.mockRestore();
    warn.mockRestore();
  });

  it('asks with the visitor id and the language, and no preview header without a token', async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json(ON)));
    vi.stubGlobal('fetch', fetcher);
    view();
    await screen.findByRole('button', { name: 'Ask the assistant' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/api\/assistant\/storefront\?visitor=[0-9a-f]{32}&lang=en$/);
    expect(init.headers).not.toHaveProperty('x-assistant-preview');
  });

  it('reads the fragment token, strips it from the URL, keeps it in session storage only and sends it as a header', async () => {
    window.history.replaceState(null, '', `/p/x?a=1#assistant-preview=${TOKEN}`);
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ ...ON, preview: true })));
    vi.stubGlobal('fetch', fetcher);
    view();
    await screen.findByRole('button', { name: 'Ask the assistant' });
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname + window.location.search).toBe('/p/x?a=1');
    expect(window.sessionStorage.getItem(PREVIEW_KEY)).toBe(TOKEN);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)['x-assistant-preview']).toBe(TOKEN);
    // The panel marks itself a preview.
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(within(screen.getByRole('dialog', { hidden: true })).getByText('Preview')).toBeTruthy();
  });

  it('drops the stored token when the server answers preview: false', async () => {
    window.sessionStorage.setItem(PREVIEW_KEY, TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(ON))),
    );
    view();
    await screen.findByRole('button', { name: 'Ask the assistant' });
    expect(window.sessionStorage.getItem(PREVIEW_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('uses the server quick prompts, as the message text, instead of the built-in ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ ...ON, quickPrompts: ['Find me lamb', 'Any deals?'] })),
      ),
    );
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the assistant' }));
    expect(screen.getByRole('button', { name: 'Find me lamb' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Any deals?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show halal meat' })).toBeNull();
  });

  it('sends the language tag without Unicode extensions', async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json(ON)));
    vi.stubGlobal('fetch', fetcher);
    render(
      <NextIntlClientProvider
        locale="en-AU-u-ca-gregory-nu-latn"
        messages={messages}
        timeZone="UTC"
      >
        <StoreProvider>
          <AssistantGate base={BASE} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    await screen.findByRole('button', { name: 'Ask the assistant' });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toMatch(/lang=en-AU$/);
  });

  it('keeps the built-in prompts when the server sends none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(ON))),
    );
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the assistant' }));
    expect(screen.getByRole('button', { name: 'Show halal meat' })).toBeTruthy();
  });

  it('words the retention for a guest, and says when chats are not kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ ...ON, retentionDays: { customer: 365, guest: 0 } })),
      ),
    );
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'AI assistant' }));
    expect(screen.getByText(/Your chat is not kept after you leave it/)).toBeTruthy();
  });
});

describe('product and store rows', () => {
  const setup: AssistantSetup = {
    ...BASE,
    guestsAllowed: true,
    welcomeText: null,
    retentionDays: 30,
  };
  async function ask(cards: unknown[]) {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    const body =
      'event: conversation\ndata: {"id":"c"}\n\n' +
      cards.map((card) => `event: card\ndata: ${JSON.stringify(card)}\n\n`).join('') +
      'event: text\ndata: {"text":"Here you go."}\n\nevent: done\ndata: {}\n\n';
    const send = vi.fn(() => Promise.resolve({ ok: true as const, reply: replyOf(body)! }));
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <AssistantWidget setup={setup} send={send} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show halal meat' }));
      await Promise.resolve();
    });
    return screen.getByRole('log');
  }
  afterEach(cleanup);

  it('shows seller, price with the tax note, a special with its struck regular price, from-price and badges', async () => {
    const log = await ask([
      product(),
      product({
        offerId: U(11),
        name: 'Beef mince',
        price: { amount: '1000', currency: 'AUD' },
        regularPrice: { amount: '1400', currency: 'AUD' },
      }),
      product({
        offerId: U(12),
        name: 'Box of dates',
        priceFrom: true,
        price: { amount: '800', currency: 'NZD' },
      }),
      product({
        offerId: U(13),
        name: 'Goat curry cut',
        price: null,
        badges: [
          { typeCode: 'HALAL', typeName: 'Halal certified', sellerClaim: false },
          { typeCode: 'ORGANIC', typeName: 'Organic', sellerClaim: true },
        ],
      }),
    ]);
    expect(within(log).getAllByText('Sold by Bright Butchers')).toHaveLength(4);
    expect(within(log).getByText('A$24.50')).toBeTruthy();
    const special = within(log).getByText('A$10.00');
    expect(special.textContent).toBe('A$10.00');
    const struck = log.querySelector('s');
    expect(struck?.textContent).toContain('A$14.00');
    expect(within(log).getByText('Special price')).toBeTruthy();
    expect(within(log).getByText('From NZ$8.00')).toBeTruthy();
    expect(within(log).getAllByText('including GST').length).toBeGreaterThan(0);
    // No price for the card without one, and the badge styles follow the product page.
    const goat = within(log).getByText('Goat curry cut').closest('li')!;
    expect(goat.textContent).not.toMatch(/\$/);
    expect(within(goat).getByText('Halal certified').className).toBe('badge hl');
    const claim = within(goat).getByText("Organic · seller's declaration");
    expect(claim.className).toBe('badge decl');
    expect(within(goat).queryByText('Organic')).toBeNull();
  });

  it('formats money from its own currency and minor units, not AUD', async () => {
    const log = await ask([
      product({ price: { amount: '5000', currency: 'JPY' } }),
      product({ offerId: U(14), price: { amount: '1999', currency: 'EUR' } }),
    ]);
    expect(log.textContent).toMatch(/JP¥5,000|¥5,000/);
    expect(log.textContent).toMatch(/€19\.99/);
  });

  it('renders a store row linking to its store page, with city, year and product count', async () => {
    const log = await ask([
      seller(),
      seller({
        sellerId: U(5),
        slug: 'quiet-corner',
        name: 'Quiet Corner',
        city: null,
        sellingSince: null,
        productCount: null,
      }),
    ]);
    const link = within(log).getByRole('link', { name: 'Bright Butchers' });
    expect(link.getAttribute('href')).toBe('/s/bright-butchers');
    expect(link.closest('li')?.textContent).toContain(
      'Brisbane · Selling since 2021 · 14 products',
    );
    const quiet = within(log).getByRole('link', { name: 'Quiet Corner' }).closest('li')!;
    expect(quiet.querySelector('small')).toBeNull();
  });

  it('renders server text inert: markup stays text and a bad slug gives no row', async () => {
    const log = await ask([
      product({ name: '<img src=x onerror=alert(1)>', sellerName: '<b>evil</b>' }),
      seller({ slug: '../account' }),
    ]);
    expect(log.querySelector('img')).toBeNull();
    expect(log.querySelector('b')?.textContent).not.toBe('evil');
    expect(log.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(log.querySelector('a[href*="account"]')).toBeNull();
  });
});
