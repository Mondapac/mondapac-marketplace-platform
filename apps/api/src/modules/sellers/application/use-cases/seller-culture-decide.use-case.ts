import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_FILE_REVIEW } from '../../contracts/permissions';
import {
  decideMembership,
  parseDecision,
  type CultureFieldProblem,
  type SellerCultureState,
} from '../../domain/seller-culture';
import { announce, viewOf, type SellerCultureView } from '../cultures/seller-culture-views';
import type { CultureDirectory, CultureInfo } from '../ports/culture-directory';
import type { SellerCertificateDirectory } from '../ports/seller-certificate-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** The seller and culture from the path, and the body `{ decision, reason? }` as it came. */
export interface SellerCultureDecideInput {
  readonly sellerId?: unknown;
  readonly cultureId?: unknown;
  readonly body?: unknown;
}

export type SellerCultureDecideFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'culture.membership-not-found' }
  | { readonly code: 'culture.not-requested' }
  | { readonly code: 'culture.not-active' }
  /** The seller holds no valid certificate of the type; the UI shows "Needs a valid <type> certificate". */
  | { readonly code: 'culture.certificate-required'; readonly requiredCertificationType: string }
  | { readonly code: 'culture.certificate-unavailable' }
  | { readonly code: 'sellers.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly CultureFieldProblem[] };

export interface SellerCultureDecideDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly certificateDirectory: SellerCertificateDirectory;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `sellers.seller-culture-decide` (multi-culture package 2; ADR-0047 decisions 3 and 12; screen
 * A5): a reviewer approves or rejects a waiting request. Rule `permissions
 * [sellers.seller-file.review]` (the seller-review key), admin population only. A rejection needs a
 * reason of 1 to 300 characters. To approve, the culture must still be ACTIVE and, when it has a
 * required certification type, the seller must hold a valid (approved, unexpired) certificate of
 * that type, read through certification's contract before the write unit opens: no certificate is
 * `culture.certificate-required`, and a read that fails is `culture.certificate-unavailable` (fail
 * closed; the reviewer also needs `certification.seller-certificate.view`, as that contract
 * asks). The write is guarded by the state it read, so two reviewers deciding at once end in one
 * decision and one `culture.not-requested`. Every decision writes
 * `sellers.seller-culture-status-changed.v1`. The reviewer is never the AI (R2).
 */
export class SellerCultureDecide extends UseCase<
  SellerCultureDecideInput,
  { readonly culture: SellerCultureView },
  SellerCultureDecideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-culture-decide',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_FILE_REVIEW.key] },
  };

  readonly #logger = new Logger('SellerCultureDecide');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCultureDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCultureDecideInput,
  ): Promise<Result<{ readonly culture: SellerCultureView }, SellerCultureDecideFailure>> {
    const result = await this.decide(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.seller-culture-decide',
      code: result.ok ? result.value.culture.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async decide(
    context: CallContext,
    input: SellerCultureDecideInput,
  ): Promise<Result<{ readonly culture: SellerCultureView }, SellerCultureDecideFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    const culture =
      typeof input.cultureId === 'string' ? parseId<'Culture'>(input.cultureId) : null;
    if (culture === null || !culture.ok) return err({ code: 'culture.membership-not-found' });
    const cultureId = culture.value;
    const body = parseDecision(input.body);
    if (!body.ok) return err({ code: 'validation.failed', fields: body.error });

    const { unitOfWork, files, sellerCultures, outbox, clock } = this.deps;
    // Read the membership first (a read-only unit): the directory calls run outside any unit.
    let before: SellerCultureState | null;
    try {
      const read = await unitOfWork.run<SellerCultureState | 'no-file' | null, never>(
        market,
        async () => {
          if (!(await files.existingIds(market, [sellerId])).has(sellerId)) return ok('no-file');
          return ok(
            (await sellerCultures.among(market, sellerId, [cultureId])).get(cultureId) ?? null,
          );
        },
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'sellers.unavailable' });
      if (read.value === 'no-file') return err({ code: 'file.not-found' });
      before = read.value;
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    if (before === null) return err({ code: 'culture.membership-not-found' });
    if (before.status !== 'requested') return err({ code: 'culture.not-requested' });

    const info = await this.deps.cultureDirectory.byIds(context, [cultureId]);
    if (!info.ok) return err({ code: 'sellers.unavailable' });
    const found: CultureInfo | undefined = info.value.get(cultureId);
    if (body.value.decision === 'approve') {
      if (found === undefined || found.status !== 'active') {
        return err({ code: 'culture.not-active' });
      }
      const required = found.requiredCertificationType;
      if (required !== null) {
        const held = await this.deps.certificateDirectory.validTypeCodes(context, sellerId);
        if (!held.ok) return err({ code: 'culture.certificate-unavailable' });
        if (!held.value.has(required)) {
          return err({ code: 'culture.certificate-required', requiredCertificationType: required });
        }
      }
    }

    const next = decideMembership(before, {
      decision: body.value.decision,
      reason: body.value.reason,
      by: actor.accountId,
      at: clock.now(),
    });
    if (!next.ok) return err(next.error);
    try {
      return await unitOfWork.run<
        { readonly culture: SellerCultureView },
        SellerCultureDecideFailure
      >(market, async () => {
        const won = await sellerCultures.transition(market, next.value, {
          version: before.version,
          status: 'requested',
        });
        // Another reviewer decided first.
        if (!won) return err({ code: 'culture.not-requested' });
        await announce(outbox, context, next.value);
        return ok({ culture: viewOf(next.value, found) });
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
