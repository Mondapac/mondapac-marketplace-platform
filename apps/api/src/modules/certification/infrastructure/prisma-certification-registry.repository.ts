import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CertificationRegistryRepository,
  IssuerStateWrite,
  NewIssuer,
  NewProposal,
  NewTypeRevision,
  StoredIssuer,
  StoredProposal,
  StoredType,
  StoredTypeRevision,
  TypeListRow,
} from '../application/ports/registry.repository';
import type { IssuerState } from '../domain/issuer';
import type { ProposalState, ProposalSubject, TypeStatus } from '../domain/registry';
import type {
  TypeDefaultBasis,
  TypeLocaleContent,
  VerificationMode,
} from '../domain/type-revision';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const TYPE_SUBJECTS: readonly ProposalSubject[] = ['type-revision', 'type-reactivation'];
const ISSUER_STATES: readonly string[] = ['proposed', 'active', 'closed-to-new', 'derecognised'];
const PROPOSAL_STATES: readonly string[] = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
];
const PENDING_PROPOSAL_INDEX = 'relaxation_proposals_market_id_subject_pending_key';
const ISSUER_NAME_INDEX = 'issuers_market_id_type_id_display_name_key_key';
const ISSUER_ACCREDITATION_INDEX = 'issuers_market_id_type_id_accreditation_number_key';

interface TypeRow {
  id: string;
  code: string;
  status: string;
  verificationMode: string;
  publishedRevisionId: string | null;
  version: number;
}

function toType(row: TypeRow): StoredType {
  if (row.publishedRevisionId === null || (row.status !== 'active' && row.status !== 'inactive')) {
    // Only the creating unit sees a type without its pointer; a read here is a fault.
    throw new Error(`certification type ${row.code} has no published revision`);
  }
  return {
    id: row.id as Id<'CertificationType'>,
    code: row.code,
    status: row.status,
    verificationMode: row.verificationMode as VerificationMode,
    publishedRevisionId: row.publishedRevisionId as Id<'CertificationTypeRevision'>,
    version: row.version,
  };
}

interface ProposalRow {
  id: string;
  subjectKind: string;
  subjectId: string;
  basedOnRevisionId: string | null;
  proposedRevisionId: string | null;
  proposedExpertReferenceCiphertext: string | null;
  state: string;
  proposerAccountId: string;
  proposedAt: Date;
  decidedByAccountId: string | null;
  decidedAt: Date | null;
  changeReasonCiphertext: string | null;
  version: number;
}

function toProposal(row: ProposalRow): StoredProposal {
  if (!PROPOSAL_STATES.includes(row.state)) throw new Error('proposal has an invalid state');
  return {
    id: row.id as Id<'RelaxationProposal'>,
    subject: row.subjectKind as ProposalSubject,
    subjectId: row.subjectId,
    basedOnRevisionId: row.basedOnRevisionId,
    proposedRevisionId: row.proposedRevisionId,
    proposedExpertReferenceCiphertext: row.proposedExpertReferenceCiphertext,
    state: row.state as ProposalState,
    proposerAccountId: row.proposerAccountId,
    proposedAt: toInstant(row.proposedAt),
    decidedByAccountId: row.decidedByAccountId,
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    changeReasonCiphertext: row.changeReasonCiphertext,
    version: row.version,
  };
}

interface IssuerRow {
  id: string;
  typeId: string;
  displayName: string;
  accreditationNumber: string | null;
  state: string;
  expertReferenceCiphertext: string | null;
  stateChangedAt: Date;
  stateChangedByKind: string;
  stateChangedByAccountId: string | null;
  version: number;
  createdAt: Date;
  type: { code: string };
}

function toIssuer(row: IssuerRow): StoredIssuer {
  if (!ISSUER_STATES.includes(row.state)) throw new Error('issuer has an invalid state');
  return {
    id: row.id as Id<'Issuer'>,
    typeId: row.typeId as Id<'CertificationType'>,
    typeCode: row.type.code,
    displayName: row.displayName,
    accreditationNumber: row.accreditationNumber,
    state: row.state as IssuerState,
    expertReferenceCiphertext: row.expertReferenceCiphertext,
    stateChangedAt: toInstant(row.stateChangedAt),
    stateChangedByKind: row.stateChangedByKind === 'seed' ? 'seed' : 'admin',
    stateChangedByAccountId: row.stateChangedByAccountId,
    version: row.version,
    createdAt: toInstant(row.createdAt),
  };
}

const TYPE_SELECT = {
  id: true,
  code: true,
  status: true,
  verificationMode: true,
  publishedRevisionId: true,
  version: true,
} as const;

const ISSUER_INCLUDE = { type: { select: { code: true } } } as const;

/**
 * {@link CertificationRegistryRepository} on `certification`'s registry tables (data design 3.1 to
 * 3.3, 3.7, 3.20, 3.22), inside the caller's unit. Every write is a guarded update under the row's
 * version or an insert; a revision, its texts and terms are inserted in one unit before anything
 * points at them (the content trigger requires it). Nothing is deleted.
 */
export class PrismaCertificationRegistryRepository implements CertificationRegistryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listTypes(market: MarketContext): Promise<readonly TypeListRow[]> {
    const tx = this.prisma.tx(market);
    // A type gets its first revision in the unit that creates it; one not yet published is not
    // listed (it never commits so, but a list must not fail on it).
    const rows = await tx.certificationType.findMany({
      where: { marketId: market.marketId, publishedRevisionId: { not: null } },
      select: {
        ...TYPE_SELECT,
        publishedRevision: {
          select: { revisionNo: true, texts: { select: { locale: true, name: true } } },
        },
      },
      orderBy: { code: 'asc' },
      take: 200,
    });
    const pending = await tx.certificationRelaxationProposal.findMany({
      where: {
        marketId: market.marketId,
        state: 'pending',
        subjectKind: { in: [...TYPE_SUBJECTS] },
        subjectId: { in: rows.map((row) => row.id) },
      },
      select: { subjectKind: true, subjectId: true },
    });
    return rows.map((row) => {
      if (row.publishedRevision === null) {
        throw new Error(`certification type ${row.code} has no published revision`);
      }
      const names: Record<string, string> = {};
      for (const text of row.publishedRevision.texts) names[text.locale] = text.name;
      return {
        type: toType(row),
        publishedRevisionNo: row.publishedRevision.revisionNo,
        names,
        pendingSubjects: pending
          .filter((p) => p.subjectId === row.id)
          .map((p) => p.subjectKind as ProposalSubject)
          .sort(),
      };
    });
  }

  async type(market: MarketContext, typeId: Id<'CertificationType'>): Promise<StoredType | null> {
    const row = await this.prisma.tx(market).certificationType.findFirst({
      where: { marketId: market.marketId, id: typeId },
      select: TYPE_SELECT,
    });
    return row === null ? null : toType(row);
  }

  async revision(
    market: MarketContext,
    revisionId: Id<'CertificationTypeRevision'>,
  ): Promise<StoredTypeRevision | null> {
    const row = await this.prisma.tx(market).certificationTypeRevision.findFirst({
      where: { marketId: market.marketId, id: revisionId },
      include: { texts: { include: { terms: { orderBy: { phrase: 'asc' } } } } },
    });
    if (row === null) return null;
    const locales: Record<string, TypeLocaleContent> = {};
    for (const text of [...row.texts].sort((a, b) => a.locale.localeCompare(b.locale))) {
      locales[text.locale] = {
        name: text.name,
        customerDescription: text.customerDescription,
        claimTerms: text.terms.map((term) => term.phrase),
      };
    }
    return {
      id: row.id as Id<'CertificationTypeRevision'>,
      typeId: row.typeId as Id<'CertificationType'>,
      revisionNo: row.revisionNo,
      content: {
        verificationMode: row.verificationMode as VerificationMode,
        requiresIssuerRegistry: row.requiresIssuerRegistry,
        requiresDocument: row.requiresDocument,
        requiresExpiry: row.requiresExpiry,
        defaultBasis: row.defaultBasis as TypeDefaultBasis,
        autoApproveSelfDeclaration: row.autoApproveSelfDeclaration,
        badgeIconKey: row.badgeIconKey,
        locales,
      },
      authorAccountId: row.authorAccountId,
      changeReasonCiphertext: row.changeReasonCiphertext,
      createdAt: toInstant(row.createdAt),
    };
  }

  async addRevision(market: MarketContext, revision: NewTypeRevision): Promise<number> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const last = await tx.certificationTypeRevision.findFirst({
      where: { marketId: market.marketId, typeId: revision.typeId },
      select: { revisionNo: true },
      orderBy: { revisionNo: 'desc' },
    });
    const revisionNo = (last?.revisionNo ?? 0) + 1;
    const { content } = revision;
    try {
      await tx.certificationTypeRevision.create({
        data: {
          id: revision.id,
          ...scope,
          typeId: revision.typeId,
          revisionNo,
          verificationMode: content.verificationMode,
          requiresIssuerRegistry: content.requiresIssuerRegistry,
          requiresDocument: content.requiresDocument,
          requiresExpiry: content.requiresExpiry,
          defaultBasis: content.defaultBasis,
          autoApproveSelfDeclaration: content.autoApproveSelfDeclaration,
          badgeIconKey: content.badgeIconKey,
          changeReasonCiphertext: revision.changeReasonCiphertext,
          authorAccountId: revision.authorAccountId,
          createdAt: toDate(revision.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      // A concurrent save took the number: the second to commit loses (its unit rolls back).
      if (this.prisma.violatedConstraint(error) !== undefined) {
        throw new StaleAggregateError('certification-type', revision.typeId);
      }
      throw error;
    }
    for (const [locale, text] of Object.entries(content.locales)) {
      await tx.certificationTypeRevisionText.create({
        data: {
          ...scope,
          typeRevisionId: revision.id,
          locale,
          name: text.name,
          customerDescription: text.customerDescription,
        },
        select: { locale: true },
      });
      const phrases = [...new Set(text.claimTerms)];
      if (phrases.length > 0) {
        await tx.certificationClaimTerm.createMany({
          data: phrases.map((phrase) => ({
            ...scope,
            typeRevisionId: revision.id,
            locale,
            phrase,
          })),
        });
      }
    }
    return revisionNo;
  }

  async publishRevision(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    revisionId: Id<'CertificationTypeRevision'>,
    expectedVersion: number,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationType.updateMany({
      where: { marketId: market.marketId, id: typeId, version: expectedVersion },
      data: { publishedRevisionId: revisionId, version: expectedVersion + 1 },
    });
    if (count !== 1) throw new StaleAggregateError('certification-type', typeId);
  }

  async setTypeStatus(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    status: TypeStatus,
    expectedVersion: number,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationType.updateMany({
      where: { marketId: market.marketId, id: typeId, version: expectedVersion },
      data: { status, version: expectedVersion + 1 },
    });
    if (count !== 1) throw new StaleAggregateError('certification-type', typeId);
  }

  async pendingProposal(
    market: MarketContext,
    subject: ProposalSubject,
    subjectId: string,
  ): Promise<StoredProposal | null> {
    const row = await this.prisma.tx(market).certificationRelaxationProposal.findFirst({
      where: { marketId: market.marketId, subjectKind: subject, subjectId, state: 'pending' },
    });
    return row === null ? null : toProposal(row);
  }

  async proposal(
    market: MarketContext,
    id: Id<'RelaxationProposal'>,
  ): Promise<StoredProposal | null> {
    const row = await this.prisma.tx(market).certificationRelaxationProposal.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toProposal(row);
  }

  async addProposal(
    market: MarketContext,
    proposal: NewProposal,
  ): Promise<'review.proposal-pending' | null> {
    try {
      await this.prisma.tx(market).certificationRelaxationProposal.create({
        data: {
          id: proposal.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          subjectKind: proposal.subject,
          subjectId: proposal.subjectId,
          basedOnRevisionId: proposal.basedOnRevisionId,
          proposedRevisionId: proposal.proposedRevisionId,
          proposedExpertReferenceCiphertext: proposal.proposedExpertReferenceCiphertext,
          state: 'pending',
          proposerAccountId: proposal.proposerAccountId,
          proposedAt: toDate(proposal.proposedAt),
          changeReasonCiphertext: proposal.changeReasonCiphertext,
          version: 1,
          createdAt: toDate(proposal.proposedAt),
        },
        select: { id: true },
      });
      return null;
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === PENDING_PROPOSAL_INDEX) {
        return 'review.proposal-pending';
      }
      throw error;
    }
  }

  async closeProposal(
    market: MarketContext,
    write: Parameters<CertificationRegistryRepository['closeProposal']>[1],
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationRelaxationProposal.updateMany({
      where: {
        marketId: market.marketId,
        id: write.id,
        version: write.expectedVersion,
        state: 'pending',
      },
      data: {
        state: write.state,
        decidedByAccountId: write.decidedByAccountId,
        decidedAt: toDate(write.decidedAt),
        version: write.expectedVersion + 1,
      },
    });
    if (count !== 1) throw new StaleAggregateError('relaxation-proposal', write.id);
  }

  async listIssuers(
    market: MarketContext,
    filter: Parameters<CertificationRegistryRepository['listIssuers']>[1],
  ): Promise<readonly StoredIssuer[]> {
    const rows = await this.prisma.tx(market).certificationIssuer.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.typeId === null ? {} : { typeId: filter.typeId }),
        ...(filter.state === null ? {} : { state: filter.state }),
        ...(filter.afterId === null ? {} : { id: { gt: filter.afterId } }),
      },
      include: ISSUER_INCLUDE,
      orderBy: { id: 'asc' },
      take: filter.limit,
    });
    return rows.map(toIssuer);
  }

  async issuer(market: MarketContext, issuerId: Id<'Issuer'>): Promise<StoredIssuer | null> {
    const row = await this.prisma.tx(market).certificationIssuer.findFirst({
      where: { marketId: market.marketId, id: issuerId },
      include: ISSUER_INCLUDE,
    });
    return row === null ? null : toIssuer(row);
  }

  async addIssuer(
    market: MarketContext,
    issuer: NewIssuer,
  ): Promise<'issuer.name-taken' | 'issuer.accreditation-taken' | null> {
    const at = toDate(issuer.createdAt);
    try {
      await this.prisma.tx(market).certificationIssuer.create({
        data: {
          id: issuer.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          typeId: issuer.typeId,
          displayName: issuer.displayName,
          displayNameKey: issuer.displayNameKey,
          accreditationNumber: issuer.accreditationNumber,
          state: 'proposed',
          expertReferenceCiphertext: null,
          stateChangedAt: at,
          stateChangedByKind: 'admin',
          stateChangedByAccountId: issuer.accountId,
          version: 1,
          createdAt: at,
        },
        select: { id: true },
      });
      return null;
    } catch (error) {
      const constraint = this.prisma.violatedConstraint(error);
      if (constraint === ISSUER_NAME_INDEX) return 'issuer.name-taken';
      if (constraint === ISSUER_ACCREDITATION_INDEX) return 'issuer.accreditation-taken';
      throw error;
    }
  }

  async setIssuerState(market: MarketContext, write: IssuerStateWrite): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationIssuer.updateMany({
      where: { marketId: market.marketId, id: write.id, version: write.expectedVersion },
      data: {
        state: write.state,
        ...(write.expertReferenceCiphertext === undefined
          ? {}
          : { expertReferenceCiphertext: write.expertReferenceCiphertext }),
        stateChangedAt: toDate(write.changedAt),
        stateChangedByKind: 'admin',
        stateChangedByAccountId: write.accountId,
        version: write.expectedVersion + 1,
      },
    });
    if (count !== 1) throw new StaleAggregateError('issuer', write.id);
  }

  async approvedCertificateCount(market: MarketContext, issuerId: Id<'Issuer'>): Promise<number> {
    return this.prisma.tx(market).certificationSellerCertification.count({
      where: {
        marketId: market.marketId,
        status: 'approved',
        approvedSubmission: { is: { issuerId } },
      },
    });
  }

  async affectedSellers(
    market: MarketContext,
    issuerId: Id<'Issuer'>,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    const rows = await this.prisma.tx(market).certificationSellerCertification.findMany({
      where: {
        marketId: market.marketId,
        status: 'approved',
        approvedSubmission: { is: { issuerId } },
        ...(afterSellerId === null ? {} : { sellerId: { gt: afterSellerId } }),
      },
      select: { sellerId: true },
      orderBy: { sellerId: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.sellerId as Id<'Seller'>);
  }

  async platformSubject(market: MarketContext): Promise<Id | null> {
    const row = await this.prisma.tx(market).certificationPlatformSubject.findFirst({
      where: { marketId: market.marketId },
      select: { subjectId: true },
    });
    return row === null ? null : (row.subjectId as Id);
  }

  async addPlatformSubject(
    market: MarketContext,
    subjectId: Id,
    createdAt: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).certificationPlatformSubject.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        subjectId,
        createdAt: toDate(createdAt),
      },
      select: { subjectId: true },
    });
  }
}
