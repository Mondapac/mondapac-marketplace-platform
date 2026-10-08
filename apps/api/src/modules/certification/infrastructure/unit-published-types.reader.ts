import { ok } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PublishedTypesReader } from '../application/ports/published-types.reader';
import type { CertificationTypeView } from '../contracts/certification.facade';
import type { ClaimVocabularyEntry } from '../domain/claim-text-matcher';

/**
 * {@link PublishedTypesReader} that opens the read-only unit the inner reader needs
 * (ADR-0025: no transaction, a guarded client, bound to the request's Market). The use cases
 * call a reader outside any unit, so each call runs in one unit of its own. The inner reader
 * only throws on a fault, so `work` never answers `err`; a rejection passes through unchanged
 * and the caller answers `unavailable`.
 */
export class UnitPublishedTypesReader implements PublishedTypesReader {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly inner: PublishedTypesReader,
  ) {}

  claimVocabulary(market: MarketContext): Promise<readonly ClaimVocabularyEntry[]> {
    return this.read(market, () => this.inner.claimVocabulary(market));
  }

  types(
    market: MarketContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<readonly CertificationTypeView[]> {
    return this.read(market, () => this.inner.types(market, filter));
  }

  private async read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok<T>(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('read unit answered an error');
    return result.value;
  }
}
