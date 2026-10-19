import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  ClaimPolicyRepository,
  NewPolicyRevision,
  PolicyRevisionSummary,
  StoredPolicy,
  StoredPolicyRevision,
} from '../application/ports/claim-policy.repository';
import { canonical, POLICY_BASES, type PolicyRow } from '../domain/claim-policy';
import { HANDLING_VALUES, type ClaimBasisRequirement, type Handling } from '../domain/claim-types';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The unique keys a concurrent writer collides on (migration `certification_claim_policies`). */
const POLICY_TYPE_KEY = 'claim_basis_policies_market_id_type_id_key';
const REVISION_NO_KEY = 'claim_policy_revisions_market_id_policy_id_revision_no_key';

interface RowRecord {
  selectorKind: string;
  categoryId: string | null;
  handling: string | null;
  basis: string;
}

/** One stored row; anything the CHECKs would refuse is a fault (fail closed), never skipped. */
function toRow(row: RowRecord): PolicyRow {
  if (!(POLICY_BASES as readonly string[]).includes(row.basis)) {
    throw new Error('policy row has an invalid basis');
  }
  const basis = row.basis as ClaimBasisRequirement;
  if (row.selectorKind === 'platform-category' && row.categoryId !== null) {
    return {
      selector: { kind: 'platform-category', categoryId: row.categoryId as Id<'Category'> },
      basis,
    };
  }
  if (
    row.selectorKind === 'handling' &&
    row.handling !== null &&
    (HANDLING_VALUES as readonly string[]).includes(row.handling) &&
    basis !== 'SELLER_OR_MANUFACTURER'
  ) {
    return { selector: { kind: 'handling', handling: row.handling as Handling }, basis };
  }
  throw new Error('policy row has an invalid selector');
}

/**
 * {@link ClaimPolicyRepository} on `certification`'s policy tables (data design 3.14), inside the
 * caller's unit. A revision and its rows are inserted in one unit before anything points at them;
 * the pointer moves only under the root's version. Nothing is updated but the root's pointer and
 * version, nothing is deleted.
 */
export class PrismaClaimPolicyRepository implements ClaimPolicyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async policyOfType(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<StoredPolicy | null> {
    const row = await this.prisma.tx(market).certificationClaimBasisPolicy.findFirst({
      where: { marketId: market.marketId, typeId },
      select: { id: true, typeId: true, publishedRevisionId: true, version: true },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'ClaimBasisPolicy'>,
      typeId: row.typeId as Id<'CertificationType'>,
      publishedRevisionId: row.publishedRevisionId as Id<'ClaimPolicyRevision'> | null,
      version: row.version,
    };
  }

  async addPolicy(
    market: MarketContext,
    policy: Parameters<ClaimPolicyRepository['addPolicy']>[1],
  ): Promise<void> {
    try {
      await this.prisma.tx(market).certificationClaimBasisPolicy.create({
        data: {
          id: policy.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          typeId: policy.typeId,
          publishedRevisionId: null,
          version: 1,
          createdAt: toDate(policy.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      // Another admin created the type's policy first: the client read version 0, now stale.
      if (this.prisma.violatedConstraint(error) === POLICY_TYPE_KEY) {
        throw new StaleAggregateError('claim-policy', policy.typeId);
      }
      throw error;
    }
  }

  async lockPolicy(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    expectedVersion: number,
  ): Promise<void> {
    // An update that changes nothing still takes the row lock, under the version guard.
    const { count } = await this.prisma.tx(market).certificationClaimBasisPolicy.updateMany({
      where: { marketId: market.marketId, id: policyId, version: expectedVersion },
      data: { version: expectedVersion },
    });
    if (count !== 1) throw new StaleAggregateError('claim-policy', policyId);
  }

  async revision(
    market: MarketContext,
    revisionId: Id<'ClaimPolicyRevision'>,
  ): Promise<StoredPolicyRevision | null> {
    const row = await this.prisma.tx(market).certificationClaimPolicyRevision.findFirst({
      where: { marketId: market.marketId, id: revisionId },
      include: {
        rows: { select: { selectorKind: true, categoryId: true, handling: true, basis: true } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'ClaimPolicyRevision'>,
      policyId: row.policyId as Id<'ClaimBasisPolicy'>,
      revisionNo: row.revisionNo,
      rows: canonical(row.rows.map(toRow)),
      authorAccountId: row.authorAccountId,
      changeReasonCiphertext: row.changeReasonCiphertext,
      createdAt: toInstant(row.createdAt),
    };
  }

  async revisions(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    limit: number,
  ): Promise<readonly PolicyRevisionSummary[]> {
    const rows = await this.prisma.tx(market).certificationClaimPolicyRevision.findMany({
      where: { marketId: market.marketId, policyId },
      select: {
        id: true,
        revisionNo: true,
        authorAccountId: true,
        changeReasonCiphertext: true,
        createdAt: true,
      },
      orderBy: { revisionNo: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'ClaimPolicyRevision'>,
      revisionNo: row.revisionNo,
      authorAccountId: row.authorAccountId,
      reasonGiven: row.changeReasonCiphertext !== null,
      createdAt: toInstant(row.createdAt),
    }));
  }

  async addRevision(market: MarketContext, revision: NewPolicyRevision): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const last = await tx.certificationClaimPolicyRevision.findFirst({
      where: { marketId: market.marketId, policyId: revision.policyId },
      select: { revisionNo: true },
      orderBy: { revisionNo: 'desc' },
    });
    const revisionNo = (last?.revisionNo ?? 0) + 1;
    try {
      await tx.certificationClaimPolicyRevision.create({
        data: {
          id: revision.id,
          ...scope,
          policyId: revision.policyId,
          revisionNo,
          changeReasonCiphertext: revision.changeReasonCiphertext,
          authorAccountId: revision.authorAccountId,
          createdAt: toDate(revision.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === REVISION_NO_KEY) {
        throw new StaleAggregateError('claim-policy', revision.policyId);
      }
      throw error;
    }
    if (revision.rows.length > 0) {
      await tx.certificationClaimPolicyRow.createMany({
        data: revision.rows.map((row) => ({
          id: this.ids.next<'ClaimPolicyRow'>(),
          ...scope,
          revisionId: revision.id,
          selectorKind: row.selector.kind,
          categoryId: row.selector.kind === 'platform-category' ? row.selector.categoryId : null,
          handling: row.selector.kind === 'handling' ? row.selector.handling : null,
          basis: row.basis,
        })),
      });
    }
    return revisionNo;
  }

  async publishRevision(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    revisionId: Id<'ClaimPolicyRevision'>,
    expectedVersion: number,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationClaimBasisPolicy.updateMany({
      where: { marketId: market.marketId, id: policyId, version: expectedVersion },
      data: { publishedRevisionId: revisionId, version: expectedVersion + 1 },
    });
    if (count !== 1) throw new StaleAggregateError('claim-policy', policyId);
  }
}
