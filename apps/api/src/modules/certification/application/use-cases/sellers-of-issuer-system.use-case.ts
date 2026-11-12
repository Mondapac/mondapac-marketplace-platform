import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CertificationRegistryRepository } from '../ports/registry.repository';

export interface SellersOfIssuerInput {
  readonly issuerId: unknown;
  readonly afterSellerId: unknown;
  readonly limit: unknown;
}

export type SellersOfIssuerFailure =
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface SellersOfIssuerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly registry: CertificationRegistryRepository;
}

/** The largest page of one call. */
export const SELLERS_OF_ISSUER_MAX_PAGE = 200;

/**
 * `certification.sellers-of-issuer-system` (multi-culture package 3a; ADR-0048 security review M3):
 * one page, in seller id order after `afterSellerId`, of the sellers holding an approved certificate
 * whose approved submission names the issuer (the same read as the derecognition mail). Seller ids
 * only. Rule `system`: the sellers handler of `certification.issuer-deactivated.v1` re-checks those
 * sellers' certified memberships. One read-only unit; a failed read is `access.unavailable`.
 */
export class SellersOfIssuerSystem extends UseCase<
  SellersOfIssuerInput,
  readonly Id<'Seller'>[],
  SellersOfIssuerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.sellers-of-issuer-system',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SellersOfIssuerSystem');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellersOfIssuerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellersOfIssuerInput,
  ): Promise<Result<readonly Id<'Seller'>[], SellersOfIssuerFailure>> {
    const body = typeof input === 'object' && input !== null ? input : null;
    const issuer = typeof body?.issuerId === 'string' ? parseId<'Issuer'>(body.issuerId) : null;
    if (issuer === null || !issuer.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'issuerId', code: 'format' }] });
    }
    let after: Id<'Seller'> | null = null;
    if (body?.afterSellerId !== null && body?.afterSellerId !== undefined) {
      const parsed =
        typeof body.afterSellerId === 'string' ? parseId<'Seller'>(body.afterSellerId) : null;
      if (parsed === null || !parsed.ok) {
        return err({
          code: 'validation.failed',
          fields: [{ path: 'afterSellerId', code: 'format' }],
        });
      }
      after = parsed.value;
    }
    const limit = body?.limit;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SELLERS_OF_ISSUER_MAX_PAGE
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(await this.deps.registry.affectedSellers(market, issuer.value, after, limit)),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      return ok(read.value);
    } catch (error) {
      this.#logger.error({
        msg: 'certification.sellers-of-issuer',
        errorName: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
  }
}
