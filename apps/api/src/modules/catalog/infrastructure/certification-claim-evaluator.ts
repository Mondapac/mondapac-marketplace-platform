import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  BadgeData,
  CertificationFacade,
  ClaimDecision,
  ClaimQuery,
} from '../../certification';
import type { ClaimCheckUnavailable, ClaimEvaluator } from '../application/ports/claim-evaluator';
import {
  isTagTypeCode,
  type TagBadge,
  type TagClaimQuery,
  type TagDecision,
} from '../domain/offer-tag';
import { OFFER_HANDLINGS, type OfferHandling } from '../domain/offer';

const UNAVAILABLE = err({ code: 'claim.check-unavailable' } as const);

const REASON = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * {@link ClaimEvaluator} over `certification.evaluateClaims` and `certificationTypes` (catalog
 * design 5; ADR-0028; certification design 4.3, 4.5). The caller's `CallContext` goes through
 * unchanged. Every answer is copied field by field into catalog's own types and checked; a
 * refusal, a fault or any answer of the wrong shape is `claim.check-unavailable` for the whole
 * call, never an allowed or empty answer (fail closed). The badge is copied only from a decision of
 * this call and only its allow-listed fields (ADR-0028 d3: a display copy that can only restrict).
 */
export class CertificationClaimEvaluator implements ClaimEvaluator {
  readonly #logger = new Logger('CertificationClaimEvaluator');

  constructor(private readonly certification: CertificationFacade) {}

  async evaluate(
    context: CallContext,
    queries: readonly TagClaimQuery[],
  ): Promise<Result<readonly TagDecision[], ClaimCheckUnavailable>> {
    let answer: Awaited<ReturnType<CertificationFacade['evaluateClaims']>>;
    try {
      answer = await this.certification.evaluateClaims(context, queries.map(toClaimQuery));
    } catch (error) {
      this.#warn(context, 'catalog.claims.certification-failed', error);
      return UNAVAILABLE;
    }
    if (!answer.ok) {
      this.#warn(context, 'catalog.claims.certification-refused', answer.error.code);
      return UNAVAILABLE;
    }
    const decisions = copyDecisions(answer.value, queries.length);
    if (decisions === null) {
      this.#warn(context, 'catalog.claims.certification-malformed', 'shape');
      return UNAVAILABLE;
    }
    return ok(decisions);
  }

  async activeTypeCodes(
    context: CallContext,
  ): Promise<Result<ReadonlySet<string>, ClaimCheckUnavailable>> {
    try {
      const answer = await this.certification.certificationTypes(context, { status: 'active' });
      if (!answer.ok) {
        this.#warn(context, 'catalog.claims.types-refused', answer.error.code);
        return UNAVAILABLE;
      }
      const codes = new Set<string>();
      for (const type of answer.value as readonly unknown[]) {
        const { code, status } = (type ?? {}) as { code?: unknown; status?: unknown };
        if (!isTagTypeCode(code) || status !== 'active') {
          this.#warn(context, 'catalog.claims.types-malformed', 'shape');
          return UNAVAILABLE;
        }
        codes.add(code);
      }
      return ok(codes);
    } catch (error) {
      this.#warn(context, 'catalog.claims.types-failed', error);
      return UNAVAILABLE;
    }
  }

  async typeCodeOf(
    context: CallContext,
    typeId: string,
  ): Promise<Result<string | null, ClaimCheckUnavailable>> {
    try {
      const answer = await this.certification.certificationTypes(context, {});
      if (!answer.ok) {
        this.#warn(context, 'catalog.claims.types-refused', answer.error.code);
        return UNAVAILABLE;
      }
      let found: string | null = null;
      for (const type of answer.value as readonly unknown[]) {
        const { typeId: id, code } = (type ?? {}) as { typeId?: unknown; code?: unknown };
        if (typeof id !== 'string' || !isTagTypeCode(code)) {
          this.#warn(context, 'catalog.claims.types-malformed', 'shape');
          return UNAVAILABLE;
        }
        if (id === typeId) found = code;
      }
      return ok(found);
    } catch (error) {
      this.#warn(context, 'catalog.claims.types-failed', error);
      return UNAVAILABLE;
    }
  }

  #warn(context: CallContext, msg: string, reason: unknown): void {
    this.#logger.warn({
      msg,
      reason:
        typeof reason === 'string' ? reason : reason instanceof Error ? reason.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

function toClaimQuery(query: TagClaimQuery): ClaimQuery {
  return {
    sellerId: query.sellerId,
    productId: query.productId,
    productRevisionId: query.productRevisionId,
    variantId: query.variantId,
    typeCode: query.typeCode as ClaimQuery['typeCode'],
    handling: query.handling,
    attestationRecorded: query.attestationRecorded,
    platformCategoryPaths: query.platformCategoryPaths.map((path) => [...path]),
  };
}

const idOf = (value: unknown): Id | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId(value);
  return parsed.ok ? parsed.value : null;
};

const instantOf = (value: unknown): Temporal.Instant | null | undefined => {
  if (value === null) return null;
  return value instanceof Temporal.Instant ? value : undefined;
};

/** One decision per query, each well formed, or null (the whole call is then unavailable). */
function copyDecisions(answer: unknown, expected: number): TagDecision[] | null {
  if (!Array.isArray(answer) || answer.length !== expected) return null;
  const out: TagDecision[] = [];
  for (const raw of answer as unknown[]) {
    const decision = copyDecision(raw);
    if (decision === null) return null;
    out.push(decision);
  }
  return out;
}

function copyDecision(raw: unknown): TagDecision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Partial<ClaimDecision>;
  if (typeof d.allowed !== 'boolean') return null;
  if (typeof d.reason !== 'string' || !REASON.test(d.reason)) return null;
  if (d.basis !== null && d.basis !== 'SELLER' && d.basis !== 'MANUFACTURER') return null;
  const evaluatedAt = instantOf(d.evaluatedAt);
  if (evaluatedAt === undefined || evaluatedAt === null) return null;
  const policyRevisionId = d.policyRevisionId === null ? null : idOf(d.policyRevisionId);
  if (d.policyRevisionId !== null && policyRevisionId === null) return null;

  let certificate: TagDecision['certificate'] = null;
  if (d.certificate !== null) {
    const c = d.certificate;
    if (typeof c !== 'object' || c === undefined) return null;
    const certificateId = idOf(c.certificateId);
    const versionId = idOf(c.versionId);
    const typeRevisionId = idOf(c.typeRevisionId);
    const issuerId = c.issuerId === null ? null : idOf(c.issuerId);
    const validUntil = instantOf(c.validUntil);
    if (
      (c.kind !== 'seller' && c.kind !== 'manufacturer') ||
      certificateId === null ||
      versionId === null ||
      typeRevisionId === null ||
      (c.issuerId !== null && issuerId === null) ||
      validUntil === undefined
    ) {
      return null;
    }
    certificate = { kind: c.kind, certificateId, versionId, issuerId, typeRevisionId, validUntil };
  }

  let badge: TagBadge | null = null;
  if (d.badge !== null) {
    badge = copyBadge(d.badge);
    if (badge === null) return null;
  }

  let inputs: TagClaimQuery | null = null;
  if (d.inputs !== null) {
    inputs = copyQuery(d.inputs);
    if (inputs === null) return null;
  }
  // An allowed decision carries everything a copy needs; anything less is not an answer.
  if (
    d.allowed &&
    (d.basis === null || certificate === null || badge === null || inputs === null)
  ) {
    return null;
  }
  return {
    allowed: d.allowed,
    basis: d.basis ?? null,
    reason: d.reason,
    certificate,
    policyRevisionId,
    badge,
    inputs,
    evaluatedAt,
  };
}

/** The allow-listed badge fields only (certification `BADGE_FIELDS`); nothing else is copied. */
function copyBadge(raw: unknown): TagBadge | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Partial<BadgeData>;
  const typeRevisionId = idOf(b.typeRevisionId);
  if (!isTagTypeCode(b.typeCode) || typeRevisionId === null) return null;
  if (b.basis !== 'SELLER' && b.basis !== 'MANUFACTURER') return null;
  if (typeof b.sellerClaim !== 'boolean' || typeof b.verifiedWithIssuer !== 'boolean') return null;
  if (b.reviewedByPlatform !== true) return null;
  let issuer: TagBadge['issuer'] = null;
  if (b.issuer !== null) {
    const id = idOf(b.issuer?.id);
    const name = b.issuer?.displayName;
    if (id === null || typeof name !== 'string' || name.length === 0 || name.length > 200) {
      return null;
    }
    issuer = { id, displayName: name };
  }
  let validUntilLocalDate: string | null = null;
  if (b.validUntilLocalDate !== null) {
    if (!(b.validUntilLocalDate instanceof Temporal.PlainDate)) return null;
    validUntilLocalDate = b.validUntilLocalDate.toString();
  }
  let validUntilZone: string | null = null;
  if (b.validUntilZone !== null) {
    if (
      typeof b.validUntilZone !== 'string' ||
      !/^[A-Za-z0-9_+\-/]{1,64}$/.test(b.validUntilZone)
    ) {
      return null;
    }
    validUntilZone = b.validUntilZone;
  }
  return {
    typeCode: b.typeCode,
    typeRevisionId,
    basis: b.basis,
    sellerClaim: b.sellerClaim,
    issuer,
    validUntilLocalDate,
    validUntilZone,
    verifiedWithIssuer: b.verifiedWithIssuer,
    reviewedByPlatform: true,
  };
}

function copyQuery(raw: unknown): TagClaimQuery | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const q = raw as Partial<ClaimQuery>;
  const sellerId = idOf(q.sellerId);
  const productId = idOf(q.productId);
  const productRevisionId = idOf(q.productRevisionId);
  const variantId = idOf(q.variantId);
  if (sellerId === null || productId === null || productRevisionId === null || variantId === null) {
    return null;
  }
  if (!isTagTypeCode(q.typeCode)) return null;
  if (!(OFFER_HANDLINGS as readonly unknown[]).includes(q.handling)) return null;
  if (typeof q.attestationRecorded !== 'boolean') return null;
  if (!Array.isArray(q.platformCategoryPaths)) return null;
  const paths: Id<'Category'>[][] = [];
  for (const path of q.platformCategoryPaths as unknown[]) {
    if (!Array.isArray(path)) return null;
    const ids: Id<'Category'>[] = [];
    for (const id of path as unknown[]) {
      const parsed = idOf(id);
      if (parsed === null) return null;
      ids.push(parsed as Id<'Category'>);
    }
    paths.push(ids);
  }
  return {
    sellerId: sellerId as Id<'Seller'>,
    productId: productId as Id<'Product'>,
    productRevisionId: productRevisionId as Id<'ProductRevision'>,
    variantId: variantId as Id<'Variant'>,
    typeCode: q.typeCode,
    handling: q.handling as OfferHandling,
    attestationRecorded: q.attestationRecorded,
    platformCategoryPaths: paths,
  };
}
