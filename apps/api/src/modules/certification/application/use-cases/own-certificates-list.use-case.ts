import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_VIEW } from '../../contracts/permissions';
import { isDraftEditable } from '../../domain/seller-certificate';
import {
  invalid,
  ownerOf,
  storeFailure,
  summaryOf,
  type CertificateSummary,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;

export interface OwnCertificatesListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface OwnCertificatesListOutput {
  readonly certificates: readonly CertificateSummary[];
  /** The id to pass as `afterId` for the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type OwnCertificatesListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-certificates.read` (certification design 7.2, 3.3): the seller's own certificates, newest
 * first, with the status code of design 3.3. Clear fields only: no number, no note, no file. Rule:
 * key `certification.own-certificate.view`; another seller's certificates are never listed.
 */
export class OwnCertificatesList extends UseCase<
  OwnCertificatesListInput,
  OwnCertificatesListOutput,
  OwnCertificatesListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificates-list',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_VIEW.key] },
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
    input: OwnCertificatesListInput,
  ): Promise<Result<OwnCertificatesListOutput, OwnCertificatesListFailure>> {
    const owner = ownerOf(context, { write: false });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    let afterId: Id<'SellerCertification'> | null = null;
    if (input.afterId !== undefined && input.afterId !== null) {
      const parsed =
        typeof input.afterId === 'string' ? parseId<'SellerCertification'>(input.afterId) : null;
      if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
      afterId = parsed.value;
    }
    let limit = DEFAULT_PAGE_SIZE;
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit)) {
        return invalid('limit', 'type');
      }
      if (input.limit < 1 || input.limit > MAX_PAGE_SIZE) return invalid('limit', 'range');
      limit = input.limit;
    }

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const read = await deps.unitOfWork
      .run(
        market,
        async () =>
          ok(
            await deps.certificates.listOwn(market, owner.sellerId, { afterId, limit: limit + 1 }),
          ),
        { readOnly: true },
      )
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-certificates-list', error),
      );
    if (!read.ok) return read;
    const page = read.value.slice(0, limit);
    return ok({
      certificates: page.map((stored) =>
        summaryOf(stored, isDraftEditable(stored.status, stored.pendingSubmissionId), now),
      ),
      nextAfterId: read.value.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    });
  }
}
