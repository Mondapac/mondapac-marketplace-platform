import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import { CustomerRenamedByAdminAudit } from '../../domain/audit';
import { parseDisplayName } from '../../domain/display-name';
import type { AccountRepository } from '../ports/account.repository';
import { isActingAsSession } from '../sellers/access-decision-reads';

export interface AdminRenameCustomerInput {
  readonly accountId: Id<'Account'>;
  /** As typed; parsed here (trimmed, 1 to 100 characters, no URL-like text). */
  readonly displayName: string;
}

export interface AdminRenameCustomerOutput {
  /** False when the name was already the one given: nothing was written. */
  readonly changed: boolean;
}

export type AdminRenameCustomerFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  /** No customer account with this id in the Market (or another population's): one answer. */
  | { readonly code: 'account.unknown' }
  /** A disabled or unverified account keeps its name (the domain's rule, as for the holder). */
  | { readonly code: 'account.not-eligible' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface AdminRenameCustomerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/** customers' key of the customer page's edit; only the declaring module can brand it. */
const EDIT_KEY = 'customers.customers.edit' as PermissionKey;

/**
 * `identity.admin-rename-customer`: an admin changes a customer account's display name from the
 * customer page (customers management phase 2). Rule `permissions [customers.customers.edit]`
 * (customers' key; a contract test pins it to the declaration): the actor must be a platform admin
 * that is not acting as a seller, checked here as well. One read-write unit under the account's
 * version: a customer account of the Market (else `account.unknown`, alike for every miss), the
 * domain's rename (an active, verified account; the same name again writes nothing), the event
 * `identity.account-display-name-changed.v1` and the audit row
 * `identity.account.renamed-by-admin` (ids and codes only, never the name). A concurrent change
 * answers `access.unavailable`. Not exposed over HTTP: customers' route calls it.
 */
export class AdminRenameCustomer extends UseCase<
  AdminRenameCustomerInput,
  AdminRenameCustomerOutput,
  AdminRenameCustomerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-rename-customer',
    rule: { kind: 'permissions', allOf: [EDIT_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminRenameCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminRenameCustomerInput,
  ): Promise<Result<AdminRenameCustomerOutput, AdminRenameCustomerFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const name = parseDisplayName(input.displayName);
    if (!name.ok) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'displayName', code: name.error.rule }],
      });
    }
    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<AdminRenameCustomerOutput, AdminRenameCustomerFailure>> => {
          const account = await this.deps.accounts.findById(market, input.accountId);
          if (account === null || account.state.population !== 'customer') {
            return err({ code: 'account.unknown' });
          }
          const renamed = account.rename({ displayName: name.value, now: this.deps.clock.now() });
          if (!renamed.ok) return err({ code: 'account.not-eligible' });
          if (!renamed.value) return ok({ changed: false });
          await this.deps.accounts.save(market, account);
          await this.deps.outbox.append(context, account.pendingEvents);
          await this.deps.audit.record(
            context,
            CustomerRenamedByAdminAudit.entry(account.state.id, {
              after: { population: 'customer' },
            }),
          );
          return ok({ changed: true });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'access.unavailable' });
      throw error;
    }
  }
}
