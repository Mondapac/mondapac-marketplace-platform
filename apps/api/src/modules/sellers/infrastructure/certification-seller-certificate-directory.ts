import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type {
  SellerCertificateDirectory,
  SellerCertificateDirectoryUnavailable,
} from '../application/ports/seller-certificate-directory';

const UNAVAILABLE = err({ code: 'seller-certificate-directory.unavailable' } as const);

/**
 * {@link SellerCertificateDirectory} over certification's `sellerCertificateOverview`. The answer
 * must hold exactly one row for the asked seller; a refusal (the caller lacks
 * `certification.seller-certificate.view`), a fault or any other shape is unavailable, never "the
 * seller has none" and never "has it".
 */
export class CertificationSellerCertificateDirectory implements SellerCertificateDirectory {
  constructor(private readonly certification: CertificationFacade) {}

  async validTypeCodes(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<ReadonlySet<string>, SellerCertificateDirectoryUnavailable>> {
    try {
      const answer = await this.certification.sellerCertificateOverview(context, [sellerId]);
      if (!answer.ok) return UNAVAILABLE;
      const [row, ...rest] = answer.value;
      if (row === undefined || rest.length > 0 || row.sellerId !== sellerId) return UNAVAILABLE;
      return ok(new Set(row.validTypeCodes));
    } catch {
      return UNAVAILABLE;
    }
  }
}
