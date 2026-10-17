import { createHash } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import type { RateCounter } from '../../src/modules/certification/application/ports/rate-counters';
import type {
  CertificateTypeCatalog,
  IssuerChoice,
  SellerTypeView,
} from '../../src/modules/certification/application/ports/certificate-type-catalog';
import type {
  CertificateField,
  CertificateFieldCipher,
  DocumentVault,
  SellerKeyDestroyed,
  VaultedDocument,
} from '../../src/modules/certification/application/ports/document-ports';
import type {
  RateCounterKeys,
  RateCounterRepository,
} from '../../src/modules/certification/application/ports/rate-counters';
import type {
  NewCertificate,
  NewDocument,
  SellerCertificateRepository,
  StoredCertificate,
  StoredDocument,
  StoredDraft,
  SubmitWrite,
  WithdrawWrite,
} from '../../src/modules/certification/application/ports/seller-certificate.repository';
import type { SellerZonesSource } from '../../src/modules/certification/application/ports/claim-facts.ports';
import type { RateReservation } from '../../src/modules/certification/domain/rate-limits';
import type { SubmissionKind } from '../../src/modules/certification/domain/seller-certificate';
import type { SellerCertificationStatus } from '../../src/modules/certification/domain/validity';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

// In-memory ports of certification's seller side, for the use-case specs and the HTTP spec. They
// keep the rules the database keeps (one open certificate per seller and type, versions, the
// draft quota, links that never dangle) so a spec sees the same refusals; the SQL itself is
// proved in test/db/certification-seller-certificate.db-spec.ts.

export const passThroughUnitOfWork = {
  run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
} as unknown as UnitOfWork;

interface MemoryCertificate {
  id: Id<'SellerCertification'>;
  sellerId: Id<'Seller'>;
  typeId: Id<'CertificationType'>;
  status: SellerCertificationStatus;
  pendingSubmissionId: Id<'Submission'> | null;
  pendingKind: SubmissionKind | null;
  approvedSubmissionId: Id<'Submission'> | null;
  approvedBoundaryAt: Temporal.Instant | null;
  statusChangedAt: Temporal.Instant;
  lastChangedAt: Temporal.Instant;
  createdAt: Temporal.Instant;
  version: number;
  draft: StoredDraft;
}

export interface MemorySubmission {
  readonly write: SubmitWrite;
  readonly marketId: string;
  withdrawn: WithdrawWrite | null;
}

export interface MemoryHistoryRow {
  readonly certificateId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly submissionId: string;
  readonly reasonCode: string | null;
}

const OPEN = (status: string): boolean => status !== 'declined' && status !== 'revoked';

/** {@link SellerCertificateRepository} over maps, one store per Market. */
export class MemoryCertificates implements SellerCertificateRepository {
  readonly certificates = new Map<string, MemoryCertificate & { marketId: string }>();
  readonly documents = new Map<
    string,
    StoredDocument & { sellerId: string; certificateId: string; marketId: string }
  >();
  readonly draftLinks: { certificateId: string; documentId: string; position: number }[] = [];
  readonly submissions: MemorySubmission[] = [];
  readonly history: MemoryHistoryRow[] = [];
  readonly quotas = new Map<string, number>();
  /** Typecode per type id, for the list and read answers. */
  readonly typeCodes = new Map<string, string>();
  failNextWrite: Error | null = null;

  private touch(id: string, expected: number, now: Temporal.Instant) {
    if (this.failNextWrite !== null) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    const row = this.certificates.get(id);
    if (row === undefined || row.version !== expected) {
      throw new StaleAggregateError('seller-certification', id);
    }
    row.version += 1;
    row.lastChangedAt = now;
    return row;
  }

  private view(row: MemoryCertificate): StoredCertificate {
    return {
      id: row.id,
      sellerId: row.sellerId,
      typeId: row.typeId,
      typeCode: this.typeCodes.get(row.typeId) ?? 'unknown',
      status: row.status,
      pendingSubmissionId: row.pendingSubmissionId,
      pendingKind: row.pendingKind,
      approvedSubmissionId: row.approvedSubmissionId,
      approvedBoundaryAt: row.approvedBoundaryAt,
      approvedIssuerState: null,
      submissionCount: this.submissions.filter((s) => s.write.certificateId === row.id).length,
      statusChangedAt: row.statusChangedAt,
      lastChangedAt: row.lastChangedAt,
      createdAt: row.createdAt,
      version: row.version,
      draft: { ...row.draft },
    };
  }

  add(market: MarketContext, c: NewCertificate): Promise<'certificate.exists' | null> {
    for (const row of this.certificates.values()) {
      if (
        row.marketId === market.marketId &&
        row.sellerId === c.sellerId &&
        row.typeId === c.typeId &&
        OPEN(row.status)
      ) {
        return Promise.resolve('certificate.exists');
      }
    }
    this.certificates.set(c.id, {
      marketId: market.marketId,
      id: c.id,
      sellerId: c.sellerId,
      typeId: c.typeId,
      status: 'draft',
      pendingSubmissionId: null,
      pendingKind: null,
      approvedSubmissionId: null,
      approvedBoundaryAt: null,
      statusChangedAt: c.now,
      lastChangedAt: c.now,
      createdAt: c.now,
      version: 1,
      draft: {
        issuerId: null,
        certificateNumberCiphertext: null,
        issueDate: null,
        expiryDate: null,
        selfDeclared: null,
        selfDeclarationNoteCiphertext: null,
      },
    });
    return Promise.resolve(null);
  }

  findOwn(market: MarketContext, sellerId: Id<'Seller'>, id: Id<'SellerCertification'>) {
    const row = this.certificates.get(id);
    return Promise.resolve(
      row !== undefined && row.marketId === market.marketId && row.sellerId === sellerId
        ? this.view(row)
        : null,
    );
  }

  listOwn(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: { afterId: Id<'SellerCertification'> | null; limit: number },
  ) {
    const rows = [...this.certificates.values()]
      .filter((row) => row.marketId === market.marketId && row.sellerId === sellerId)
      .sort(
        (a, b) =>
          Temporal.Instant.compare(b.createdAt, a.createdAt) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    const start = page.afterId === null ? 0 : rows.findIndex((row) => row.id === page.afterId) + 1;
    return Promise.resolve(rows.slice(start, start + page.limit).map((row) => this.view(row)));
  }

  saveDraft(
    _m: MarketContext,
    id: Id<'SellerCertification'>,
    expectedVersion: number,
    draft: StoredDraft,
    now: Temporal.Instant,
  ) {
    this.touch(id, expectedVersion, now).draft = { ...draft };
    return Promise.resolve();
  }

  deleteNeverSubmitted(_m: MarketContext, sellerId: Id<'Seller'>, id: Id<'SellerCertification'>) {
    const row = this.certificates.get(id);
    if (row === undefined || row.sellerId !== sellerId) return Promise.resolve(false);
    if (this.submissions.some((s) => s.write.certificateId === id)) return Promise.resolve(false);
    for (const link of this.draftLinks.filter((l) => l.certificateId === id)) {
      this.documents.delete(link.documentId);
    }
    this.draftLinks.splice(
      0,
      this.draftLinks.length,
      ...this.draftLinks.filter((l) => l.certificateId !== id),
    );
    this.certificates.delete(id);
    return Promise.resolve(true);
  }

  listDocuments(_m: MarketContext, certificateId: Id<'SellerCertification'>) {
    return Promise.resolve(
      this.draftLinks
        .filter((link) => link.certificateId === certificateId)
        .sort((a, b) => a.position - b.position)
        .map((link) => this.documentView(link.documentId, link.position)),
    );
  }

  private documentView(documentId: string, position: number): StoredDocument {
    const doc = this.documents.get(documentId)!;
    return {
      id: doc.id,
      position,
      mediaType: doc.mediaType,
      byteSize: doc.byteSize,
      pageCount: doc.pageCount,
      createdAt: doc.createdAt,
      objectKey: doc.objectKey,
      dataKeyEnvelope: doc.dataKeyEnvelope,
      cleanSha256: doc.cleanSha256,
      submitted: this.submissions.some((s) => s.write.documentIds.includes(doc.id)),
      purpose: 'seller-certificate',
    };
  }

  findDocumentForRead(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
  ) {
    const doc = this.documents.get(documentId);
    if (doc === undefined || doc.sellerId !== sellerId) return Promise.resolve(null);
    const link = this.draftLinks.find(
      (l) => l.certificateId === certificateId && l.documentId === documentId,
    );
    const submitted = this.submissions.find(
      (s) => s.write.certificateId === certificateId && s.write.documentIds.includes(documentId),
    );
    if (link === undefined && submitted === undefined) return Promise.resolve(null);
    return Promise.resolve(this.documentView(documentId, link?.position ?? 1));
  }

  addDocument(market: MarketContext, d: NewDocument) {
    this.touch(d.certificateId, d.expectedVersion, d.now);
    this.documents.set(d.id, {
      id: d.id,
      position: d.position,
      mediaType: d.mediaType,
      byteSize: d.byteSize,
      pageCount: d.pageCount,
      createdAt: d.now,
      objectKey: d.objectKey,
      dataKeyEnvelope: d.dataKeyEnvelope,
      cleanSha256: d.cleanSha256,
      submitted: false,
      purpose: 'seller-certificate',
      sellerId: d.sellerId,
      certificateId: d.certificateId,
      marketId: market.marketId,
    });
    this.draftLinks.push({
      certificateId: d.certificateId,
      documentId: d.id,
      position: d.position,
    });
    return Promise.resolve();
  }

  removeDocument(
    _m: MarketContext,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ) {
    const index = this.draftLinks.findIndex(
      (l) => l.certificateId === certificateId && l.documentId === documentId,
    );
    if (index < 0) return Promise.resolve('missing' as const);
    this.touch(certificateId, expectedVersion, now);
    this.draftLinks.splice(index, 1);
    if (this.submissions.some((s) => s.write.documentIds.includes(documentId))) {
      return Promise.resolve('unlinked' as const);
    }
    this.documents.delete(documentId);
    return Promise.resolve('deleted' as const);
  }

  submit(market: MarketContext, w: SubmitWrite) {
    const row = this.touch(w.certificateId, w.expectedVersion, w.submittedAt);
    this.submissions.push({ write: w, marketId: market.marketId, withdrawn: null });
    row.status = w.toStatus;
    row.pendingSubmissionId = w.submissionId;
    row.pendingKind = w.kind;
    if (w.toStatus !== w.fromStatus) row.statusChangedAt = w.submittedAt;
    this.history.push({
      certificateId: w.certificateId,
      fromStatus: w.fromStatus,
      toStatus: w.toStatus,
      submissionId: w.submissionId,
      reasonCode: null,
    });
    return Promise.resolve();
  }

  withdraw(_m: MarketContext, w: WithdrawWrite) {
    const row = this.touch(w.certificateId, w.expectedVersion, w.decidedAt);
    const submission = this.submissions.find((s) => s.write.submissionId === w.submissionId);
    if (submission !== undefined) submission.withdrawn = w;
    row.status = w.toStatus;
    row.pendingSubmissionId = null;
    row.pendingKind = null;
    if (w.toStatus !== w.fromStatus) row.statusChangedAt = w.decidedAt;
    this.history.push({
      certificateId: w.certificateId,
      fromStatus: w.fromStatus,
      toStatus: w.toStatus,
      submissionId: w.submissionId,
      reasonCode: w.cause,
    });
    return Promise.resolve();
  }

  reserveQuota(_m: MarketContext, sellerId: Id<'Seller'>, bytes: number, limit: number) {
    const held = this.quotas.get(sellerId) ?? 0;
    if (held + bytes > limit) return Promise.resolve(false);
    this.quotas.set(sellerId, held + bytes);
    return Promise.resolve(true);
  }

  releaseQuota(_m: MarketContext, sellerId: Id<'Seller'>, bytes: number) {
    this.quotas.set(sellerId, Math.max(0, (this.quotas.get(sellerId) ?? 0) - bytes));
    return Promise.resolve();
  }
}

/** A registry of types and issuers per Market. */
export class MemoryTypeCatalog implements CertificateTypeCatalog {
  readonly types = new Map<string, SellerTypeView & { marketId: string }>();
  readonly issuers = new Map<string, IssuerChoice & { marketId: string }>();
  unavailable = false;

  addType(market: MarketContext, type: SellerTypeView) {
    this.types.set(type.typeId, { ...type, marketId: market.marketId });
  }
  addIssuer(market: MarketContext, issuer: IssuerChoice) {
    this.issuers.set(issuer.id, { ...issuer, marketId: market.marketId });
  }
  private guard() {
    if (this.unavailable) throw new Error('the registry is unavailable');
  }
  typeByCode(market: MarketContext, code: string) {
    this.guard();
    return Promise.resolve(
      [...this.types.values()].find((t) => t.marketId === market.marketId && t.code === code) ??
        null,
    );
  }
  typeById(market: MarketContext, typeId: Id<'CertificationType'>) {
    this.guard();
    const type = this.types.get(typeId);
    return Promise.resolve(type?.marketId === market.marketId ? type : null);
  }
  issuer(market: MarketContext, issuerId: Id<'Issuer'>) {
    this.guard();
    const issuer = this.issuers.get(issuerId);
    return Promise.resolve(issuer?.marketId === market.marketId ? issuer : null);
  }
  activeIssuers(market: MarketContext, typeId: Id<'CertificationType'>) {
    return Promise.resolve(
      [...this.issuers.values()].filter(
        (i) => i.marketId === market.marketId && i.typeId === typeId && i.state === 'active',
      ),
    );
  }
  activeTypes(market: MarketContext) {
    return Promise.resolve(
      [...this.types.values()].filter(
        (t) => t.marketId === market.marketId && t.status === 'active',
      ),
    );
  }
}

/** Counters in a map; `deny` pretends the budget is spent. */
export class MemoryCounters implements RateCounterRepository {
  readonly counts = new Map<string, number>();
  failing = false;
  reserve(
    _m: MarketContext,
    counters: readonly RateCounter[],
    now: Temporal.Instant,
  ): Promise<readonly RateReservation[]> {
    if (this.failing) return Promise.reject(new Error('counters down'));
    return Promise.resolve(
      counters.map((c) => {
        const key = `${c.limit.kind}:${Buffer.from(c.keyHash).toString('hex')}`;
        const count = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, count);
        return { kind: c.limit.kind, count, windowStartedAt: now };
      }),
    );
  }
}

export const fakeCounterKeys: RateCounterKeys = {
  keyOf: (market, kind, subject) =>
    new Uint8Array(createHash('sha256').update(`${kind}|${market.marketId}|${subject}`).digest()),
};

/** Reversible stand-in for the subject key: not secret, but shaped like the real envelope. */
export class FakeCipher implements CertificateFieldCipher {
  destroyed = new Set<string>();
  private gone(seller: string): Result<never, SellerKeyDestroyed> | null {
    return this.destroyed.has(seller) ? err({ code: 'subject-key.destroyed' }) : null;
  }
  seal(_m: MarketContext, seller: Id<'Seller'>, field: CertificateField, value: string) {
    return Promise.resolve(
      this.gone(seller) ?? ok(`v1.${Buffer.from(`${field}|${value}`).toString('base64url')}`),
    );
  }
  open(_m: MarketContext, seller: Id<'Seller'>, field: CertificateField, sealed: string) {
    const gone = this.gone(seller);
    if (gone !== null) return Promise.resolve(gone);
    // The field is bound into the envelope, like the real label: a copy to another column fails.
    const [stored, ...rest] = Buffer.from(sealed.slice(3), 'base64url').toString().split('|');
    if (stored !== field) return Promise.resolve(err({ code: 'subject-key.destroyed' as const }));
    return Promise.resolve(ok(rest.join('|')));
  }
  hash(_m: MarketContext, seller: Id<'Seller'>, content: string) {
    return Promise.resolve(
      this.gone(seller) ??
        ok(createHash('sha256').update(`hash|${seller}|${content}`).digest('hex')),
    );
  }
}

/** The vault over a map; the bytes are kept in clear (the real one is tested on its own). */
export class MemoryVault implements DocumentVault {
  readonly objects = new Map<string, Buffer>();
  destroyed = new Set<string>();
  seal(
    _m: MarketContext,
    seller: Id<'Seller'>,
    documentId: Id<'UploadedDocument'>,
    plain: Buffer,
  ): Promise<Result<VaultedDocument, SellerKeyDestroyed>> {
    if (this.destroyed.has(seller)) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    const objectKey = `certification/${seller}/${documentId}`;
    this.objects.set(objectKey, plain);
    return Promise.resolve(
      ok({
        objectKey,
        dataKeyEnvelope: `v1.${Buffer.from(documentId).toString('base64url')}`,
        cleanSha256: createHash('sha256').update(plain).digest(),
      }),
    );
  }
  open(
    _m: MarketContext,
    seller: Id<'Seller'>,
    document: VaultedDocument,
  ): Promise<Result<Buffer | null, SellerKeyDestroyed>> {
    if (this.destroyed.has(seller)) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    return Promise.resolve(ok(this.objects.get(document.objectKey) ?? null));
  }
  discard(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }
}

export class MemoryOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_c: CallContext, events: readonly PendingEvent[]): Promise<void> {
    this.events.push(...events);
    return Promise.resolve();
  }
}

export function zonesOf(
  answers: Record<string, { zone: string | null; addressZone: string | null }>,
): SellerZonesSource {
  return {
    zonesOf: (_c, sellerIds) =>
      Promise.resolve(
        new Map(sellerIds.map((id) => [id, answers[id] ?? { zone: null, addressZone: null }])),
      ),
  };
}
