import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SellerFile, type SellerFileOrigin } from '../../domain/seller-file';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/** One delivery of `identity.seller-registered.v1` (sellers design 7.5). */
export interface CreateSellerFileInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id;
  readonly origin: SellerFileOrigin;
}

export type CreateSellerFileOutput =
  | { readonly code: 'seller-file.created' }
  | { readonly code: 'seller-file.exists' }
  | { readonly code: 'seller-file.already-handled' };

export type CreateSellerFileFailure = { readonly code: 'access.denied' };

export interface CreateSellerFileDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * The handler `sellers.create-file` (sellers design 7.5; SEL-02; slice 1). Rule `system`, from
 * the subscription on `identity.seller-registered.v1`. In one unit, through `runOnce`, it
 * creates the `SellerFile` with its admin settings (all types, proposals off, AI off), tax
 * profile and store profile under the id `identity` minted, records
 * `approvalRequiredAtRegistration` from the Market policy read in this unit, and appends
 * `sellers.seller-file-created.v1`. Never in `identity`'s transaction (ADR-0004 decision 5).
 *
 * Idempotent twice over: the inbox skips an event this handler already handled, and the primary
 * key makes a file that the backfill created first a no-op (`seller-file.exists`). A policy that
 * cannot be read throws, so the unit commits nothing and the delivery is retried: no value is
 * ever recorded that was not read. No log line holds more than ids, codes and counts.
 */
export class CreateSellerFile extends UseCase<
  CreateSellerFileInput,
  CreateSellerFileOutput,
  CreateSellerFileFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.create-seller-file',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CreateSellerFile');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CreateSellerFileDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CreateSellerFileInput,
  ): Promise<Result<CreateSellerFileOutput, CreateSellerFileFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, outbox, clock } = this.deps;

    const handled = await unitOfWork.runOnce(market, input.delivery, async () => {
      const file = SellerFile.create({
        sellerId: input.sellerId as Id<'Seller'>,
        marketId: market.marketId,
        origin: input.origin,
        approvalRequiredAtRegistration: policy.approvalRequired(market),
        now: clock.now(),
      });
      const created = await files.addWithRoots(market, file);
      if (created) await outbox.append(context, file.pendingEvents, input.delivery.eventId);
      return ok(created);
    });
    if (!handled.ok) throw new Error('create-seller-file: the unit failed');

    const output: CreateSellerFileOutput = !handled.value.handled
      ? { code: 'seller-file.already-handled' }
      : handled.value.value
        ? { code: 'seller-file.created' }
        : { code: 'seller-file.exists' };
    this.#logger.log({
      msg: `sellers.${output.code}`,
      sellerId: input.sellerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
