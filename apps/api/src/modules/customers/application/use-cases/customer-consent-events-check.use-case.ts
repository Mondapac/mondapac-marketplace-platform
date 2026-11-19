import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { LEGAL_CUSTOMER_CONSENT_VIEW } from '../section-keys';

export interface CustomerConsentEventsCheckOutput {
  readonly canSeeConsentEvents: true;
}

export type CustomerConsentEventsCheckFailure = { readonly code: 'access.denied' };

/**
 * `customers.customer-consent-events-check`: asks the gate whether the caller holds legal's key
 * `legal.customer-consent.view`. It reads and writes nothing; the timeline read and export call it
 * to decide whether the consent kind (`consent-changed`) is part of the answer (phase 2b, part 4).
 * An entry carries no consent value, but only real changes are recorded and the default is "not
 * granted", so the count of entries tells whether the consent stands: the same fact the consent
 * section shows behind legal's key. The answer `access.denied` means "no"; the admin population is
 * required as for every admin use case.
 */
export class CustomerConsentEventsCheck extends UseCase<
  Record<string, never>,
  CustomerConsentEventsCheckOutput,
  CustomerConsentEventsCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.customer-consent-events-check',
    rule: { kind: 'permissions', allOf: [LEGAL_CUSTOMER_CONSENT_VIEW] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CustomerConsentEventsCheckOutput, CustomerConsentEventsCheckFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(ok({ canSeeConsentEvents: true }));
  }
}
