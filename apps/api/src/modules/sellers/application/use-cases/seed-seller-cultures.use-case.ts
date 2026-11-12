import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { ApplySignupCultures } from './apply-signup-cultures.use-case';

/** Sellers read per batch, and batches per run: a run touches at most 2 000 sellers; the daily run continues. */
export const SEED_SELLER_CULTURES_BATCH = 200;
export const SEED_SELLER_CULTURES_MAX_BATCHES = 10;

export interface SeedSellerCulturesResult {
  /** Sellers that had no culture and were given the "universal" treatment by this run. */
  readonly attached: number;
  /** Sellers read but not attached: rejected, suspended, or unknown to identity. */
  readonly skipped: number;
  /** Sellers whose attach failed (retried by the next run). */
  readonly failed: number;
  /** The run stopped at its cap with more sellers still to read; the next run continues. */
  readonly remaining: boolean;
}

export type SeedSellerCulturesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface SeedSellerCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly accessReader: SellerAccessReader;
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
 * undone. Only sellers whose access is pending or approved are attached (not rejected, suspended
 * or unknown). It reads up to 10 batches of 200 by seller id with a cursor, so a seller that fails
 * is passed over instead of stalling the backlog; a rejected or suspended seller stays in the
 * roster and is passed over on every run (at most 2 000 are read per run). With no Active culture yet nothing happens and the next run converges.
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
    const { unitOfWork, sellerCultures, accessReader, applySignup } = this.deps;
    let attached = 0;
    let skipped = 0;
    let failed = 0;
    let remaining = false;
    let cursor: Id<'Seller'> | undefined;
    for (let batch = 0; batch < SEED_SELLER_CULTURES_MAX_BATCHES; batch += 1) {
      let sellerIds: readonly Id<'Seller'>[];
      try {
        const read = await unitOfWork.run<readonly Id<'Seller'>[], never>(
          market,
          async () =>
            ok(
              await sellerCultures.sellerIdsWithoutCultures(
                market,
                SEED_SELLER_CULTURES_BATCH,
                cursor,
              ),
            ),
          { readOnly: true },
        );
        if (!read.ok) return err({ code: 'sellers.unavailable' });
        sellerIds = read.value;
      } catch {
        return err({ code: 'sellers.unavailable' });
      }
      if (sellerIds.length === 0) break;
      // The cursor moves past every seller read, so one that fails (or is skipped) is not asked
      // again first on every batch of the run.
      cursor = sellerIds[sellerIds.length - 1];
      remaining = sellerIds.length === SEED_SELLER_CULTURES_BATCH;
      // Only a seller whose access is pending (onboarding) or approved (active) is attached; a
      // rejected or suspended one, or one identity does not know or cannot answer for, is not
      // (security review L2, fail closed).
      let access;
      try {
        access = await accessReader.accessOfMany(context, sellerIds);
      } catch {
        failed += sellerIds.length;
        continue;
      }
      for (const sellerId of sellerIds) {
        const state = access.get(sellerId);
        if (state !== 'pending' && state !== 'approved') {
          skipped += 1;
          continue;
        }
        const done = await applySignup.execute(context, { sellerId });
        if (done.ok) attached += 1;
        else failed += 1;
      }
    }
    const result = { attached, skipped, failed, remaining };
    this.#logger.log({
      msg: 'sellers.seed-seller-cultures',
      ...result,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(result);
  }
}
