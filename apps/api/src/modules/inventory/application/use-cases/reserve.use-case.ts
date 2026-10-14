import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_RESERVE_LINES,
  type AccessUnavailable,
  type RequestThrottled,
  type ReserveFailure,
  type ReserveRequest,
  type ReserveResult,
} from '../../contracts/ordering-port';
import {
  AllocationPolicy,
  type AllocationRequest,
  type LineFailure,
} from '../../domain/allocation-policy';
import { CustomerCapPolicy } from '../../domain/customer-cap-policy';
import { Reservation } from '../../domain/reservation';
import { SellableCalculator } from '../../domain/sellable-calculator';
import { availabilityOf, MAX_STOCK_LEVEL } from '../../domain/stock';
import type { AvailabilitySignalRepository } from '../ports/availability-signal.repository';
import { RESERVE_LIMITS, rateVerdict } from '../../domain/rate-limits';
import type { InventoryPolicyProvider } from '../ports/inventory-policy-provider';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { ReservationRepository } from '../ports/reservation.repository';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import {
  distinctSellUnits,
  insufficientOf,
  lockSellUnitsOf,
  recomputeSellUnitSignals,
  sellerPriorities,
} from '../reservation-support';
import { validationFailed } from '../source-use-case-support';

export interface ReserveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reservations: ReservationRepository;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
  readonly signals: AvailabilitySignalRepository;
  readonly outbox: OutboxWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** The longest a statement of the reserve unit may wait for a stock lock (design 4.2 step 2). */
const LOCK_TIMEOUT_MS = 3000;

const CONFLICT_RETRY = Object.freeze({ code: 'conflict.retry' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

interface CheckedLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
}

/**
 * `inventory.reserve` (inventory design 3.1, 4.2, 5.1; data design 4.4): the 15-minute hold of a
 * whole checkout, all lines or none (INV-07).
 *
 * Rule `own-resources`, customer population only: the holder is the actor's account, never an
 * input. The acting-as refusal (Hassan finding 8) cannot be written until SEL-08 gives the actor
 * an acting-as marker; `reserve.acting-as.spec.ts` is the tripwire that fails the build when it
 * does.
 *
 * Before the work, the holder's budget is spent in a unit of its own (6 calls per 15 minutes, 30
 * per 24 hours; design 5.4, M2), so a refused call keeps its count; a replay of the live
 * reservation is not counted. Over the budget the answer is `request.throttled`; a limiter that
 * cannot answer fails closed with `access.unavailable` (Hassan finding 6).
 *
 * One READ COMMITTED unit with `lockTimeoutMs: 3000` (a timeout, a deadlock or a same-holder race
 * answers `conflict.retry`). Inside, in order: the holder's ACTIVE reservation (a replay with the
 * same checkout and lines returns it, nothing else happens); one `FOR NO KEY UPDATE` statement over
 * every non-retired item of every requested sell unit and of the previous reservation's, in
 * ascending id order; the previous reservation released as `superseded`; the held sums (a new
 * statement); per line the cap (before allocation, finding 1) and the allocation; the new
 * reservation; the signals. An `err` commits nothing, so the release is undone with it.
 */
export class Reserve extends UseCase<ReserveRequest, ReserveResult, ReserveFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.reserve',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('Reserve');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReserveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReserveRequest,
  ): Promise<Result<ReserveResult, ReserveFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' });
    }
    const checked = this.check(input);
    if (!checked.ok) return checked;
    const refused = await this.spendBudget(context, actor.accountId, checked.value);
    if (refused !== null) return err(refused);

    let result: Result<Placed, ReserveFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        () => this.place(context, market, actor.accountId, checked.value),
        { lockTimeoutMs: LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        this.#logger.warn({
          msg: 'inventory.reserve.conflict-retry',
          metric: 'conflict.retry',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err(CONFLICT_RETRY);
      }
      throw error;
    }
    if (!result.ok) {
      this.#logger.log({
        msg: 'inventory.reserve.refused',
        code: result.error.code,
        ...(result.error.code === 'inventory.insufficient'
          ? { lines: result.error.details.lines.map((line) => line.reason) }
          : {}),
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return result;
    }
    this.#logger.log({
      msg: 'inventory.reserve.done',
      reservationId: result.value.reservationId,
      lines: result.value.lines.length,
      replayed: result.value.replayed,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      reservationId: result.value.reservationId,
      expiresAt: result.value.expiresAt,
      lines: result.value.lines,
    });
  }

  /** Spends one call from the holder's budget; `null` when allowed or when it is a live replay. */
  private async spendBudget(
    context: CallContext,
    holder: Id<'Account'>,
    input: { checkoutRef: string; lines: CheckedLine[] },
  ): Promise<RequestThrottled | AccessUnavailable | null> {
    const { market } = context;
    const { unitOfWork, reservations, counters, counterKeys, clock } = this.deps;
    try {
      const now = clock.now();
      // A replay (same checkout, same lines, still live) is not counted (design 5.4). If the peek
      // fails the call is counted, never waved through.
      const replayed = await unitOfWork
        .run(
          market,
          async () => {
            const previous = await reservations.findActiveByHolder(market, holder);
            return ok(
              previous !== null &&
                previous.isLiveAt(now) &&
                previous.matches(input.checkoutRef, input.lines),
            );
          },
          { readOnly: true },
        )
        .then((peek) => peek.ok && peek.value)
        .catch(() => false);
      if (replayed) return null;
      const keyed = RESERVE_LIMITS.map((limit) => ({
        limit,
        keyHash: counterKeys.keyOf(market, limit.kind, holder),
      }));
      const reserved = await unitOfWork.run(market, async () =>
        ok(await counters.reserve(market, keyed, now)),
      );
      if (!reserved.ok) return UNAVAILABLE;
      const verdict = rateVerdict(RESERVE_LIMITS, reserved.value, now);
      if (verdict.allowed) return null;
      this.#logger.warn({
        msg: 'inventory.reserve.throttled',
        metric: 'request.throttled',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
    } catch {
      this.#logger.error({
        msg: 'inventory.reserve.rate-counters-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
  }

  /** Input shape: a checkout id and 1 to 50 distinct sell units with whole positive quantities. */
  private check(
    input: ReserveRequest,
  ): Result<{ checkoutRef: string; lines: CheckedLine[] }, ReserveFailure> {
    const fields: { path: string; code: string }[] = [];
    const checkoutRef = typeof input?.checkoutRef === 'string' ? parseId(input.checkoutRef) : null;
    if (checkoutRef === null || !checkoutRef.ok)
      fields.push({ path: 'checkoutRef', code: 'format' });
    if (!Array.isArray(input?.lines) || input.lines.length === 0) {
      fields.push({ path: 'lines', code: 'type' });
      return validationFailed(fields);
    }
    if (input.lines.length > MAX_RESERVE_LINES) return err({ code: 'batch.too-large' });
    const lines: CheckedLine[] = [];
    const seen = new Set<string>();
    for (const [at, raw] of (input.lines as readonly unknown[]).entries()) {
      const line = raw as { offerId?: unknown; variantId?: unknown; quantity?: unknown } | null;
      const offerId = typeof line?.offerId === 'string' ? parseId<'Offer'>(line.offerId) : null;
      const variantId =
        typeof line?.variantId === 'string' ? parseId<'Variant'>(line.variantId) : null;
      if (offerId === null || !offerId.ok)
        fields.push({ path: `lines.${at}.offerId`, code: 'format' });
      if (variantId === null || !variantId.ok) {
        fields.push({ path: `lines.${at}.variantId`, code: 'format' });
      }
      const quantity = line?.quantity;
      if (
        typeof quantity !== 'number' ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_STOCK_LEVEL
      ) {
        fields.push({ path: `lines.${at}.quantity`, code: 'range' });
      }
      if (
        offerId?.ok === true &&
        variantId?.ok === true &&
        typeof quantity === 'number' &&
        Number.isSafeInteger(quantity)
      ) {
        const key = `${offerId.value}/${variantId.value}`;
        if (seen.has(key)) fields.push({ path: `lines.${at}`, code: 'duplicate' });
        seen.add(key);
        lines.push({ offerId: offerId.value, variantId: variantId.value, quantity });
      }
    }
    if (fields.length > 0 || checkoutRef === null || !checkoutRef.ok)
      return validationFailed(fields);
    return ok({ checkoutRef: checkoutRef.value, lines });
  }

  private async place(
    context: CallContext,
    market: MarketContext,
    holder: Id<'Account'>,
    input: { checkoutRef: string; lines: CheckedLine[] },
  ): Promise<Result<Placed, ReserveFailure>> {
    const { reservations, policies, ids, clock } = this.deps;
    const now = clock.now();

    // The holder's earlier ACTIVE reservation, expired or not. A live replay returns as it is.
    const previous = await reservations.findActiveByHolder(market, holder);
    if (
      previous !== null &&
      previous.isLiveAt(now) &&
      previous.matches(input.checkoutRef, input.lines)
    ) {
      return ok(viewOf(previous, true));
    }

    // Lock (L1, L2): one statement, ascending ids, before any write.
    const previousLines = previous?.state.lines ?? [];
    const sellUnits = distinctSellUnits([...input.lines, ...previousLines]);
    const { all: locked, known } = await lockSellUnitsOf(
      reservations,
      market,
      sellUnits,
      previousLines.map((line) => line.stockItemId),
    );

    // Supersede (design 3.1): guarded, so a release or expiry by another unit is not an error.
    if (previous !== null) {
      await reservations.releaseActive(market, previous.state.id, 'superseded', now);
    }

    // With the locks held, every read is a new statement (L3).
    const held = await reservations.heldQuantities(
      market,
      locked.map((item) => item.id),
      now,
    );
    const limits = await reservations.purchaseLimits(
      market,
      input.lines.map((line) => line.offerId),
    );
    const priorities = await sellerPriorities(this.deps.inventories, market, locked);
    const defaultThreshold = policies.defaultLowStockThreshold(market);
    const failures: LineFailure[] = [];
    const requests: AllocationRequest[] = [];
    for (const line of input.lines) {
      const items = locked.filter(
        (item) =>
          item.offerId === line.offerId && item.variantId === line.variantId && !item.retired,
      );
      if (items.length === 0) {
        const retired = known.some(
          (item) =>
            item.offerId === line.offerId && item.variantId === line.variantId && item.retired,
        );
        failures.push({
          offerId: line.offerId,
          variantId: line.variantId,
          reason: retired ? 'retired' : 'out',
        });
        continue;
      }
      const sellable = SellableCalculator.ofSellUnit(
        items.map((item) => ({
          onHand: item.onHand,
          held: held.get(item.id) ?? 0,
          retired: false,
        })),
      );
      // The cap reads only public data: the status and `onlyLeft` (design 5.1), checked before the
      // allocation (Hassan finding 1).
      const threshold = priorities.thresholdOf(items[0]!.sellerId) ?? defaultThreshold;
      const cap = CustomerCapPolicy.capOf({
        purchaseLimit: limits.get(line.offerId) ?? null,
        availability: availabilityOf(sellable, threshold),
        lowStockThreshold: threshold,
        defaultCap: policies.defaultCustomerCap(market),
        lineCeiling: policies.maxLineQuantity(market),
      });
      if (line.quantity > cap) {
        failures.push({ offerId: line.offerId, variantId: line.variantId, reason: 'over-limit' });
        continue;
      }
      requests.push({
        offerId: line.offerId,
        variantId: line.variantId,
        quantity: line.quantity,
        candidates: [...items]
          .sort((a, b) => priorities.rankOf(a) - priorities.rankOf(b))
          .map((item) => ({
            stockItemId: item.id,
            sellable: SellableCalculator.ofItem(item.onHand, held.get(item.id) ?? 0),
          })),
      });
    }
    // Every remaining line is allocated even when another already failed, so the answer names all
    // failing lines at once (design 4.2 step 7).
    const allocated = AllocationPolicy.allocate(requests);
    if (!allocated.ok) failures.push(...allocated.failures);
    if (failures.length > 0 || !allocated.ok) return err(insufficientOf(input.lines, failures));

    const reservation = Reservation.place({
      id: ids.next<'Reservation'>(),
      holderAccountId: holder,
      checkoutRef: input.checkoutRef,
      lines: allocated.allocations.map((allocation) => ({
        id: ids.next<'ReservationLine'>(),
        offerId: allocation.offerId,
        variantId: allocation.variantId,
        stockItemId: allocation.stockItemId,
        quantity: allocation.quantity,
      })),
      now,
      duration: Temporal.Duration.from({ minutes: policies.reservationMinutes(market) }),
    });
    if ((await reservations.insert(market, reservation)) === 'holder-conflict') {
      // A racing reserve of the same holder committed first; nothing is held (design 4.2).
      return err(CONFLICT_RETRY);
    }
    await recomputeSellUnitSignals(this.deps, context, market, locked, sellUnits, now);
    return ok(viewOf(reservation, false));
  }
}

type Placed = ReserveResult & { readonly replayed: boolean };

function viewOf(reservation: Reservation, replayed: boolean): Placed {
  return {
    reservationId: reservation.state.id,
    expiresAt: reservation.state.expiresAt,
    lines: reservation.state.lines.map((line) => ({
      offerId: line.offerId,
      variantId: line.variantId,
      reservationLineId: line.id,
    })),
    replayed,
  };
}
