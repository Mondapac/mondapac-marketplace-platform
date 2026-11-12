import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';

export interface CultureApprovedMembersInput {
  readonly cultureId: unknown;
}

export type CultureApprovedMembersFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'sellers.unavailable' };

export interface CultureApprovedMembersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
}

/**
 * `sellers.culture-approved-members` (ADR-0048, security review M1): whether any seller is
 * approved in a culture, so `catalog` can refuse to change the culture's required certification
 * type while someone is (their approval was checked against the old type). Rule `anonymous`: a
 * culture id in, one flag out, in process only. A fault is `sellers.unavailable` and the caller
 * refuses (fail closed). One read-only unit.
 */
export class CultureApprovedMembers extends UseCase<
  CultureApprovedMembersInput,
  boolean,
  CultureApprovedMembersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.culture-approved-members',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureApprovedMembersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureApprovedMembersInput,
  ): Promise<Result<boolean, CultureApprovedMembersFailure>> {
    const id = typeof input?.cultureId === 'string' ? parseId<'Culture'>(input.cultureId) : null;
    if (id === null || !id.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'cultureId', code: 'format' }] });
    }
    try {
      return await this.deps.unitOfWork.run<boolean, CultureApprovedMembersFailure>(
        context.market,
        async () => ok(await this.deps.sellerCultures.hasApproved(context.market, id.value)),
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
