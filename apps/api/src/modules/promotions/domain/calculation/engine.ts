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

function commit(
  state: State,
  promotion: CalculationPromotion,
  amounts: ReadonlyMap<string, bigint>,
  kind: 'line' | 'shipping',
): void {
  const bps = kind === 'shipping' ? 10000 : promotion.platformShareBps;
  const ids = [...amounts.keys()].sort(compareText);
  for (const targetId of ids) {
    const amount = amounts.get(targetId) ?? 0n;
    if (amount <= 0n) continue;
    const platformShare = floorShare(amount, bps);
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
      if (!promotion.specialCampaign) state.platformLeft -= platformShare;
    }
  }
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

function applyItemLayer(
  state: State,
  lines: readonly CartLine[],
  promotions: readonly CalculationPromotion[],
): void {
  const chosen = new Map<string, Map<string, bigint>>();
  for (const line of lines) {
    let best: { amount: bigint; promotion: CalculationPromotion } | null = null;
    for (const promotion of promotions) {
      if (!matchesLine(promotion, line)) continue;
      const wanted =
        promotion.reward.kind === 'PERCENT'
          ? floorShare(lineGross(line), promotion.reward.bps)
          : promotion.reward.amount * BigInt(line.quantity);
      const share =
        promotion.maxShareBps === null
          ? wanted
          : min(wanted, floorShare(lineGross(line), promotion.maxShareBps));
      const amount = min(share, min(state.remaining.get(line.id)!, state.capLeft.get(line.id)!));
      if (amount > 0n && better(amount, promotion, best)) best = { amount, promotion };
    }
    if (best !== null) {
      const perLine = chosen.get(best.promotion.id) ?? new Map<string, bigint>();
      perLine.set(line.id, best.amount);
      chosen.set(best.promotion.id, perLine);
    }
  }
  for (const promotion of [...promotions].sort(byFundingThenId)) {
    const perLine = chosen.get(promotion.id);
    if (perLine === undefined) continue;
    commit(state, promotion, trim(perLine, limitOf(promotion, state, false)), 'line');
  }
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
  const room = (line: CartLine) => min(state.remaining.get(line.id)!, state.capLeft.get(line.id)!);
  const capacity = eligible.reduce((sum, line) => sum + room(line), 0n);
  let amount =
    promotion.reward.kind === 'PERCENT'
      ? floorShare(base, promotion.reward.bps)
      : min(promotion.reward.amount, base);
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
  applyItemLayer(state, lines, layer('ITEM'));
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
 * Calculates every discount of one order. Pure and deterministic: the same input, in any order of
 * its lines, charges and promotions, gives the same output.
 */
export function calculateDiscounts(
  input: CalculationInput,
): Result<CalculationOutput, CalculationError> {
  const invalid = validate(input);
  if (invalid !== null) return err(invalid);

  const candidates = input.promotions
    .filter((promotion) => promotion.code === null || promotion.code === input.code)
    .filter((promotion) => !promotion.firstOrderOnly || input.isFirstOrder)
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
    const entered = input.promotions.find((promotion) => promotion.code === input.code);
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
