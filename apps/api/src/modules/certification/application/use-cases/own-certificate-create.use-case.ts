import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { DRAFT_SAVE_LIMITS } from '../../domain/rate-limits';
import {
  invalid,
  ownerOf,
  reserveLimits,
  storeFailure,
  summaryOf,
  type CertificateSummary,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateCreateInput {
  /** The code of an active type of the Market. */
  readonly typeCode: unknown;
}

export type OwnCertificateCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'type.inactive' }
  | { readonly code: 'certificate.exists' }
  | { readonly code: 'conflict.stale' }
  | RateFailure
  | ValidationFailure;

const TYPE_CODE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * `own-certificate.create` (certification design 3.1 row 1, 7.2): a seller starts a certificate
 * of a type that is active in the Market, with an empty draft. At most one open certificate per
 * seller and type (T1). Rule: key `certification.own-certificate.manage`, the seller population;
 * an acting-as session is refused. The seller is the actor's, never a request field (AC 17).
 */
export class OwnCertificateCreate extends UseCase<
  OwnCertificateCreateInput,
  CertificateSummary,
  OwnCertificateCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-create',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_MANAGE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnCertificateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnCertificateCreateInput,
  ): Promise<Result<CertificateSummary, OwnCertificateCreateFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    if (typeof input.typeCode !== 'string' || !TYPE_CODE.test(input.typeCode)) {
      return invalid('typeCode', 'format');
    }
    const typeCode = input.typeCode;
    const { deps } = this;
    const throttled = await reserveLimits(
      deps,
      context,
      DRAFT_SAVE_LIMITS.map((limit) => ({ limit, subject: owner.accountId })),
    );
    if (throttled !== null) return err(throttled);

    const { market } = context;
    const now = deps.clock.now();
    const id = deps.ids.next<'SellerCertification'>();
    try {
      const written = await deps.unitOfWork.run<CertificateSummary, OwnCertificateCreateFailure>(
        market,
        async () => {
          const type = await deps.types.typeByCode(market, typeCode);
          if (type === null) return err({ code: 'type.not-found' } as const);
          if (type.status !== 'active') return err({ code: 'type.inactive' } as const);
          const refusal = await deps.certificates.add(market, {
            id,
            sellerId: owner.sellerId,
            typeId: type.typeId,
            now,
          });
          if (refusal !== null) return err({ code: refusal } as const);
          const stored = await deps.certificates.findOwn(market, owner.sellerId, id);
          if (stored === null) throw new Error('create: the certificate was not stored');
          return ok(summaryOf(stored, true, now));
        },
      );
      return written;
    } catch (error) {
      return storeFailure(context, 'certification.own-certificate-create.failed', error);
    }
  }
}
