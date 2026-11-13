import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { demoteMembership, type SellerCultureState } from '../../domain/seller-culture';
import { announce } from '../cultures/seller-culture-views';
import type { CultureDirectory } from '../ports/culture-directory';
import type { SellerCertificateDirectory } from '../ports/seller-certificate-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';

export interface RecheckCultureCertificatesInput {
  readonly sellerId: unknown;
}

export interface RecheckCultureCertificatesResult {
  /** Approvals taken back to `requested` because the certificate of the type is no longer valid. */
  readonly demoted: number;
}

export type RecheckCultureCertificatesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** A culture or the certificate state could not be read, or a write failed: retry. */
  | { readonly code: 'sellers.unavailable' };

export interface RecheckCultureCertificatesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly certificateDirectory: SellerCertificateDirectory;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `sellers.recheck-culture-certificates` (multi-culture package 3a; ADR-0048 security review M2):
 * after one of the seller's certificates expired or was revoked, every `approved` membership of the
 * seller in a culture with a required certification type is checked against the seller's valid
 * certificates now; one whose type the seller no longer holds a valid certificate of goes back to
 * `requested` (guarded on its version, one `sellers.seller-culture-status-changed.v1` each), and a
 * reviewer decides it again. The event says which seller; the type is re-read rather than trusted,
 * so a renewal approved in between (the seller holds another valid certificate of the type) keeps
 * the approval, and a repeated or late delivery converges. Rule `system` (the handler of
 * certification's events). A failed read or write is `sellers.unavailable`: the delivery is
 * retried. The visibility rule checks the certificate at read time as well (fail closed), so this
 * is the durable half of M2, not the only one.
 */
export class RecheckCultureCertificates extends UseCase<
  RecheckCultureCertificatesInput,
  RecheckCultureCertificatesResult,
  RecheckCultureCertificatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.recheck-culture-certificates',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecheckCultureCertificates');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RecheckCultureCertificatesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecheckCultureCertificatesInput,
  ): Promise<Result<RecheckCultureCertificatesResult, RecheckCultureCertificatesFailure>> {
    const id = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (id === null || !id.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
    }
    const result = await recheckSellerCultures(this.deps, context, id.value);
    this.#logger.log({
      msg: 'sellers.culture-certificates-rechecked',
      code: result.ok ? 'rechecked' : result.error.code,
      demoted: result.ok ? result.value.demoted : 0,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}

/**
 * The body of the re-check for one seller (shared with the re-check of a derecognised issuer's
 * sellers): the seller's `approved` memberships in certified cultures whose type the seller no
 * longer holds a valid certificate of go back to `requested`.
 */
export async function recheckSellerCultures(
  deps: RecheckCultureCertificatesDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<RecheckCultureCertificatesResult, RecheckCultureCertificatesFailure>> {
  const { market } = context;
  const unavailable = err({ code: 'sellers.unavailable' } as const);
  let approved: readonly SellerCultureState[];
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellerCultures.forSeller(market, sellerId)),
      { readOnly: true },
    );
    if (!read.ok) return unavailable;
    approved = read.value.filter((row) => row.status === 'approved');
  } catch {
    return unavailable;
  }
  if (approved.length === 0) return ok({ demoted: 0 });

  const cultures = await deps.cultureDirectory.byIds(
    context,
    approved.map((row) => row.cultureId),
  );
  if (!cultures.ok) return unavailable;
  const certified = approved.flatMap((row) => {
    const type = cultures.value.get(row.cultureId)?.requiredCertificationType ?? null;
    return type === null ? [] : [{ row, type }];
  });
  if (certified.length === 0) return ok({ demoted: 0 });

  const valid = await deps.certificateDirectory.validTypeCodes(context, sellerId, [
    ...new Set(certified.map(({ type }) => type)),
  ]);
  if (!valid.ok) return unavailable;
  const lapsed = certified.filter(({ type }) => !valid.value.has(type)).map(({ row }) => row);
  if (lapsed.length === 0) return ok({ demoted: 0 });

  try {
    const written = await deps.unitOfWork.run<number, never>(market, async () => {
      const at = deps.clock.now();
      let moved = 0;
      for (const state of lapsed) {
        const next = demoteMembership(state, at);
        const won = await deps.sellerCultures.transition(market, next, {
          version: state.version,
          status: 'approved',
        });
        // Lost: the row changed since (a reviewer or another delivery acted); the next event or
        // the read-time check covers it.
        if (!won) continue;
        await announce(deps.outbox, context, next);
        moved += 1;
      }
      return ok(moved);
    });
    return written.ok ? ok({ demoted: written.value }) : unavailable;
  } catch {
    return unavailable;
  }
}
