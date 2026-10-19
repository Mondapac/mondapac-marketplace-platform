import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { PricingValidationFailed } from '../../contracts/pricing.facade';
import { MAX_SPECIALS, type SpecialInForce } from '../../contracts/pricing-specials.facade';
import { effectivePriceAt, effectiveRegular } from '../../domain/price-series';
import type { PriceSeriesRepository } from '../ports/price-series.repository';
import type { SpecialsInForceReader } from '../ports/specials-in-force.reader';

export interface SpecialsInForceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly specials: SpecialsInForceReader;
  readonly series: PriceSeriesRepository;
  readonly clock: Clock;
}

/**
 * `pricing.specials-in-force`: the storefront's specials shelf. Rule `anonymous` (prices are
 * public; no Cost, hold or history). One read-only unit at the Clock's now: the candidate
 * records, then each series is loaded and kept only when its effective price is a special
 * (the special in force is below the regular price in force, pricing design 4.1), with the
 * regular price beside it. A key appears once, so a list can be shorter than `limit`.
 */
export class SpecialsInForceQuery extends UseCase<
  { readonly limit: number },
  readonly SpecialInForce[],
  PricingValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.specials-in-force',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SpecialsInForceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly limit: number },
  ): Promise<Result<readonly SpecialInForce[], PricingValidationFailed>> {
    const limit = input?.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SPECIALS) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    const { market } = context;
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.run<readonly SpecialInForce[], PricingValidationFailed>(
      market,
      async () => {
        const found: SpecialInForce[] = [];
        const seen = new Set<string>();
        for (const key of await this.deps.specials.candidates(market, now, limit)) {
          const mapKey = `${key.offerId}/${key.variantId}`;
          if (seen.has(mapKey)) continue;
          seen.add(mapKey);
          const series = await this.deps.series.findByKey(market, key);
          if (series === null) continue;
          const effective = effectivePriceAt(series.state, now);
          const regular = effectiveRegular(series.state, now);
          if (
            effective?.basis !== 'special' ||
            effective.specialEndsAt === null ||
            regular === null
          )
            continue;
          found.push({
            offerId: key.offerId,
            variantId: key.variantId,
            price: { amount: effective.amount.amount, currency: effective.amount.currency },
            regularPrice: { amount: regular.amount.amount, currency: regular.amount.currency },
            taxInclusive: effective.taxInclusive,
            endsAt: effective.specialEndsAt,
          });
        }
        return ok(found);
      },
      { readOnly: true },
    );
  }
}
