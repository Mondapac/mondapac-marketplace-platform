import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isCustomerConsentSource,
  type ConsentSource,
  type MarketingChannel,
} from '../domain/marketing-consent';
import type { LegalDependencies } from './legal-dependencies';
import type { MarketingConsentRecord } from './ports/marketing-consent.repository';

// Marketing email consent (personalization package 1b, customers package 4). Express opt-in: no
// record means no consent. A signed-in customer reads and changes their own consent; the
// one-click unsubscribe link (notifications) withdraws it; a marketing send asks whether it is
// granted. Only a real change is recorded, and every change is appended to the history with its
// source and time. No email address, and no consent value, reaches a log or an event.

export type EmailPreferencesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface EmailPreferencesView {
  /** Whether the customer agreed to receive marketing email. */
  readonly marketing: boolean;
  /** When it last changed; null when the customer never chose. */
  readonly changedAt: Temporal.Instant | null;
}

/** The body of a change: `marketing` (required) and `source` (`sign-up` or `account`). */
export type EmailPreferencesInput = Readonly<Record<string, unknown>>;

const EMAIL: MarketingChannel = 'email';

/** One row per account and channel: a first write and a concurrent one must not both insert. */
const SERIAL = { isolation: 'serializable' } as const;

/** The signed-in customer's account; null for any other actor (fail closed). */
function customerOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer' ? actor.accountId : null;
}

const viewOf = (record: MarketingConsentRecord | null): EmailPreferencesView => ({
  marketing: record?.granted === true,
  changedAt: record?.changedAt ?? null,
});

/**
 * Sets the consent and appends the change, unless it already holds that value. Runs inside the
 * caller's unit of work. Answers the record as it now stands.
 */
async function change(
  deps: LegalDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  granted: boolean,
  source: ConsentSource,
): Promise<{ readonly record: MarketingConsentRecord | null; readonly changed: boolean }> {
  const before = await deps.consents.find(context.market, accountId, EMAIL);
  if ((before?.granted ?? false) === granted) return { record: before, changed: false };
  const now = deps.clock.now();
  const record: MarketingConsentRecord = {
    id: before?.id ?? deps.ids.next<'MarketingConsent'>(),
    accountId,
    channel: EMAIL,
    granted,
    source,
    changedAt: now,
    createdAt: before?.createdAt ?? now,
  };
  await deps.consents.record(context.market, record, {
    id: deps.ids.next<'MarketingConsentChange'>(),
    accountId,
    channel: EMAIL,
    granted,
    source,
    occurredAt: now,
  });
  return { record, changed: true };
}

/** The customer reads their email preferences. */
export async function viewEmailPreferences(
  deps: LegalDependencies,
  context: CallContext,
): Promise<Result<EmailPreferencesView, EmailPreferencesFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<EmailPreferencesView, EmailPreferencesFailure>(
    context.market,
    async () => ok(viewOf(await deps.consents.find(context.market, accountId, EMAIL))),
    { readOnly: true },
  );
}

/**
 * The customer changes their marketing email consent: `marketing` true or false, and `source`,
 * the screen it was given on (`sign-up`: the unticked box of the sign-up page, sent right after
 * the account was created; `account`: the account page, the default). Nothing is recorded when
 * the value does not change.
 */
export async function setEmailPreferences(
  deps: LegalDependencies,
  context: CallContext,
  input: EmailPreferencesInput,
): Promise<Result<EmailPreferencesView, EmailPreferencesFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  const marketing = input?.marketing;
  if (marketing === undefined) fields.push({ path: 'marketing', code: 'required' });
  else if (typeof marketing !== 'boolean') fields.push({ path: 'marketing', code: 'type' });
  const source = input?.source ?? 'account';
  if (!isCustomerConsentSource(source)) fields.push({ path: 'source', code: 'one-of' });
  if (fields.length > 0) return err({ code: 'validation.failed', fields });

  return deps.unitOfWork.run<EmailPreferencesView, EmailPreferencesFailure>(
    context.market,
    async () => {
      const { record } = await change(
        deps,
        context,
        accountId,
        marketing as boolean,
        source as ConsentSource,
      );
      return ok(viewOf(record));
    },
    SERIAL,
  );
}

/**
 * Whether a marketing email may be sent to this customer account now (system actor only: the
 * marketing sends are jobs). False when the account never agreed or withdrew.
 */
export async function marketingEmailConsentOf(
  deps: LegalDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'> },
): Promise<Result<{ readonly granted: boolean }, never>> {
  return deps.unitOfWork.run<{ readonly granted: boolean }, never>(
    context.market,
    async () => {
      const record = await deps.consents.find(context.market, input.accountId, EMAIL);
      return ok({ granted: record?.granted === true });
    },
    { readOnly: true },
  );
}

/**
 * Withdraws the marketing email consent of the account named by a verified unsubscribe link
 * (notifications checks the link's signature before it calls). Answers whether anything changed;
 * a second click changes nothing and is not an error.
 */
export async function withdrawMarketingEmailByLink(
  deps: LegalDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'> },
): Promise<Result<{ readonly withdrawn: boolean }, never>> {
  return deps.unitOfWork.run<{ readonly withdrawn: boolean }, never>(
    context.market,
    async () => {
      const { changed } = await change(deps, context, input.accountId, false, 'unsubscribe-link');
      return ok({ withdrawn: changed });
    },
    SERIAL,
  );
}
