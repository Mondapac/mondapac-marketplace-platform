import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { ownSellerOrderDocument, type DocumentFailure } from '../document-flow';
import type { OrderDocumentView } from '../../domain/order-document';

/** The most seller orders one bulk packing-slip request may name (phase 1 brief B1-3). */
export const MAX_BULK_DOCUMENTS = 50;

export interface SellerOrderDocumentsView {
  /** One document per readable, paid seller order, in the order asked (repeats dropped). */
  readonly documents: readonly OrderDocumentView[];
  /**
   * Ids that gave no document: not the shop's, unknown (the two look the same) or not paid.
   * The reason is only `not-available`, so a foreign id learns nothing.
   */
  readonly unavailable: readonly string[];
}

type Input = { readonly sellerOrderIds: unknown };

/**
 * The documents of several of the seller's own paid orders at once, for printing packing slips
 * from a selection. Every id goes through the single-order read, so ownership and the numbering
 * switch are that read's; this adds only the cap and the per-id outcome.
 */
export class SellerViewOrderDocuments extends UseCase<
  Input,
  SellerOrderDocumentsView,
  DocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-view-order-documents',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<SellerOrderDocumentsView, DocumentFailure>> {
    const ids = input?.sellerOrderIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DOCUMENTS) {
      return err({
        code: 'validation.failed',
        fields: [
          {
            path: 'sellerOrderIds',
            code: ids === undefined ? 'required' : Array.isArray(ids) ? 'size' : 'type',
          },
        ],
      });
    }
    const unique = [...new Set(ids.map((id: unknown) => (typeof id === 'string' ? id : '')))];
    // Every id is checked before the first read: a bad one costs nothing.
    if (unique.some((id) => !parseId<'SellerOrder'>(id)?.ok)) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'sellerOrderIds', code: 'format' }],
      });
    }
    const documents: OrderDocumentView[] = [];
    const unavailable: string[] = [];
    for (const id of unique) {
      const read = await ownSellerOrderDocument(this.deps, context, { sellerOrderId: id });
      if (read.ok) {
        documents.push(read.value);
      } else if (
        read.error.code === 'ordering.seller-order-not-found' ||
        read.error.code === 'ordering.document-not-available'
      ) {
        unavailable.push(id);
      } else {
        // A malformed id, a refusal or the numbering switch ends the whole request.
        return read.error.code === 'validation.failed'
          ? err({
              code: 'validation.failed',
              fields: [{ path: 'sellerOrderIds', code: 'format' }],
            })
          : err(read.error);
      }
    }
    return ok({ documents, unavailable });
  }
}
