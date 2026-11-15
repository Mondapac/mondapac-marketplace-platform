import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  DocumentKindCounts,
  DocumentListFilter,
  DocumentListRecord,
  DocumentSort,
} from '../../domain/admin-document-list';

export const ADMIN_DOCUMENT_LIST_READER = Symbol('ADMIN_DOCUMENT_LIST_READER');

/**
 * The read side of the admin Invoices list: paid seller orders (order confirmations) and credit
 * notes, one kind per read. Every method runs in the open read unit of the use case, through the
 * Market-scoped client, and only ever sees the Market's own rows.
 */
export interface AdminDocumentListReader {
  page(
    market: MarketContext,
    filter: DocumentListFilter,
    sort: DocumentSort,
    offset: number,
    limit: number,
  ): Promise<readonly DocumentListRecord[]>;
  count(market: MarketContext, filter: DocumentListFilter): Promise<number>;
  countByKind(market: MarketContext): Promise<DocumentKindCounts>;
}
