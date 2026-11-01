import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { distribute, floorShare } from './allocation';
import { LAYERS } from './types';
import type {
  Allocation,
  AppliedPromotion,
  CalculationError,
  CalculationInput,
  CalculationOutput,
  CalculationPromotion,
  CartLine,
  CodeOutcome,
  Layer,
  LineResult,
  ShippingCharge,
  ShippingResult,
  Reward,
  Tier,
} from './types';

// The pure discount calculation (promotions package T1; plan sections 6 and 8). Four layers in
// order, each on the result of the one before: item, seller cart, platform cart, shipping. Wallet
// credit is payment, not a discount, and is not here.
//
// Rules, in the order they bite:
// - One item-level discount per line, the best for the buyer (ties: the seller-funded one, then
//   the smaller promotion id).
// - One code per order: only the entered code's promotion is a candidate.
// - Automatic offers of different layers stack. A promotion marked non-combinable is used alone:
//   the engine compares "all combinable promotions together" with "each non-combinable one alone"
//   and takes whichever gives the buyer most (ties: the stack, then the smaller id).
// - The first-order discount does not stack with a platform code: the larger of the two applies.
// - All discounts together take at most `lineDiscountCapBps` of a line's price, never more than
//   what is left of the line (never below zero).
// - The platform's share of the goods discounts of one order is capped at that order's
//   commission, unless the promotion is a special campaign. Shipping discounts are always
//   platform-funded and are outside this cap (shipping is not a seller transfer).
// - Money is integer minor units; every share is floored and the rounding remainder goes to the
//   largest line (ties: the smaller line id). The result never depends on the input order.
//
// Phase 2 types:
// - Multi-unit item offers (buy X get Y, multi-buy, bundle) are worked out over the whole pool of
//   units they qualify, each into a discount per line. That discount is the offer's candidate for
//   the line, on the whole line amount, and competes with every other item-level candidate under
//   the one-discount-per-line rule: a line is covered by one offer or not at all, never one unit
//   by one offer and the rest by another.
// - The units that qualify a multi-unit offer are paid at full price: a line another item-level
//   offer wins is taken out of the offer's pool and the competition is run again until it is
//   stable (see applyItemLayer; owner decision 2026-10-28).
// - A limit of units (flash sale) is spent line by line, the dearest unit price first (ties:
//   the smaller line id), only by lines the offer wins.
// - A tiered cart discount takes the highest tier its goods amount reaches.
// - A single-use code that was already redeemed matches the entered code and gives nothing.

interface Placed {
  readonly kind: 'line' | 'shipping';
  readonly targetId: string;
  readonly allocation: Allocation;
}

interface State {
  /** Gross minus everything allocated so far, per line. */
  remaining: Map<string, bigint>;
  /** What the line's cap still allows, per line. */
  capLeft: Map<string, bigint>;
  placed: Placed[];
  /** The commission not yet used by platform-funded, non-special discounts. */
  platformLeft: bigint;
}

const cloneState = (state: State): State => ({
  remaining: new Map(state.remaining),
  capLeft: new Map(state.capLeft),
  placed: [...state.placed],
  platformLeft: state.platformLeft,
});

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lineGross = (line: CartLine): bigint => line.unitPrice * BigInt(line.quantity);

/** Seller-funded first (the plan: the platform pays less on a tie), then the smaller id. */
const byFundingThenId = (a: CalculationPromotion, b: CalculationPromotion): number =>
  a.platformShareBps - b.platformShareBps || compareText(a.id, b.id);

/** Automatic promotions before the code, then by funding and id. */
const byCodeThenFundingThenId = (a: CalculationPromotion, b: CalculationPromotion): number =>
  Number(a.code !== null) - Number(b.code !== null) || byFundingThenId(a, b);

const allows = (targets: readonly string[] | null, value: string): boolean =>
  targets === null || targets.includes(value);

/** A seller's promotion touches that seller's lines only; a platform one any line its targets name. */
function matchesLine(promotion: CalculationPromotion, line: CartLine): boolean {
  return (
    (promotion.sellerId === null || promotion.sellerId === line.sellerId) &&
    allows(promotion.productIds, line.productId) &&
    allows(promotion.sellerIds, line.sellerId)
  );
}

function matchesCharge(promotion: CalculationPromotion, charge: ShippingCharge): boolean {
  return (
    allows(promotion.zones, charge.zoneCode) &&
    (promotion.sellerIds === null ||
      (charge.sellerId !== null && promotion.sellerIds.includes(charge.sellerId))) &&
    (promotion.sellerId === null || promotion.sellerId === charge.sellerId)
  );
}

/** The most a promotion may still give in this order: its cap, per-order limit, budget and commission. */
function limitOf(promotion: CalculationPromotion, state: State, shipping: boolean): bigint | null {
  let limit: bigint | null = null;
  const lower = (value: bigint | null) => {
    if (value !== null) limit = limit === null ? value : min(limit, value);
  };
  lower(promotion.capAmount);
  lower(promotion.maxPerOrder);
  lower(promotion.budgetRemaining);
  if (!shipping && !promotion.specialCampaign && promotion.platformShareBps > 0) {
    // floor(d * bps / 10000) is at most d * bps / 10000, so a discount of this size never takes
    // more than the commission that is left, whatever the per-line rounding.
    lower((state.platformLeft * 10000n) / BigInt(promotion.platformShareBps));
  }
  return limit === null ? null : limit < 0n ? 0n : limit;
}

/**
 * The most a promotion may give on one line so that the seller's share of it stays within
 * `sellerMaxShareBps` of the line; null when the promotion has no such limit. The seller pays
 * `amount - platformShare` and the platform share is spread over the lines with a rounding
 * remainder (see {@link commit}), so a line's platform share can be one unit below its exact
 * share: one unit of the limit is kept in reserve when the platform pays part of the discount.
 */
function sellerLineLimit(promotion: CalculationPromotion, gross: bigint): bigint | null {
  const max = promotion.sellerMaxShareBps ?? null;
  const platform = promotion.platformShareBps;
  if (max === null || platform >= 10000) return null;
  const allowed = floorShare(gross, max);
  const sellerPart = BigInt(10000 - platform);
  if (platform === 0) return allowed;
  if (allowed <= 0n) return 0n;
  return ((allowed - 1n) * 10000n) / sellerPart;
}

function commit(
  state: State,
  promotion: CalculationPromotion,
  amounts: ReadonlyMap<string, bigint>,
  kind: 'line' | 'shipping',
): void {
  const bps = kind === 'shipping' ? 10000 : promotion.platformShareBps;
  const ids = [...amounts.keys()].filter((id) => (amounts.get(id) ?? 0n) > 0n).sort(compareText);
  // The platform's share is taken once for the whole promotion and then spread over its lines
  // (the remainder to the largest line), so the sellers do not absorb every rounding unit.
  const total = ids.reduce((sum, id) => sum + (amounts.get(id) ?? 0n), 0n);
  const platformTotal = floorShare(total, bps);
  const platformShares = distribute(
    platformTotal,
    ids.map((id) => ({ id, weight: amounts.get(id) ?? 0n, cap: amounts.get(id) ?? 0n })),
  );
  for (const targetId of ids) {
    const amount = amounts.get(targetId) ?? 0n;
    const platformShare = platformShares.get(targetId) ?? 0n;
    state.placed.push({
      kind,
      targetId,
      allocation: {
        promotionId: promotion.id,
        layer: promotion.layer,
        amount,
        sellerShare: amount - platformShare,
        platformShare,
      },
    });
    if (kind === 'line') {
      state.remaining.set(targetId, (state.remaining.get(targetId) ?? 0n) - amount);
      state.capLeft.set(targetId, (state.capLeft.get(targetId) ?? 0n) - amount);
    }
  }
  if (kind === 'line' && !promotion.specialCampaign) state.platformLeft -= platformTotal;
}

/** Trims per-target amounts to `limit`, keeping the split in proportion; the remainder goes to the largest. */
function trim(amounts: Map<string, bigint>, limit: bigint | null): Map<string, bigint> {
  const total = [...amounts.values()].reduce((sum, value) => sum + value, 0n);
  if (limit === null || total <= limit) return amounts;
  return distribute(
    limit,
    [...amounts.entries()].map(([id, value]) => ({ id, weight: value, cap: value })),
  );
}

function better(
  amount: bigint,
  promotion: CalculationPromotion,
  best: { amount: bigint; promotion: CalculationPromotion } | null,
): boolean {
  if (best === null) return true;
  if (amount !== best.amount) return amount > best.amount;
  return byFundingThenId(promotion, best.promotion) < 0;
}

const unitsOf = (line: CartLine): bigint => BigInt(line.quantity);

/** Whole groups of `size` that `units` hold, within `maxRepeats` (null for none). */
function groupsOf(units: bigint, size: bigint, maxRepeats: number | null): bigint {
  const groups = units / size;
  return maxRepeats === null || groups <= BigInt(maxRepeats) ? groups : BigInt(maxRepeats);
}

/** Cheapest unit price first; equal prices by the smaller line id. */
const byPriceThenId = (a: CartLine, b: CartLine): number =>
  a.unitPrice === b.unitPrice ? compareText(a.id, b.id) : a.unitPrice < b.unitPrice ? -1 : 1;

/**
 * Takes `count` units from the lines, cheapest first, and answers the units taken per line.
 * Lines with no unit taken are left out.
 */
function takeCheapest(lines: readonly CartLine[], count: bigint): Map<string, bigint> {
  const taken = new Map<string, bigint>();
  let left = count;
  for (const line of [...lines].sort(byPriceThenId)) {
    if (left <= 0n) break;
    const units = unitsOf(line) < left ? unitsOf(line) : left;
    taken.set(line.id, units);
    left -= units;
  }
  return taken;
}

const rewardPerUnit = (reward: CalculationPromotion['reward'], unitPrice: bigint): bigint =>
  reward.kind === 'PERCENT' ? floorShare(unitPrice, reward.bps) : min(reward.amount, unitPrice);

/**
 * The discount per line of a promotion that works over the pool of units it qualifies (buy X get
 * Y, multi-buy, bundle); null for a promotion that is worked out line by line. Lines it gives
 * nothing to are not in the map.
 */
function poolDiscounts(
  promotion: CalculationPromotion,
  lines: readonly CartLine[],
): Map<string, bigint> | null {
  const pool = lines.filter((line) => matchesLine(promotion, line));
  const out = new Map<string, bigint>();
  const buyXGetY = promotion.buyXGetY ?? null;
  if (buyXGetY !== null) {
    const size = BigInt(buyXGetY.buyQty + buyXGetY.getQty);
    const units = pool.reduce((sum, line) => sum + unitsOf(line), 0n);
    const rewarded = groupsOf(units, size, buyXGetY.maxRepeats) * BigInt(buyXGetY.getQty);
    for (const [lineId, count] of takeCheapest(pool, rewarded)) {
      const line = pool.find((candidate) => candidate.id === lineId)!;
      out.set(lineId, count * rewardPerUnit(promotion.reward, line.unitPrice));
    }
    return out;
  }
  const multiBuy = promotion.multiBuy ?? null;
  if (multiBuy !== null) {
    const size = BigInt(multiBuy.groupQty);
    const units = pool.reduce((sum, line) => sum + unitsOf(line), 0n);
    const groups = groupsOf(units, size, multiBuy.maxRepeats);
    const groupsPrice = groups * multiBuy.groupPrice;
    return spreadOverUnits(pool, takeCheapest(pool, groups * size), (cost) => cost - groupsPrice);
  }
  const bundle = promotion.bundle ?? null;
  if (bundle !== null) {
    let sets: bigint | null = null;
    for (const item of bundle.items) {
      const have = pool
        .filter((line) => line.productId === item.productId)
        .reduce((sum, line) => sum + unitsOf(line), 0n);
      const complete = have / BigInt(item.quantity);
      sets = sets === null || complete < sets ? complete : sets;
    }
    sets = sets === null ? 0n : groupsOf(sets, 1n, bundle.maxRepeats);
    const taken = new Map<string, bigint>();
    for (const item of bundle.items) {
      const ofItem = pool.filter((line) => line.productId === item.productId);
      for (const [lineId, count] of takeCheapest(ofItem, sets * BigInt(item.quantity))) {
        taken.set(lineId, (taken.get(lineId) ?? 0n) + count);
      }
    }
    const setsOff = sets * bundle.amountOff;
    return spreadOverUnits(pool, taken, () => setsOff);
  }
  return null;
}

/**
 * Spreads a group offer over the lines whose units it uses: `discountOf` is the discount for those
 * units given what they cost on their own (multi-buy: that cost less the groups' price; bundle: the
 * amount off the sets). Never more than the units cost; the split follows each line's share of that
 * cost and the remainder goes to the largest line.
 */
function spreadOverUnits(
  pool: readonly CartLine[],
  taken: ReadonlyMap<string, bigint>,
  discountOf: (cost: bigint) => bigint,
): Map<string, bigint> {
  const value = (line: CartLine) => (taken.get(line.id) ?? 0n) * line.unitPrice;
  const used = pool.filter((line) => value(line) > 0n);
  const cost = used.reduce((sum, line) => sum + value(line), 0n);
  const total = min(discountOf(cost), cost);
  if (total <= 0n) return new Map();
  const split = distribute(
    total,
    used.map((line) => ({ id: line.id, weight: value(line), cap: value(line) })),
  );
  return new Map([...split].filter(([, amount]) => amount > 0n));
}

/** What each item-level promotion wins: its amount per line, and the line each line was won by. */
interface ItemOutcome {
  readonly chosen: Map<string, Map<string, bigint>>;
  readonly winner: Map<string, string>;
}

/**
 * One round of the per-line competition. `excluded` holds, per multi-unit promotion, the lines
 * that are out of its pool (they were won by another offer, see {@link applyItemLayer}); nothing
 * in the state is changed here.
 */
function competeOnLines(
  state: State,
  lines: readonly CartLine[],
  promotions: readonly CalculationPromotion[],
  lineCapBps: number,
  excluded: ReadonlyMap<string, ReadonlySet<string>>,
): ItemOutcome {
  const out = (promotion: CalculationPromotion, line: CartLine): boolean =>
    excluded.get(promotion.id)?.has(line.id) === true;
  const pooled = new Map<string, Map<string, bigint>>();
  for (const promotion of promotions) {
    const inPool = lines.filter((line) => !out(promotion, line));
    const discounts = poolDiscounts(promotion, inPool);
    if (discounts !== null) pooled.set(promotion.id, discounts);
  }
  // The units a limited promotion may still discount in this order.
  const unitsLeft = new Map<string, bigint>();
  for (const promotion of promotions) {
    if (promotion.unitLimit != null) unitsLeft.set(promotion.id, BigInt(promotion.unitLimit));
  }
  const chosen = new Map<string, Map<string, bigint>>();
  const winner = new Map<string, string>();
  // The dearest unit price first, so a limit of units goes where it saves most (ties: line id).
  const ordered = [...lines].sort((a, b) =>
    a.unitPrice === b.unitPrice ? compareText(a.id, b.id) : a.unitPrice > b.unitPrice ? -1 : 1,
  );
  for (const line of ordered) {
    let best: { amount: bigint; promotion: CalculationPromotion; units: bigint } | null = null;
    for (const promotion of promotions) {
      if (!matchesLine(promotion, line) || out(promotion, line)) continue;
      const pool = pooled.get(promotion.id);
      // A limited promotion covers only the units that are left, and its shares are held against
      // those units' price, not the whole line's.
      const limited = unitsLeft.has(promotion.id);
      const covered = limited ? min(unitsOf(line), unitsLeft.get(promotion.id)!) : unitsOf(line);
      const coveredGross = line.unitPrice * covered;
      const base = limited ? coveredGross : lineGross(line);
      const wanted =
        pool !== undefined
          ? (pool.get(line.id) ?? 0n)
          : promotion.reward.kind === 'PERCENT'
            ? floorShare(coveredGross, promotion.reward.bps)
            : min(promotion.reward.amount, line.unitPrice) * covered;
      const byShare =
        promotion.maxShareBps === null
          ? wanted
          : min(wanted, floorShare(base, promotion.maxShareBps));
      const bySeller = sellerLineLimit(promotion, base);
      const share = bySeller === null ? byShare : min(byShare, bySeller);
      const byCap = limited ? min(share, floorShare(coveredGross, lineCapBps)) : share;
      const amount = min(byCap, min(state.remaining.get(line.id)!, state.capLeft.get(line.id)!));
      if (amount > 0n && better(amount, promotion, best))
        best = { amount, promotion, units: covered };
    }
    if (best !== null) {
      const perLine = chosen.get(best.promotion.id) ?? new Map<string, bigint>();
      perLine.set(line.id, best.amount);
      chosen.set(best.promotion.id, perLine);
      winner.set(line.id, best.promotion.id);
      const left = unitsLeft.get(best.promotion.id);
      if (left !== undefined) unitsLeft.set(best.promotion.id, left - best.units);
    }
  }
  return { chosen, winner };
}

function applyItemLayer(
  state: State,
  lines: readonly CartLine[],
  promotions: readonly CalculationPromotion[],
  lineCapBps: number,
): void {
  // The units that qualify a multi-unit offer (the "buy" units of buy X get Y, the units of a
  // multi-buy or a bundle) are paid at full price: a line another item-level offer wins does not
  // count toward the offer's pool. The pools are rebuilt without such lines and the competition is
  // run again, until no pooled line is won by another offer. Lines only ever leave a pool, so the
  // rounds are bounded, and every round depends on the cart alone, not on the order of its parts.
  // Owner decision 2026-10-28.
  const excluded = new Map<string, Set<string>>();
  let outcome = competeOnLines(state, lines, promotions, lineCapBps, excluded);
  for (let round = 0; round <= lines.length * promotions.length; round++) {
    let grew = false;
    for (const promotion of promotions) {
      if (promotion.buyXGetY == null && promotion.multiBuy == null && promotion.bundle == null) {
        continue;
      }
      for (const line of lines) {
        const won = outcome.winner.get(line.id);
        if (won === undefined || won === promotion.id || !matchesLine(promotion, line)) continue;
        const set = excluded.get(promotion.id) ?? new Set<string>();
        if (!set.has(line.id)) {
          set.add(line.id);
          excluded.set(promotion.id, set);
          grew = true;
        }
      }
    }
    if (!grew) break;
    outcome = competeOnLines(state, lines, promotions, lineCapBps, excluded);
  }
  for (const promotion of [...promotions].sort(byFundingThenId)) {
    const perLine = outcome.chosen.get(promotion.id);
    if (perLine === undefined) continue;
    commit(state, promotion, trim(perLine, limitOf(promotion, state, false)), 'line');
  }
}

/** The reward of the highest tier whose threshold `base` reaches; null below the first tier. */
function tierReward(tiers: readonly Tier[], base: bigint): Reward | null {
  let reached: Tier | null = null;
  for (const tier of tiers) {
    if (tier.threshold <= base && (reached === null || tier.threshold > reached.threshold)) {
      reached = tier;
    }
  }
  return reached === null ? null : reached.reward;
}

function applyCartPromotion(
  state: State,
  lines: readonly CartLine[],
  promotion: CalculationPromotion,
): void {
  const eligible = lines.filter(
    (line) => matchesLine(promotion, line) && (state.remaining.get(line.id) ?? 0n) > 0n,
  );
  const base = eligible.reduce((sum, line) => sum + state.remaining.get(line.id)!, 0n);
  if (base <= 0n) return;
  if (promotion.minSpend !== null && base < promotion.minSpend) return;
  const room = (line: CartLine) => {
    const left = min(state.remaining.get(line.id)!, state.capLeft.get(line.id)!);
    const bySeller = sellerLineLimit(promotion, lineGross(line));
    return bySeller === null ? left : min(left, bySeller);
  };
  const capacity = eligible.reduce((sum, line) => sum + room(line), 0n);
  // A tiered promotion gives the reward of the highest tier its goods amount reaches.
  const reward = promotion.tiers == null ? promotion.reward : tierReward(promotion.tiers, base);
  if (reward === null) return;
  let amount = reward.kind === 'PERCENT' ? floorShare(base, reward.bps) : min(reward.amount, base);
  amount = min(amount, capacity);
  if (promotion.maxShareBps !== null) amount = min(amount, floorShare(base, promotion.maxShareBps));
  const limit = limitOf(promotion, state, false);
  if (limit !== null) amount = min(amount, limit);
  if (amount <= 0n) return;
  const split = distribute(
    amount,
    eligible.map((line) => ({
      id: line.id,
      weight: state.remaining.get(line.id)!,
      cap: room(line),
    })),
  );
  commit(state, promotion, split, 'line');
}

const layerTotal = (state: State, layer: Layer): bigint =>
  state.placed
    .filter((placed) => placed.allocation.layer === layer)
    .reduce((sum, placed) => sum + placed.allocation.amount, 0n);

function applyCartLayer(
  state: State,
  lines: readonly CartLine[],
  promotions: readonly CalculationPromotion[],
  layer: Layer,
): State {
  const run = (target: State, list: readonly CalculationPromotion[]) => {
    for (const promotion of [...list].sort(byCodeThenFundingThenId)) {
      applyCartPromotion(target, lines, promotion);
    }
  };
  const firstOrder = promotions.filter((promotion) => promotion.type === 'FIRST_ORDER');
  const codes = promotions.filter(
    (promotion) => promotion.code !== null && promotion.type !== 'FIRST_ORDER',
  );
  // The first-order discount does not stack with a platform code: the larger of the two wins
  // (a tie goes to the code the customer typed).
  if (layer === 'PLATFORM_CART' && firstOrder.length > 0 && codes.length > 0) {
    const withCode = cloneState(state);
    run(
      withCode,
      promotions.filter((promotion) => promotion.type !== 'FIRST_ORDER'),
    );
    const withFirstOrder = cloneState(state);
    run(
      withFirstOrder,
      promotions.filter((promotion) => !codes.includes(promotion)),
    );
    return layerTotal(withCode, layer) >= layerTotal(withFirstOrder, layer)
      ? withCode
      : withFirstOrder;
  }
  run(state, promotions);
  return state;
}

function applyShippingLayer(
  state: State,
  charges: readonly ShippingCharge[],
  promotions: readonly CalculationPromotion[],
): void {
  const goodsNet = [...state.remaining.values()].reduce((sum, value) => sum + value, 0n);
  const chosen = new Map<string, Map<string, bigint>>();
  for (const charge of charges) {
    let best: { amount: bigint; promotion: CalculationPromotion } | null = null;
    for (const promotion of promotions) {
      if (!matchesCharge(promotion, charge)) continue;
      if (promotion.minSpend !== null && goodsNet < promotion.minSpend) continue;
      const wanted =
        promotion.reward.kind === 'PERCENT'
          ? floorShare(charge.amount, promotion.reward.bps)
          : promotion.reward.amount;
      const amount = min(wanted, charge.amount);
      if (amount > 0n && better(amount, promotion, best)) best = { amount, promotion };
    }
    if (best !== null) {
      const perCharge = chosen.get(best.promotion.id) ?? new Map<string, bigint>();
      perCharge.set(charge.id, best.amount);
      chosen.set(best.promotion.id, perCharge);
    }
  }
  for (const promotion of [...promotions].sort(byFundingThenId)) {
    const perCharge = chosen.get(promotion.id);
    if (perCharge === undefined) continue;
    commit(state, promotion, trim(perCharge, limitOf(promotion, state, true)), 'shipping');
  }
}

function runScenario(input: CalculationInput, promotions: readonly CalculationPromotion[]): State {
  const lines = [...input.lines].sort((a, b) => compareText(a.id, b.id));
  let state: State = {
    remaining: new Map(lines.map((line) => [line.id, lineGross(line)])),
    capLeft: new Map(
      lines.map((line) => [line.id, floorShare(lineGross(line), input.rules.lineDiscountCapBps)]),
    ),
    placed: [],
    platformLeft: input.orderCommission,
  };
  const layer = (name: Layer) => promotions.filter((promotion) => promotion.layer === name);
  applyItemLayer(state, lines, layer('ITEM'), input.rules.lineDiscountCapBps);
  state = applyCartLayer(state, lines, layer('SELLER_CART'), 'SELLER_CART');
  state = applyCartLayer(state, lines, layer('PLATFORM_CART'), 'PLATFORM_CART');
  applyShippingLayer(
    state,
    [...input.shipping].sort((a, b) => compareText(a.id, b.id)),
    layer('SHIPPING'),
  );
  return state;
}

const buyerDiscount = (state: State): bigint =>
  state.placed.reduce((sum, placed) => sum + placed.allocation.amount, 0n);

const isCount = (value: number, max = 1_000_000): boolean =>
  Number.isInteger(value) && value >= 1 && value <= max;
const validReward = (reward: Reward): boolean =>
  reward.kind === 'PERCENT'
    ? Number.isInteger(reward.bps) && reward.bps >= 1 && reward.bps <= 10000
    : reward.amount >= 1n;

/** The path of the first wrong phase 2 or phase 3 field of a promotion, or null. */
export function validatePhase2(promotion: CalculationPromotion): string | null {
  const audience = promotion.audience ?? null;
  // These two types are defined by their audience: without one they would apply to everybody.
  if (
    (promotion.type === 'CUSTOMER_GROUP' || promotion.type === 'STORE_FOLLOWER') &&
    audience === null
  ) {
    return 'promotions.audience';
  }
  if (audience !== null) {
    if (
      audience.kind === 'RETURNING_CUSTOMER' &&
      (!Number.isInteger(audience.minDaysSinceLastOrder) || audience.minDaysSinceLastOrder < 1)
    ) {
      return 'promotions.audience';
    }
    if (
      audience.kind === 'DELIVERY_ZONE' &&
      (audience.zones.length === 0 || audience.zones.some((zone) => zone === ''))
    ) {
      return 'promotions.audience';
    }
    // A store follower offer belongs to a store.
    if (audience.kind === 'STORE_FOLLOWER' && promotion.sellerId === null) {
      return 'promotions.audience';
    }
  }
  const tiers = promotion.tiers ?? null;
  if (tiers !== null) {
    if (tiers.length === 0 || tiers.length > 50) return 'promotions.tiers';
    const seen = new Set<bigint>();
    for (const tier of tiers) {
      if (tier.threshold < 0n || seen.has(tier.threshold) || !validReward(tier.reward)) {
        return 'promotions.tiers';
      }
      seen.add(tier.threshold);
    }
  }
  const buyXGetY = promotion.buyXGetY ?? null;
  if (
    buyXGetY !== null &&
    (!isCount(buyXGetY.buyQty) ||
      !isCount(buyXGetY.getQty) ||
      (buyXGetY.maxRepeats !== null && !isCount(buyXGetY.maxRepeats)))
  ) {
    return 'promotions.buyXGetY';
  }
  const multiBuy = promotion.multiBuy ?? null;
  if (
    multiBuy !== null &&
    (!isCount(multiBuy.groupQty) ||
      multiBuy.groupPrice < 0n ||
      (multiBuy.maxRepeats !== null && !isCount(multiBuy.maxRepeats)))
  ) {
    return 'promotions.multiBuy';
  }
  const bundle = promotion.bundle ?? null;
  if (bundle !== null) {
    const products = new Set(bundle.items.map((item) => item.productId));
    if (
      bundle.items.length === 0 ||
      products.size !== bundle.items.length ||
      bundle.items.some((item) => !isCount(item.quantity)) ||
      bundle.amountOff < 0n ||
      (bundle.maxRepeats !== null && !isCount(bundle.maxRepeats))
    ) {
      return 'promotions.bundle';
    }
  }
  const unitLimit = promotion.unitLimit ?? null;
  if (unitLimit !== null && (!Number.isInteger(unitLimit) || unitLimit < 0)) {
    return 'promotions.unitLimit';
  }
  return null;
}

function validate(input: CalculationInput): CalculationError | null {
  const bad = (path: string): CalculationError => ({ code: 'calculation.invalid-input', path });
  if (!/^[A-Z]{3}$/.test(input.currency)) return bad('currency');
  const cap = input.rules.lineDiscountCapBps;
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return bad('rules.lineDiscountCapBps');
  if (input.orderCommission < 0n) return bad('orderCommission');
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (line.id === '' || seen.has(line.id)) return bad('lines.id');
    seen.add(line.id);
    if (line.unitPrice < 0n) return bad('lines.unitPrice');
    if (!Number.isInteger(line.quantity) || line.quantity < 1) return bad('lines.quantity');
  }
  const charges = new Set<string>();
  for (const charge of input.shipping) {
    if (charge.id === '' || charges.has(charge.id)) return bad('shipping.id');
    charges.add(charge.id);
    if (charge.amount < 0n) return bad('shipping.amount');
  }
  const promotions = new Set<string>();
  for (const promotion of input.promotions) {
    if (promotion.id === '' || promotions.has(promotion.id)) return bad('promotions.id');
    promotions.add(promotion.id);
    const bps = promotion.platformShareBps;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return bad('promotions.platformShareBps');
    const reward = promotion.reward;
    if (reward.kind === 'PERCENT') {
      if (!Number.isInteger(reward.bps) || reward.bps < 1 || reward.bps > 10000) {
        return bad('promotions.reward');
      }
    } else if (reward.amount < 1n) {
      return bad('promotions.reward');
    }
    const share = promotion.maxShareBps;
    if (share !== null && (!Number.isInteger(share) || share < 1 || share > 10000)) {
      return bad('promotions.maxShareBps');
    }
    const sellerShare = promotion.sellerMaxShareBps ?? null;
    if (
      sellerShare !== null &&
      (!Number.isInteger(sellerShare) || sellerShare < 1 || sellerShare > 10000)
    ) {
      return bad('promotions.sellerMaxShareBps');
    }
    const shape = validatePhase2(promotion);
    if (shape !== null) return bad(shape);
    for (const limit of [
      promotion.capAmount,
      promotion.maxPerOrder,
      promotion.budgetRemaining,
      promotion.minSpend,
    ]) {
      if (limit !== null && limit < 0n) return bad('promotions.limits');
    }
  }
  return null;
}

/**
 * Whether the customer is in the audience of the promotion. Fail closed: a fact that is unknown
 * (no customer, no read, a customer who never ordered) never lets an audience promotion apply.
 */
function audienceAllows(promotion: CalculationPromotion, input: CalculationInput): boolean {
  const audience = promotion.audience ?? null;
  if (audience === null) return true;
  switch (audience.kind) {
    case 'RETURNING_CUSTOMER': {
      const days = input.customer?.daysSinceLastOrder ?? null;
      return days !== null && Number.isInteger(days) && days >= audience.minDaysSinceLastOrder;
    }
    case 'DELIVERY_ZONE':
      return input.shipping.some((charge) => audience.zones.includes(charge.zoneCode));
    case 'STORE_FOLLOWER': {
      const followed = input.customer?.followedSellerIds ?? null;
      return (
        promotion.sellerId !== null && followed !== null && followed.includes(promotion.sellerId)
      );
    }
  }
}

/**
 * Calculates every discount of one order. Pure and deterministic: the same input, in any order of
 * its lines, charges and promotions, gives the same output.
 */
export function calculateDiscounts(
  input: CalculationInput,
): Result<CalculationOutput, CalculationError> {
  const invalid = validate(input);
  if (invalid !== null) return err(invalid);

  // One code per order: when a single-use code and a public code have the same text, the
  // single-use code is the one entered and the public one is dropped.
  const batchMatch =
    input.code !== null &&
    input.promotions.some(
      (promotion) => promotion.type === 'BATCH_CODE' && promotion.code === input.code,
    );
  const candidates = input.promotions
    .filter(
      (promotion) =>
        promotion.code === null ||
        (promotion.code === input.code &&
          promotion.codeUsed !== true &&
          (!batchMatch || promotion.type === 'BATCH_CODE')),
    )
    .filter((promotion) => !promotion.firstOrderOnly || input.isFirstOrder)
    .filter((promotion) => audienceAllows(promotion, input))
    .sort((a, b) => compareText(a.id, b.id));
  const stack = candidates.filter((promotion) => promotion.combinable);
  const alone = candidates.filter((promotion) => !promotion.combinable);
  // The stack comes first so that it wins a tie; each non-combinable promotion is a scenario of its own.
  let chosen = runScenario(input, stack);
  let chosenTotal = buyerDiscount(chosen);
  for (const promotion of alone) {
    const state = runScenario(input, [promotion]);
    const total = buyerDiscount(state);
    if (total > chosenTotal) {
      chosen = state;
      chosenTotal = total;
    }
  }
  return ok(output(input, chosen));
}

const layerOrder = (layer: Layer): number => LAYERS.indexOf(layer);

function output(input: CalculationInput, state: State): CalculationOutput {
  const sortedAllocations = (kind: Placed['kind'], targetId: string): Allocation[] =>
    state.placed
      .filter((placed) => placed.kind === kind && placed.targetId === targetId)
      .map((placed) => placed.allocation)
      .sort(
        (a, b) =>
          layerOrder(a.layer) - layerOrder(b.layer) || compareText(a.promotionId, b.promotionId),
      );
  const sum = (items: readonly Allocation[], pick: (a: Allocation) => bigint): bigint =>
    items.reduce((total, item) => total + pick(item), 0n);

  const lines: LineResult[] = [...input.lines]
    .sort((a, b) => compareText(a.id, b.id))
    .map((line) => {
      const allocations = sortedAllocations('line', line.id);
      const gross = lineGross(line);
      const discount = sum(allocations, (a) => a.amount);
      return { lineId: line.id, gross, discount, net: gross - discount, allocations };
    });
  const shipping: ShippingResult[] = [...input.shipping]
    .sort((a, b) => compareText(a.id, b.id))
    .map((charge) => {
      const allocations = sortedAllocations('shipping', charge.id);
      const discount = sum(allocations, (a) => a.amount);
      return {
        shippingId: charge.id,
        gross: charge.amount,
        discount,
        net: charge.amount - discount,
        allocations,
      };
    });

  const applied = new Map<string, AppliedPromotion>();
  for (const placed of state.placed) {
    const { allocation } = placed;
    const previous = applied.get(allocation.promotionId);
    applied.set(allocation.promotionId, {
      promotionId: allocation.promotionId,
      layer: allocation.layer,
      amount: (previous?.amount ?? 0n) + allocation.amount,
      sellerShare: (previous?.sellerShare ?? 0n) + allocation.sellerShare,
      platformShare: (previous?.platformShare ?? 0n) + allocation.platformShare,
    });
  }
  const appliedList = [...applied.values()].sort(
    (a, b) =>
      layerOrder(a.layer) - layerOrder(b.layer) || compareText(a.promotionId, b.promotionId),
  );

  let code: CodeOutcome = 'NONE';
  if (input.code !== null) {
    const matching = input.promotions.filter((promotion) => promotion.code === input.code);
    const entered = matching.find((promotion) => promotion.type === 'BATCH_CODE') ?? matching[0];
    code = entered === undefined ? 'UNKNOWN' : applied.has(entered.id) ? 'APPLIED' : 'NOT_APPLIED';
  }

  const goodsGross = lines.reduce((total, line) => total + line.gross, 0n);
  const goodsAllocations = lines.flatMap((line) => line.allocations);
  const goodsDiscount = sum(goodsAllocations, (a) => a.amount);
  const shippingGross = shipping.reduce((total, charge) => total + charge.gross, 0n);
  const shippingDiscount = shipping.reduce((total, charge) => total + charge.discount, 0n);
  return {
    currency: input.currency,
    lines,
    shipping,
    applied: appliedList,
    code,
    totals: {
      goodsGross,
      goodsDiscount,
      goodsNet: goodsGross - goodsDiscount,
      sellerShare: sum(goodsAllocations, (a) => a.sellerShare),
      platformShare: sum(goodsAllocations, (a) => a.platformShare),
      shippingGross,
      shippingDiscount,
      shippingNet: shippingGross - shippingDiscount,
      payable: goodsGross - goodsDiscount + shippingGross - shippingDiscount,
    },
  };
}
