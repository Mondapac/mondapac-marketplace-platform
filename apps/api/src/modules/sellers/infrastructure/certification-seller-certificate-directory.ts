import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type {
  SellerCertificateDirectory,
  SellerCertificateDirectoryUnavailable,
} from '../application/ports/seller-certificate-directory';

const UNAVAILABLE = err({ code: 'seller-certificate-directory.unavailable' } as const);

/**
 * {@link SellerCertificateDirectory} over certification's `sellerValidCertificateTypes` (package 3a:
 * an `anonymous` / `system` pair, so the reviewer's decision and the system's re-check after a
 * certificate ended read the same measure; before 3a it was `sellerCertificateOverview`, which only
 * an admin holding `certification.seller-certificate.view` may call). The answer must hold exactly
 * one row for the asked seller; a refusal, a fault or any other shape is unavailable, never "the
 * seller has none" and never "has it".
 */
export class CertificationSellerCertificateDirectory implements SellerCertificateDirectory {
  constructor(private readonly certification: CertificationFacade) {}

  async validTypeCodes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    typeCodes: readonly string[],
  ): Promise<Result<ReadonlySet<string>, SellerCertificateDirectoryUnavailable>> {
    try {
      const answer = await this.certification.sellerValidCertificateTypes(
        context,
        [sellerId],
        typeCodes,
      );
      if (!answer.ok) return UNAVAILABLE;
      const [row, ...rest] = answer.value;
      if (row === undefined || rest.length > 0 || row.sellerId !== sellerId) return UNAVAILABLE;
      // Never more than was asked: an unasked code is a malformed answer.
      if (row.validTypeCodes.some((code) => !typeCodes.includes(code))) return UNAVAILABLE;
      return ok(new Set(row.validTypeCodes));
    } catch {
      return UNAVAILABLE;
    }
  }

  async sellersOfIssuer(
    context: CallContext,
    issuerId: string,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<Result<readonly Id<'Seller'>[], SellerCertificateDirectoryUnavailable>> {
    try {
      const answer = await this.certification.sellersOfIssuer(
        context,
        issuerId,
        afterSellerId,
        limit,
      );
      if (!answer.ok || answer.value.length > limit) return UNAVAILABLE;
      return ok(answer.value);
    } catch {
      return UNAVAILABLE;
    }
  }
}
