import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SellerFile } from '../../domain/seller-file';
import type { RegisteredSellerSource } from '../ports/registered-seller-source';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/** Sellers per page of `identity`'s id paging (R-6 allows up to 500). */
export const BACKFILL_PAGE_SIZE = 100;

export interface BackfillSellerFilesOutput {
  /** Files this run created. */
  readonly created: number;
  /** Registered sellers that already had a file. */
  readonly existing: number;
  /** Sellers whose file could not be created in this run; the next run tries again. */
  readonly failed: number;
}

export type BackfillSellerFilesFailure = { readonly code: 'access.denied' };

export interface BackfillSellerFilesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly registered: RegisteredSellerSource;
  readonly clock: Clock;
}

/**
 * The deploy-time backfill that only creates missing files (sellers design 14.3 Q-M4; slice 1).
 * Rule `system`, run per hosted Market at worker start and then daily
 * (`sellers.backfill-files`). It pages the registered sellers of `identity` by id (R-6), reads
 * which already have a file in one read-only unit per page, and creates each missing one in a
 * unit of its own, exactly as the handler does: `approvalRequiredAtRegistration` takes the
 * Market's value at backfill time, which is the only value that can be known for them. It never
 * changes or removes an existing file, and it never approves anyone: a seller `identity`
 * already reports `approved` gets a file with no approved revision and stays not eligible to
 * sell (Ali change 1).
 *
 * Safe to run twice and concurrently: the primary key converges. One seller's failure is
 * counted and logged by id, never fatal for the others.
 */
export class BackfillSellerFiles extends UseCase<
  Record<string, never>,
  BackfillSellerFilesOutput,
  BackfillSellerFilesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.backfill-seller-files',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('BackfillSellerFiles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BackfillSellerFilesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<BackfillSellerFilesOutput, BackfillSellerFilesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, outbox, registered, clock } = this.deps;

    let created = 0;
    let existing = 0;
    let failed = 0;
    let after: Id<'Seller'> | null = null;
    for (;;) {
      const page = await registered.page(context, after, BACKFILL_PAGE_SIZE);
      if (page.items.length > 0) {
        const known = await unitOfWork.run(
          market,
          async () =>
            ok(
              await files.existingIds(
                market,
                page.items.map((item) => item.sellerId),
              ),
            ),
          { readOnly: true },
        );
        if (!known.ok) throw new Error('backfill-seller-files: the read unit failed');
        for (const item of page.items) {
          if (known.value.has(item.sellerId)) {
            existing += 1;
            continue;
          }
          try {
            const done = await unitOfWork.run(market, async () => {
              const file = SellerFile.create({
                sellerId: item.sellerId,
                marketId: market.marketId,
                origin: item.origin,
                approvalRequiredAtRegistration: policy.approvalRequired(market),
                now: clock.now(),
              });
              const added = await files.addWithRoots(market, file);
              if (added) await outbox.append(context, file.pendingEvents);
              return ok(added);
            });
            if (!done.ok) throw new Error('the unit failed');
            if (done.value) created += 1;
            else existing += 1;
          } catch (error) {
            failed += 1;
            this.#logger.error({
              msg: 'sellers.backfill-seller-files.failed',
              sellerId: item.sellerId,
              error: error instanceof Error ? error.name : 'unknown',
              marketId: market.marketId,
              correlationId: context.correlationId,
            });
          }
        }
      }
      // A page that does not advance would loop for ever.
      if (page.next === null || page.next === after) break;
      after = page.next;
    }
    return ok({ created, existing, failed });
  }
}
