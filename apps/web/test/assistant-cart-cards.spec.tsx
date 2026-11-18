// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { cardOf, replyOf } from '../src/assistant/assistant.ts';
import {
  BasketProposalCardView,
  CartActionCardView,
  CartSummaryCardView,
} from '../src/assistant/cart-card-views.tsx';
import {
  basketProposalOf,
  cartActionOf,
  cartSummaryOf,
  type BasketProposalView,
  type CartAction,
} from '../src/assistant/cart-cards.ts';
import { liveCartOf } from '../src/cart/live-cart.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock('../src/checkout/actions.ts', () => ({}));

const U = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const OFFER = U(1);
const PRODUCT = U(2);
const SELLER = U(3);
const OTHER_SELLER = U(4);
const VARIANT = U(5);
const VARIANT_B = U(6);
const LINE = U(7);
const aud = (amount: string) => ({ amount, currency: 'AUD' });

const unit = (extra: object = {}) => ({
  variantId: VARIANT,
  label: '500 g',
  price: aud('1250'),
  taxInclusive: true,
  maxQuantity: 6,
  lineId: null,
  inCart: 0,
  addable: 6,
  ...extra,
});
const actionBody = (extra: object = {}) => ({
  kind: 'cart-action',
  action: 'add',
  offerId: OFFER,
  productId: PRODUCT,
  sellerId: SELLER,
  sellerName: 'Halal Corner',
  name: 'Lamb mince',
  lineId: null,
  currentQuantity: null,
  quantity: 2,
  limited: false,
  cartFull: false,
  units: [unit()],
  cartMode: 'multi-store',
  otherStore: false,
  ...extra,
});

describe('parsing the cart cards', () => {
  it("reads a cart-action card and keeps the server's numbers", () => {
    const card = cartActionOf(actionBody());
    expect(card).toMatchObject({ action: 'add', quantity: 2, cartMode: 'multi-store' });
    expect(card?.units[0]?.price).toEqual({ amount: 1250, currency: 'AUD' });
  });

  it('never takes "unknown" for "safe" in single-store mode', () => {
    expect(
      cartActionOf(actionBody({ cartMode: 'single-store', otherStore: null }))?.otherStore,
    ).toBeNull();
    expect(
      cartActionOf(actionBody({ cartMode: 'single-store', otherStore: 'no' }))?.otherStore,
    ).toBeNull();
  });

  it.each([
    ['an id that is not a UUID', { offerId: '../cart' }],
    ['an unknown action', { action: 'buy-now' }],
    ['no units', { units: [] }],
    ['a unit with a bad variant id', { units: [unit({ variantId: 'x/y' })] }],
    ['a unit with a bad line id', { units: [unit({ lineId: '../x' })] }],
    ['an unknown cart mode', { cartMode: 'any' }],
    ['a set-quantity without a line', { action: 'set-quantity', lineId: null }],
    ['a zero add', { quantity: 0 }],
    ['a negative quantity', { quantity: -1 }],
  ])('drops a cart-action card with %s', (_name, extra) => {
    expect(cartActionOf(actionBody(extra))).toBeNull();
  });

  it('drops a bad price but keeps the card', () => {
    const card = cartActionOf(
      actionBody({ units: [unit({ price: { amount: '-1', currency: 'AUD' } })] }),
    );
    expect(card?.units[0]?.price).toBeNull();
  });

  const cartBody = (extra: object = {}) => ({
    kind: 'cart',
    lineCount: 1,
    total: aud('2500'),
    groups: [
      {
        sellerId: SELLER,
        sellerName: 'Halal Corner',
        subtotal: aud('2500'),
        minimumOrder: { state: 'below-minimum', minimum: aud('4000') },
        lines: [
          {
            lineId: LINE,
            offerId: OFFER,
            variantId: VARIANT,
            productId: PRODUCT,
            name: 'Lamb mince',
            variantLabel: '500 g',
            quantity: 2,
            state: 'buyable',
            unitPrice: aud('1250'),
            maxQuantity: 6,
          },
        ],
      },
    ],
    ...extra,
  });

  it('reads a cart card and drops one with a bad line state', () => {
    expect(cartSummaryOf(cartBody())?.groups[0]?.lines[0]?.quantity).toBe(2);
    const bad = cartBody();
    (bad.groups[0]!.lines[0] as { state: string }).state = 'gone';
    expect(cartSummaryOf(bad)).toBeNull();
  });

  const option = (extra: object = {}) => ({
    offerId: OFFER,
    productId: PRODUCT,
    sellerId: SELLER,
    sellerName: 'Halal Corner',
    name: 'Lamb mince 500 g',
    variantId: VARIANT,
    price: aud('1250'),
    priceFrom: false,
    taxInclusive: true,
    quantity: 2,
    sizeNote: 'exact',
    ...extra,
  });
  const basketBody = (extra: object = {}) => ({
    kind: 'basket-proposal',
    proposal: {
      mode: 'multi-store',
      goal: 'best-match',
      itemCount: 3,
      stores: [
        {
          sellerId: SELLER,
          sellerName: 'Halal Corner',
          lines: [
            {
              ...option(),
              itemIndex: 0,
              text: 'lamb mince 1 kg',
              lineTotal: aud('2500'),
              alternatives: [
                option({
                  offerId: U(11),
                  name: 'Lamb mince 1 kg',
                  price: aud('2300'),
                  quantity: 1,
                }),
              ],
            },
          ],
          subtotal: aud('2500'),
          subtotalIsFrom: false,
        },
      ],
      uncertain: [
        {
          itemIndex: 1,
          text: 'rice',
          options: [option({ offerId: U(12), name: 'Basmati rice', quantity: null })],
        },
      ],
      notFound: [{ itemIndex: 2, text: 'saffron', reason: 'not-found' }],
      alternativeStores: [],
      total: aud('2500'),
      totalIsFrom: false,
      deliveryShownAtCheckout: true,
      ...extra,
    },
  });

  it('reads the pack ceiling of a basket option and leaves it empty when absent', () => {
    const body = basketBody();
    expect(basketProposalOf(body)?.stores[0]?.lines[0]?.maxQuantity).toBeNull();
    const line = (body.proposal as { stores: { lines: object[] }[] }).stores[0]!.lines[0]!;
    Object.assign(line, { maxQuantity: 4 });
    expect(basketProposalOf(body)?.stores[0]?.lines[0]?.maxQuantity).toBe(4);
  });

  it('reads a basket proposal', () => {
    const card = basketProposalOf(basketBody());
    expect(card?.stores[0]?.lines[0]?.wish).toBe('lamb mince 1 kg');
    expect(card?.notFound[0]?.wish).toBe('saffron');
  });

  it('reads a proposal whose server sends no variant id (it cannot be added then)', () => {
    const body = basketBody();
    delete (body.proposal.stores[0]!.lines[0] as { variantId?: string }).variantId;
    expect(basketProposalOf(body)?.stores[0]?.lines[0]?.variantId).toBeNull();
  });

  it.each([
    ['a bad mode', { mode: 'x' }],
    ['a bad not-found reason', { notFound: [{ itemIndex: 0, text: 'a', reason: 'gone' }] }],
    ['a bad total', { total: { amount: 'abc', currency: 'AUD' } }],
  ])('drops a proposal with %s', (_name, extra) => {
    expect(basketProposalOf(basketBody(extra) as never)).toBeNull();
  });

  it('flows through cardOf and replyOf into their own lists', () => {
    expect(cardOf(actionBody())?.kind).toBe('cart-action');
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const reply = replyOf(
      frame('conversation', { id: 'c1' }) +
        frame('card', actionBody()) +
        frame('card', cartBody()) +
        frame('card', basketBody()) +
        frame('notice', { code: 'cart-sign-in' }) +
        frame('done', {}),
    );
    expect(reply?.cartActions).toHaveLength(1);
    expect(reply?.carts).toHaveLength(1);
    expect(reply?.baskets).toHaveLength(1);
    expect(reply?.notices).toEqual(['cart-sign-in']);
  });
});

// ---- the views, against the real cart routes -------------------------------------------------

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer>;
let calls: Call[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({
    method,
    path,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const { status, body } = answers[`${method} ${path}`] ?? {
    status: 404,
    body: { code: 'not-found' },
  };
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});
const called = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  calls = [];
  answers = {
    'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
    'POST cart/items': { status: 200, body: { lineId: LINE } },
    'GET cart': { status: 200, body: { groups: [], lineCount: 0 } },
  };
  forgetCsrfToken();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (
  node: React.ReactNode,
  initial: ReturnType<typeof liveCartOf> | null = null,
  live = true,
) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live} initialLiveCart={initial}>
        {node}
      </StoreProvider>
    </NextIntlClientProvider>,
  );

const action = (extra: object = {}): CartAction => cartActionOf(actionBody(extra))!;

describe('the cart-action card', () => {
  it('changes nothing until the buyer clicks, then adds the chosen quantity with the cart route', async () => {
    wrap(<CartActionCardView card={action()} />);
    expect(called('POST', 'cart/items')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'One more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));

    await waitFor(() => expect(called('POST', 'cart/items')).toHaveLength(1));
    expect(called('POST', 'cart/items')[0]?.body).toEqual({
      offerId: OFFER,
      variantId: VARIANT,
      quantity: 3,
    });
    expect(await screen.findByText(/Added to your cart/)).toBeTruthy();
  });

  it('stops the quantity at the most the cart accepts and says so', () => {
    wrap(
      <CartActionCardView
        card={action({ quantity: 6, limited: true, units: [unit({ addable: 4 })] })}
      />,
    );
    expect(screen.getByRole('status', { hidden: true })?.textContent).toBe('4');
    expect(screen.getByText('Up to 4 can be added')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'One more' }).hasAttribute('disabled')).toBe(true);
  });

  it('adds the unit the buyer picks when there are several', async () => {
    wrap(
      <CartActionCardView
        card={action({
          units: [unit(), unit({ variantId: VARIANT_B, label: '1 kg', price: aud('2300') })],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /1 kg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(called('POST', 'cart/items')).toHaveLength(1));
    expect((called('POST', 'cart/items')[0]?.body as { variantId: string }).variantId).toBe(
      VARIANT_B,
    );
  });

  it('shows no button when the cart is full', () => {
    wrap(<CartActionCardView card={action({ cartFull: true, units: [unit({ addable: 0 })] })} />);
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
    expect(screen.getByText(/cart is full/i)).toBeTruthy();
  });

  it('says plainly when the cart refuses the change, and offers another try', async () => {
    answers['POST cart/items'] = { status: 422, body: { code: 'cart.offer-not-purchasable' } };
    wrap(<CartActionCardView card={action()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/did not accept/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('sets a quantity and removes a line through the line routes', async () => {
    answers[`PUT cart/items/${LINE}`] = { status: 200, body: { lineId: LINE, quantity: 4 } };
    answers[`DELETE cart/items/${LINE}`] = { status: 200, body: { removed: true } };
    const set = action({
      action: 'set-quantity',
      lineId: LINE,
      currentQuantity: 2,
      quantity: 4,
      units: [unit({ lineId: LINE, inCart: 2 })],
    });
    wrap(<CartActionCardView card={set} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update quantity' }));
    await waitFor(() => expect(called('PUT', `cart/items/${LINE}`)).toHaveLength(1));
    expect(called('PUT', `cart/items/${LINE}`)[0]?.body).toEqual({ quantity: 4 });
    cleanup();

    const remove = action({ action: 'remove', lineId: LINE, currentQuantity: 2, quantity: 0 });
    wrap(<CartActionCardView card={remove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from cart' }));
    await waitFor(() => expect(called('DELETE', `cart/items/${LINE}`)).toHaveLength(1));
  });

  it('takes the ceiling of a set-quantity card from the unit of its own line', () => {
    const other = unit({
      variantId: VARIANT_B,
      label: '1 kg',
      maxQuantity: 2,
      lineId: U(30),
      inCart: 1,
    });
    const card = action({
      action: 'set-quantity',
      lineId: LINE,
      currentQuantity: 2,
      quantity: 6,
      units: [other, unit({ lineId: LINE, inCart: 2, maxQuantity: 6 })],
    });
    wrap(<CartActionCardView card={card} />);
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('6');
  });

  it('asks first in single-store mode when the cart holds another store, and adds nothing yet', async () => {
    const otherBody = {
      groups: [
        {
          sellerId: OTHER_SELLER,
          sellerName: 'Other Market',
          subtotal: aud('1000'),
          minimumOrder: { state: 'none', minimum: null },
          lines: [
            {
              lineId: U(20),
              offerId: U(21),
              variantId: U(22),
              quantity: 1,
              state: 'buyable',
              reason: null,
              unitPrice: aud('1000'),
              previousPrice: null,
              availability: { status: 'in-stock', onlyLeft: null },
              display: {
                productId: null,
                productName: 'Dates',
                variantLabel: null,
                imageId: null,
              },
            },
          ],
        },
      ],
      lineCount: 1,
    };
    const other = liveCartOf(otherBody, null);
    // The widget reads the cart again before it decides: otherStore true or null is never "safe".
    answers['GET cart'] = { status: 200, body: otherBody };
    wrap(
      <CartActionCardView card={action({ cartMode: 'single-store', otherStore: true })} />,
      other,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add to cart' }));
    expect(await screen.findByText(/one store at a time/)).toBeTruthy();
    expect(called('POST', 'cart/items')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeTruthy();
    expect(called('POST', 'cart/items')).toHaveLength(0);
  });

  it('marks an older card as out of date once the cart changes, and turns its button off', async () => {
    answers['GET cart'] = {
      status: 200,
      body: {
        groups: [
          {
            sellerId: SELLER,
            sellerName: 'Halal Corner',
            subtotal: aud('1250'),
            minimumOrder: { state: 'none', minimum: null },
            lines: [
              {
                lineId: LINE,
                offerId: OFFER,
                variantId: VARIANT,
                quantity: 1,
                state: 'buyable',
                reason: null,
                unitPrice: aud('1250'),
                previousPrice: null,
                availability: { status: 'in-stock', onlyLeft: null },
                display: {
                  productId: null,
                  productName: 'Lamb mince',
                  variantLabel: null,
                  imageId: null,
                },
              },
            ],
          },
        ],
        lineCount: 1,
      },
    };
    wrap(
      <>
        <CartActionCardView card={action({ name: 'Older card' })} />
        <CartActionCardView card={action({ name: 'Newer card' })} />
      </>,
    );
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    const [older, newer] = screen.getAllByRole('region');
    // The buyer adds from the newer card: the cart changes under the older one.
    fireEvent.click(within(newer!).getByRole('button', { name: 'Add to cart' }));
    expect(await within(older!).findByText(/may be out of date/)).toBeTruthy();
    expect(
      within(older!).getByRole('button', { name: 'Add to cart' }).hasAttribute('disabled'),
    ).toBe(true);
    // The card that did the add says it is done, not out of date.
    expect(within(newer!).queryByText(/may be out of date/)).toBeNull();
    expect(await within(newer!).findByText(/Added to your cart/)).toBeTruthy();
  });

  it('does not call a card out of date while the cart has only just been read', () => {
    wrap(<CartActionCardView card={action()} />);
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to cart' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('offers no change on sample data', () => {
    wrap(<CartActionCardView card={action()} />, null, false);
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
  });

  it('renders seller-entered text as text, never markup', () => {
    wrap(<CartActionCardView card={action({ name: '<img src=x onerror=alert(1)>' })} />);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the cart card', () => {
  it('shows stores, lines and the totals the cart gave', () => {
    const card = cartSummaryOf({
      kind: 'cart',
      lineCount: 1,
      total: aud('2500'),
      groups: [
        {
          sellerId: SELLER,
          sellerName: 'Halal Corner',
          subtotal: aud('2500'),
          minimumOrder: { state: 'below-minimum', minimum: aud('4000') },
          lines: [
            {
              lineId: LINE,
              offerId: OFFER,
              variantId: VARIANT,
              productId: PRODUCT,
              name: 'Lamb mince',
              variantLabel: null,
              quantity: 2,
              state: 'buyable',
              unitPrice: aud('1250'),
              maxQuantity: 6,
            },
          ],
        },
      ],
    })!;
    wrap(<CartSummaryCardView card={card} />);
    expect(screen.getByText('Halal Corner')).toBeTruthy();
    expect(screen.getByText('Lamb mince')).toBeTruthy();
    expect(screen.getByText(/minimum order is A\$40\.00/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View cart' }).getAttribute('href')).toBe('/cart');
  });
});

describe('the basket proposal card', () => {
  const proposal = (): BasketProposalView => {
    const option = (extra: object = {}) => ({
      offerId: OFFER,
      productId: PRODUCT,
      sellerId: SELLER,
      sellerName: 'Halal Corner',
      name: 'Lamb mince 500 g',
      variantId: VARIANT,
      price: aud('1250'),
      priceFrom: false,
      taxInclusive: true,
      quantity: 2,
      sizeNote: 'exact',
      ...extra,
    });
    return basketProposalOf({
      kind: 'basket-proposal',
      proposal: {
        mode: 'multi-store',
        goal: 'best-match',
        itemCount: 3,
        stores: [
          {
            sellerId: SELLER,
            sellerName: 'Halal Corner',
            lines: [
              {
                ...option(),
                itemIndex: 0,
                text: 'lamb mince 1 kg',
                lineTotal: aud('2500'),
                alternatives: [
                  option({
                    offerId: U(11),
                    name: 'Lamb mince 1 kg',
                    variantId: VARIANT_B,
                    price: aud('2300'),
                    quantity: 1,
                  }),
                ],
              },
            ],
            subtotal: aud('2500'),
            subtotalIsFrom: false,
          },
        ],
        uncertain: [
          {
            itemIndex: 1,
            text: 'rice',
            options: [
              option({
                offerId: U(12),
                name: 'Basmati rice',
                variantId: U(13),
                quantity: null,
                price: aud('900'),
              }),
            ],
          },
        ],
        notFound: [{ itemIndex: 2, text: 'saffron', reason: 'not-found' }],
        alternativeStores: [],
        total: aud('2500'),
        totalIsFrom: false,
        deliveryShownAtCheckout: true,
      },
    })!;
  };

  it('adds nothing until "Add all", then adds each picked line and leaves the unsure one out', async () => {
    wrap(<BasketProposalCardView card={proposal()} />);
    expect(called('POST', 'cart/items')).toHaveLength(0);
    expect(screen.getByText('saffron')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 of 3 items to cart' }));
    await waitFor(() => expect(called('POST', 'cart/items')).toHaveLength(1));
    expect(called('POST', 'cart/items')[0]?.body).toEqual({
      offerId: OFFER,
      variantId: VARIANT,
      quantity: 2,
    });
    expect(await screen.findByText(/1 item added/)).toBeTruthy();
  });

  it('adds an unsure line once the buyer chooses it, and honours the edited packs and a swap', async () => {
    wrap(<BasketProposalCardView card={proposal()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Choose this/ }));
    const groups = screen.getAllByRole('group', { name: 'Quantity' });
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'One more' })); // lamb 2 -> 3
    fireEvent.click(screen.getAllByRole('button', { name: /^Use this/ })[0]!); // swap lamb for the 1 kg
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 of 3 items to cart' }));
    await waitFor(() => expect(called('POST', 'cart/items')).toHaveLength(2));
    const bodies = called('POST', 'cart/items').map((c) => c.body);
    expect(bodies).toContainEqual({ offerId: U(11), variantId: VARIANT_B, quantity: 1 });
    expect(bodies).toContainEqual({ offerId: U(12), variantId: U(13), quantity: 1 });
  });

  it('never lets the packs pass the most the product allows', async () => {
    const card = proposal();
    const limited = {
      ...card,
      stores: card.stores.map((store) => ({
        ...store,
        lines: store.lines.map((line) => ({ ...line, maxQuantity: 1 })),
      })),
    } as BasketProposalView;
    wrap(<BasketProposalCardView card={limited} />);
    const group = screen.getAllByRole('group', { name: 'Quantity' })[0]!;
    // The planner proposed 2 packs but only 1 can be added: shown and sent as 1, and "+" is off.
    expect(within(group).getByRole('status').textContent).toBe('1');
    expect(within(group).getByRole('button', { name: 'One more' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 of 3 items to cart' }));
    await waitFor(() => expect(called('POST', 'cart/items')).toHaveLength(1));
    expect(called('POST', 'cart/items')[0]?.body).toEqual({
      offerId: OFFER,
      variantId: VARIANT,
      quantity: 1,
    });
  });

  it('says why "+" is off when the ceiling is reached, and counts up to a ceiling of 3', () => {
    const card = proposal();
    const limited = {
      ...card,
      stores: card.stores.map((store) => ({
        ...store,
        lines: store.lines.map((line) => ({ ...line, quantity: 1, maxQuantity: 3 })),
      })),
    } as BasketProposalView;
    wrap(<BasketProposalCardView card={limited} />);
    const group = screen.getAllByRole('group', { name: 'Quantity' })[0]!;
    const more = within(group).getByRole('button', { name: 'One more' });
    expect(screen.queryByText(/The most you can add/)).toBeNull();
    fireEvent.click(more);
    fireEvent.click(more);
    expect(within(group).getByRole('status').textContent).toBe('3');
    expect(more).toHaveProperty('disabled', true);
    const note = screen.getByText('The most you can add is 3 packs.');
    expect(group.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('leaves a product with nothing left to add out of the list and the total', () => {
    const card = proposal();
    const none = {
      ...card,
      stores: card.stores.map((store) => ({
        ...store,
        lines: store.lines.map((line) => ({ ...line, maxQuantity: 0 })),
      })),
    } as BasketProposalView;
    wrap(<BasketProposalCardView card={none} />);
    expect(screen.getByText(/cannot be added from here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Add 0 of 3 items to cart/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('starts a swapped-to product from its own, lower ceiling', () => {
    const card = proposal();
    const swapped = {
      ...card,
      stores: card.stores.map((store) => ({
        ...store,
        lines: store.lines.map((line) => ({
          ...line,
          alternatives: line.alternatives.map((option) => ({
            ...option,
            quantity: 5,
            maxQuantity: 2,
          })),
        })),
      })),
    } as BasketProposalView;
    wrap(<BasketProposalCardView card={swapped} />);
    const group = screen.getAllByRole('group', { name: 'Quantity' })[0]!;
    fireEvent.click(within(group).getByRole('button', { name: 'One more' })); // lamb 2 -> 3
    fireEvent.click(screen.getAllByRole('button', { name: /^Use this/ })[0]!);
    const after = screen.getAllByRole('group', { name: 'Quantity' })[0]!;
    expect(within(after).getByRole('status').textContent).toBe('2');
    expect(within(after).getByRole('button', { name: 'One more' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('removing a line takes it out of the add', () => {
    wrap(<BasketProposalCardView card={proposal()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Remove from list/ }));
    expect(
      screen
        .getByRole('button', { name: /^Add \d+ of \d+ items to cart/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(called('POST', 'cart/items')).toHaveLength(0);
  });

  it('cannot add a line the server sent no sell unit for', () => {
    const card = proposal();
    const noUnit: BasketProposalView = {
      ...card,
      stores: card.stores.map((s) => ({
        ...s,
        lines: s.lines.map((l) => ({ ...l, variantId: null })),
      })),
    };
    wrap(<BasketProposalCardView card={noUnit} />);
    expect(
      screen
        .getByRole('button', { name: /^Add \d+ of \d+ items to cart/ })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('reports the lines the cart refused and lets the buyer retry only those', async () => {
    answers['POST cart/items'] = { status: 422, body: { code: 'cart.offer-not-purchasable' } };
    wrap(<BasketProposalCardView card={proposal()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 of 3 items to cart' }));
    expect(await screen.findByText(/1 item was not added/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the rest again' })).toBeTruthy();
  });

  it('does not let an old answer stand for an edited line, and ignores removed lines', async () => {
    answers['POST cart/items'] = { status: 422, body: { code: 'cart.offer-not-purchasable' } };
    wrap(<BasketProposalCardView card={proposal()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Add 1 of 3 items to cart/ }));
    expect(await screen.findByText(/1 item was not added/)).toBeTruthy();
    // Removing the refused line clears the alert and the retry label.
    fireEvent.click(screen.getByRole('button', { name: /^Remove from list/ }));
    expect(screen.queryByText(/1 item was not added/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try the rest again' })).toBeNull();
  });

  it('says so on a line the server sent no sell unit for', () => {
    const card = proposal();
    const noUnit: BasketProposalView = {
      ...card,
      stores: card.stores.map((s) => ({
        ...s,
        lines: s.lines.map((l) => ({ ...l, variantId: null })),
      })),
    };
    wrap(<BasketProposalCardView card={noUnit} />);
    expect(screen.getByText(/cannot be added from here/)).toBeTruthy();
  });

  it('groups lines under their store with its subtotal', () => {
    wrap(<BasketProposalCardView card={proposal()} />);
    expect(screen.getAllByText('Halal Corner')).not.toHaveLength(0);
    expect(screen.getByText('A$25.00', { selector: '.ascc-gh span' })).toBeTruthy();
  });
});
