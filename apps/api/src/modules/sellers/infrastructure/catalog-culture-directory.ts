import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CatalogCulturesFacade, CatalogCultureSummary } from '../../catalog';
import type {
  CultureDirectory,
  CultureDirectoryUnavailable,
  CultureInfo,
} from '../application/ports/culture-directory';

const UNAVAILABLE = err({ code: 'culture-directory.unavailable' } as const);

const infoOf = (c: CatalogCultureSummary): CultureInfo => ({
  id: c.id,
  code: c.code,
  status: c.status,
  requiredCertificationType: c.requiredCertificationType,
  names: c.names,
});

/**
 * {@link CultureDirectory} over catalog's `culturesByIds`. Any refusal or fault is unavailable,
 * never an empty map read as "no such culture" by a caller that would then accept or hide. Bound by
 * `SellerStoreProfileModule`; the facade opens a read-only unit of its own.
 */
export class CatalogCultureDirectory implements CultureDirectory {
  constructor(private readonly catalog: CatalogCulturesFacade) {}

  async active(
    context: CallContext,
  ): Promise<Result<readonly CultureInfo[], CultureDirectoryUnavailable>> {
    try {
      const answer = await this.catalog.activeCultures(context);
      return answer.ok ? ok(answer.value.map(infoOf)) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  async byIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<ReadonlyMap<Id<'Culture'>, CultureInfo>, CultureDirectoryUnavailable>> {
    try {
      const answer = await this.catalog.culturesByIds(context, cultureIds);
      if (!answer.ok) return UNAVAILABLE;
      return ok(new Map(answer.value.map((c) => [c.id, infoOf(c)])));
    } catch {
      return UNAVAILABLE;
    }
  }
}
