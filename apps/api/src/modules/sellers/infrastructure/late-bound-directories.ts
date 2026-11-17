import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  CultureDirectory,
  CultureDirectoryUnavailable,
  CultureInfo,
} from '../application/ports/culture-directory';
import type {
  SellerCertificateDirectory,
  SellerCertificateDirectoryUnavailable,
} from '../application/ports/seller-certificate-directory';

/**
 * The culture directory as `SellersModule` provides it: unavailable until `SellerStoreProfileModule`
 * binds the real one (over catalog's `culturesByIds`) at start. Catalog imports sellers, so the
 * binding is made from outside; until it is made a request is refused, never let through.
 */
export class LateBoundCultureDirectory implements CultureDirectory {
  #bound: CultureDirectory | null = null;

  bind(directory: CultureDirectory): void {
    if (this.#bound !== null) throw new Error('LateBoundCultureDirectory is already bound');
    this.#bound = directory;
  }

  active(
    context: CallContext,
  ): Promise<Result<readonly CultureInfo[], CultureDirectoryUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'culture-directory.unavailable' } as const));
    }
    return this.#bound.active(context);
  }

  byIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<ReadonlyMap<Id<'Culture'>, CultureInfo>, CultureDirectoryUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'culture-directory.unavailable' } as const));
    }
    return this.#bound.byIds(context, cultureIds);
  }
}

/** The certificate directory, late-bound like {@link LateBoundCultureDirectory}; fail closed. */
export class LateBoundSellerCertificateDirectory implements SellerCertificateDirectory {
  #bound: SellerCertificateDirectory | null = null;

  bind(directory: SellerCertificateDirectory): void {
    if (this.#bound !== null) {
      throw new Error('LateBoundSellerCertificateDirectory is already bound');
    }
    this.#bound = directory;
  }

  validTypeCodes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    typeCodes: readonly string[],
  ): Promise<Result<ReadonlySet<string>, SellerCertificateDirectoryUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'seller-certificate-directory.unavailable' } as const));
    }
    return this.#bound.validTypeCodes(context, sellerId, typeCodes);
  }

  sellersOfIssuer(
    context: CallContext,
    issuerId: string,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<Result<readonly Id<'Seller'>[], SellerCertificateDirectoryUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'seller-certificate-directory.unavailable' } as const));
    }
    return this.#bound.sellersOfIssuer(context, issuerId, afterSellerId, limit);
  }
}
