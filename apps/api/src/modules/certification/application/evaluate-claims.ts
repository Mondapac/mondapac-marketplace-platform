import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { CertificationValidationFailed } from '../contracts/certification.facade';
import { decide, resolveRequirement, type ClaimFacts } from '../domain/claim-rule';
import {
  HANDLING_VALUES,
  type ClaimDecision,
  type ClaimQuery,
  type Handling,
} from '../domain/claim-types';
import { isCertificationTypeCode } from '../domain/type-revision';
import type { SellerZones } from '../domain/validity';
import type { ClaimFactsReader, TypeAndPolicy } from './ports/claim-facts.ports';
import type { SellerZoneAnswer, SellerZonesSource } from './ports/claim-facts.ports';

export const MAX_CLAIM_QUERIES = 100;
const MAX_PATHS = 50;
const MAX_PATH_DEPTH = 12;

const logger = new Logger('EvaluateClaims');

export interface EvaluateClaimsDependencies {
  readonly facts: ClaimFactsReader;
  readonly zones: SellerZonesSource;
  readonly now: () => Temporal.Instant;
}

type Parsed = { readonly query: ClaimQuery } | { readonly invalid: true };

/** Step 0 for one query: every id parses, the enums are in their lists, the paths are bounded. */
function parseQuery(raw: unknown): Parsed {
  if (typeof raw !== 'object' || raw === null) return { invalid: true };
  // Each field is read once.
  const q = raw as Record<string, unknown>;
  const { sellerId, productId, productRevisionId, variantId, typeCode, handling } = q;
  const { attestationRecorded, platformCategoryPaths } = q;
  const seller = typeof sellerId === 'string' ? parseId<'Seller'>(sellerId) : null;
  const product = typeof productId === 'string' ? parseId<'Product'>(productId) : null;
  const revision =
    typeof productRevisionId === 'string' ? parseId<'ProductRevision'>(productRevisionId) : null;
  const variant =
    variantId === null
      ? ({ ok: true, value: null } as const)
      : typeof variantId === 'string'
        ? parseId<'Variant'>(variantId)
        : null;
  if (!seller?.ok || !product?.ok || !revision?.ok || !variant?.ok) return { invalid: true };
  if (!isCertificationTypeCode(typeCode)) return { invalid: true };
  if (typeof handling !== 'string' || !(HANDLING_VALUES as readonly string[]).includes(handling)) {
    return { invalid: true };
  }
  if (typeof attestationRecorded !== 'boolean') return { invalid: true };
  if (!Array.isArray(platformCategoryPaths) || platformCategoryPaths.length > MAX_PATHS) {
    return { invalid: true };
  }
  const paths: Id<'Category'>[][] = [];
  for (let i = 0; i < platformCategoryPaths.length; i += 1) {
    const path: unknown = platformCategoryPaths[i];
    if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH_DEPTH) {
      return { invalid: true };
    }
    const ids: Id<'Category'>[] = [];
    for (let j = 0; j < path.length; j += 1) {
      const id: unknown = path[j];
      const parsed = typeof id === 'string' ? parseId<'Category'>(id) : null;
      if (!parsed?.ok) return { invalid: true };
      ids.push(parsed.value);
    }
    paths.push(ids);
  }
  return {
    query: {
      sellerId: seller.value,
      productId: product.value,
      productRevisionId: revision.value,
      variantId: variant.value,
      typeCode,
      handling: handling as Handling,
      attestationRecorded,
      platformCategoryPaths: paths,
    },
  };
}

function refused(raw: unknown, at: Temporal.Instant): ClaimDecision {
  return {
    allowed: false,
    basis: null,
    reason: 'input-invalid',
    certificate: null,
    policyRevisionId: null,
    badge: null,
    // Echoed as received: the caller's own value, never read for a decision.
    inputs: raw as ClaimQuery,
    evaluatedAt: at,
  };
}

function unavailable(query: ClaimQuery, at: Temporal.Instant): ClaimDecision {
  return {
    allowed: false,
    basis: null,
    reason: 'unavailable',
    certificate: null,
    policyRevisionId: null,
    badge: null,
    inputs: query,
    evaluatedAt: at,
  };
}

const categoryIdsOf = (q: ClaimQuery): Id<'Category'>[] => [
  ...new Set(q.platformCategoryPaths.flat()),
];

/**
 * `evaluateClaims` (design 4.1, 4.2), shared by the `anonymous` and `system` use cases. It
 * never reads the actor: the Market comes from `context.market`, the seller from the query.
 * The batch is 1 to 100 queries; a malformed query answers `input-invalid` and the others still
 * answer. Any exception or malformed read turns every query of the batch into `unavailable`
 * (rule 1); nothing is cached. The clock is read once, so one batch has one instant.
 */
export async function evaluateClaimsFor(
  deps: EvaluateClaimsDependencies,
  context: CallContext,
  queries: readonly unknown[],
): Promise<Result<readonly ClaimDecision[], CertificationValidationFailed>> {
  if (!Array.isArray(queries)) {
    return err({ code: 'validation.failed', fields: [{ path: 'queries', code: 'format' }] });
  }
  const count = queries.length;
  if (count < 1 || count > MAX_CLAIM_QUERIES) {
    return err({ code: 'validation.failed', fields: [{ path: 'queries', code: 'length' }] });
  }
  const at = deps.now();
  const parsed: Parsed[] = [];
  for (let i = 0; i < count; i += 1) parsed.push(parseQuery(queries[i]));
  const valid = parsed.flatMap((p, index) => ('query' in p ? [{ index, query: p.query }] : []));

  const decisions = new Map<number, ClaimDecision>();
  try {
    const policies =
      valid.length === 0
        ? []
        : await deps.facts.typesAndPolicies(
            context.market,
            valid.map(({ query }) => ({
              typeCode: query.typeCode,
              categoryIds: categoryIdsOf(query),
              handling: query.handling,
            })),
          );
    if (policies.length !== valid.length) throw new Error('policy read misaligned');

    // Only seller-basis queries need the seller's certificate and zones (design 4.2 step 1):
    // not an unknown type and not a NOT_APPLICABLE requirement, which `decide` denies anyway.
    const needsSeller = valid.map((_, k) => {
      const { type, policy } = policies[k]!;
      return (
        type !== null &&
        resolveRequirement(type.defaultBasis, policy?.matchedRows ?? []) !== 'NOT_APPLICABLE'
      );
    });
    const undecided = valid.filter((_, k) => needsSeller[k]);
    const certificates =
      undecided.length === 0
        ? []
        : await deps.facts.sellerCertificates(
            context.market,
            undecided.map(({ query }) => ({ sellerId: query.sellerId, typeCode: query.typeCode })),
          );
    if (certificates.length !== undecided.length) throw new Error('certificate read misaligned');
    const sellerIds = [...new Set(undecided.map(({ query }) => query.sellerId))];
    const zoneAnswer: SellerZoneAnswer =
      sellerIds.length === 0 ? new Map() : await deps.zones.zonesOf(context, sellerIds);
    for (const key of zoneAnswer.keys()) {
      if (!sellerIds.includes(key)) throw new Error('unexpected zone key');
    }

    let u = 0;
    valid.forEach(({ index, query }, k) => {
      const typeAndPolicy: TypeAndPolicy = policies[k]!;
      const seller = needsSeller[k] === true;
      const certificate = seller ? (certificates[u] ?? null) : null;
      const zone = seller ? zoneAnswer.get(query.sellerId) : undefined;
      if (seller) u += 1;
      const sellerZones: SellerZones | null =
        zone?.zone != null && zone.addressZone != null
          ? {
              zone: zone.zone as SellerZones['zone'],
              addressZone: zone.addressZone as SellerZones['addressZone'],
            }
          : null;
      const facts: ClaimFacts = {
        type: typeAndPolicy.type,
        policy: typeAndPolicy.policy,
        sellerCertificate: certificate,
        sellerZones,
      };
      decisions.set(index, decide(query, facts, at));
    });
  } catch (error) {
    // The class of the failure only; never ids or values.
    logger.error(`evaluateClaims failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return ok(
      parsed.map((p, index) =>
        'query' in p ? unavailable(p.query, at) : refused(queries[index], at),
      ),
    );
  }
  return ok(
    parsed.map((p, index) =>
      'query' in p ? (decisions.get(index) as ClaimDecision) : refused(queries[index], at),
    ),
  );
}
