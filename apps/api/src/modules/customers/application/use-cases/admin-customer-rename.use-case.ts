import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_EDIT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  type ListValidationFailure,
} from '../customer-list-flow';
import { accountIdOf } from '../customer-page-flow';

export type RenameFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.customer-not-found' }
  /** A disabled or unverified account keeps its name (identity's rule). */
  | { readonly code: 'customers.customer-not-eligible' }
  | ListValidationFailure;

const logger = new Logger('AdminCustomerRename');

/**
 * `customers.admin-customer-rename`: an admin changes a customer's display name from the customer
 * page (phase 2). Rule: `customers.customers.view` and `customers.customers.edit`, the admin
 * population. `identity` owns the account and the write: it checks the key again, validates the
 * name (1 to 100 characters; a disabled or unverified account keeps its name), saves, records
 * `identity.account-display-name-changed.v1` (the read model follows it) and its own audit row,
 * in one unit. A change then adds a timeline entry (the admin as its actor); if that write fails
 * the rename stays and the failure is logged (ids only). The name is personal data: never logged.
 */
export class AdminCustomerRename extends UseCase<
  unknown,
  { readonly changed: boolean },
  RenameFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-rename',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EDIT.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerManagementDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<{ readonly changed: boolean }, RenameFailure>> {
    const admin = adminAccountOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalidField('body', 'type');
    for (const key of Object.keys(input)) {
      if (key !== 'accountId' && key !== 'displayName') return invalidField(key, 'unknown');
    }
    const accountId = accountIdOf(input['accountId']);
    if (accountId === null) return err({ code: 'customers.customer-not-found' });
    const name = input['displayName'];
    if (typeof name !== 'string') return invalidField('displayName', 'type');
    const { deps } = this;

    const known = await deps.unitOfWork.run(
      context.market,
      async () => ok(await deps.timeline.hasCustomer(context.market, accountId)),
      { readOnly: true },
    );
    if (!known.ok) return err({ code: 'access.unavailable' });
    if (!known.value) return err({ code: 'customers.customer-not-found' });

    const renamed = await deps.identity.renameCustomerForAdmin(context, {
      accountId,
      displayName: name,
    });
    if (!renamed.ok) {
      const code = renamed.error.code;
      if (code === 'validation.failed') {
        const fields = (renamed.error as { fields?: readonly { path: string; code: string }[] })
          .fields;
        return err({
          code: 'validation.failed',
          fields: fields ?? [{ path: 'displayName', code: 'value' }],
        });
      }
      if (code === 'account.unknown') return err({ code: 'customers.customer-not-found' });
      if (code === 'account.not-eligible') return err({ code: 'customers.customer-not-eligible' });
      if (code === 'access.denied') return err({ code: 'access.denied' });
      return err({ code: 'access.unavailable' });
    }
    if (!renamed.value.changed) return ok({ changed: false });

    const now = deps.clock.now();
    let recorded: { readonly ok: boolean };
    try {
      recorded = await deps.unitOfWork.run(context.market, async () =>
        ok(
          await deps.timeline.record(
            context.market,
            {
              id: deps.ids.next<'CustomerTimelineEntry'>(),
              accountId,
              occurredAt: now,
              kind: 'renamed-by-admin',
              ref: null,
              actorAccountId: admin,
              detail: null,
              sourceEventId: null,
            },
            now,
          ),
        ),
      );
    } catch {
      recorded = { ok: false };
    }
    if (!recorded.ok) {
      logger.warn({
        msg: 'customers.admin-customer-rename',
        code: 'timeline-not-written',
        accountId,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
    return ok({ changed: true });
  }
}
