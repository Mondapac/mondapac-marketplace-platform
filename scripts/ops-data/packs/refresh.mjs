// Pack "refresh" (operational test data design, phase 3, `ops refresh`): adds fresh activity to a
// finished operational test database WITHOUT deleting anything, so the dashboards and lists show
// today's data: shelves that ran low are filled again, "was" prices whose special price ended or
// is about to end get a new two-week window, and a small batch of today's orders is placed in
// Stripe test mode through the same steps the orders pack uses (orders.mjs: card, webhook,
// worker, pickup, and for one order an admin cancellation).
//
// Everything goes through the API like a person would. Each order has its own key
// (r<YYYYMMDD>-<n>), so a rerun on the same day tops the batch up to the wanted count and never
// pays twice; a new day adds a new batch. The loader's state records every key.
import { runOrder, orderContext, signedInBuyer, ensureAddresses } from './orders.mjs';
import { sellerSignIn } from './sellers.mjs';

const DAY = 86_400_000;

/** How far each order of a batch goes, in order (a cycle). Cancelling is local-only by guard. */
export const BATCH_OUTCOMES = ['paid', 'ready', 'paid', 'collected', 'ready', 'cancelled'];

const asList = (value) => (Array.isArray(value) ? value : [value]);

/** The day as YYYYMMDD in UTC, the key's date part. */
export const dayKey = (now) => new Date(now).toISOString().slice(0, 10).replaceAll('-', '');

/** True when a shelf is below half of its scenario level (then it is filled to the level). */
export const needsStock = (onHand, level) => onHand < Math.ceil(level / 2);

/** True when a "was" price has no special price now, or it ends within the next 3 days. */
export function needsSpecial(special, now) {
  if (special === null) return true;
  if (special.state === 'ended' || special.state === 'cancelled') return true;
  return Date.parse(special.endsAt) < now + 3 * DAY;
}

/**
 * The orders of one day's batch. Each takes a store that has offers, picks products from its
 * shelf (never the held-price one) until the store's minimum order is met, and a buyer by
 * rotation. Deterministic for a day and a count, so a rerun plans the same orders.
 * `index` is the offer index of orders.mjs: store key -> product key -> { offerId, variantIds }.
 */
export function planBatch({ scenario, index, now, count }) {
  const day = Math.floor(now / DAY);
  const stores = scenario.sellers.filter((seller) => index.get(seller.key)?.size > 0);
  if (stores.length === 0 || scenario.buyers.length === 0) return [];
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    const buyer = scenario.buyers[(day * 7 + n * 5) % scenario.buyers.length];
    let lines = null;
    // Try the stores in rotation; the first whose shelf can meet its minimum gives the lines.
    for (let attempt = 0; attempt < stores.length && lines === null; attempt += 1) {
      const seller = stores[(day * 3 + n * 4 + attempt) % stores.length];
      lines = linesFor(scenario, seller, index.get(seller.key), (day + n) % 97);
    }
    if (lines === null) continue;
    entries.push({
      key: `r${dayKey(now)}-${n + 1}`,
      buyer: buyer.key,
      outcome: BATCH_OUTCOMES[n % BATCH_OUTCOMES.length],
      card: n % 2 === 0 ? 'visa' : 'mastercard',
      lines,
    });
  }
  return entries;
}

/** Lines [store, product, quantity] reaching the store's minimum, or null when the shelf cannot. */
function linesFor(scenario, seller, products, start) {
  const offers = scenario.offers[seller.key] ?? [];
  const shelf = offers.filter(
    (entry) => products.has(entry.product) && entry.product !== scenario.held.product,
  );
  if (shelf.length === 0) return null;
  const minimum = seller.minimum ?? 0;
  const lines = [];
  let total = 0;
  for (
    let step = 0;
    step < shelf.length && lines.length < 4 && (lines.length === 0 || total < minimum);
    step += 1
  ) {
    const entry = shelf[(start + step) % shelf.length];
    const price = Number(asList(entry.price)[0]);
    const level = Number(asList(entry.stock)[0]);
    const quantity = Math.min(level, 5, Math.max(1, Math.ceil((minimum - total) / price)));
    if (quantity < 1) continue;
    lines.push([seller.key, entry.product, quantity]);
    total += price * quantity;
  }
  return total >= minimum && lines.length > 0 ? lines : null;
}

/** Fills the shelves that ran low (below half of the scenario's level) back to the level. */
async function topUpStock(session, seller, offerIds, scenario, state) {
  const sources = await session.ok('GET', '/inventory/seller/sources');
  const source = sources.sources.find((item) => item.isDefault) ?? sources.sources[0];
  let filled = 0;
  for (const [product, offerId] of offerIds) {
    const entry = scenario.offers[seller.key].find((item) => item.product === product);
    const levels = asList(entry.stock);
    const stock = await session.ok('GET', `/inventory/seller/offers/${offerId}/stock`);
    for (const [position, variantId] of (state.products[product]?.variantIds ?? []).entries()) {
      const row = stock.variants.find((variant) => variant.variantId === variantId)?.sources[0];
      if (!row || !needsStock(row.onHand, levels[position])) continue;
      await session.ok(
        'PUT',
        `/inventory/seller/offers/${offerId}/variants/${variantId}/sources/${source.id}/stock`,
        { onHand: levels[position], expectedVersion: row.version },
      );
      filled += 1;
    }
  }
  return filled;
}

/** A new two-week special price where a "was" price has none (or it ends within 3 days). */
async function renewSpecials(session, seller, offerIds, scenario, state, now) {
  const endsAt = new Date(now + 14 * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
  let renewed = 0;
  for (const [product, offerId] of offerIds) {
    const entry = scenario.offers[seller.key].find((item) => item.product === product);
    if (entry.was === undefined) continue;
    const selling = asList(entry.price);
    const prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
    for (const [position, variantId] of (state.products[product]?.variantIds ?? []).entries()) {
      const price = prices.variants.find((variant) => variant.variantId === variantId);
      // A special price waiting for review is left to the admin; a missing regular price is a
      // loader problem the main run reports, not something to paper over here.
      if (!price || price.inForce === null || price.heldSpecial !== null) continue;
      if (!needsSpecial(price.special, now)) continue;
      await session.ok(
        'PUT',
        `/pricing/seller/offers/${offerId}/variants/${variantId}/special-price`,
        {
          amount: String(selling[position]),
          currency: scenario.currency,
          endsAt,
          expectedVersion: price.seriesVersion,
        },
      );
      renewed += 1;
    }
  }
  return renewed;
}

/**
 * The refresh. `sessions` are NOT passed in: the approved stores sign in here (the refresh does
 * not rebuild sellers). Returns the counts for the log.
 */
export async function refreshPack({
  admin,
  reviewer,
  scenario,
  state,
  save,
  password,
  log,
  orders,
  now = Date.now(),
}) {
  const market = scenario.market;
  const sessions = new Map();
  for (const seller of scenario.sellers) {
    if (state.sellers?.[seller.key]?.state !== 'approved') continue;
    const found = await sellerSignIn(seller, password, market);
    if (found?.access === 'approved') sessions.set(seller.key, found.session);
  }
  if (sessions.size === 0) throw new Error('no approved store in the state: run the loader first');

  const ctx = await orderContext({ admin, reviewer, scenario, sessions, state, save, log });
  let filled = 0;
  let renewed = 0;
  for (const seller of scenario.sellers) {
    const session = sessions.get(seller.key);
    const products = ctx.index.get(seller.key);
    if (!session || !products) continue;
    const offerIds = [...products].map(([product, found]) => [product, found.offerId]);
    filled += await topUpStock(session, seller, offerIds, scenario, state);
    renewed += await renewSpecials(session, seller, offerIds, scenario, state, now);
  }
  log(`  ${filled} shelves filled again, ${renewed} special prices renewed`);

  const counts = {};
  if (orders > 0) {
    const plan = planBatch({ scenario, index: ctx.index, now, count: orders });
    const buyers = new Map();
    for (const entry of plan) {
      if (!buyers.has(entry.buyer)) {
        const buyer = scenario.buyers.find((item) => item.key === entry.buyer);
        const { session } = await signedInBuyer(
          buyer,
          password,
          market,
          state.buyers[buyer.key] !== undefined,
        );
        state.buyers[buyer.key] = { email: buyer.email };
        save();
        buyers.set(buyer.key, {
          session,
          addressIds: await ensureAddresses(session, buyer, scenario),
        });
      }
      const { session, addressIds } = buyers.get(entry.buyer);
      const stage = await runOrder(ctx, entry, session, addressIds);
      counts[stage] = (counts[stage] ?? 0) + 1;
    }
    if (ctx.refundsOff) {
      log('  note: this Market has refunds switched off, so the cancelled order stays paid');
    }
  }
  log(
    `  today's batch: ${
      Object.entries(counts)
        .map(([name, count]) => `${count} ${name}`)
        .join(', ') || 'no orders'
    }`,
  );
  state.lastRefresh = { at: new Date(now).toISOString(), filled, renewed, orders: counts };
  save();
  return { filled, renewed, orders: counts };
}
