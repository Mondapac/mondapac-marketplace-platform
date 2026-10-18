import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  BehaviourEventRecord,
  BehaviourEventRepository,
} from '../ports/behaviour-event.repository';
import type { EngagementGuestTokens } from '../ports/guest-tokens';
import type {
  PersonalizationSettingRecord,
  PersonalizationSettingRepository,
} from '../ports/personalization-setting.repository';

// Test doubles of the engagement stores: events per Market, the switch per (Market, account) as
// the unique key keeps it, and predictable guest tokens.

export class InMemoryBehaviourEvents implements BehaviourEventRepository {
  readonly rows: (BehaviourEventRecord & { readonly marketId: string })[] = [];

  append(market: MarketContext, event: BehaviourEventRecord) {
    this.rows.push({ ...event, marketId: market.marketId });
    return Promise.resolve();
  }

  deleteForAccount(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      this.remove(
        (row) =>
          row.marketId === market.marketId &&
          row.subject.kind === 'account' &&
          row.subject.accountId === accountId,
      ),
    );
  }

  purgeBefore(
    market: MarketContext,
    accountBefore: Temporal.Instant,
    guestBefore: Temporal.Instant,
  ) {
    const before = (row: BehaviourEventRecord, edge: Temporal.Instant) =>
      row.occurredAt.epochMilliseconds < edge.epochMilliseconds;
    const accountEvents = this.remove(
      (row) =>
        row.marketId === market.marketId &&
        row.subject.kind === 'account' &&
        before(row, accountBefore),
    );
    const guestEvents = this.remove(
      (row) =>
        row.marketId === market.marketId &&
        row.subject.kind === 'guest' &&
        before(row, guestBefore),
    );
    return Promise.resolve({ accountEvents, guestEvents });
  }

  private remove(match: (row: BehaviourEventRecord & { readonly marketId: string }) => boolean) {
    let removed = 0;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (match(this.rows[index]!)) {
        this.rows.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

const key = (market: MarketContext, accountId: string) => `${market.marketId}|${accountId}`;

export class InMemoryPersonalizationSettings implements PersonalizationSettingRepository {
  readonly rows = new Map<string, PersonalizationSettingRecord>();

  find(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.rows.get(key(market, accountId)) ?? null);
  }

  save(market: MarketContext, setting: PersonalizationSettingRecord) {
    this.rows.set(key(market, setting.accountId), setting);
    return Promise.resolve();
  }

  delete(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.rows.delete(key(market, accountId)));
  }
}

/** Tokens `g` + 42 characters; the hash is `h:` + the token, so a test can predict it. */
export class FakeEngagementGuestTokens implements EngagementGuestTokens {
  #next = 0;

  issue() {
    this.#next += 1;
    const token = `g${this.#next.toString().padStart(42, '0')}`;
    return { token, hash: this.hashOf(token)! };
  }

  hashOf(token: string): string | null {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? `h:${token}` : null;
  }
}
