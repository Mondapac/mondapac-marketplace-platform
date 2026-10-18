import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type { ProductCertificationStatus } from '../../domain/validity';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  productFailure,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';

/** The most history rows one read returns (newest first). */
export const MAX_PRODUCT_HISTORY_ROWS = 200;

export interface ProductCertificateHistoryInput {
  readonly certificateId: unknown;
}

export interface ProductHistoryEntryOut {
  readonly id: string;
  readonly fromStatus: ProductCertificationStatus | null;
  readonly toStatus: ProductCertificationStatus;
  readonly revisionId: string | null;
  /** `null` for the system actor (the expiry job). */
  readonly actor: { readonly accountId: string } | null;
  readonly reasonCode: string | null;
  /** A note was given; its text stays sealed on the row. */
  readonly noteGiven: boolean;
  readonly occurredAt: string;
}

export interface ProductCertificateHistoryOutput {
  readonly certificateId: string;
  readonly entries: readonly ProductHistoryEntryOut[];
}

export type ProductCertificateHistoryFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'certificate.not-found' }
  | ValidationFailure;

/**
 * `product-certificate.history-read` (certification design 3.4, 11 "status history"; slice 15):
 * the status history of one manufacturer certificate, newest first, at most
 * {@link MAX_PRODUCT_HISTORY_ROWS} rows: from, to, the revision, the actor (an admin account or
 * the system), the reason code and whether a note was given. Clear fields only, so the view key
 * suffices and nothing is decrypted or audited; reading a note's text is a later, audited read.
 * One read-only unit. Rule: key `certification.product-certificate.view`, the admin population.
 */
export class ProductCertificateHistoryRead extends UseCase<
  ProductCertificateHistoryInput,
  ProductCertificateHistoryOutput,
  ProductCertificateHistoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-history-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateHistoryInput,
  ): Promise<Result<ProductCertificateHistoryOutput, ProductCertificateHistoryFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(
        market,
        async () => {
          const root = await deps.products.get(market, certificateId);
          if (root === null) return ok(null);
          return ok(await deps.products.history(market, certificateId, MAX_PRODUCT_HISTORY_ROWS));
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-history-read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return NOT_FOUND;
    return ok({
      certificateId,
      entries: read.value.map((row) => ({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        revisionId: row.revisionId,
        actor: row.actorAccountId === null ? null : { accountId: row.actorAccountId },
        reasonCode: row.reasonCode,
        noteGiven: row.noteGiven,
        occurredAt: row.occurredAt.toString(),
      })),
    });
  }
}
