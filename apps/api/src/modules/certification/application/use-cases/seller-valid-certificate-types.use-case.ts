import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationTypeCode, TimeZoneId } from '../../domain/claim-types';
import { isCertificationTypeCode } from '../../domain/type-revision';
import { sellerCertificateValidAt, type SellerZones } from '../../domain/validity';
import type {
  ClaimFactsReader,
  SellerCertificateRequest,
  SellerZonesSource,
} from '../ports/claim-facts.ports';

export interface SellerValidCertificateTypesInput {
  readonly sellerIds: unknown;
  /** The type codes asked about; the answer is a subset of them. */
  readonly typeCodes: unknown;
}

/** Per seller: the asked type codes it holds a valid certificate of now. Nothing else. */
export interface SellerValidCertificateTypesRow {
  readonly sellerId: Id<'Seller'>;
  readonly validTypeCodes: readonly string[];
}

export type SellerValidCertificateTypesFailure =
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/** The most distinct seller ids of one call (the sellers facade's own batch size). */
export const VALID_TYPES_MAX_SELLERS = 100;
/** The most distinct type codes of one call (a Market has a handful of certification types). */
export const VALID_TYPES_MAX_TYPES = 20;

/** What the shared body reads with: the claim facts, the seller zones and the clock. */
export interface SellerValidCertificateTypesDependencies {
  readonly facts: ClaimFactsReader;
  readonly zones: SellerZonesSource;
  readonly clock: Clock;
}

const logger = new Logger('SellerValidCertificateTypes');

/**
 * The shared body of the `anonymous` / `system` pair (multi-culture package 3a; ADR-0048 security
 * review M2 and its follow-up M1): per requested seller (at most 100 distinct ids, one row each in
 * the order of first occurrence), the asked type codes (at most 20) the seller holds a valid
 * certificate of now. "Valid" is the one canonical measure `sellerCertificateValidAt` (design
 * 2.4), the one `evaluateClaims` decides with: the non-terminal certificate of the (seller, type)
 * and its approved submission from the claim facts reader, an issuer on the allow-list (active or
 * closed-to-new), a submission whose type revision requires an expiry has one, both seller zones
 * present and usable, and not past the earliest boundary across them, at the clock's now. It
 * answers type codes only: no certificate id, number, issuer, date or review state, so it is safe
 * for a request actor and the system actor alike. It is a membership precondition, never a claim:
 * a tag is decided by `evaluateClaims` alone. Any failed read is `access.unavailable` (the caller
 * fails closed), never an empty list.
 */
export async function sellerValidCertificateTypes(
  deps: SellerValidCertificateTypesDependencies,
  context: CallContext,
  input: SellerValidCertificateTypesInput,
): Promise<Result<readonly SellerValidCertificateTypesRow[], SellerValidCertificateTypesFailure>> {
  const body = typeof input === 'object' && input !== null ? input : null;
  const rawSellers = body?.sellerIds;
  if (!Array.isArray(rawSellers) || rawSellers.length > VALID_TYPES_MAX_SELLERS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
  }
  const ids: Id<'Seller'>[] = [];
  for (const item of rawSellers as unknown[]) {
    const parsed = typeof item === 'string' ? parseId<'Seller'>(item) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    if (!ids.includes(parsed.value)) ids.push(parsed.value);
  }
  const rawTypes = body?.typeCodes;
  if (!Array.isArray(rawTypes) || rawTypes.length > VALID_TYPES_MAX_TYPES) {
    return err({ code: 'validation.failed', fields: [{ path: 'typeCodes', code: 'range' }] });
  }
  const types: CertificationTypeCode[] = [];
  for (const item of rawTypes as unknown[]) {
    if (!isCertificationTypeCode(item)) {
      return err({ code: 'validation.failed', fields: [{ path: 'typeCodes', code: 'format' }] });
    }
    if (!types.includes(item)) types.push(item);
  }
  if (ids.length === 0) return ok([]);
  if (types.length === 0) return ok(ids.map((sellerId) => ({ sellerId, validTypeCodes: [] })));

  try {
    const requests: SellerCertificateRequest[] = ids.flatMap((sellerId) =>
      types.map((typeCode) => ({ sellerId, typeCode })),
    );
    const certificates = await deps.facts.sellerCertificates(context.market, requests);
    if (certificates.length !== requests.length) throw new Error('certificate read misaligned');
    const zones = await deps.zones.zonesOf(context, ids);
    const now = deps.clock.now();
    const valid = new Map<Id<'Seller'>, string[]>(ids.map((sellerId) => [sellerId, []]));
    requests.forEach((request, index) => {
      const answer = certificates[index]!;
      if (answer.sellerId !== request.sellerId || answer.typeCode !== request.typeCode) {
        throw new Error('certificate answer out of order');
      }
      if (answer.certificate === null) return;
      const zone = zones.get(request.sellerId);
      // A missing zone is no zone (never a default): the measure answers "not valid".
      const sellerZones: SellerZones | null =
        zone?.zone != null && zone.addressZone != null
          ? { zone: zone.zone as TimeZoneId, addressZone: zone.addressZone as TimeZoneId }
          : null;
      if (sellerCertificateValidAt(answer.certificate, sellerZones, now).valid) {
        valid.get(request.sellerId)!.push(request.typeCode);
      }
    });
    return ok(ids.map((sellerId) => ({ sellerId, validTypeCodes: valid.get(sellerId)! })));
  } catch (error) {
    logger.error({
      msg: 'certification.valid-types',
      errorName: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
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
    private readonly deps: SellerValidCertificateTypesDependencies,
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
