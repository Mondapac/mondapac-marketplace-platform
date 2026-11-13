import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CULTURE_READ } from '../../contracts/permissions';
import { adminAccountOf, cultureIdOf, viewOf, type CultureView } from '../cultures/culture-views';
import type { CultureRepository } from '../ports/culture.repository';

export interface CultureGetInput {
  readonly cultureId?: unknown;
}

export type CultureGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'culture.not-found' };

export interface CultureGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultures: CultureRepository;
}

/**
 * `culture.get` (multi-culture package 1): one culture for the admin editor. Rule: the key
 * `catalog.culture.read` and the admin population. One read-only unit.
 */
export class CultureGet extends UseCase<
  CultureGetInput,
  { readonly culture: CultureView },
  CultureGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-get',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_READ.key] },
  };

  readonly #logger = new Logger('CultureGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureGetInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.culture-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: CultureGetInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureGetFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const id = cultureIdOf(input.cultureId, 'cultureId');
    if (!id.ok) return err({ code: 'culture.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.cultures.findById(market, id.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'culture.not-found' });
    return ok({ culture: viewOf(read.value) });
  }
}
