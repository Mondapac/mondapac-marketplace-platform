import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  IssuerRequestAnswerWrite,
  IssuerRequestNotice,
  IssuerRequestQueueEntry,
  IssuerRequestRepository,
  NewIssuerRequest,
  StoredIssuerRequest,
} from '../../src/modules/certification/application/ports/issuer-request.repository';
import type { StoredDocument } from '../../src/modules/certification/application/ports/seller-certificate.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// In-memory "my issuer is not listed" requests (certification slice 6), for the use-case specs and
// the HTTP spec. They keep the rules the database keeps (one Market per row, an answer once under
// the version, files of the request only); the SQL is proved in
// test/db/certification-issuer-request.db-spec.ts.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MemoryRequest extends Mutable<Omit<StoredIssuerRequest, 'documents'>> {
  readonly marketId: string;
  documents: StoredDocument[];
  answeredByAccountId: Id<'Account'> | null;
}

export class MemoryIssuerRequests implements IssuerRequestRepository {
  readonly rows = new Map<string, MemoryRequest>();
  /** Type code per type id, for the queue and the read. */
  readonly typeCodes = new Map<string, string>();
  /** When set, `sellerId|typeId` of each open request is mirrored here (the certificate fake). */
  constructor(private readonly openMirror?: Set<string>) {}
  failNextWrite: Error | null = null;

  private mirror() {
    if (this.openMirror === undefined) return;
    this.openMirror.clear();
    for (const row of this.rows.values()) {
      if (row.state === 'open') this.openMirror.add(`${row.sellerId}|${row.typeId}`);
    }
  }

  add(market: MarketContext, request: NewIssuerRequest): Promise<void> {
    if (this.failNextWrite !== null) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      return Promise.reject(error);
    }
    this.rows.set(request.id, {
      marketId: market.marketId,
      id: request.id,
      sellerId: request.sellerId,
      typeId: request.typeId,
      typeCode: this.typeCodes.get(request.typeId) ?? 'unknown',
      typedNameCiphertext: request.typedNameCiphertext,
      state: 'open',
      answerReasonCode: null,
      issuerId: null,
      answeredAt: null,
      answeredByAccountId: null,
      version: 1,
      createdAt: request.now,
      documents: [
        {
          id: request.document.id,
          position: 1,
          mediaType: request.document.mediaType,
          byteSize: request.document.byteSize,
          pageCount: request.document.pageCount,
          createdAt: request.now,
          objectKey: request.document.objectKey,
          dataKeyEnvelope: request.document.dataKeyEnvelope,
          cleanSha256: request.document.cleanSha256,
          submitted: false,
          purpose: 'issuer-request',
        },
      ],
    });
    this.mirror();
    return Promise.resolve();
  }

  openQueue(market: MarketContext, cap: number): Promise<readonly IssuerRequestQueueEntry[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.marketId === market.marketId && row.state === 'open')
        .sort(
          (a, b) =>
            a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, cap)
        .map((row) => ({
          id: row.id,
          sellerId: row.sellerId,
          typeCode: row.typeCode,
          version: row.version,
          documentCount: row.documents.length,
          createdAt: row.createdAt,
        })),
    );
  }

  find(market: MarketContext, id: Id<'IssuerRequest'>): Promise<StoredIssuerRequest | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.marketId !== market.marketId) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      sellerId: row.sellerId,
      typeId: row.typeId,
      typeCode: row.typeCode,
      typedNameCiphertext: row.typedNameCiphertext,
      state: row.state,
      answerReasonCode: row.answerReasonCode,
      issuerId: row.issuerId,
      answeredAt: row.answeredAt,
      version: row.version,
      createdAt: row.createdAt,
      documents: [...row.documents],
    });
  }

  answer(market: MarketContext, write: IssuerRequestAnswerWrite): Promise<void> {
    const row = this.rows.get(write.id);
    if (
      row === undefined ||
      row.marketId !== market.marketId ||
      row.version !== write.expectedVersion ||
      row.state !== 'open'
    ) {
      return Promise.reject(new StaleAggregateError('issuer-request', write.id));
    }
    row.state = write.outcome;
    row.issuerId = write.issuerId;
    row.answerReasonCode = write.reasonCode;
    row.answeredAt = write.answeredAt;
    row.answeredByAccountId = write.accountId;
    row.version += 1;
    this.mirror();
    return Promise.resolve();
  }

  notice(market: MarketContext, id: Id<'IssuerRequest'>): Promise<IssuerRequestNotice | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.marketId !== market.marketId) return Promise.resolve(null);
    return Promise.resolve({
      sellerId: row.sellerId,
      typeCode: row.typeCode,
      state: row.state,
      answerReasonCode: row.answerReasonCode,
    });
  }
}
