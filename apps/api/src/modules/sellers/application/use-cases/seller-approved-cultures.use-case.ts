import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';

export interface SellerApprovedCulturesInput {
  readonly sellerIds: unknown;
}

export type SellerApprovedCulturesFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'sellers.unavailable' };

export interface SellerApprovedCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
}

/** The most distinct seller ids of one call. */
export const APPROVED_CULTURES_MAX_SELLERS = 100;

/**
 * The shared body of the `anonymous` / `system` pair (multi-culture package 3a; ADR-0047 decision
 * 5): per requested seller (at most 100 distinct, well-formed ids, else `validation.failed`), the
 * ids of the cultures it is `approved` in. A seller with no approval, an unknown id and another
 * Market's id are all absent from the map, byte-identical. Ids only: no status history, reviewer
 * or reason. A failed read is `sellers.unavailable` (the caller fails closed: no culture), never
 * an empty map. One read-only unit.
 */
export async function sellerApprovedCultures(
  deps: SellerApprovedCulturesDependencies,
  context: CallContext,
  input: SellerApprovedCulturesInput,
): Promise<
  Result<ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>, SellerApprovedCulturesFailure>
> {
  const raw = typeof input === 'object' && input !== null ? input.sellerIds : undefined;
  if (!Array.isArray(raw)) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'type' }] });
  }
  const ids = new Set<Id<'Seller'>>();
  for (const item of raw as unknown[]) {
    const parsed = typeof item === 'string' ? parseId<'Seller'>(item) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    ids.add(parsed.value);
  }
  if (ids.size > APPROVED_CULTURES_MAX_SELLERS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] });
  }
  if (ids.size === 0) return ok(new Map());
  try {
    return await deps.unitOfWork.run<
      ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>,
      SellerApprovedCulturesFailure
    >(
      context.market,
      async () => ok(await deps.sellerCultures.approvedForSellers(context.market, [...ids])),
      { readOnly: true },
    );
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `sellers.seller-approved-cultures`: rule `anonymous`, in process only (no HTTP route). */
export class SellerApprovedCultures extends UseCase<
  SellerApprovedCulturesInput,
  ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>,
  SellerApprovedCulturesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-approved-cultures',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerApprovedCulturesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerApprovedCulturesInput,
  ): Promise<
    Result<ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>, SellerApprovedCulturesFailure>
  > {
    return sellerApprovedCultures(this.deps, context, input);
  }
}
