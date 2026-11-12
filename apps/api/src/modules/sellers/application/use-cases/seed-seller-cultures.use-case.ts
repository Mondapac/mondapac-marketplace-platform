import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { ApplySignupCultures } from './apply-signup-cultures.use-case';

/** Sellers attached per run, so a first run on a large Market stays short; the daily run continues. */
export const SEED_SELLER_CULTURES_BATCH = 200;

export interface SeedSellerCulturesResult {
  /** Sellers that had no culture and were given the "universal" treatment by this run. */
  readonly attached: number;
  /** Sellers left for the next run (the batch was full, or a seller's attach failed). */
  readonly remaining: boolean;
}

export type SeedSellerCulturesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface SeedSellerCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly applySignup: ApplySignupCultures;
}

/**
 * `sellers.seed-seller-cultures` (multi-culture package 2; ADR-0048): the one-time attach of sellers
 * that predate the signup rule (the test and demo seed, and any seller registered before this
 * release). Rule `system`, run per hosted Market at worker start and then daily, like
 * `catalog.seed-cultures`. Each seller with no membership row at all gets exactly what a new seller
 * gets ("universal": approved in every Active culture with no required certificate, requested in
 * the others, so a certified culture is approved only by a reviewer with a valid certificate). It
 * only ever adds: a seller with any row is skipped, so a rejection or a later change is never
 * undone. With no Active culture yet nothing happens and the next run converges.
 */
export class SeedSellerCultures extends UseCase<
  Record<string, never>,
  SeedSellerCulturesResult,
  SeedSellerCulturesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seed-seller-cultures',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedSellerCultures');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedSellerCulturesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedSellerCulturesResult, SeedSellerCulturesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    let sellerIds;
    try {
      const read = await this.deps.unitOfWork.run<
        Awaited<ReturnType<SellerCultureRepository['sellerIdsWithoutCultures']>>,
        never
      >(
        market,
        async () =>
          ok(
            await this.deps.sellerCultures.sellerIdsWithoutCultures(
              market,
              SEED_SELLER_CULTURES_BATCH,
            ),
          ),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'sellers.unavailable' });
      sellerIds = read.value;
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    let attached = 0;
    let failed = false;
    for (const sellerId of sellerIds) {
      const done = await this.deps.applySignup.execute(context, { sellerId });
      if (done.ok) attached += 1;
      else failed = true;
    }
    const result = {
      attached,
      remaining: failed || sellerIds.length === SEED_SELLER_CULTURES_BATCH,
    };
    this.#logger.log({
      msg: 'sellers.seed-seller-cultures',
      ...result,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(result);
  }
}
