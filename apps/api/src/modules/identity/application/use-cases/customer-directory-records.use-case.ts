import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';

/** One customer account as the `customers` read model copies it. PERSONAL DATA: never logged. */
export interface CustomerDirectoryRecord {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  readonly signedUpAt: Temporal.Instant;
}

export type CustomerDirectoryFailure = { readonly code: 'validation.failed' };

export interface CustomerDirectoryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

const MAX_IDS = 100;

/**
 * `identity.customer-directory-records`: the directory fields of customer accounts by id, for the
 * `customers` read model (kept by identity's account events). Rule `system`. At most 100 ids;
 * an unknown id, another Market's and a non-customer account are absent. Not exposed over HTTP.
 */
export class CustomerDirectoryRecords extends UseCase<
  { readonly accountIds: readonly string[] },
  readonly CustomerDirectoryRecord[],
  CustomerDirectoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.customer-directory-records',
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
    input: { readonly accountIds: readonly string[] },
  ): Promise<Result<readonly CustomerDirectoryRecord[], CustomerDirectoryFailure>> {
    const raw = input?.accountIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_IDS) {
      return Promise.resolve(err({ code: 'validation.failed' }));
    }
    const ids = new Set<Id<'Account'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Account'>(value) : null;
      if (parsed === null || !parsed.ok) return Promise.resolve(err({ code: 'validation.failed' }));
      ids.add(parsed.value);
    }
    if (ids.size === 0) return Promise.resolve(ok([]));
    return this.deps.unitOfWork.run<readonly CustomerDirectoryRecord[], CustomerDirectoryFailure>(
      context.market,
      async () => {
        const rows = await this.deps.accounts.customerDirectoryRows(context.market, [...ids]);
        return ok(rows.map(toRecord));
      },
      { readOnly: true },
    );
  }
}

export function toRecord(row: {
  readonly id: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  readonly signedUpAt: Temporal.Instant;
}): CustomerDirectoryRecord {
  return {
    accountId: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt,
    signedUpAt: row.signedUpAt,
  };
}
