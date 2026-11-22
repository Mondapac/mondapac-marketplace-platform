// Orders pack (operational test data design, phase 2, PR 3): buyers sign up on the buyer site and
// confirm their address from Mailpit, fill their address books and carts, and pay by card on the
// MondaPac page (POST /orders/pay) with Stripe test ConfirmationTokens. The loader delivers
// Stripe's real test-mode events to the local webhook (stripe.mjs), the worker confirms the order
// (the money is captured), and the stores and the admin take each order as far as the scenario
// says: ready, collected, refunded or cancelled. Some carts stay open.
//
// State: state.buyers[key] = { email }, state.orders[key] = { orderId, stage }, so a rerun
// resumes an order where it stopped and never pays twice; state.carts[key] = 'filled'.
import { mailLink, Session, sleep } from '../lib.mjs';
import { filed, settle } from './requests.mjs';
import { StripeTestMode, deliverEvent, webhookSecretOf } from '../stripe.mjs';

/** How far each outcome takes an order, in order. */
const STAGES = ['placed', 'paid', 'ready', 'collected', 'refunded'];
const TARGET = {
  paid: 'paid',
  ready: 'ready',
  collected: 'collected',
  refunded: 'refunded',
  cancelled: 'cancelled',
  declined: 'declined',
  'requires-action': 'requires-action',
};
const reached = (stage, target) => STAGES.indexOf(stage) >= STAGES.indexOf(target);

async function waitFor(label, check, seconds) {
  for (let waited = 0; waited <= seconds; waited += 2) {
    const value = await check();
    if (value) return value;
    await sleep(2000);
  }
  throw new Error(`${label} did not happen within ${seconds} s (is the worker running?)`);
}

/**
 * Signs the buyer in, or signs them up and confirms the address from Mailpit (confirming signs in,
 * so every buyer costs one sign-in against the per-address limit of the run).
 */
export async function signedInBuyer(buyer, password, market, known) {
  const session = new Session('customer', market);
  if (known) {
    const first = await session.request('POST', '/identity/customer/sign-in', {
      email: buyer.email,
      password,
    });
    if (first.status === 200) return { session, created: false };
  }
  const since = Date.now() - 2000;
  const signUp = await session.request('POST', '/identity/customer/sign-up', {
    email: buyer.email,
    password,
  });
  if (signUp.status === 403 && signUp.body?.code === 'request.csrf') {
    throw new Error(
      'the API refused the buyer sign-up (403 request.csrf): start it with a Market file that lists ' +
        'the buyer site origin (STOREFRONT_ORIGIN=http://storefront.localhost:3003 node ' +
        'scripts/dev-panels-market.mjs AU, then restart the API).',
    );
  }
  if (signUp.status < 200 || signUp.status > 299) {
    throw new Error(`${buyer.key}: sign-up -> ${signUp.status} ${JSON.stringify(signUp.body)}`);
  }
  // Sign-up answers the same for a new and an existing address (no account oracle): an address
  // that already has an account gets no confirmation mail. Without one, the account is older than
  // the state file: sign in instead.
  let token;
  try {
    token = await mailLink(buyer.email, /#(\S+)/, { since });
  } catch (error) {
    const again = await session.request('POST', '/identity/customer/sign-in', {
      email: buyer.email,
      password,
    });
    if (again.status === 200) return { session, created: false };
    throw error;
  }
  const confirmed = await session.request('POST', '/identity/customer/confirm-email', {
    token,
    password,
  });
  if (confirmed.status === 429) {
    throw new Error(
      `${buyer.key}: sign-ins from this machine are throttled; write the local Market file with ` +
        'LOCAL_SIGN_IN_ORIGIN_LIMIT=300 (README.md) and restart the API.',
    );
  }
  if (confirmed.status !== 200) {
    throw new Error(`${buyer.key}: confirm-email -> ${confirmed.status} ${confirmed.body?.code}`);
  }
  return { session, created: true };
}

/** The buyer's addresses, created when missing (matched by street line); returns their ids. */
export async function ensureAddresses(session, buyer, scenario) {
  const book = await session.ok('GET', '/customers/me/addresses');
  const items = book.addresses ?? book.items ?? [];
  const ids = [];
  for (const [index, address] of buyer.addresses.entries()) {
    const known = items.find((item) => item.line1 === address.line1);
    if (known) {
      ids.push(known.id);
      continue;
    }
    const created = await session.ok('POST', '/customers/me/addresses', {
      recipientFirstName: address.firstName ?? buyer.firstName,
      recipientLastName: address.lastName ?? buyer.lastName,
      phone: buyer.phone,
      line1: address.line1,
      suburb: address.suburb,
      region: scenario.buyerRegion,
      postcode: address.postcode,
      isDefault: index === 0,
    });
    ids.push(created.id ?? created.address?.id);
  }
  return ids;
}

/**
 * The offer id and variant ids of each store's scenario products, read from the store's own offer
 * list (the products pack made them with SKU <PREFIX>-<n>, n the offer's place in the scenario).
 */
export async function offerIndex(scenario, sessions, state) {
  const index = new Map();
  for (const seller of scenario.sellers) {
    const session = sessions.get(seller.key);
    const offers = scenario.offers[seller.key];
    if (!session || !offers) continue;
    const listed = await session.ok('GET', '/catalog/seller/offers?limit=50');
    const bySku = new Map(listed.items.map((item) => [item.sellerSku, item.offerId]));
    const prefix = seller.key.slice(0, 3).toUpperCase();
    const products = new Map();
    for (const [position, entry] of offers.entries()) {
      const offerId = bySku.get(`${prefix}-${String(position + 1).padStart(3, '0')}`);
      const variantIds = state.products?.[entry.product]?.variantIds;
      if (offerId && variantIds) products.set(entry.product, { offerId, variantIds });
    }
    index.set(seller.key, products);
  }
  return index;
}

function lineOf(index, [store, product, quantity, variant = 0], label) {
  const found = index.get(store)?.get(product);
  if (!found) {
    throw new Error(`${label}: no offer of ${product} at ${store} (run the products pack first)`);
  }
  const variantId = found.variantIds[variant];
  if (!variantId) throw new Error(`${label}: ${product} has no variant ${variant}`);
  return { offerId: found.offerId, variantId, quantity };
}

/** Empties the buyer's cart, then adds exactly these lines. */
async function fillCart(session, lines) {
  const cart = await session.ok('GET', '/cart');
  for (const line of cart.lines ?? []) {
    await session.ok('DELETE', `/cart/items/${line.lineId ?? line.id}`);
  }
  for (const line of lines) await session.ok('POST', '/cart/items', line);
}

/** In-person pickup for every store of the cart, from the delivery methods the API offers. */
async function pickupChoices(session, addressId, label) {
  const quotes = await session.ok('POST', '/orders/delivery-quotes', { addressId });
  const choices = {};
  for (const seller of quotes.sellers ?? []) {
    const pickup = (seller.methods ?? []).find((method) => method.method === 'pickup');
    if (!pickup?.available) {
      throw new Error(
        `${label}: store ${seller.sellerId} offers no pickup (${pickup?.reason ?? 'not listed'})`,
      );
    }
    choices[seller.sellerId] = { method: 'pickup' };
  }
  return choices;
}

/**
 * Delivers Stripe's events of the order's PaymentIntent (its id from the admin's order view: the
 * buyer's answer carries no PaymentIntent once the card is authorised), then waits for the worker
 * to confirm the order. Safe to repeat: the API stores each Stripe event once.
 */
export async function confirmPaid(ctx, entry, buyer, orderId, label) {
  const { admin, stripe, secret, scenario, state, save } = ctx;
  const view = await admin.ok('GET', `/ordering/admin/orders/${orderId}`);
  if (typeof view.paymentIntentId !== 'string') {
    throw new Error(`${label}: the order has no PaymentIntent (${view.paymentState})`);
  }
  // Only a PaymentIntent Stripe ties to this very order (a stale state file never points the
  // replay at another one), and only its events.
  await stripe.assertOwnPaymentIntent(view.paymentIntentId, orderId);
  const since = Math.floor(Date.parse(view.createdAt) / 1000) - 120;
  const events = await stripe.eventsOf(view.paymentIntentId, since);
  if (events.length === 0) throw new Error(`${label}: Stripe wrote no event for the payment`);
  for (const event of events) {
    const status = await deliverEvent(event, secret, scenario.market);
    if (status < 200 || status > 299) {
      throw new Error(`${label}: the webhook refused ${event.type} (${status})`);
    }
  }
  const order = await waitFor(
    `${label}: order confirmed`,
    async () => {
      const read = await buyer.ok('GET', `/orders/${orderId}`);
      return read.status === 'pending-payment' ? null : read;
    },
    120,
  );
  if (order.status !== 'confirmed') {
    throw new Error(`${label}: the order is ${order.status} (${order.cancelReason ?? ''})`);
  }
  state.orders[entry.key] = { orderId, stage: 'paid' };
  save();
}

export async function place(ctx, entry, buyer, addressIds, label) {
  const { scenario, index, stripe, state, save, sellerIdOf } = ctx;
  await fillCart(
    buyer,
    entry.lines.map((line) => lineOf(index, line, label)),
  );
  const addressId = addressIds[entry.address ?? 0];
  const deliveryMethods = await pickupChoices(buyer, addressId, label);
  const sellerNotes = Object.fromEntries(
    Object.entries(entry.notes ?? {}).map(([store, note]) => [sellerIdOf(store), note]),
  );
  const confirmationToken = await stripe.confirmationToken(scenario.cards[entry.card]);
  const paid = await buyer.request('POST', '/orders/pay', {
    addressId,
    deliveryMethods,
    ...(Object.keys(sellerNotes).length > 0 ? { sellerNotes } : {}),
    confirmationToken,
  });
  if (entry.outcome === 'declined') {
    if (paid.status !== 402 || paid.body?.code !== 'ordering.card-declined') {
      throw new Error(`${label}: expected a declined card, got ${paid.status} ${paid.body?.code}`);
    }
    state.orders[entry.key] = { orderId: null, stage: 'declined' };
    save();
    return;
  }
  if (paid.status !== 200) {
    throw new Error(`${label}: POST /orders/pay -> ${paid.status} ${JSON.stringify(paid.body)}`);
  }
  const { orderId } = paid.body;
  if (entry.outcome === 'requires-action') {
    if (paid.body.status !== 'requires-action') {
      throw new Error(`${label}: expected 3D Secure, got ${paid.body.status}`);
    }
    state.orders[entry.key] = { orderId, stage: 'requires-action' };
    save();
    return;
  }
  state.orders[entry.key] = { orderId, stage: 'placed' };
  save();
  if (paid.body.status !== 'authorised') {
    throw new Error(`${label}: the card was not authorised (${paid.body.status})`);
  }
  await confirmPaid(ctx, entry, buyer, orderId, label);
}

/**
 * An admin refund or cancellation, through maker-checker when the area asks for it. False when the
 * Market has refunds switched off (tax.refundCredit.enabled, an owner decision): the order stays
 * where it is, and a later run with the switch on finishes it.
 */
async function giveBack(ctx, path, body, label) {
  const { admin, reviewer, log } = ctx;
  const answer = await admin.request('POST', path, body);
  if (answer.status === 409 && answer.body?.code === 'ordering.refund-disabled') {
    ctx.refundsOff = true;
    return false;
  }
  const pending = [];
  if (!filed(answer, pending, label) && (answer.status < 200 || answer.status > 299)) {
    throw new Error(`POST ${path} (${label}) -> ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  await settle(reviewer, pending, log);
  return true;
}

/** Takes a paid order as far as its outcome: ready, collected, refunded, or cancelled. */
export async function fulfil(ctx, entry, buyer, label) {
  const { admin, sessions, state, save, sellerKeyOf } = ctx;
  const record = state.orders[entry.key];
  const target = TARGET[entry.outcome];
  const view = await admin.ok('GET', `/ordering/admin/orders/${record.orderId}`);
  if (target === 'cancelled') {
    // A cancellation refunds every line and the order stays confirmed (the refunds carry it), so
    // only the loader's state says it was done.
    if (
      !(await giveBack(
        ctx,
        `/ordering/admin/orders/${record.orderId}/cancel`,
        { reason: 'seller-cancelled', lossBearer: 'seller' },
        `cancel order ${entry.key}`,
      ))
    ) {
      return;
    }
    state.orders[entry.key] = { ...record, stage: 'cancelled' };
    save();
    return;
  }
  for (const part of view.sellerOrders) {
    const store = sessions.get(sellerKeyOf(part.sellerId));
    if (!store) throw new Error(`${label}: no signed-in store for seller ${part.sellerId}`);
    if (!reached(record.stage, 'ready') && reached(target, 'ready') && part.readyAt === null) {
      await store.ok('POST', `/ordering/seller/orders/${part.sellerOrderId}/ready`, {});
    }
    if (!reached(record.stage, 'collected') && reached(target, 'collected')) {
      const own = await waitFor(
        `${label}: pickup code`,
        async () => {
          const order = await buyer.ok('GET', `/orders/${record.orderId}`);
          return order.pickupCodes.find((code) => code.sellerId === part.sellerId) ?? null;
        },
        30,
      );
      await store.ok('POST', `/ordering/seller/orders/${part.sellerOrderId}/confirm-pickup`, {
        code: own.code,
      });
    }
  }
  const stage = reached(target, 'collected') ? 'collected' : target;
  state.orders[entry.key] = { ...record, stage };
  save();
  if (target === 'refunded' && !reached(record.stage, 'refunded')) {
    const part = view.sellerOrders[0];
    const line = part.lines[0];
    const refunded = await giveBack(
      ctx,
      `/ordering/admin/orders/${record.orderId}/seller-orders/${part.sellerOrderId}/refunds`,
      {
        lines: [{ orderLineId: line.lineId, quantity: 1 }],
        reason: 'damaged',
        lossBearer: 'seller',
      },
      `refund order ${entry.key}`,
    );
    if (!refunded) return;
    state.orders[entry.key] = { ...record, stage: 'refunded' };
    save();
  }
}

/**
 * What the order steps share: the Stripe test client and webhook secret, the offers of each store,
 * and the loader's state (state.buyers, state.orders, state.carts are created here).
 */
export async function orderContext({ admin, reviewer, scenario, sessions, state, save, log }) {
  const market = scenario.market;
  const stripe = new StripeTestMode(process.env.STRIPE_SECRET_KEY, market);
  const secret = webhookSecretOf(process.env.STRIPE_WEBHOOK_SECRET, market);
  state.buyers ??= {};
  state.orders ??= {};
  state.carts ??= {};
  const sellerIds = new Map(
    Object.entries(state.sellers ?? {}).map(([key, value]) => [key, value.sellerId]),
  );
  const sellerIdOf = (key) => {
    const id = sellerIds.get(key);
    if (!id) throw new Error(`no seller id for store ${key} (run the sellers pack first)`);
    return id;
  };
  const sellerKeyOf = (id) => [...sellerIds].find(([, value]) => value === id)?.[0];
  const index = await offerIndex(scenario, sessions, state);
  return {
    admin,
    reviewer,
    scenario,
    index,
    stripe,
    secret,
    state,
    save,
    log,
    sessions,
    sellerIdOf,
    sellerKeyOf,
  };
}

/** Takes one order from nothing to its outcome; a rerun resumes where an earlier run stopped. */
export async function runOrder(ctx, entry, buyer, addressIds) {
  const { state } = ctx;
  const label = `order ${entry.key}`;
  if (!state.orders[entry.key]) await place(ctx, entry, buyer, addressIds, label);
  // An earlier run stopped between the card and the confirmation: deliver the events again.
  if (state.orders[entry.key].stage === 'placed') {
    await confirmPaid(ctx, entry, buyer, state.orders[entry.key].orderId, label);
  }
  const stage = state.orders[entry.key].stage;
  if (!['declined', 'requires-action', 'cancelled', 'refunded'].includes(stage)) {
    if (TARGET[entry.outcome] !== 'paid') await fulfil(ctx, entry, buyer, label);
  }
  return state.orders[entry.key].stage;
}

export async function ordersPack({
  admin,
  reviewer,
  scenario,
  sessions,
  state,
  save,
  password,
  log,
}) {
  const market = scenario.market;
  const ctx = await orderContext({ admin, reviewer, scenario, sessions, state, save, log });
  const { index } = ctx;

  const buyers = new Map();
  let made = 0;
  for (const buyer of scenario.buyers) {
    const { session, created } = await signedInBuyer(
      buyer,
      password,
      market,
      state.buyers[buyer.key] !== undefined,
    );
    if (created) {
      made += 1;
      await session.ok('PUT', '/identity/customer/profile/display-name', {
        displayName: `${buyer.firstName} ${buyer.lastName}`,
      });
    }
    state.buyers[buyer.key] = { email: buyer.email };
    save();
    const addressIds = await ensureAddresses(session, buyer, scenario);
    buyers.set(buyer.key, { session, addressIds });
  }
  save();
  log(`  ${scenario.buyers.length} buyers (${made} new) with their address books`);

  const counts = {};
  for (const entry of scenario.orders) {
    const { session, addressIds } = buyers.get(entry.buyer);
    const reachedStage = await runOrder(ctx, entry, session, addressIds);
    counts[reachedStage] = (counts[reachedStage] ?? 0) + 1;
  }
  if (ctx.refundsOff) {
    log(
      '  note: this Market has refunds switched off (tax.refundCredit.enabled), so the orders to ' +
        'cancel or refund stay paid or collected; a later run with the switch on finishes them',
    );
  }
  log(
    `  ${scenario.orders.length} orders (${Object.entries(counts)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ')})`,
  );

  for (const cart of scenario.openCarts) {
    if (state.carts[cart.buyer] === 'filled') continue;
    const { session } = buyers.get(cart.buyer);
    await fillCart(
      session,
      cart.lines.map((line) => lineOf(index, line, `open cart ${cart.buyer}`)),
    );
    state.carts[cart.buyer] = 'filled';
    save();
  }
  log(`  ${scenario.openCarts.length} open carts`);
}
