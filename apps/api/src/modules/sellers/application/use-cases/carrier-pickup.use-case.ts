import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  CarrierPickup,
  SellerDetailsNotFound,
  SellersUnavailable,
  SellersValidationFailed,
} from '../../contracts/sellers.facade';
import { PickupDetailsReadForCarrier } from '../../domain/audit';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { RevisionContentSealer } from '../ports/revision-content-sealer';

export interface CarrierPickupInput {
  readonly sellerId?: unknown;
  readonly sellerOrderId?: unknown;
}

export type CarrierPickupFailure =
  SellersValidationFailed | SellerDetailsNotFound | SellersUnavailable;

export interface CarrierPickupDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
  readonly sealer: RevisionContentSealer;
  readonly audit: AuditWriter;
}

/**
 * `carrierPickup` (SHP-02/03): the store name, phone and operating address of a seller's
 * **approved** revision, in clear, for shipping to hand to the real-time carrier as the pickup of
 * one paid seller order. Rule `system`. The same audited decrypting read as the reviewer's
 * (design 9): the sealed content is read in a read-only unit, opened outside any unit and checked
 * against the revision's keyed hash; only then does a read-write unit write the
 * `sellers.pickup-details.read-for-carrier` row with the seller order id, and a refused row
 * means nothing is returned. Only the store name, the phone and the operating address leave: no
 * legal name, email, registered address or identifier. Clear content never reaches a log, an
 * event or an audit row.
 */
export class CarrierPickupRead extends UseCase<
  CarrierPickupInput,
  CarrierPickup,
  CarrierPickupFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.carrier-pickup',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CarrierPickup');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CarrierPickupDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CarrierPickupInput,
  ): Promise<Result<CarrierPickup, CarrierPickupFailure>> {
    const result = await this.read(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.carrier-pickup',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: CarrierPickupInput,
  ): Promise<Result<CarrierPickup, CarrierPickupFailure>> {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    const order =
      typeof input.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
    if (parsed === null || !parsed.ok || order === null || !order.ok) {
      return err({
        code: 'validation.failed',
        fields: [
          ...(parsed === null || !parsed.ok ? [{ path: 'sellerId', code: 'format' }] : []),
          ...(order === null || !order.ok ? [{ path: 'sellerOrderId', code: 'format' }] : []),
        ],
      });
    }
    const sellerId = parsed.value;
    const { market } = context;
    const { unitOfWork, revisions, sealer, audit } = this.deps;
    try {
      const loaded = await unitOfWork.run(
        market,
        async () => {
          const revision = await revisions.findApproved(market, sellerId);
          if (revision === null) return ok(null);
          const sealed = await revisions.readSealedContent(market, sellerId, revision.id);
          if (sealed === null) throw new Error('carrier-pickup: no sealed content');
          return ok({ revision, sealed });
        },
        { readOnly: true },
      );
      if (!loaded.ok) return err({ code: 'sellers.unavailable' });
      if (loaded.value === null) return err({ code: 'seller.details-not-found' });
      const { revision, sealed } = loaded.value;

      const opened = await sealer.open(market, sellerId, sealed);
      if (!opened.ok) return this.refuse(market.marketId, revision.id, 'open-failed');
      const hashed = await sealer.hash(market, sellerId, opened.value);
      if (!hashed.ok || hashed.value !== revision.contentHash) {
        return this.refuse(market.marketId, revision.id, 'content-hash-mismatch');
      }

      // The audit row, in a unit of the read: refused, nothing is returned (design 9).
      const written = await unitOfWork.run(market, async () => {
        await audit.record(
          context,
          PickupDetailsReadForCarrier.entry(sellerId, {
            after: { revisionId: revision.id, sellerOrderId: order.value },
          }),
        );
        return ok(undefined);
      });
      if (!written.ok) return err({ code: 'sellers.unavailable' });

      const content = opened.value;
      return ok({
        sellerId,
        storeName: content.storeName,
        phone: content.phone,
        operatingAddress: content.address,
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }

  /** A fixed, personal-data-free reason: a hash mismatch may mean tampering. */
  private refuse(
    marketId: string,
    revisionId: string,
    reason: 'open-failed' | 'content-hash-mismatch',
  ): Result<never, SellersUnavailable> {
    this.#logger.warn({
      msg: 'sellers.carrier-pickup-refused',
      reason,
      revisionId,
      marketId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}
