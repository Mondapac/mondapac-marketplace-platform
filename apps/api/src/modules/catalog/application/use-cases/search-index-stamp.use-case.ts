import type { CallContext, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OfferSearchFactsReader } from '../ports/offer-search-facts.reader';

export interface SearchIndexStampDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly searchReader: OfferSearchFactsReader;
}

/**
 * `searchIndexStamp` of the index facade: rule `system`. A short text that changes when a
 * definition's published revision, a brand or an alias changes, so search can tell that the
 * documents it keeps are out of date and rebuild them (attributes A7).
 */
export class SearchIndexStampQuery extends UseCase<Record<string, never>, string, never> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.search-index-stamp',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchIndexStampDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.searchReader.searchIndexStamp(context.market)),
      { readOnly: true },
    );
  }
}
