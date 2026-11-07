import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { OfferSellUnitChanged } from '../../domain/events';
import { applySellUnitChanges, type SellUnitChange } from '../../domain/offer-sell-unit';
import type { OfferRepository } from '../ports/offer.repository';
import type { OfferSellUnitRepository } from '../ports/offer-sell-unit.repository';
import type { SaveWorkingCopy } from '../working-copy/save-working-copy.service';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';

/** One requested change as the route passes it: a closed shape; each of the two fields is optional. */
export interface OwnOfferSellUnitChange {
  readonly variantId: string;
  readonly variantSku?: string | null;
  readonly selling?: boolean;
}

export interface OwnOfferSetSellUnitsInput {
  readonly offerId: string;
  readonly units: readonly OwnOfferSellUnitChange[];
}

export interface OwnOfferSetSellUnitsOutput {
  /** The variants whose SKU or switch changed; empty when nothing differed (nothing was stored). */
  readonly changedVariantIds: readonly string[];
}

export type OwnOfferSetSellUnitsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.sku-taken' }
  | { readonly code: 'offer.none-selling' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnOfferSetSellUnitsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly sellUnits: OfferSellUnitRepository;
  readonly eligibility: SellerEligibilityReader;
  /** Spends the account's save budget (design 8.4: shared with draft saves and Offer edits). */
  readonly save: Pick<SaveWorkingCopy, 'reserveSaves'>;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

const INPUT_KEYS = ['offerId', 'units'] as const;
const UNIT_KEYS = ['variantId', 'variantSku', 'selling'] as const;
const MAX_UNITS = 100;

/**
 * `own-offer.set-sell-units` (variants V5; plan decisions t4, t14): a seller sets, per sell unit of
 * their own Offer, an optional variant SKU and the reversible "selling" switch. Rule: the key
 * `catalog.own-product.edit` and the seller population; the seller comes from the actor. Following
 * the rules of `own-offer.edit`, it works on a draft or a published Offer and is allowed in
 * acting-as. The units of the product are read in the unit, the changes are applied by the domain
 * (`applySellUnitChanges`: a known variant once, the SKU shape, no SKU twice, at least one unit
 * keeps selling), and only the changed rows are written. A SKU already used by the seller (another
 * unit or an open Offer) is `offer.sku-taken`; the database unique decides a race. A unit turned
 * off sale or back on sale emits `catalog.offer-sell-unit-changed.v1`. The variant is never
 * retired; a lost race on a row is `conflict.stale`. An Offer of another seller, a deleted one and an unknown id are one `offer.not-found`.
 */
export class OwnOfferSetSellUnits extends UseCase<
  OwnOfferSetSellUnitsInput,
  OwnOfferSetSellUnitsOutput,
  OwnOfferSetSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-set-sell-units',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSetSellUnits');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSetSellUnitsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSetSellUnitsInput,
  ): Promise<Result<OwnOfferSetSellUnitsOutput, OwnOfferSetSellUnitsFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-set-sell-units',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: OwnOfferSetSellUnitsInput,
  ): Promise<Result<OwnOfferSetSellUnitsOutput, OwnOfferSetSellUnitsFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const parsed = parse(input);
    if (!parsed.ok) return parsed;
    const { offerId, changes } = parsed.value;

    // Spent before any read, so a loop of requests is bounded (the same budget as an Offer edit).
    const throttled = await deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    try {
      return await deps.unitOfWork.run<OwnOfferSetSellUnitsOutput, OwnOfferSetSellUnitsFailure>(
        market,
        async () => {
          const offer = await deps.offers.findById(market, offerId);
          if (
            offer === null ||
            offer.state.sellerId !== sellerId ||
            offer.state.status === 'deleted'
          ) {
            return err({ code: 'offer.not-found' } as const);
          }
          await deps.sellUnits.lockOffer(market, offerId);
          const current = await deps.sellUnits.unitsOf(market, offerId, offer.state.productId);
          const applied = applySellUnitChanges(current, changes);
          if (!applied.ok) {
            const refusal = applied.error;
            if (refusal.code === 'sell-unit.none-selling')
              return err({ code: 'offer.none-selling' } as const);
            return err({
              code: 'validation.failed',
              fields: [
                {
                  path: `units.${refusal.variantId}`,
                  code:
                    refusal.code === 'sell-unit.variant-unknown'
                      ? 'unknown'
                      : refusal.code === 'sell-unit.sku-invalid'
                        ? 'format'
                        : 'duplicate',
                },
              ],
            } as const);
          }
          const { changed } = applied.value;
          if (changed.length === 0) return ok({ changedVariantIds: [] });
          const now = deps.clock.now();
          const saved = await deps.sellUnits.save(
            market,
            { id: offerId, sellerId, productId: offer.state.productId },
            changed.map(({ variantId, variantSku, selling }) => ({
              variantId,
              variantSku,
              selling,
            })),
            now,
          );
          if (saved.refusal !== null) return err({ code: saved.refusal } as const);
          const events = saved.stored.flatMap((row) => {
            const before = current.find((c) => c.variantId === row.variantId)!;
            const after = changed.find((c) => c.variantId === row.variantId)!;
            return before.selling === after.selling
              ? []
              : [
                  OfferSellUnitChanged.record({
                    aggregateId: row.rowId,
                    aggregateVersion: row.version,
                    occurredAt: now,
                    payload: { offerId, variantId: row.variantId, selling: after.selling },
                  }),
                ];
          });
          if (events.length > 0) await deps.outbox.append(context, events);
          return ok({ changedVariantIds: changed.map((unit) => unit.variantId) });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}

function parse(
  input: OwnOfferSetSellUnitsInput,
): Result<
  { offerId: Id<'Offer'>; changes: readonly SellUnitChange[] },
  OwnOfferSetSellUnitsFailure
> {
  const fail = (path: string, code: string) =>
    err({ code: 'validation.failed', fields: [{ path, code }] } as const);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('body', 'type');
  }
  for (const key of Object.keys(input)) {
    if (!(INPUT_KEYS as readonly string[]).includes(key)) return fail(key, 'unknown');
  }
  const offer = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
  if (offer === null || !offer.ok) return fail('offerId', 'format');
  if (!Array.isArray(input.units) || input.units.length === 0 || input.units.length > MAX_UNITS) {
    return fail('units', 'format');
  }
  const changes: SellUnitChange[] = [];
  for (const [index, unit] of (input.units as unknown[]).entries()) {
    const path = `units.${index}`;
    if (typeof unit !== 'object' || unit === null || Array.isArray(unit)) return fail(path, 'type');
    const record = unit as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(UNIT_KEYS as readonly string[]).includes(key)) return fail(path, 'unknown');
    }
    const variant =
      typeof record.variantId === 'string' ? parseId<'Variant'>(record.variantId) : null;
    if (variant === null || !variant.ok) return fail(`${path}.variantId`, 'format');
    if (record.variantSku === undefined && record.selling === undefined) return fail(path, 'empty');
    if (
      record.variantSku !== undefined &&
      record.variantSku !== null &&
      typeof record.variantSku !== 'string'
    ) {
      return fail(`${path}.variantSku`, 'format');
    }
    if (record.selling !== undefined && typeof record.selling !== 'boolean') {
      return fail(`${path}.selling`, 'format');
    }
    changes.push({
      variantId: variant.value,
      ...(record.variantSku !== undefined ? { variantSku: record.variantSku } : {}),
      ...(record.selling !== undefined ? { selling: record.selling } : {}),
    });
  }
  return ok({ offerId: offer.value, changes });
}
