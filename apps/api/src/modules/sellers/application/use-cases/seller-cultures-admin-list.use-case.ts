import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_FILE_REVIEW } from '../../contracts/permissions';
import type { SellerCultureState } from '../../domain/seller-culture';
import {
  viewOf,
  type CertificateState,
  type SellerCultureView,
} from '../cultures/seller-culture-views';
import type { CultureDirectory } from '../ports/culture-directory';
import type { SellerCertificateDirectory } from '../ports/seller-certificate-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

export interface SellerCulturesAdminListInput {
  readonly sellerId?: unknown;
}

export type SellerCulturesAdminListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface SellerCulturesAdminListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
  readonly certificateDirectory: SellerCertificateDirectory;
}

/**
 * `sellers.seller-cultures-admin-list` (multi-culture package 2; screen A5): a reviewer's list of
 * one seller's culture memberships, each with its status, reason and, for a culture with a required
 * certification type, whether the seller holds a valid certificate of it (`certificate`, and
 * `needsCertificate` for "Needs a valid <certificate> certificate"). Rule `permissions
 * [sellers.seller-file.review]`, admin population only. An unknown seller and another Market's
 * seller are both `file.not-found`. If the certificate cannot be read, the list still answers with
 * `certificate: 'unavailable'` (the approval itself fails closed). One read-only unit, then
 * the directory calls outside it.
 */
export class SellerCulturesAdminList extends UseCase<
  SellerCulturesAdminListInput,
  { readonly cultures: readonly SellerCultureView[] },
  SellerCulturesAdminListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-cultures-admin-list',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_FILE_REVIEW.key] },
  };

  readonly #logger = new Logger('SellerCulturesAdminList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCulturesAdminListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCulturesAdminListInput,
  ): Promise<
    Result<{ readonly cultures: readonly SellerCultureView[] }, SellerCulturesAdminListFailure>
  > {
    const result = await this.list(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.seller-cultures-admin-list',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: SellerCulturesAdminListInput,
  ): Promise<
    Result<{ readonly cultures: readonly SellerCultureView[] }, SellerCulturesAdminListFailure>
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;

    let states: readonly SellerCultureState[] | null;
    try {
      const read = await this.deps.unitOfWork.run<readonly SellerCultureState[] | null, never>(
        market,
        async () => {
          if (!(await this.deps.files.existingIds(market, [sellerId])).has(sellerId)) {
            return ok(null);
          }
          return ok(await this.deps.sellerCultures.forSeller(market, sellerId));
        },
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'sellers.unavailable' });
      states = read.value;
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    if (states === null) return err({ code: 'file.not-found' });

    const info = await this.deps.cultureDirectory.byIds(
      context,
      states.map((s) => s.cultureId),
    );
    if (!info.ok) return err({ code: 'sellers.unavailable' });
    const asked = [
      ...new Set(
        states.flatMap((s) => {
          const type = info.value.get(s.cultureId)?.requiredCertificationType ?? null;
          return s.status === 'requested' && type !== null ? [type] : [];
        }),
      ),
    ];
    const held =
      asked.length > 0
        ? await this.deps.certificateDirectory.validTypeCodes(context, sellerId, asked)
        : null;
    return ok({
      cultures: states.map((state) => {
        const culture = info.value.get(state.cultureId);
        const required = culture?.requiredCertificationType ?? null;
        let certificate: CertificateState = 'not-required';
        if (required !== null) {
          if (held === null || !held.ok) certificate = 'unavailable';
          else certificate = held.value.has(required) ? 'held' : 'missing';
        }
        return viewOf(state, culture, certificate);
      }),
    });
  }
}
