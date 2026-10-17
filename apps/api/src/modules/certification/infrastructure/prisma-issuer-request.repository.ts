import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  IssuerRequestAnswerWrite,
  IssuerRequestNotice,
  IssuerRequestQueueEntry,
  IssuerRequestRepository,
  NewIssuerRequest,
  StoredIssuerRequest,
} from '../application/ports/issuer-request.repository';
import type { IssuerRequestState } from '../domain/issuer-request';
import {
  DOCUMENT_INCLUDE,
  toDate,
  toDocument,
  toInstant,
} from './prisma-seller-certificate.repository';

/** One open request per seller and type (Hassan L2): the unique partial index of the migration. */
const UNIQUE_OPEN_REQUEST = 'issuer_requests_market_id_seller_id_type_id_open_key';

/**
 * {@link IssuerRequestRepository} on `certification.issuer_requests` and its files (data design
 * 3.8). Every method runs in the open unit of its caller. The answer moves the request with one
 * guarded `updateMany` on (id, version, state open), so a stale or second answer writes nothing;
 * the `issuer_requests_answer_once` trigger is the database's backstop. Nothing here reads or
 * writes `issuers` beyond the foreign key of an answer, a draft or a submission.
 */
export class PrismaIssuerRequestRepository implements IssuerRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    request: NewIssuerRequest,
  ): Promise<'issuer-request.already-open' | null> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    // The request row first: a second open request of the seller and type stops here, before the
    // file row (the caller's unit rolls back on the refusal either way).
    try {
      await tx.certificationIssuerRequest.create({
        data: {
          ...base,
          id: request.id,
          sellerId: request.sellerId,
          typeId: request.typeId,
          typedNameCiphertext: request.typedNameCiphertext,
          state: 'open',
          version: 1,
          createdAt: toDate(request.now),
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_OPEN_REQUEST) {
        return 'issuer-request.already-open';
      }
      throw error;
    }
    await tx.certificationUploadedDocument.create({
      data: {
        ...base,
        id: request.document.id,
        ownerSellerId: request.sellerId,
        purpose: 'issuer-request',
        typeId: request.typeId,
        state: 'clean',
        mediaType: request.document.mediaType,
        byteSize: BigInt(request.document.byteSize),
        pageCount: request.document.pageCount,
        dataKeyEnvelope: request.document.dataKeyEnvelope,
        objectKey: request.document.objectKey,
        cleanSha256: Uint8Array.from(request.document.cleanSha256),
        version: 1,
        createdAt: toDate(request.now),
      },
      select: { id: true },
    });
    await tx.certificationIssuerRequestDocument.create({
      data: {
        ...base,
        issuerRequestId: request.id,
        typeId: request.typeId,
        sellerId: request.sellerId,
        documentId: request.document.id,
        position: 1,
      },
      select: { documentId: true },
    });
    return null;
  }

  async hasOpen(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    typeId: Id<'CertificationType'>,
  ): Promise<boolean> {
    const row = await this.prisma.tx(market).certificationIssuerRequest.findFirst({
      where: { marketId: market.marketId, sellerId, typeId, state: 'open' },
      select: { id: true },
    });
    return row !== null;
  }

  async openQueue(market: MarketContext, cap: number): Promise<readonly IssuerRequestQueueEntry[]> {
    const rows = await this.prisma.tx(market).certificationIssuerRequest.findMany({
      where: { marketId: market.marketId, state: 'open' },
      select: {
        id: true,
        sellerId: true,
        version: true,
        createdAt: true,
        type: { select: { code: true } },
        _count: { select: { documents: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: cap,
    });
    return rows.map((row) => ({
      id: row.id as Id<'IssuerRequest'>,
      sellerId: row.sellerId as Id<'Seller'>,
      typeCode: row.type.code,
      version: row.version,
      documentCount: row._count.documents,
      createdAt: toInstant(row.createdAt),
    }));
  }

  async find(market: MarketContext, id: Id<'IssuerRequest'>): Promise<StoredIssuerRequest | null> {
    const row = await this.prisma.tx(market).certificationIssuerRequest.findFirst({
      where: { marketId: market.marketId, id },
      include: {
        type: { select: { code: true } },
        documents: {
          include: { document: { include: DOCUMENT_INCLUDE } },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'IssuerRequest'>,
      sellerId: row.sellerId as Id<'Seller'>,
      typeId: row.typeId as Id<'CertificationType'>,
      typeCode: row.type.code,
      typedNameCiphertext: row.typedNameCiphertext,
      state: row.state as IssuerRequestState,
      answerReasonCode: row.answerReasonCode,
      issuerId: row.issuerId as Id<'Issuer'> | null,
      answeredAt: row.answeredAt === null ? null : toInstant(row.answeredAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
      documents: row.documents.map((link) => toDocument(link.document, link.position)),
    };
  }

  async answer(market: MarketContext, write: IssuerRequestAnswerWrite): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationIssuerRequest.updateMany({
      where: {
        marketId: market.marketId,
        id: write.id,
        version: write.expectedVersion,
        state: 'open',
      },
      data: {
        state: write.outcome,
        issuerId: write.issuerId,
        answerReasonCode: write.reasonCode,
        answeredAt: toDate(write.answeredAt),
        answeredByAccountId: write.accountId,
        version: write.expectedVersion + 1,
      },
    });
    if (count !== 1) throw new StaleAggregateError('issuer-request', write.id);
  }

  async notice(
    market: MarketContext,
    id: Id<'IssuerRequest'>,
  ): Promise<IssuerRequestNotice | null> {
    const row = await this.prisma.tx(market).certificationIssuerRequest.findFirst({
      where: { marketId: market.marketId, id },
      select: {
        sellerId: true,
        state: true,
        answerReasonCode: true,
        type: { select: { code: true } },
      },
    });
    return row === null
      ? null
      : {
          sellerId: row.sellerId as Id<'Seller'>,
          typeCode: row.type.code,
          state: row.state as IssuerRequestState,
          answerReasonCode: row.answerReasonCode,
        };
  }
}
