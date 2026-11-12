import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CulturesAttachedAtSignup } from '../../domain/audit';
import {
  approveAtSignup,
  parseSignupSelection,
  requestMembership,
  type CultureFieldProblem,
  type SellerCultureState,
} from '../../domain/seller-culture';
import { announce } from '../cultures/seller-culture-views';
import type { CultureDirectory, CultureInfo } from '../ports/culture-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** `cultures`: nothing or `universal` (all Active cultures), or an explicit list of codes. */
export interface ApplySignupCulturesInput {
  readonly sellerId: Id<'Seller'>;
  readonly cultures?: unknown;
}

export interface ApplySignupCulturesResult {
  /** Memberships created approved at once (cultures with no required certificate). */
  readonly approved: number;
  /** Memberships created requested (cultures with a required certificate; a reviewer decides). */
  readonly requested: number;
  /** Cultures the seller already had a membership in: left as they are. */
  readonly unchanged: number;
}

export type ApplySignupCulturesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly CultureFieldProblem[] };

export interface ApplySignupCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `sellers.apply-signup-cultures` (multi-culture package 2; ADR-0048 amending ADR-0047 decision 3):
 * attaches a new seller to the cultures it chose at signup. Rule `system`: from the subscription
 * on `identity.seller-registered.v1` (the default, "universal") and, through the sellers facade,
 * from any signup step that carries an explicit list. The selection is nothing or `universal` (every
 * ACTIVE culture of the Market now) or a list of 1 to 20 distinct codes, each an ACTIVE culture of
 * the Market (`validation.failed` with `cultures.N` `unknown-or-inactive`; an empty list is refused,
 * never read as "all"). A culture with no required certification type becomes approved at once (no
 * person decides; audited, event written); a culture with one becomes requested, and only a
 * reviewer approves it, with the seller's valid certificate (`sellers.seller-culture-decide`). A
 * membership the seller already has is left as it is, so a retried delivery is safe. No ACTIVE culture
 * means nothing is attached (logged, no failure). A directory that cannot answer is
 * `sellers.unavailable` and nothing is written (fail closed; the delivery is retried).
 */
export class ApplySignupCultures extends UseCase<
  ApplySignupCulturesInput,
  ApplySignupCulturesResult,
  ApplySignupCulturesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.apply-signup-cultures',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ApplySignupCultures');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ApplySignupCulturesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ApplySignupCulturesInput,
  ): Promise<Result<ApplySignupCulturesResult, ApplySignupCulturesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const result = await this.apply(context, input);
    this.#logger.log({
      msg: 'sellers.apply-signup-cultures',
      code: result.ok ? 'attached' : result.error.code,
      ...(result.ok ? result.value : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async apply(
    context: CallContext,
    input: ApplySignupCulturesInput,
  ): Promise<Result<ApplySignupCulturesResult, ApplySignupCulturesFailure>> {
    const selection = parseSignupSelection(input.cultures);
    if (!selection.ok) return err({ code: 'validation.failed', fields: selection.error });
    const { market } = context;

    // Catalog opens a read-only unit of its own, so no unit is open while asking.
    const active = await this.deps.cultureDirectory.active(context);
    if (!active.ok) return err({ code: 'sellers.unavailable' });
    let chosen: readonly CultureInfo[];
    if (selection.value.kind === 'universal') {
      chosen = active.value;
    } else {
      const byCode = new Map(active.value.map((c) => [c.code, c]));
      const fields: CultureFieldProblem[] = [];
      const found: CultureInfo[] = [];
      selection.value.codes.forEach((code, index) => {
        const culture = byCode.get(code);
        if (culture === undefined)
          fields.push({ path: `cultures.${index}`, code: 'unknown-or-inactive' });
        else found.push(culture);
      });
      if (fields.length > 0) return err({ code: 'validation.failed', fields });
      chosen = found;
    }
    if (chosen.length === 0) {
      this.#logger.warn({
        msg: 'sellers.apply-signup-cultures.no-active-culture',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok({ approved: 0, requested: 0, unchanged: 0 });
    }

    const { unitOfWork, files, sellerCultures, audit, outbox, clock } = this.deps;
    try {
      return await unitOfWork.run<ApplySignupCulturesResult, ApplySignupCulturesFailure>(
        market,
        async () => {
          if (!(await files.existingIds(market, [input.sellerId])).has(input.sellerId)) {
            return err({ code: 'file.not-found' });
          }
          const at = clock.now();
          const held = await sellerCultures.among(
            market,
            input.sellerId,
            chosen.map((c) => c.id),
          );
          const approved: Id<'Culture'>[] = [];
          const requested: Id<'Culture'>[] = [];
          let unchanged = 0;
          for (const culture of chosen) {
            if (held.has(culture.id)) {
              unchanged += 1;
              continue;
            }
            const request = {
              sellerId: input.sellerId,
              cultureId: culture.id,
              cultureCode: culture.code,
              by: null,
              at,
            };
            // Nothing becomes approved in a certified culture here (ADR-0048).
            let state: SellerCultureState;
            if (culture.requiredCertificationType === null) state = approveAtSignup(request);
            else {
              const made = requestMembership(null, request);
              state = made.state;
            }
            if (!(await sellerCultures.insert(market, state))) {
              unchanged += 1;
              continue;
            }
            await announce(outbox, context, state);
            (state.status === 'approved' ? approved : requested).push(culture.id);
          }
          if (approved.length + requested.length > 0) {
            await audit.record(
              context,
              CulturesAttachedAtSignup.entry(input.sellerId, {
                after: { approvedCultureIds: approved, requestedCultureIds: requested },
              }),
            );
          }
          return ok({ approved: approved.length, requested: requested.length, unchanged });
        },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
