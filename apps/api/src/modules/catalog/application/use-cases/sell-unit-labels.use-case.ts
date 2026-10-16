import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_FACADE_BATCH,
  sellUnitKey,
  type SellUnitKey,
  type SellUnitLabelsMap,
} from '../../contracts/catalog.facade';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { SellUnitLabelsReader } from '../ports/sell-unit-labels.reader';

export interface SellUnitLabelsInput {
  readonly keys: readonly { readonly offerId: string; readonly variantId: string }[];
  readonly locale: string;
}

export interface SellUnitLabelsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly labelsReader: SellUnitLabelsReader;
}

/**
 * `sellUnitLabels`: the published product name and published Variant label of each requested
 * (Offer, Variant), at most 200 keys, duplicates collapsed. Rule `anonymous`: published names
 * are public content and the answer carries no price, stock, Cost or seller data. The request
 * is checked whole before any read. The Market comes from the context only; an unknown key and
 * another Market's key are both absent. Seller-entered text: callers escape it.
 */
export class SellUnitLabelsQuery extends UseCase<
  SellUnitLabelsInput,
  SellUnitLabelsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.sell-unit-labels',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellUnitLabelsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellUnitLabelsInput,
  ): Promise<Result<SellUnitLabelsMap, OfferSellUnitsFailure>> {
    if (!Array.isArray(input.keys) || typeof input.locale !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'type' }] });
    }
    if (input.keys.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const distinct = new Map<string, SellUnitKey>();
    for (const raw of input.keys as readonly unknown[]) {
      const item = raw as { offerId?: unknown; variantId?: unknown } | null;
      const offer = typeof item?.offerId === 'string' ? parseId<'Offer'>(item.offerId) : null;
      const variant =
        typeof item?.variantId === 'string' ? parseId<'Variant'>(item.variantId) : null;
      if (offer === null || !offer.ok || variant === null || !variant.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] });
      }
      const key = { offerId: offer.value, variantId: variant.value };
      distinct.set(sellUnitKey(key), key);
    }
    if (distinct.size === 0) return ok(new Map());
    const requested = [...distinct.values()];
    return this.deps.unitOfWork.run<SellUnitLabelsMap, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.labelsReader.read(context.market, requested, input.locale)),
      { readOnly: true },
    );
  }
}
