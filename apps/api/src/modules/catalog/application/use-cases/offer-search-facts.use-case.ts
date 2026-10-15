import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OfferSearchFactsMap } from '../../contracts/catalog-index.facade';
import { parseOfferIds, type OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { OfferSearchFactsReader } from '../ports/offer-search-facts.reader';

export interface OfferSearchFactsInput {
  readonly offerIds: readonly string[];
  readonly locale: string;
}

export interface OfferSearchFactsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly searchReader: OfferSearchFactsReader;
}

/**
 * `offerSearchFacts` of the index facade: rule `system` (an event handler or a job of a read
 * model). The request is checked whole before any read, then one read-only unit (ADR-0025)
 * asks the store. The Market comes from the context only.
 */
export class OfferSearchFactsQuery extends UseCase<
  OfferSearchFactsInput,
  OfferSearchFactsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-search-facts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferSearchFactsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferSearchFactsInput,
  ): Promise<Result<OfferSearchFactsMap, OfferSellUnitsFailure>> {
    const ids = parseOfferIds(input.offerIds);
    if (!ids.ok) return ids;
    if (typeof input.locale !== 'string' || input.locale.length === 0 || input.locale.length > 35) {
      return {
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'locale', code: 'format' }] },
      };
    }
    if (ids.value.size === 0) return ok(new Map());
    const requested: Id<'Offer'>[] = [...ids.value];
    return this.deps.unitOfWork.run<OfferSearchFactsMap, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.searchReader.read(context.market, requested, input.locale)),
      { readOnly: true },
    );
  }
}
