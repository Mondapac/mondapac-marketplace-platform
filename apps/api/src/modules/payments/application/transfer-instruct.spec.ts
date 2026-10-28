import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  ACCOUNT,
  AMOUNT,
  buildTransferHarness,
  EXTERNAL,
  KEY,
  MARKET_FACTS,
  PAYOUT,
  SELLER,
  T0,
} from '../../../../test/support/transfer-harness';
import { TEST_HMAC_KEYS, testKeyring } from '../../../../test/support/payments-fakes';

const refusedWith = (code: string) => ok({ kind: 'refused', code });

describe.each([['AU'], ['ZZ']] as const)('payments.instruct-transfer in market %s', (code) => {
  const facts = MARKET_FACTS[code];
  let h: ReturnType<typeof buildTransferHarness>;
  beforeEach(() => {
    h = buildTransferHarness(code);
  });
  const instruct = (fields: Record<string, unknown> = {}) =>
    h.useCases.instruct.execute(h.system, h.request(fields));

  describe('the happy path', () => {
    it('sends once and stores the transfer as executed', async () => {
      await h.ready();

      const result = await instruct();

      expect(result.ok).toBe(true);
      expect(h.transferGateway.creates).toEqual([
        {
          destination: ACCOUNT,
          amountMinor: AMOUNT,
          currency: facts.currency,
          transferGroup: PAYOUT,
          key: KEY,
          payoutId: PAYOUT,
          marketId: code,
        },
      ]);
      const row = h.row()!;
      expect(row).toMatchObject({
        state: 'executed',
        sendCount: 1,
        providerTransferRef: 'tr_test_0001',
        sellerId: SELLER,
        accountRef: ACCOUNT,
        amountMinor: AMOUNT,
        currency: facts.currency,
        reference: PAYOUT,
      });
      expect(result).toEqual(ok({ kind: 'accepted', transferExecutionId: row.id }));
      expect(h.outbox.events.map((e) => e.type)).toEqual(['payments.transfer-changed.v1']);
      expect(h.audit.rows.map((r) => r.action)).toContain('payments.transfer.executed');
    });

    it('locks the seller account in the reserving unit and calls Stripe outside any unit', async () => {
      await h.ready();

      await instruct();

      expect(h.accounts.locks).toEqual([SELLER]);
      expect(h.depthAtCall.length).toBeGreaterThanOrEqual(2);
      expect(h.depthAtCall.every((c) => c.depth === 0)).toBe(true);
      expect(h.depthAtCall.map((c) => c.call)).toEqual(['readAccount', 'createTransfer']);
    });

    it('answers a repeated key with the same transfer and sends nothing again', async () => {
      await h.ready();
      const first = await instruct();

      const again = await instruct();

      expect(again).toEqual(first);
      expect(h.transferGateway.creates).toHaveLength(1);
    });

    it('refuses a repeated key with other content', async () => {
      await h.ready();
      await instruct();

      for (const other of [
        { amount: { amount: AMOUNT + 1n, currency: facts.currency } },
        { reference: '01990000-0000-7000-8000-0000000000e9' },
        { sellerId: '01990000-0000-7000-8000-0000000000b9' },
      ]) {
        expect(await instruct(other)).toEqual(refusedWith('idempotency.key-reused'));
      }
      expect(h.transferGateway.creates).toHaveLength(1);
    });
  });

  describe('validation and the Market limits', () => {
    it.each([
      ['a key with a space', { instructionKey: 'bad key' }],
      ['an empty key', { instructionKey: '' }],
      ['a seller that is not an id', { sellerId: 'seller' }],
      ['a reference that is not an id', { reference: 'payout' }],
      ['a zero amount', { amount: { amount: 0n, currency: 'X' } }],
      ['a number amount', { amount: { amount: 5000, currency: 'AUD' } }],
      ['no amount', { amount: null }],
    ])('refuses %s', async (_name, fields) => {
      await h.ready();

      const result = await instruct(fields);

      expect(result).toEqual(refusedWith('validation.failed'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it("refuses another currency than the Market's", async () => {
      await h.ready();

      const result = await instruct({ amount: { amount: AMOUNT, currency: facts.other } });

      expect(result).toEqual(refusedWith('payments.transfer.currency-mismatch'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('allows exactly the ceiling and refuses one above it with an alert', async () => {
      await h.ready();
      const exact = await instruct({
        instructionKey: 'exact',
        amount: { amount: facts.max, currency: facts.currency },
      });
      expect(exact.ok && exact.value.kind).toBe('accepted');

      const above = await instruct({
        instructionKey: 'above',
        amount: { amount: facts.max + 1n, currency: facts.currency },
      });

      expect(above).toEqual(refusedWith('payments.transfer.amount-out-of-range'));
      expect(h.alerts()).toEqual([{ kind: 'amount-out-of-range' }]);
      expect(h.transferGateway.creates).toHaveLength(1);
      expect(h.row('above')).toBeUndefined();
    });

    it('is unavailable when the policy cannot be read or has no ceiling', async () => {
      const throwing = buildTransferHarness(code, (real) => ({
        ...real,
        marketCurrency: () => {
          throw new Error('no config');
        },
      }));
      await throwing.ready();
      expect(
        await throwing.useCases.instruct.execute(throwing.system, throwing.request() as never),
      ).toEqual(err({ code: 'payments.unavailable' }));

      const nullLimits = buildTransferHarness(code, (real) => ({
        ...real,
        transferLimits: () => null,
      }));
      await nullLimits.ready();
      expect(
        await nullLimits.useCases.instruct.execute(
          nullLimits.system,
          nullLimits.request() as never,
        ),
      ).toEqual(err({ code: 'payments.unavailable' }));
      expect(nullLimits.transferGateway.creates).toHaveLength(0);
    });

    it('is unavailable without a Stripe key or a hash key, and sends nothing', async () => {
      await h.ready();
      h.transferGateway.isAvailable = false;
      expect(await instruct()).toEqual(err({ code: 'payments.unavailable' }));
      h.transferGateway.isAvailable = true;
      (h.deps as { keyring: unknown }).keyring = testKeyring({}, null);
      expect(await instruct()).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.transferGateway.creates).toHaveLength(0);
      expect(h.row()).toBeUndefined();
    });
  });

  describe('the connected account', () => {
    it('refuses a seller without a connected account', async () => {
      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
    });

    it('refuses an account that is not ready', async () => {
      await h.seedAccount({ status: 'restricted', payoutsEnabled: false });
      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses an account in its cooling-off', async () => {
      await h.ready();
      await h.seedAccount({ coolingOffUntil: T0.add({ hours: 5 }) });
      h.connect.readAnswer = ok(h.accountSnapshot());

      expect(await instruct()).toEqual(refusedWith('payments.transfer.cooling-off'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses an account whose hash was never stamped (NULL never matches)', async () => {
      await h.ready();
      await h.seedAccount({ externalAccountHmac: null });

      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      expect(h.connect.reads).toEqual([]);
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses when the live read has no default bank account', async () => {
      await h.ready();
      h.connect.readAnswer = ok(h.accountSnapshot({ defaultExternalAccountId: null }));

      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses when the live read names another seller or Market', async () => {
      await h.ready();
      h.connect.readAnswer = ok(
        h.accountSnapshot({ metadataSellerId: '01990000-0000-7000-8000-0000000000b9' }),
      );
      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      h.connect.readAnswer = ok(h.accountSnapshot({ metadataMarketId: 'XX' }));
      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      h.connect.readAnswer = ok(h.accountSnapshot({ transfersActive: false }));
      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('never falls back to the stored state when the live read fails, and raises the metric', async () => {
      await h.ready();
      h.connect.readAnswer = err({ code: 'payment.provider-unavailable' });

      const result = await instruct();

      expect(result).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.transferGateway.creates).toHaveLength(0);
      expect(h.row()).toBeUndefined();
      expect(h.liveCheckFailures()).toHaveLength(1);
      expect(h.liveCheckFailures()[0]).toMatchObject({ targetId: SELLER });
      expect(h.accounts.changes).toHaveLength(0);
    });

    it('starts a cooling-off when the live bank account differs, and sends nothing', async () => {
      await h.ready();
      h.connect.readAnswer = ok(h.accountSnapshot({ defaultExternalAccountId: 'ba_other' }));

      const result = await instruct();

      expect(result).toEqual(refusedWith('payments.transfer.cooling-off'));
      expect(h.transferGateway.creates).toHaveLength(0);
      expect(h.row()).toBeUndefined();
      expect(h.accounts.changes).toHaveLength(1);
      expect(h.accounts.changes[0]).toMatchObject({
        kind: 'updated',
        detectedBy: 'live-check',
        sourceEventId: null,
        externalAccountHmac: h.hmacOf('ba_other'),
      });
      const stored = h.accounts.rows.get(h.accountKey)!;
      expect(stored.externalAccountHmac).toBe(h.hmacOf('ba_other'));
      expect(stored.coolingOffUntil).not.toBeNull();
      expect(stored.payoutsPausedUntil).not.toBeNull();
      expect(h.audit.rows.map((r) => r.action)).toContain('payments.payout-change.recorded');

      // The next instruction meets the cooling-off.
      h.connect.readAnswer = ok(h.accountSnapshot({ defaultExternalAccountId: 'ba_other' }));
      expect(await instruct()).toEqual(refusedWith('payments.transfer.cooling-off'));
    });

    it('re-stamps the same account under the current key without a change', async () => {
      await h.ready();
      await h.seedAccount({ externalAccountHmac: h.hmacOf(EXTERNAL, 1) });
      h.connect.readAnswer = ok(h.accountSnapshot());
      (h.deps as { keyring: unknown }).keyring = testKeyring(TEST_HMAC_KEYS, 2);

      const result = await instruct();

      expect(result.ok && result.value.kind).toBe('accepted');
      expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL, 2));
      expect(h.accounts.changes).toHaveLength(0);
    });

    it('is unavailable with an alert when the key of the stored version is missing', async () => {
      await h.ready();
      (h.deps as { keyring: unknown }).keyring = testKeyring({ 2: TEST_HMAC_KEYS[2] }, 2);

      const result = await instruct();

      expect(result).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.alerts()).toEqual([{ kind: 'hmac-key-missing' }]);
      expect(h.accounts.changes).toHaveLength(0);
      expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL, 1));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses when a change was recorded between the live check and the lock', async () => {
      await h.ready();
      const read = h.connect.readAccount.bind(h.connect);
      h.connect.readAccount = async (ref: string) => {
        const result = await read(ref);
        const row = h.accounts.rows.get(h.accountKey)!;
        h.accounts.rows.set(h.accountKey, {
          ...row,
          lastChangeId: '01990000-0000-7000-8000-0000000000c9',
        });
        return result;
      };

      expect(await instruct()).toEqual(refusedWith('payments.transfer.account-not-ready'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });
  });

  describe('Stripe answers', () => {
    it('keeps an unknown answer as sending and never sends it again', async () => {
      await h.ready();
      h.transferGateway.createAnswer = { kind: 'unknown' };

      const first = await instruct();
      const second = await instruct();

      expect(first).toEqual(err({ code: 'payments.unavailable' }));
      expect(second).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.transferGateway.creates).toHaveLength(1);
      expect(h.row()).toMatchObject({ state: 'sending', sendCount: 1 });
      expect(h.row()!.leaseUntil).toEqual(T0.add({ seconds: facts.leaseSeconds }));
    });

    it('does not send again after the lease ran out either', async () => {
      await h.leaveSending();
      h.clock.advance(Temporal.Duration.from({ seconds: facts.leaseSeconds + 1 }));

      expect(await instruct()).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.transferGateway.creates).toHaveLength(1);
    });

    it('ends a refused create as refused and says so definitely', async () => {
      await h.ready();
      h.transferGateway.createAnswer = { kind: 'refused', code: 'provider-refused' };

      expect(await instruct()).toEqual(refusedWith('payments.transfer.provider-refused'));
      expect(h.row()).toMatchObject({ state: 'refused', failureCode: 'provider-refused' });
      // Repeating the key repeats the refusal and sends nothing.
      expect(await instruct()).toEqual(refusedWith('payments.transfer.provider-refused'));
      expect(h.transferGateway.creates).toHaveLength(1);
    });

    it('alerts when the platform balance is insufficient', async () => {
      await h.ready();
      h.transferGateway.createAnswer = { kind: 'refused', code: 'insufficient-balance' };

      expect(await instruct()).toEqual(
        refusedWith('payments.transfer.insufficient-platform-balance'),
      );
      expect(h.row()).toMatchObject({
        state: 'refused',
        failureCode: 'insufficient-platform-balance',
      });
      expect(h.alerts()).toEqual([{ kind: 'insufficient-platform-balance' }]);
      expect(await instruct()).toEqual(
        refusedWith('payments.transfer.insufficient-platform-balance'),
      );
    });

    it('answers a key that another instruction stored first (insert conflict) with that row', async () => {
      await h.ready();
      const find = h.transfers.findByKey.bind(h.transfers);
      let first = true;
      h.transfers.findByKey = async (market, key) => {
        if (first) {
          first = false;
          return null;
        }
        return find(market, key);
      };
      // The other instruction's row is stored before ours is inserted.
      await h.transfers.insert(h.market, {
        id: '01990000-0000-7000-8000-0000000000f1',
        instructionKey: KEY,
        sellerId: SELLER,
        accountRef: ACCOUNT,
        amountMinor: AMOUNT,
        currency: facts.currency,
        reference: PAYOUT,
        state: 'sending',
        providerTransferRef: null,
        failureCode: null,
        reversedMinor: 0n,
        sendCount: 1,
        leaseUntil: T0.add({ seconds: 60 }),
        abandonedAt: null,
        fenceBreachedAt: null,
        executedAt: null,
        createdAt: T0,
        updatedAt: T0,
        version: 1,
      });

      expect(await instruct()).toEqual(err({ code: 'payments.unavailable' }));
      expect(h.transferGateway.creates).toHaveLength(0);
    });

    it('refuses a late instruction for a key that was given up (tombstone)', async () => {
      await h.ready();
      expect((await h.useCases.abandon.execute(h.system, KEY as never)).ok).toBe(true);

      expect(await instruct()).toEqual(refusedWith('idempotency.key-reused'));
      expect(h.transferGateway.creates).toHaveLength(0);
    });
  });

  describe('the daily total', () => {
    const big = { amount: { amount: facts.max, currency: facts.currency } };
    const seedExecuted = (key: string, amount: bigint, at: Temporal.Instant) => {
      h.transfers.rows.set(`${code}/${key}`, {
        market: code,
        id: `01990000-0000-7000-8000-${Math.abs(key.length * 977 + Number(amount % 1000n))
          .toString(16)
          .padStart(12, '0')}`,
        instructionKey: key,
        sellerId: SELLER,
        accountRef: ACCOUNT,
        amountMinor: amount,
        currency: facts.currency,
        reference: PAYOUT,
        state: 'executed',
        providerTransferRef: `tr_${key}`,
        failureCode: null,
        reversedMinor: 0n,
        sendCount: 1,
        leaseUntil: null,
        abandonedAt: null,
        fenceBreachedAt: null,
        executedAt: at,
        createdAt: at,
        updatedAt: at,
        version: 2,
      });
    };

    it('alerts once the day total in the Market zone passes the threshold', async () => {
      await h.ready();
      seedExecuted('earlier', facts.threshold - 1n, T0.subtract({ minutes: 5 }));

      await instruct({ instructionKey: 'one', ...big });

      expect(h.alerts()).toEqual([{ kind: 'daily-total-over-threshold' }]);
    });

    it('does not alert at the threshold exactly, nor for yesterday in the Market zone', async () => {
      await h.ready();
      seedExecuted('earlier', facts.threshold - facts.max, T0.subtract({ minutes: 5 }));
      await instruct({ instructionKey: 'one', ...big });
      expect(h.alerts()).toEqual([]);

      // A transfer before the start of the Market's day does not count toward today's total.
      const startOfDay = T0.toZonedDateTimeISO(facts.zone).startOfDay().toInstant();
      seedExecuted('yesterday', facts.threshold, startOfDay.subtract({ seconds: 1 }));
      await instruct({ instructionKey: 'two', amount: { amount: 1n, currency: facts.currency } });
      expect(h.alerts()).toEqual([{ kind: 'daily-total-over-threshold' }]);
    });
  });
});
