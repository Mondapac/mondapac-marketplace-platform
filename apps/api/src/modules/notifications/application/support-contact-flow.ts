import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { SupportContactChanged } from '../domain/audit';
import { parseSupportEmail } from '../domain/support-email';
import type { NotificationsDependencies } from './notifications-dependencies';

export type SupportContactFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** Another admin changed the address first; the screen reloads and tries again. */
  | { readonly code: 'notifications.conflict' };

/** `email` is null when neither an admin nor the Market configuration gave an address. */
export interface SupportContactView {
  readonly email: string | null;
  /** 0 while the Market default (or nothing) is in force. */
  readonly version: number;
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

/** The address in force: the newest admin version, else the Market default. */
export async function viewSupportContact(
  deps: NotificationsDependencies,
  context: CallContext,
): Promise<Result<SupportContactView, SupportContactFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<SupportContactView, SupportContactFailure>(
    context.market,
    async () => {
      const latest = await deps.contacts.latest(context.market);
      return ok(
        latest === null
          ? { email: deps.policy.defaultSupportEmail(context.market), version: 0 }
          : { email: latest.email, version: latest.version },
      );
    },
    { readOnly: true },
  );
}

/** An admin sets the address; every change is a new version, audited by version. */
export async function setSupportContact(
  deps: NotificationsDependencies,
  context: CallContext,
  input: { readonly email: unknown },
): Promise<Result<SupportContactView, SupportContactFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const email = parseSupportEmail(input?.email);
  if (!email.ok) {
    return err({ code: 'validation.failed', fields: [{ path: email.error.path, code: 'format' }] });
  }

  const now = deps.clock.now();
  return deps.unitOfWork.run<SupportContactView, SupportContactFailure>(
    context.market,
    async () => {
      const latest = await deps.contacts.latest(context.market);
      const currentEmail = latest?.email ?? deps.policy.defaultSupportEmail(context.market);
      const currentVersion = latest?.version ?? 0;
      // The same address again changes nothing: no new version, no audit row.
      if (currentEmail === email.value) return ok({ email: email.value, version: currentVersion });

      const version = currentVersion + 1;
      const written = await deps.contacts.append(context.market, {
        version,
        email: email.value,
        changedAt: now,
        previousEmail: currentEmail,
        changedBy: actor.accountId,
      });
      if (!written) return err({ code: 'notifications.conflict' } as const);
      await deps.audit.record(
        context,
        SupportContactChanged.entry('support-email', {
          before: { version: currentVersion },
          after: { version },
        }),
      );
      return ok({ email: email.value, version });
    },
  );
}
