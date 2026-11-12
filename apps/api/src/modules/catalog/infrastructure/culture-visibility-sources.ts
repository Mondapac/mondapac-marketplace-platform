import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type { SellersFacade } from '../../sellers';
import type {
  CultureVisibilitySourceUnavailable,
  SellerCertificateTypes,
  SellerMemberCultures,
} from '../application/ports/culture-visibility-sources';

const UNAVAILABLE = err({ code: 'culture-visibility.source-unavailable' } as const);

/**
 * {@link SellerMemberCultures} over `sellers.approvedCulturesOfSellers`. The caller's context goes
 * through unchanged (the facade picks its `anonymous` or `system` use case). Anything but a map of
 * id lists is unavailable.
 */
export class SellersMemberCultures implements SellerMemberCultures {
  constructor(private readonly sellers: SellersFacade) {}

  async approvedCultures(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Seller'>, ReadonlySet<Id<'Culture'>>>,
      CultureVisibilitySourceUnavailable
    >
  > {
    try {
      const answer = await this.sellers.approvedCulturesOfSellers(context, sellerIds);
      if (!answer.ok) return UNAVAILABLE;
      const approved: ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]> = answer.value;
      if (!((approved as unknown) instanceof Map)) return UNAVAILABLE;
      const out = new Map<Id<'Seller'>, ReadonlySet<Id<'Culture'>>>();
      for (const [sellerId, cultureIds] of approved.entries()) {
        if (!sellerIds.includes(sellerId) || !Array.isArray(cultureIds)) return UNAVAILABLE;
        out.set(sellerId, new Set(cultureIds));
      }
      return ok(out);
    } catch {
      return UNAVAILABLE;
    }
  }
}

/**
 * {@link SellerCertificateTypes} over `certification.sellerValidCertificateTypes`. The answer must
 * hold exactly one row per asked seller; any other shape, a refusal or a fault is unavailable,
 * never "the seller holds none" and never "holds it".
 */
export class CertificationSellerCertificateTypes implements SellerCertificateTypes {
  constructor(private readonly certification: CertificationFacade) {}

  async validTypes(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ReadonlyMap<Id<'Seller'>, ReadonlySet<string>>, CultureVisibilitySourceUnavailable>
  > {
    const asked = [...new Set(sellerIds)];
    try {
      const answer = await this.certification.sellerValidCertificateTypes(context, asked);
      if (!answer.ok || answer.value.length !== asked.length) return UNAVAILABLE;
      const out = new Map<Id<'Seller'>, ReadonlySet<string>>();
      for (const row of answer.value) {
        if (!asked.includes(row.sellerId) || !Array.isArray(row.validTypeCodes)) return UNAVAILABLE;
        out.set(row.sellerId, new Set(row.validTypeCodes));
      }
      return out.size === asked.length ? ok(out) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}
