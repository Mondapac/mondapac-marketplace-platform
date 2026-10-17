import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type {
  ChangeReasonRead,
  ExpertReferenceHolder,
  RegistryCipher,
} from '../../src/modules/certification/application/ports/registry-cipher';
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
} from '../../src/modules/certification/application/ports/registry.repository';
import type { ExpertApproval } from '../../src/modules/certification/domain/issuer';
import type { ProposalSubject, TypeStatus } from '../../src/modules/certification/domain/registry';
import type { TypeRevisionContent } from '../../src/modules/certification/domain/type-revision';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { fakeRunOnce } from './fake-run-once';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface State {
  types: Map<string, Mutable<StoredType> & { marketId: string }>;
  revisions: Map<string, StoredTypeRevision & { marketId: string }>;
  proposals: Map<string, Mutable<StoredProposal> & { marketId: string }>;
  issuers: Map<string, Mutable<StoredIssuer> & { marketId: string; nameKey: string }>;
  /** Approved certificates by issuer id: the seller of each. */
  approved: Map<string, Id<'Seller'>[]>;
  platformSubjects: Map<string, Id>;
}

const copyState = (s: State): State => ({
  types: new Map([...s.types].map(([k, v]) => [k, { ...v }])),
  revisions: new Map(s.revisions),
  proposals: new Map([...s.proposals].map(([k, v]) => [k, { ...v }])),
  issuers: new Map([...s.issuers].map(([k, v]) => [k, { ...v }])),
  approved: new Map([...s.approved].map(([k, v]) => [k, [...v]])),
  platformSubjects: new Map(s.platformSubjects),
});

/**
 * The registry in memory, with the contract of the SQL repository: a write under a moved version
 * throws `StaleAggregateError`, one pending proposal per subject, a unique issuer name key and
 * accreditation number per type. {@link unitOfWork} rolls the whole state back on `err` or a
 * throw, as a transaction does. The SQL itself is in test/db/certification-registry.db-spec.ts.
 */
export class MemoryRegistry implements CertificationRegistryRepository {
  state: State = {
    types: new Map(),
    revisions: new Map(),
    proposals: new Map(),
    issuers: new Map(),
    approved: new Map(),
    platformSubjects: new Map(),
  };
  /** Called after each count: a test adds an approval here to race the derecognition. */
  onCount: (() => void) | null = null;
  readonly handled = new Set<string>();

  readonly unitOfWork: UnitOfWork = {
    run: async <T, E>(
      _market: MarketContext,
      work: () => Promise<Result<T, E>>,
    ): Promise<Result<T, E>> => {
      const before = copyState(this.state);
      try {
        const result = await work();
        if (!result.ok) this.state = before;
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      }
    },
    runOnce: fakeRunOnce(this.handled),
  };

  addType(
    market: MarketContext,
    type: { id: Id<'CertificationType'>; code: string; status: TypeStatus },
    revision: { id: Id<'CertificationTypeRevision'>; content: TypeRevisionContent },
    at: Temporal.Instant,
    authorAccountId: string,
  ): void {
    this.state.revisions.set(revision.id, {
      marketId: market.marketId,
      id: revision.id,
      typeId: type.id,
      revisionNo: 1,
      content: revision.content,
      authorAccountId,
      changeReasonCiphertext: null,
      createdAt: at,
    });
    this.state.types.set(type.id, {
      marketId: market.marketId,
      id: type.id,
      code: type.code,
      status: type.status,
      verificationMode: revision.content.verificationMode,
      publishedRevisionId: revision.id,
      version: 1,
    });
  }

  approve(issuerId: Id<'Issuer'>, sellerId: Id<'Seller'>): void {
    this.state.approved.set(issuerId, [...(this.state.approved.get(issuerId) ?? []), sellerId]);
  }

  private mine<T extends { marketId: string }>(market: MarketContext, row: T | undefined) {
    return row !== undefined && row.marketId === market.marketId ? row : null;
  }

  private strip<T extends { marketId: string }>(row: T): Omit<T, 'marketId'> {
    const rest: Partial<T> = { ...row };
    delete rest.marketId;
    return rest as Omit<T, 'marketId'>;
  }

  private public(row: Mutable<StoredIssuer> & { marketId: string; nameKey: string }): StoredIssuer {
    const rest: Partial<typeof row> = { ...row };
    delete rest.marketId;
    delete rest.nameKey;
    return rest as StoredIssuer;
  }

  listTypes(market: MarketContext): Promise<readonly TypeListRow[]> {
    const rows = [...this.state.types.values()]
      .filter((t) => t.marketId === market.marketId)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((t): TypeListRow => {
        const revision = this.state.revisions.get(t.publishedRevisionId)!;
        return {
          type: this.strip(t),
          publishedRevisionNo: revision.revisionNo,
          names: Object.fromEntries(
            Object.entries(revision.content.locales).map(([l, c]) => [l, c.name]),
          ),
          pendingSubjects: [...this.state.proposals.values()]
            .filter((p) => p.subjectId === t.id && p.state === 'pending')
            .map((p) => p.subject),
        };
      });
    return Promise.resolve(rows);
  }

  type(market: MarketContext, typeId: Id<'CertificationType'>): Promise<StoredType | null> {
    const row = this.mine(market, this.state.types.get(typeId));
    return Promise.resolve(row === null ? null : this.strip(row));
  }

  revision(
    market: MarketContext,
    revisionId: Id<'CertificationTypeRevision'>,
  ): Promise<StoredTypeRevision | null> {
    const row = this.mine(market, this.state.revisions.get(revisionId));
    return Promise.resolve(row === null ? null : this.strip(row));
  }

  addRevision(market: MarketContext, revision: NewTypeRevision): Promise<number> {
    const revisionNo =
      [...this.state.revisions.values()].filter((r) => r.typeId === revision.typeId).length + 1;
    this.state.revisions.set(revision.id, {
      marketId: market.marketId,
      id: revision.id,
      typeId: revision.typeId,
      revisionNo,
      content: revision.content,
      authorAccountId: revision.authorAccountId,
      changeReasonCiphertext: revision.changeReasonCiphertext,
      createdAt: revision.createdAt,
    });
    return Promise.resolve(revisionNo);
  }

  private typeAt(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    expectedVersion: number,
  ): Mutable<StoredType> {
    const row = this.mine(market, this.state.types.get(typeId));
    if (row === null || row.version !== expectedVersion) {
      throw new StaleAggregateError('CertificationType', typeId);
    }
    return row;
  }

  publishRevision(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    revisionId: Id<'CertificationTypeRevision'>,
    expectedVersion: number,
  ): Promise<void> {
    const row = this.typeAt(market, typeId, expectedVersion);
    row.publishedRevisionId = revisionId;
    row.version += 1;
    return Promise.resolve();
  }

  setTypeStatus(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    status: TypeStatus,
    expectedVersion: number,
  ): Promise<void> {
    const row = this.typeAt(market, typeId, expectedVersion);
    row.status = status;
    row.version += 1;
    return Promise.resolve();
  }

  pendingProposal(
    market: MarketContext,
    subject: ProposalSubject,
    subjectId: string,
  ): Promise<StoredProposal | null> {
    const row = [...this.state.proposals.values()].find(
      (p) =>
        p.marketId === market.marketId &&
        p.subject === subject &&
        p.subjectId === subjectId &&
        p.state === 'pending',
    );
    return Promise.resolve(row === undefined ? null : this.strip(row));
  }

  proposal(market: MarketContext, id: Id<'RelaxationProposal'>): Promise<StoredProposal | null> {
    const row = this.mine(market, this.state.proposals.get(id));
    return Promise.resolve(row === null ? null : this.strip(row));
  }

  async addProposal(
    market: MarketContext,
    proposal: NewProposal,
  ): Promise<'review.proposal-pending' | null> {
    if ((await this.pendingProposal(market, proposal.subject, proposal.subjectId)) !== null) {
      return 'review.proposal-pending';
    }
    this.state.proposals.set(proposal.id, {
      ...proposal,
      marketId: market.marketId,
      state: 'pending',
      decidedByAccountId: null,
      decidedAt: null,
      version: 1,
    });
    return null;
  }

  closeProposal(
    market: MarketContext,
    write: Parameters<CertificationRegistryRepository['closeProposal']>[1],
  ): Promise<void> {
    const row = this.mine(market, this.state.proposals.get(write.id));
    if (row === null || row.state !== 'pending' || row.version !== write.expectedVersion) {
      throw new StaleAggregateError('RelaxationProposal', write.id);
    }
    // The table's CHECK: the decider is never the proposer.
    if (write.decidedByAccountId === row.proposerAccountId) {
      throw new Error('relaxation_proposals_decider_not_proposer');
    }
    row.state = write.state;
    row.decidedByAccountId = write.decidedByAccountId;
    row.decidedAt = write.decidedAt;
    row.version += 1;
    return Promise.resolve();
  }

  listIssuers(
    market: MarketContext,
    filter: Parameters<CertificationRegistryRepository['listIssuers']>[1],
  ): Promise<readonly StoredIssuer[]> {
    const rows = [...this.state.issuers.values()]
      .filter(
        (i) =>
          i.marketId === market.marketId &&
          (filter.typeId === null || i.typeId === filter.typeId) &&
          (filter.state === null || i.state === filter.state) &&
          (filter.afterId === null || i.id > filter.afterId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit)
      .map((i) => this.public(i));
    return Promise.resolve(rows);
  }

  issuer(market: MarketContext, issuerId: Id<'Issuer'>): Promise<StoredIssuer | null> {
    const row = this.mine(market, this.state.issuers.get(issuerId));
    return Promise.resolve(row === null ? null : this.public(row));
  }

  addIssuer(
    market: MarketContext,
    issuer: NewIssuer,
  ): Promise<'issuer.name-taken' | 'issuer.accreditation-taken' | null> {
    const peers = [...this.state.issuers.values()].filter(
      (i) => i.marketId === market.marketId && i.typeId === issuer.typeId,
    );
    if (peers.some((i) => i.nameKey === issuer.displayNameKey)) {
      return Promise.resolve('issuer.name-taken');
    }
    if (
      issuer.accreditationNumber !== null &&
      peers.some((i) => i.accreditationNumber === issuer.accreditationNumber)
    ) {
      return Promise.resolve('issuer.accreditation-taken');
    }
    const type = this.state.types.get(issuer.typeId)!;
    this.state.issuers.set(issuer.id, {
      marketId: market.marketId,
      nameKey: issuer.displayNameKey,
      id: issuer.id,
      typeId: issuer.typeId,
      typeCode: type.code,
      displayName: issuer.displayName,
      accreditationNumber: issuer.accreditationNumber,
      state: 'proposed',
      expertReferenceCiphertext: null,
      stateChangedAt: issuer.createdAt,
      stateChangedByKind: 'admin',
      stateChangedByAccountId: issuer.accountId,
      version: 1,
      createdAt: issuer.createdAt,
    });
    return Promise.resolve(null);
  }

  setIssuerState(market: MarketContext, write: IssuerStateWrite): Promise<void> {
    const row = this.mine(market, this.state.issuers.get(write.id));
    if (row === null || row.version !== write.expectedVersion) {
      throw new StaleAggregateError('Issuer', write.id);
    }
    row.state = write.state;
    if (write.expertReferenceCiphertext !== undefined) {
      row.expertReferenceCiphertext = write.expertReferenceCiphertext;
    }
    row.stateChangedAt = write.changedAt;
    row.stateChangedByKind = 'admin';
    row.stateChangedByAccountId = write.accountId;
    row.version += 1;
    return Promise.resolve();
  }

  approvedCertificateCount(market: MarketContext, issuerId: Id<'Issuer'>): Promise<number> {
    const count =
      this.mine(market, this.state.issuers.get(issuerId)) === null
        ? 0
        : (this.state.approved.get(issuerId)?.length ?? 0);
    const hook = this.onCount;
    this.onCount = null;
    hook?.();
    return Promise.resolve(count);
  }

  affectedSellers(
    market: MarketContext,
    issuerId: Id<'Issuer'>,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    if (this.mine(market, this.state.issuers.get(issuerId)) === null) return Promise.resolve([]);
    const sellers = [...new Set(this.state.approved.get(issuerId) ?? [])]
      .sort()
      .filter((s) => afterSellerId === null || s > afterSellerId)
      .slice(0, limit);
    return Promise.resolve(sellers);
  }

  platformSubject(market: MarketContext): Promise<Id | null> {
    return Promise.resolve(this.state.platformSubjects.get(market.marketId) ?? null);
  }

  addPlatformSubject(market: MarketContext, subjectId: Id): Promise<void> {
    if (this.state.platformSubjects.has(market.marketId)) throw new Error('unique');
    this.state.platformSubjects.set(market.marketId, subjectId);
    return Promise.resolve();
  }
}

/**
 * A reversible stand-in for the registry cipher: each value is tagged with its Market, holder and
 * text, so a test sees where it was sealed and a value moved elsewhere does not open. A reason
 * key in {@link erased} answers `erased`.
 */
export class FakeRegistryCipher implements RegistryCipher {
  readonly erased = new Set<string>();
  readonly reasonKeys: string[] = [];

  sealExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    approval: ExpertApproval,
  ): Promise<string> {
    return Promise.resolve(`x:${market.marketId}:${holder}:${JSON.stringify(approval)}`);
  }

  openExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    sealed: string,
  ): Promise<ExpertApproval> {
    const prefix = `x:${market.marketId}:${holder}:`;
    if (!sealed.startsWith(prefix)) throw new Error('fake cipher: wrong binding');
    return Promise.resolve(JSON.parse(sealed.slice(prefix.length)) as ExpertApproval);
  }

  sealChangeReason(market: MarketContext, holderId: Id, text: string): Promise<string> {
    this.reasonKeys.push(holderId);
    return Promise.resolve(`r:${market.marketId}:${holderId}:${text}`);
  }

  openChangeReason(market: MarketContext, holderId: Id, sealed: string): Promise<ChangeReasonRead> {
    if (this.erased.has(holderId)) return Promise.resolve({ state: 'erased' });
    const prefix = `r:${market.marketId}:${holderId}:`;
    if (!sealed.startsWith(prefix)) throw new Error('fake cipher: wrong binding');
    return Promise.resolve({ state: 'given', text: sealed.slice(prefix.length) });
  }
}
