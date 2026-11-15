import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  recheckSellerCultures,
  type RecheckCultureCertificatesDependencies,
  type RecheckCultureCertificatesFailure,
  type RecheckCultureCertificatesResult,
} from './recheck-culture-certificates.use-case';

export interface RecheckCulturesOfIssuerInput {
  readonly issuerId: unknown;
}

/** One page of the issuer's sellers. */
export const ISSUER_SELLERS_PAGE = 200;

/**
 * `sellers.recheck-cultures-of-issuer` (multi-culture package 3a; ADR-0048 security review M3):
 * after an issuer was derecognised (every certificate naming it is invalid from that instant), the
 * certified memberships of every seller holding an approved certificate that names the issuer are
 * re-checked as after an expiry (`recheckSellerCultures`), page by page in seller id order through
 * certification's `sellersOfIssuer`. Rule `system` (the handler of
 * `certification.issuer-deactivated.v1`, form `derecognised` only). A failed read or write is
 * `sellers.unavailable`: the delivery is retried, and the re-check is idempotent (an approval taken
 * back is no longer approved). The visibility rule's read-time check hides the Offers meanwhile.
 */
export class RecheckCulturesOfIssuer extends UseCase<
  RecheckCulturesOfIssuerInput,
  RecheckCultureCertificatesResult,
  RecheckCultureCertificatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.recheck-cultures-of-issuer',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecheckCulturesOfIssuer');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RecheckCultureCertificatesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecheckCulturesOfIssuerInput,
  ): Promise<Result<RecheckCultureCertificatesResult, RecheckCultureCertificatesFailure>> {
    const issuer = typeof input?.issuerId === 'string' ? parseId<'Issuer'>(input.issuerId) : null;
    if (issuer === null || !issuer.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'issuerId', code: 'format' }] });
    }
    let demoted = 0;
    let sellers = 0;
    let after: Id<'Seller'> | null = null;
    for (;;) {
      const page = await this.deps.certificateDirectory.sellersOfIssuer(
        context,
        issuer.value,
        after,
        ISSUER_SELLERS_PAGE,
      );
      if (!page.ok) return err({ code: 'sellers.unavailable' });
      for (const sellerId of page.value) {
        const result = await recheckSellerCultures(this.deps, context, sellerId);
        if (!result.ok) return result;
        demoted += result.value.demoted;
      }
      sellers += page.value.length;
      if (page.value.length < ISSUER_SELLERS_PAGE) break;
      after = page.value[page.value.length - 1]!;
    }
    this.#logger.log({
      msg: 'sellers.culture-certificates-rechecked-for-issuer',
      sellers,
      demoted,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ demoted });
  }
}
