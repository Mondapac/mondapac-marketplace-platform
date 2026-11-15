import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  toRecord,
  type CustomerDirectoryDependencies,
  type CustomerDirectoryFailure,
  type CustomerDirectoryRecord,
} from './customer-directory-records.use-case';

const MAX_PAGE = 200;

/**
 * `identity.customer-directory-page`: a keyset page (ascending by id, at most 200) of the Market's
 * customer accounts, for the one-off backfill of the `customers` read model. Rule `system`.
 */
export class CustomerDirectoryPage extends UseCase<
  { readonly after: string | null; readonly limit: number },
  readonly CustomerDirectoryRecord[],
  CustomerDirectoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.customer-directory-page',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerDirectoryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly after: string | null; readonly limit: number },
  ): Promise<Result<readonly CustomerDirectoryRecord[], CustomerDirectoryFailure>> {
    const limit = input?.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      return Promise.resolve(err({ code: 'validation.failed' }));
    }
    let after: Id<'Account'> | null = null;
    if (input.after !== null) {
      const parsed = typeof input.after === 'string' ? parseId<'Account'>(input.after) : null;
      if (parsed === null || !parsed.ok) return Promise.resolve(err({ code: 'validation.failed' }));
      after = parsed.value;
    }
    return this.deps.unitOfWork.run<readonly CustomerDirectoryRecord[], CustomerDirectoryFailure>(
      context.market,
      async () => {
        const rows = await this.deps.accounts.customerDirectoryPage(context.market, after, limit);
        return ok(rows.map(toRecord));
      },
      { readOnly: true },
    );
  }
}
