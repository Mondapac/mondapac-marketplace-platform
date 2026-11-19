import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  parseCultureIds,
  requestMembership,
  type CultureFieldProblem,
} from '../../domain/seller-culture';
import { announce, viewOf, type SellerCultureView } from '../cultures/seller-culture-views';
import { sellerActorOf } from '../draft/draft-support';
import type { CultureDirectory } from '../ports/culture-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** `{ cultureIds }` as it came: one or more cultures (the signup step sends the whole list). */
export interface SellerCulturesRequestInput {
  readonly body?: unknown;
}

export interface RequestedCultureView extends SellerCultureView {
  /** What this request did: opened a request, opened a rejected one again, or changed nothing. */
  readonly outcome: 'requested' | 'requested-again' | 'unchanged';
}

export type SellerCulturesRequestFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly CultureFieldProblem[] };

export interface SellerCulturesRequestDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `sellers.seller-cultures-request` (multi-culture package 2; ADR-0047 decision 3; screen S1): the
 * acting seller asks to join one or more cultures at once (1 to 20 distinct ids). Rule
 * `own-resources`, allowed before approval; the seller is the actor's. Every culture must be ACTIVE
 * in the Market, asked through catalog's contract before the unit opens (any doubt refuses: fail
 * closed); one that is not refuses the whole request with its path (`cultureIds.N`,
 * `not-active`). Then one read-write unit: a new request is inserted, a rejected one is opened again,
 * a request that waits or an approved membership is left as it is (a retried signup is safe), and
 * every change writes `sellers.seller-culture-status-changed.v1`. Nothing here checks a
 * certificate: that is the reviewer's approval. A later culture is again a request. Two racing
 * requests for one pair end in one row and one event.
 */
export class SellerCulturesRequest extends UseCase<
  SellerCulturesRequestInput,
  { readonly cultures: readonly RequestedCultureView[] },
  SellerCulturesRequestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-cultures-request',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('SellerCulturesRequest');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCulturesRequestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCulturesRequestInput,
  ): Promise<
    Result<{ readonly cultures: readonly RequestedCultureView[] }, SellerCulturesRequestFailure>
  > {
    const result = await this.request(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.seller-cultures-request',
      code: result.ok ? 'requested' : result.error.code,
      changed: result.ok
        ? result.value.cultures.filter((c) => c.outcome !== 'unchanged').length
        : 0,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async request(
    context: CallContext,
    input: SellerCulturesRequestInput,
  ): Promise<
    Result<{ readonly cultures: readonly RequestedCultureView[] }, SellerCulturesRequestFailure>
  > {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const parsed = parseCultureIds(input.body);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
    const ids = parsed.value;

    // Catalog opens a read-only unit of its own, so no unit is open while asking.
    const known = await this.deps.cultureDirectory.byIds(context, ids);
    if (!known.ok) return err({ code: 'sellers.unavailable' });
    const fields: CultureFieldProblem[] = [];
    ids.forEach((id, index) => {
      if (known.value.get(id)?.status !== 'active') {
        fields.push({ path: `cultureIds.${index}`, code: 'not-active' });
      }
    });
    if (fields.length > 0) return err({ code: 'validation.failed', fields });

    const { market } = context;
    const { unitOfWork, files, sellerCultures, outbox, clock } = this.deps;
    try {
      return await unitOfWork.run<
        { readonly cultures: readonly RequestedCultureView[] },
        SellerCulturesRequestFailure
      >(market, async () => {
        if (!(await files.existingIds(market, [owner.sellerId])).has(owner.sellerId)) {
          return err({ code: 'file.not-found' });
        }
        const at = clock.now();
        const held = await sellerCultures.among(market, owner.sellerId, ids);
        const done: RequestedCultureView[] = [];
        for (const id of ids) {
          const culture = known.value.get(id)!;
          const before = held.get(id) ?? null;
          const outcome = requestMembership(before, {
            sellerId: owner.sellerId,
            cultureId: id,
            cultureCode: culture.code,
            by: owner.accountId,
            at,
          });
          let kind: RequestedCultureView['outcome'] = 'unchanged';
          let state = outcome.state;
          if (outcome.kind === 'changed') {
            const written =
              before === null
                ? await sellerCultures.insert(market, outcome.state)
                : await sellerCultures.transition(market, outcome.state, {
                    version: before.version,
                    status: 'rejected',
                  });
            if (written) {
              await announce(outbox, context, outcome.state);
              kind = outcome.reopened ? 'requested-again' : 'requested';
            } else {
              // Another request or decision won the race: show what is stored now.
              const now = (await sellerCultures.among(market, owner.sellerId, [id])).get(id);
              if (now === undefined) return err({ code: 'sellers.unavailable' });
              state = now;
            }
          }
          done.push({ ...viewOf(state, culture), outcome: kind });
        }
        return ok({ cultures: done });
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
