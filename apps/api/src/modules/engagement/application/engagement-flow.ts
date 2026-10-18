import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  readBehaviour,
  retentionEdges,
  type BehaviourFacts,
  type FieldProblem,
} from '../domain/behaviour-event';
import type { EngagementDependencies } from './engagement-dependencies';
import type { BehaviourSubject } from './ports/behaviour-event.repository';
import type { PersonalizationSettingRecord } from './ports/personalization-setting.repository';

// Behaviour capture (personalization package 1a). The storefront reports what a shopper viewed,
// searched for or added to the cart; a signed-in customer's event is kept under the account, a
// guest's under the hash of the engagement guest cookie. Nothing is recorded when the browser
// sends Global Privacy Control or the customer switched personalization off; switching it off
// deletes what was recorded. Ids only: no event, log or error carries the search text, the guest
// token or an account id.

export type RecordFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] };

/** What the guest cookie must do after a guest event: set a new token, or nothing. */
export type GuestCookie = { readonly action: 'set'; readonly token: string } | null;

/** The body of an event (see `readBehaviour`), and whether the browser sent `Sec-GPC: 1`. */
export interface RecordInput {
  readonly event: Readonly<Record<string, unknown>>;
  readonly globalPrivacyControl: boolean;
}

export interface RecordGuestInput extends RecordInput {
  /** The raw token of the engagement guest cookie; null when there is none. */
  readonly token: string | null;
}

export interface Recorded {
  readonly recorded: boolean;
}

export interface PersonalizationView {
  /** Whether behaviour is recorded and used for this customer. */
  readonly enabled: boolean;
  /** When the customer last changed it; null when they never did. */
  readonly changedAt: Temporal.Instant | null;
}

export type PersonalizationFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/** One settings row per account: a first write and a concurrent one must not both insert. */
const SERIAL = { isolation: 'serializable' } as const;

/** The signed-in customer's account; null for any other actor (fail closed). */
function customerOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer' ? actor.accountId : null;
}

const viewOf = (record: PersonalizationSettingRecord | null): PersonalizationView => ({
  enabled: record?.enabled ?? true,
  changedAt: record?.changedAt ?? null,
});

async function append(
  deps: EngagementDependencies,
  context: CallContext,
  subject: BehaviourSubject,
  facts: BehaviourFacts,
): Promise<void> {
  await deps.events.append(context.market, {
    id: deps.ids.next<'BehaviourEvent'>(),
    subject,
    facts,
    occurredAt: deps.clock.now(),
  });
}

/**
 * A signed-in customer's event. Recorded unless the browser sent Global Privacy Control or the
 * customer switched personalization off; `recorded` says which.
 */
export async function recordCustomerEvent(
  deps: EngagementDependencies,
  context: CallContext,
  input: RecordInput,
): Promise<Result<Recorded, RecordFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const read = readBehaviour(input.event);
  if (!read.ok) return err({ code: 'validation.failed', fields: read.fields });
  if (input.globalPrivacyControl) return ok({ recorded: false });

  return deps.unitOfWork.run<Recorded, RecordFailure>(context.market, async () => {
    const setting = await deps.settings.find(context.market, accountId);
    if (!viewOf(setting).enabled) return ok({ recorded: false });
    await append(deps, context, { kind: 'account', accountId }, read.facts);
    return ok({ recorded: true });
  });
}

/**
 * A guest's event, under the hash of the engagement guest cookie. A guest without a well-formed
 * cookie gets a new token (set only on a success). Global Privacy Control records nothing and
 * sets no cookie.
 */
export async function recordGuestEvent(
  deps: EngagementDependencies,
  context: CallContext,
  input: RecordGuestInput,
): Promise<Result<Recorded & { readonly cookie: GuestCookie }, RecordFailure>> {
  const read = readBehaviour(input.event);
  if (!read.ok) return err({ code: 'validation.failed', fields: read.fields });
  if (input.globalPrivacyControl) return ok({ recorded: false, cookie: null });

  const known = input.token === null ? null : deps.guestTokens.hashOf(input.token);
  const issued = known === null ? deps.guestTokens.issue() : null;
  const guestHash = known ?? issued!.hash;
  return deps.unitOfWork.run<Recorded & { readonly cookie: GuestCookie }, RecordFailure>(
    context.market,
    async () => {
      await append(deps, context, { kind: 'guest', guestHash }, read.facts);
      return ok({
        recorded: true,
        cookie: issued === null ? null : { action: 'set', token: issued.token },
      });
    },
  );
}

/** The customer reads their personalization switch (on unless they switched it off). */
export async function viewPersonalization(
  deps: EngagementDependencies,
  context: CallContext,
): Promise<Result<PersonalizationView, PersonalizationFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<PersonalizationView, PersonalizationFailure>(
    context.market,
    async () => ok(viewOf(await deps.settings.find(context.market, accountId))),
    { readOnly: true },
  );
}

/**
 * The customer switches personalization on or off (`enabled`, required). Switching it off also
 * deletes every event recorded for the account, in the same unit. Nothing changes when the value
 * is the one it already has.
 */
export async function setPersonalization(
  deps: EngagementDependencies,
  context: CallContext,
  input: Readonly<Record<string, unknown>>,
): Promise<Result<PersonalizationView, PersonalizationFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const enabled = input?.enabled;
  if (enabled === undefined) {
    return err({ code: 'validation.failed', fields: [{ path: 'enabled', code: 'required' }] });
  }
  if (typeof enabled !== 'boolean') {
    return err({ code: 'validation.failed', fields: [{ path: 'enabled', code: 'type' }] });
  }

  return deps.unitOfWork.run<PersonalizationView, PersonalizationFailure>(
    context.market,
    async () => {
      const before = await deps.settings.find(context.market, accountId);
      if (viewOf(before).enabled === enabled) return ok(viewOf(before));
      const now = deps.clock.now();
      const record: PersonalizationSettingRecord = {
        id: before?.id ?? deps.ids.next<'PersonalizationSetting'>(),
        accountId,
        enabled,
        changedAt: now,
        createdAt: before?.createdAt ?? now,
      };
      await deps.settings.save(context.market, record);
      if (!enabled) await deps.events.deleteForAccount(context.market, accountId);
      return ok(viewOf(record));
    },
    SERIAL,
  );
}

/**
 * Deletes, for one Market, the events past their retention: 12 months for an account, 30 days for
 * a guest. Safe to run twice and concurrently.
 */
export async function purgeExpiredEvents(
  deps: EngagementDependencies,
  context: CallContext,
): Promise<Result<{ readonly accountEvents: number; readonly guestEvents: number }, never>> {
  const edges = retentionEdges(deps.clock.now());
  return deps.unitOfWork.run(context.market, async () =>
    ok(await deps.events.purgeBefore(context.market, edges.account, edges.guest)),
  );
}

/**
 * Deletes everything engagement holds about one account in the Market: its events and its
 * switch. For account deletion (customers package 5); safe to run twice.
 */
export async function forgetAccount(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'> },
): Promise<Result<{ readonly events: number }, never>> {
  return deps.unitOfWork.run(context.market, async () => {
    const events = await deps.events.deleteForAccount(context.market, input.accountId);
    await deps.settings.delete(context.market, input.accountId);
    return ok({ events });
  });
}
