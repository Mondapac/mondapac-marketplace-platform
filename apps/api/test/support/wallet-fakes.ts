import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../../src/modules/wallet/application/ports/market-setting.repository';
import type {
  BalanceRecord,
  DueHold,
  DueLot,
  HistoryPage,
  HistoryRow,
  HoldRecord,
  InternalAccountKind,
  JournalRecord,
  NewJournal,
  NewLot,
  ReconcileMismatch,
  WalletAccountRecord,
  WalletRepository,
} from '../../src/modules/wallet/application/ports/wallet.repository';
import type { Lot, Take } from '../../src/modules/wallet/domain/lots';

/**
 * The wallet ledger in memory, with the same rules the tables enforce: a journal must balance, a
 * key is used once, a lot only decreases except for a settled hold, nothing is ever deleted.
 */
export class MemoryWallet implements WalletRepository {
  readonly accounts = new Map<
    string,
    WalletAccountRecord & { customer: string | null; kind: string }
  >();
  readonly balances = new Map<string, BalanceRecord>();
  readonly journals: NewJournal[] = [];
  readonly lots = new Map<
    string,
    Lot & { wallet: Id<'WalletAccount'>; original: bigint; journalId: string }
  >();
  readonly holds = new Map<
    string,
    HoldRecord & { lots: Take[]; resolvedAt: Temporal.Instant | null }
  >();
  readonly locks: string[] = [];

  findWallet(_m: MarketContext, customer: Id<'Account'>) {
    const found = [...this.accounts.values()].find((a) => a.customer === customer);
    return Promise.resolve(found === undefined ? null : { id: found.id, status: found.status });
  }
  async ensureWallet(
    m: MarketContext,
    input: {
      newAccountId: Id<'WalletAccount'>;
      customerAccountId: Id<'Account'>;
      currency: string;
      now: Temporal.Instant;
    },
  ) {
    if ((await this.findWallet(m, input.customerAccountId)) === null) {
      this.accounts.set(input.newAccountId, {
        id: input.newAccountId,
        status: 'active',
        customer: input.customerAccountId,
        kind: 'credit_liability',
      });
      this.balances.set(input.newAccountId, {
        walletAccountId: input.newAccountId,
        availableMinor: 0n,
        heldMinor: 0n,
      });
    }
    return (await this.findWallet(m, input.customerAccountId))!;
  }
  ensureInternalAccounts(
    _m: MarketContext,
    kinds: readonly InternalAccountKind[],
    input: { newId: () => Id<'WalletAccount'> },
  ) {
    const out = new Map<InternalAccountKind, Id<'WalletAccount'>>();
    for (const kind of kinds) {
      let found = [...this.accounts.values()].find((a) => a.kind === kind);
      if (found === undefined) {
        const id = input.newId();
        found = { id, status: 'active', customer: null, kind };
        this.accounts.set(id, found);
      }
      out.set(kind, found.id);
    }
    return Promise.resolve(out);
  }
  lockBalance(_m: MarketContext, id: Id<'WalletAccount'>) {
    this.locks.push(id);
    return Promise.resolve({ ...this.balances.get(id)! });
  }
  readBalance(_m: MarketContext, id: Id<'WalletAccount'>) {
    const b = this.balances.get(id);
    return Promise.resolve({
      availableMinor: b?.availableMinor ?? 0n,
      heldMinor: b?.heldMinor ?? 0n,
    });
  }
  saveBalance(_m: MarketContext, balance: BalanceRecord) {
    if (balance.availableMinor < 0n || balance.heldMinor < 0n) throw new Error('CHECK balances');
    this.balances.set(balance.walletAccountId, { ...balance });
    return Promise.resolve();
  }
  findJournal(_m: MarketContext, key: string) {
    const found = this.journals.find((j) => j.idempotencyKey === key);
    return Promise.resolve(
      found === undefined
        ? null
        : ({
            id: found.id,
            fingerprint: found.fingerprint,
            result: found.result,
          } satisfies JournalRecord),
    );
  }
  hasJournals() {
    return Promise.resolve(this.journals.length > 0);
  }
  appendJournal(_m: MarketContext, journal: NewJournal) {
    const sum = journal.postings.reduce((total, p) => total + p.amountMinor, 0n);
    if (journal.postings.length < 2 || sum !== 0n) throw new Error('unbalanced journal');
    if (this.journals.some((j) => j.idempotencyKey === journal.idempotencyKey)) {
      throw new Error('duplicate idempotency key');
    }
    this.journals.push(journal);
    return Promise.resolve();
  }
  createLot(_m: MarketContext, lot: NewLot) {
    this.lots.set(lot.id, {
      id: lot.id,
      source: lot.source,
      remaining: lot.amountMinor,
      expiresAt: lot.expiresAt,
      createdAt: lot.createdAt,
      wallet: lot.walletAccountId,
      original: lot.amountMinor,
      journalId: lot.journalId,
    });
    return Promise.resolve();
  }
  lotsWithCredit(_m: MarketContext, wallet: Id<'WalletAccount'>) {
    return Promise.resolve(
      [...this.lots.values()].filter((l) => l.wallet === wallet && l.remaining > 0n),
    );
  }
  findLot(_m: MarketContext, id: Id<'WalletLot'>) {
    return Promise.resolve(this.lots.get(id) ?? null);
  }
  findLotWallet(_m: MarketContext, id: Id<'WalletLot'>) {
    return Promise.resolve(this.lots.get(id)?.wallet ?? null);
  }
  setLotRemaining(_m: MarketContext, id: Id<'WalletLot'>, remaining: bigint) {
    const lot = this.lots.get(id)!;
    if (remaining > lot.remaining) {
      const settled = [...this.holds.values()].some(
        (h) => h.status !== 'held' && h.status !== 'captured' && h.lots.some((t) => t.lotId === id),
      );
      if (!settled || remaining > lot.original) throw new Error('lot guard: only decreases');
    }
    this.lots.set(id, { ...lot, remaining });
    return Promise.resolve();
  }
  findHold(_m: MarketContext, orderId: Id<'Order'>, wallet?: Id<'WalletAccount'>) {
    const found = [...this.holds.values()].find(
      (h) => h.orderId === orderId && (wallet === undefined || h.walletAccountId === wallet),
    );
    return Promise.resolve(found ?? null);
  }
  findHoldById(_m: MarketContext, id: Id<'WalletHold'>) {
    return Promise.resolve(this.holds.get(id) ?? null);
  }
  createHold(_m: MarketContext, hold: HoldRecord, takes: readonly Take[]) {
    this.holds.set(hold.id, { ...hold, lots: [...takes], resolvedAt: null });
    return Promise.resolve();
  }
  holdLots(_m: MarketContext, id: Id<'WalletHold'>) {
    return Promise.resolve([...this.holds.get(id)!.lots]);
  }
  settleHold(
    _m: MarketContext,
    id: Id<'WalletHold'>,
    status: HoldRecord['status'],
    now: Temporal.Instant,
  ) {
    const hold = this.holds.get(id)!;
    if (hold.status !== 'held') throw new Error('hold guard');
    this.holds.set(id, { ...hold, status, resolvedAt: now });
    return Promise.resolve();
  }
  history(_m: MarketContext, wallet: Id<'WalletAccount'>, page: HistoryPage) {
    const rows = this.journals
      .filter((j) => j.walletAccountId === wallet)
      .map((j): HistoryRow => ({
        journalId: j.id,
        kind: j.kind,
        amountMinor: j.postings.find((p) => p.accountId === wallet)?.amountMinor ?? 0n,
        reasonCode: j.reasonCode,
        orderId: j.orderId,
        createdAt: j.createdAt,
      }))
      .reverse();
    return Promise.resolve(rows.slice(0, page.limit));
  }
  expiringLots(
    _m: MarketContext,
    wallet: Id<'WalletAccount'>,
    before: Temporal.Instant,
    after: Temporal.Instant,
    limit: number,
  ) {
    return Promise.resolve(
      [...this.lots.values()]
        .filter(
          (l) =>
            l.wallet === wallet &&
            l.source === 'promo' &&
            l.remaining > 0n &&
            l.expiresAt !== null &&
            l.expiresAt.epochMilliseconds > after.epochMilliseconds &&
            l.expiresAt.epochMilliseconds <= before.epochMilliseconds,
        )
        .slice(0, limit),
    );
  }
  dueLots(_m: MarketContext, now: Temporal.Instant, limit: number): Promise<readonly DueLot[]> {
    return Promise.resolve(
      [...this.lots.values()]
        .filter(
          (l) =>
            l.source === 'promo' &&
            l.remaining > 0n &&
            l.expiresAt !== null &&
            l.expiresAt.epochMilliseconds <= now.epochMilliseconds,
        )
        .slice(0, limit)
        .map((l) => ({ lotId: l.id, walletAccountId: l.wallet })),
    );
  }
  reconcile(): Promise<readonly ReconcileMismatch[]> {
    const out: ReconcileMismatch[] = [];
    const posted = new Map<string, bigint>();
    for (const journal of this.journals) {
      const total = journal.postings.reduce((sum, leg) => sum + leg.amountMinor, 0n);
      if (total !== 0n) {
        out.push({ check: 'journal-unbalanced', subject: journal.id, expected: 0n, actual: total });
      }
      for (const leg of journal.postings) {
        posted.set(leg.accountId, (posted.get(leg.accountId) ?? 0n) + leg.amountMinor);
      }
    }
    const heldOf = (wallet: string) =>
      [...this.holds.values()]
        .filter((h) => h.status === 'held' && h.walletAccountId === wallet)
        .reduce((sum, h) => sum + h.amountMinor, 0n);
    for (const account of this.accounts.values()) {
      if (account.kind !== 'credit_liability') continue;
      const balance = this.balances.get(account.id);
      const available = balance?.availableMinor ?? 0n;
      const lotted = [...this.lots.values()]
        .filter((l) => l.wallet === account.id)
        .reduce((sum, l) => sum + l.remaining, 0n);
      const checks: [ReconcileMismatch['check'], bigint, bigint][] = [
        ['postings-vs-available', available, posted.get(account.id) ?? 0n],
        ['lots-vs-available', available, lotted],
        ['held-holds-vs-held', balance?.heldMinor ?? 0n, heldOf(account.id)],
      ];
      for (const [check, expected, actual] of checks) {
        if (expected !== actual) out.push({ check, subject: account.id, expected, actual });
      }
    }
    return Promise.resolve(out);
  }
  dueHolds(_m: MarketContext, now: Temporal.Instant, limit: number): Promise<readonly DueHold[]> {
    return Promise.resolve(
      [...this.holds.values()]
        .filter(
          (h) => h.status === 'held' && h.expiresAt.epochMilliseconds <= now.epochMilliseconds,
        )
        .slice(0, limit)
        .map((h) => ({ holdId: h.id, walletAccountId: h.walletAccountId })),
    );
  }
}

export class MemoryMarketSetting implements MarketSettingRepository {
  record: MarketSettingRecord | null = null;
  saves = 0;
  find() {
    return Promise.resolve(this.record);
  }
  findForUpdate() {
    return Promise.resolve(this.record);
  }
  save(_m: MarketContext, record: MarketSettingRecord) {
    this.saves += 1;
    this.record = record;
    return Promise.resolve();
  }
}
