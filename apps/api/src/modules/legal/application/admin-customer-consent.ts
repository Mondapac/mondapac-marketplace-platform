import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor } from '../../../platform/authz';
import type {
  AdminConsentChange,
  AdminConsentHistoryRequest,
  AdminConsentState,
  CustomerConsentFailure,
} from '../contracts/customer-consent.facade';
import { MARKETING_CHANNELS, type MarketingChannel } from '../domain/marketing-consent';
import type { LegalDependencies } from './legal-dependencies';

// The admin's reads of one customer's marketing consent (customers management phase 2b): the
// current state of every channel and the history of changes with their source. Read only. A
// platform admin not acting as anyone; the gate checks `legal.customer-consent.view`.

type Dependencies = Pick<LegalDependencies, 'unitOfWork' | 'consents'>;

/** The largest page an admin's read answers (an export reads 10,000 and one more). */
const MAX_WINDOW = 10_001;

const isChannel = (value: string): value is MarketingChannel =>
  (MARKETING_CHANNELS as readonly string[]).includes(value);

export async function readAdminCustomerConsent(
  deps: Dependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<{ readonly channels: readonly AdminConsentState[] }, CustomerConsentFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const states: AdminConsentState[] = [];
      for (const channel of MARKETING_CHANNELS) {
        const record = await deps.consents.find(context.market, accountId, channel);
        states.push({
          channel,
          granted: record?.granted ?? false,
          source: record?.source ?? null,
          changedAt: record?.changedAt.toString() ?? null,
        });
      }
      return ok(states);
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({ channels: read.value });
}

export async function readAdminConsentHistory(
  deps: Dependencies,
  context: CallContext,
  request: AdminConsentHistoryRequest,
): Promise<
  Result<
    { readonly rows: readonly AdminConsentChange[]; readonly total: number | null },
    CustomerConsentFailure
  >
> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  // A channel legal does not know has no changes; it never widens the read.
  const channels = request.channels === null ? null : request.channels.filter(isChannel);
  const window = {
    offset: Math.max(request.window.offset, 0),
    limit: Math.min(Math.max(request.window.limit, 0), MAX_WINDOW),
  };
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const rows = await deps.consents.changesOf(
        context.market,
        request.accountId,
        channels,
        request.direction,
        window,
      );
      const total = request.withTotal
        ? await deps.consents.countChangesOf(context.market, request.accountId, channels)
        : null;
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({
    rows: read.value.rows.map((row) => ({
      channel: row.channel,
      granted: row.granted,
      source: row.source,
      occurredAt: row.occurredAt.toString(),
    })),
    total: read.value.total,
  });
}
