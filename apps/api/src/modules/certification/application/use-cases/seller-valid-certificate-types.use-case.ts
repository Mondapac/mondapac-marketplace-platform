import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { reviewFailure, type ReviewDependencies } from '../review/review.shared';

export interface SellerValidCertificateTypesInput {
  readonly sellerIds: unknown;
}

/** Per seller: the type codes it holds a valid certificate of now. Nothing else. */
export interface SellerValidCertificateTypesRow {
  readonly sellerId: Id<'Seller'>;
  readonly validTypeCodes: readonly string[];
}

export type SellerValidCertificateTypesFailure =
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/** The most distinct seller ids of one call (the sellers facade's own batch size). */
export const VALID_TYPES_MAX_SELLERS = 100;

/**
 * The shared body of the `anonymous` / `system` pair (multi-culture package 3a; ADR-0048 security
 * review M2): per requested seller (at most 100 distinct ids, one row each in the order of first
 * occurrence), the codes of the certification types the seller holds a valid certificate of now.
 * "Valid" is the measure of design 3.3 that `sellerCertificateOverview` uses (approved, not past
 * its stored boundary, issuer not derecognised), read at the clock's now. It answers type codes
 * only: no certificate id, number, issuer, date or review state, so it is safe for a request
 * actor and the system actor alike. It is a membership precondition, never a claim: a tag is
 * decided by `evaluateClaims` alone. A failed read is `access.unavailable` (the caller fails
 * closed), never an empty list.
 */
export async function sellerValidCertificateTypes(
  deps: ReviewDependencies,
  context: CallContext,
  input: SellerValidCertificateTypesInput,
): Promise<Result<readonly SellerValidCertificateTypesRow[], SellerValidCertificateTypesFailure>> {
  const raw = typeof input === 'object' && input !== null ? input.sellerIds : undefined;
  if (!Array.isArray(raw) || raw.length > VALID_TYPES_MAX_SELLERS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
  }
  const ids: Id<'Seller'>[] = [];
  for (const item of raw as unknown[]) {
    const parsed = typeof item === 'string' ? parseId<'Seller'>(item) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    if (!ids.includes(parsed.value)) ids.push(parsed.value);
  }
  if (ids.length === 0) return ok([]);
  const { market } = context;
  const now = deps.clock.now();
  const read = await deps.unitOfWork
    .run(market, async () => ok(await deps.reviews.overview(market, ids, now)), {
      readOnly: true,
    })
    .catch((error: unknown) => reviewFailure(context, 'certification.valid-types', error));
  if (!read.ok) return read;
  const bySeller = new Map(read.value.map((row) => [row.sellerId, row]));
  return ok(
    ids.map((sellerId) => ({
      sellerId,
      validTypeCodes: [...(bySeller.get(sellerId)?.validTypeCodes ?? [])],
    })),
  );
}

/** `certification.seller-valid-certificate-types`: rule `anonymous` (request actors, in process). */
export class SellerValidCertificateTypes extends UseCase<
  SellerValidCertificateTypesInput,
  readonly SellerValidCertificateTypesRow[],
  SellerValidCertificateTypesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-valid-certificate-types',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerValidCertificateTypesInput,
  ): Promise<
    Result<readonly SellerValidCertificateTypesRow[], SellerValidCertificateTypesFailure>
  > {
    return sellerValidCertificateTypes(this.deps, context, input);
  }
}
